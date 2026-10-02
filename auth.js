/* =====================================================================
 * auth.js — AUTENTICAÇÃO (Supabase Auth) COM SESSÃO OFFLINE
 * ---------------------------------------------------------------------
 * Fala com a API REST do Supabase diretamente (sem SDK, para não
 * depender de CDN e não quebrar offline).
 *
 * Princípios:
 *  - A sessão fica gravada no IndexedDB e vale por 30 dias SEM internet.
 *  - Offline, a entrada é validada contra um hash PBKDF2 da senha
 *    gravado no aparelho no último login bem-sucedido. A senha em si
 *    nunca é armazenada.
 *  - Sessão vencida bloqueia APENAS o envio. O preenchimento de
 *    inspeções nunca é bloqueado: o dado do campo não pode ser perdido.
 *  - O access_token é renovado silenciosamente sempre que há rede.
 *
 * A autorização de verdade está na RLS do banco (backend/supabase.sql).
 * Nada aqui é barreira de segurança: é ergonomia de tela.
 * ===================================================================== */

const AUTH = (function () {

  const CHAVE_SESSAO = 'sessao';        // no IndexedDB (tabela kv)
  const MARGEM_RENOVACAO = 120;         // segundos antes de expirar

  let sessao = null;                    // objeto em memória
  const ouvintes = [];

  /* ===================================================================
   * Utilitários
   * =================================================================== */

  function base() { return String((CONFIG.supabase || {}).url || '').replace(/\/+$/, ''); }
  function anon() { return (CONFIG.supabase || {}).anonKey || ''; }

  function configurado() {
    const s = (CONFIG.supabase || {});
    return !!s.url && String(s.url).indexOf('SEUPROJETO') === -1 &&
           !!s.anonKey && String(s.anonKey).indexOf('COLOQUE-AQUI') === -1;
  }

  /**
   * MODO LOCAL — enquanto o Supabase não estiver configurado em config.js,
   * o app funciona sem servidor (contas e inspeções só no aparelho).
   * Com o Supabase configurado, vale a base central: cadastro aprovado
   * pelo administrador e inspeções reunidas num só lugar.
   */
  function modoLocal() { return !configurado(); }

  async function fetchTimeout(url, opcoes, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms || 20000);
    try {
      return await fetch(url, Object.assign({}, opcoes || {}, { signal: ctrl.signal }));
    } finally {
      clearTimeout(t);
    }
  }

  function agora() { return Date.now(); }

  function notificar() {
    ouvintes.forEach(fn => { try { fn(estado()); } catch (e) {} });
  }
  function aoMudar(fn) { ouvintes.push(fn); }

  /* -------------------------------------------------------------------
   * Hash local da senha (PBKDF2-SHA256, 150 mil iterações)
   * Permite validar a entrada offline sem guardar a senha.
   * ----------------------------------------------------------------- */
  function paraHex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function hashSenha(senha, salHex) {
    const sal = salHex
      ? Uint8Array.from(salHex.match(/.{2}/g).map(h => parseInt(h, 16)))
      : crypto.getRandomValues(new Uint8Array(16));
    const chave = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: sal, iterations: 150000, hash: 'SHA-256' }, chave, 256);
    return { sal: paraHex(sal.buffer || sal), hash: paraHex(bits) };
  }

  async function conferirSenhaLocal(senha, guardado) {
    if (!guardado || !guardado.sal || !guardado.hash) return false;
    const r = await hashSenha(senha, guardado.sal);
    // Comparação de tempo constante (paranoia barata)
    if (r.hash.length !== guardado.hash.length) return false;
    let dif = 0;
    for (let i = 0; i < r.hash.length; i++) {
      dif |= r.hash.charCodeAt(i) ^ guardado.hash.charCodeAt(i);
    }
    return dif === 0;
  }

  /* ===================================================================
   * Persistência da sessão
   * =================================================================== */

  async function gravarSessao(s) {
    sessao = s;
    await DB.kvSet(CHAVE_SESSAO, s);
    notificar();
    return s;
  }

  async function carregarSessao() {
    sessao = await DB.kvGet(CHAVE_SESSAO, null);
    return sessao;
  }

  async function limparSessao(manterCredencial) {
    // Ao sair, preservamos e-mail e hash para permitir novo login
    // offline do mesmo usuário; os registros locais dele continuam
    // intactos, presos ao seu usuarioId.
    const anterior = sessao;
    const nova = manterCredencial && anterior ? {
      email: anterior.email,
      credencial: anterior.credencial,
      perfil: anterior.perfil,
      usuarioId: anterior.usuarioId,
      desconectado: true
    } : null;
    sessao = nova;
    if (nova) await DB.kvSet(CHAVE_SESSAO, nova);
    else await DB.kvSet(CHAVE_SESSAO, null);
    notificar();
  }

  /* ===================================================================
   * Estado consultado pelo restante do app
   * =================================================================== */

  /** Sessão offline ainda dentro da validade de 30 dias? */
  function dentroDaValidadeOffline() {
    if (!sessao) return false;
    if (sessao.local) return true;      // conta local não expira: não há servidor para renovar
    if (!sessao.validadeOffline) return false;
    return agora() < sessao.validadeOffline;
  }

  /**
   * Há usuário identificado neste aparelho?
   * ATENÇÃO: de propósito, NÃO depende da validade de 30 dias. Sessão
   * vencida continua permitindo abrir o app e PREENCHER inspeções —
   * o que vence é o direito de ENVIAR (ver podeEnviar). Perder o
   * registro de campo por causa de token é inaceitável.
   */
  function autenticado() {
    return !!(sessao && !sessao.desconectado && sessao.usuarioId && sessao.perfil);
  }

  function perfil() {
    return (sessao && sessao.perfil) ? sessao.perfil : null;
  }

  function usuarioId() {
    return sessao ? sessao.usuarioId : null;
  }

  function ehAdmin() {
    return !!(perfil() && perfil().perfil === 'admin');
  }

  /** Administrador ou visão "todas": vê as inspeções de outros usuários. */
  function veTodas() {
    const p = perfil();
    return ehAdmin() || !!(p && p.visao === 'todas');
  }

  function lotes() {
    const p = perfil();
    return CONFIG.lotesPermitidos(p ? p.lotes : [], ehAdmin());
  }

  /**
   * Pode enviar para o servidor? Exige sessão dentro da validade de 30
   * dias e refresh token guardado. Fora disso o envio para; a fila
   * espera o próximo login com internet.
   */
  function podeEnviar() {
    if (!sessao || sessao.desconectado) return false;
    if (sessao.local) return false;     // nada para onde enviar ainda
    return !!(sessao.refreshToken && dentroDaValidadeOffline());
  }

  function estado() {
    return {
      autenticado: autenticado(),
      usuarioId: usuarioId(),
      perfil: perfil(),
      ehAdmin: ehAdmin(),
      lotes: lotes(),
      podeEnviar: podeEnviar(),
      sessaoVencida: !!(sessao && !sessao.desconectado && !dentroDaValidadeOffline()),
      diasRestantesOffline: sessao && sessao.validadeOffline
        ? Math.max(0, Math.ceil((sessao.validadeOffline - agora()) / 86400000))
        : 0,
      emailUltimaConta: sessao ? sessao.email : null,
      configurado: configurado(),
      modoLocal: modoLocal(),
      contaLocal: !!(sessao && sessao.local)
    };
  }

  /* ===================================================================
   * Chamadas ao Supabase
   * =================================================================== */

  function cabecalhosAnon(extra) {
    return Object.assign({
      apikey: anon(),
      'Content-Type': 'application/json'
    }, extra || {});
  }

  async function cabecalhosAutenticados(extra) {
    const token = await obterToken();
    return Object.assign({
      apikey: anon(),
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    }, extra || {});
  }

  /**
   * Access token válido; renova pelo refresh_token quando necessário.
   * @param {boolean} forcar - ignora o token em cache e troca por um
   *        novo. Usado quando a sessão offline venceu: só uma ida real
   *        ao servidor devolve a validade dos 30 dias.
   */
  async function obterToken(forcar) {
    if (!sessao) throw new Error('SEM_SESSAO');
    const folga = MARGEM_RENOVACAO * 1000;
    if (!forcar && sessao.accessToken && sessao.expiraEm && sessao.expiraEm - folga > agora()) {
      return sessao.accessToken;
    }
    if (!sessao.refreshToken) throw new Error('SEM_SESSAO');

    const r = await fetchTimeout(base() + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: cabecalhosAnon(),
      body: JSON.stringify({ refresh_token: sessao.refreshToken })
    }, 20000);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      // Refresh recusado (senha trocada, usuário desativado, token velho).
      // Não derruba a sessão offline: apenas impede o envio.
      sessao.accessToken = null;
      sessao.expiraEm = 0;
      await DB.kvSet(CHAVE_SESSAO, sessao);
      throw new Error('SESSAO_EXPIRADA');
    }
    await aplicarTokens(j);
    return sessao.accessToken;
  }

  /** Todo contato bem-sucedido com o servidor devolve os 30 dias. */
  async function renovarValidade() {
    if (!sessao) return;
    sessao.validadeOffline = agora() + CONFIG.auth.diasSessaoOffline * 86400000;
    await DB.kvSet(CHAVE_SESSAO, sessao);
    notificar();
  }

  async function aplicarTokens(j) {
    sessao.accessToken = j.access_token;
    sessao.refreshToken = j.refresh_token || sessao.refreshToken;
    sessao.expiraEm = agora() + ((j.expires_in || 3600) * 1000);
    // Cada contato bem-sucedido com o servidor renova os 30 dias.
    sessao.validadeOffline = agora() + CONFIG.auth.diasSessaoOffline * 86400000;
    await DB.kvSet(CHAVE_SESSAO, sessao);
    notificar();
  }

  /** Busca (ou atualiza) o perfil do usuário na tabela usuarios. */
  async function carregarPerfil(idUsuario, token) {
    const url = base() + '/rest/v1/' + CONFIG.supabase.tabelaUsuarios +
                '?id=eq.' + encodeURIComponent(idUsuario) + '&select=*';
    const r = await fetchTimeout(url, {
      headers: { apikey: anon(), Authorization: 'Bearer ' + token }
    }, 20000);
    const j = await r.json().catch(() => []);
    if (!r.ok) throw new Error('Não foi possível ler o cadastro: ' + (j.message || r.status));
    return (Array.isArray(j) && j[0]) ? j[0] : null;
  }

  /* -------------------------------------------------------------------
   * CADASTRO
   * -------------------------------------------------------------------
   * 1) cria o usuário no Auth
   * 2) grava a linha em usuarios com status 'pendente'
   * Requer internet — não há como criar conta offline.
   * ----------------------------------------------------------------- */
  async function cadastrar(dados) {
    const erros = validarCadastro(dados);
    if (erros.length) throw new Error(erros.join(' '));

    // ---- MODO LOCAL: conta criada no próprio aparelho ----
    if (modoLocal()) return cadastrarLocal(dados);

    if (!navigator.onLine) throw new Error('SEM_REDE');

    // 1) Auth
    const r = await fetchTimeout(base() + '/auth/v1/signup', {
      method: 'POST',
      headers: cabecalhosAnon(),
      body: JSON.stringify({
        email: dados.email.trim().toLowerCase(),
        password: dados.senha,
        data: { nome: dados.nome.trim(), funcao: dados.funcao, lotes: dados.lotes }
      })
    }, 30000);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j.msg || j.error_description || j.message || '').toLowerCase();
      if (msg.indexOf('already') !== -1 || msg.indexOf('registered') !== -1) {
        throw new Error('Este e-mail já possui cadastro. Use "Esqueci minha senha".');
      }
      throw new Error('Falha no cadastro: ' + (j.msg || j.message || r.status));
    }

    // A linha em "usuarios" é criada pelo próprio banco (gatilho), sempre
    // como PENDENTE — exceto o administrador da base de acessos.
    const token = j.access_token || null;
    return { ok: true, precisaConfirmarEmail: !token, pendente: true };
  }

  async function gravarLinhaUsuario(idUsuario, dados, token) {
    const r = await fetchTimeout(base() + '/rest/v1/' + CONFIG.supabase.tabelaUsuarios, {
      method: 'POST',
      headers: {
        apikey: anon(),
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify({
        id: idUsuario,
        nome: dados.nome.trim(),
        email: dados.email.trim().toLowerCase(),
        funcao: dados.funcao,
        lotes: dados.lotes,
        perfil: 'inspetor',
        status: 'pendente'
      })
    }, 30000);
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error('Conta criada, mas o cadastro não foi gravado: ' + t.slice(0, 180));
    }
  }

  /**
   * Cadastro sem servidor. A primeira conta do aparelho é
   * administradora (alguém precisa poder administrar) e todas entram
   * já ativas: aprovação só faz sentido quando há base compartilhada.
   * Ao final já deixa a pessoa conectada — um passo a menos em campo.
   */
  async function cadastrarLocal(dados) {
    const existente = await DB.obterUsuarioLocalPorEmail(dados.email);
    if (existente) {
      throw new Error('Já existe uma conta com este e-mail neste aparelho. Use "Entrar".');
    }
    const primeira = (await DB.contarUsuariosLocais()) === 0;
    const credencial = await hashSenha(dados.senha);
    const usuario = await DB.criarUsuarioLocal({
      nome: dados.nome.trim(),
      email: dados.email,
      funcao: dados.funcao,
      lotes: dados.lotes,
      perfil: primeira ? 'admin' : 'inspetor',
      credencial: credencial
    });
    await abrirSessaoLocal(usuario);
    return { ok: true, local: true, admin: primeira, entrou: true };
  }

  /** Monta a sessão de uma conta local. */
  async function abrirSessaoLocal(usuario) {
    usuario.ultimo_acesso = new Date().toISOString();
    await DB.atualizarUsuarioLocal(usuario.id, { ultimo_acesso: usuario.ultimo_acesso });
    await gravarSessao({
      email: usuario.email,
      usuarioId: usuario.id,
      local: true,
      accessToken: null,
      refreshToken: null,
      expiraEm: 0,
      validadeOffline: null,
      manterConectado: true,
      credencial: usuario.credencial,
      perfil: usuario,
      entrouEm: new Date().toISOString(),
      desconectado: false
    });
    return estado();
  }

  /** Login de conta local (confere o hash gravado no aparelho). */
  async function entrarLocal(email, senha) {
    const usuario = await DB.obterUsuarioLocalPorEmail(email);
    if (!usuario) {
      throw new Error('Não há conta com este e-mail neste aparelho. Toque em "Criar cadastro".');
    }
    if (usuario.status !== 'ativo') {
      throw new Error('Conta desativada neste aparelho.');
    }
    const ok = await conferirSenhaLocal(senha, usuario.credencial);
    if (!ok) throw new Error('Senha incorreta.');
    return abrirSessaoLocal(usuario);
  }

  function validarCadastro(d) {
    const e = [];
    if (!d.nome || d.nome.trim().length < 5) e.push('Informe o nome completo.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email || '')) e.push('E-mail inválido.');
    if (!d.funcao) e.push('Selecione a função.');
    if (!Array.isArray(d.lotes) || !d.lotes.length) e.push('Selecione ao menos um lote.');
    if (!validarSenha(d.senha)) {
      e.push('A senha precisa de no mínimo ' + CONFIG.auth.minimoSenha +
             ' caracteres, com letra e número.');
    }
    if (d.senha !== d.confirmacao) e.push('A confirmação de senha não confere.');
    return e;
  }

  function validarSenha(senha) {
    return !!senha &&
      senha.length >= CONFIG.auth.minimoSenha &&
      /[A-Za-zÀ-ÿ]/.test(senha) &&
      /[0-9]/.test(senha);
  }

  /* -------------------------------------------------------------------
   * LOGIN ONLINE
   * ----------------------------------------------------------------- */
  async function entrar(email, senha, manterConectado) {
    email = String(email || '').trim().toLowerCase();
    if (modoLocal()) return entrarLocal(email, senha);

    const r = await fetchTimeout(base() + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: cabecalhosAnon(),
      body: JSON.stringify({ email: email, password: senha })
    }, 25000);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      const msg = (j.error_description || j.msg || j.message || '').toLowerCase();
      if (msg.indexOf('invalid') !== -1 || msg.indexOf('credentials') !== -1) {
        throw new Error('E-mail ou senha incorretos.');
      }
      if (msg.indexOf('confirm') !== -1) {
        throw new Error('Confirme o e-mail antes de entrar.');
      }
      throw new Error('Não foi possível entrar: ' + (j.msg || j.message || r.status));
    }

    const idUsuario = j.user ? j.user.id : null;
    let linha = await carregarPerfil(idUsuario, j.access_token);

    if (!linha) throw new Error('Cadastro não localizado. Fale com o administrador.');

    if (linha.status === 'pendente') {
      throw new Error('PENDENTE');
    }
    if (linha.status === 'recusado') {
      throw new Error('Cadastro recusado pelo administrador.');
    }
    if (linha.status === 'inativo') {
      throw new Error('Usuário desativado. Fale com o administrador.');
    }

    // Mesma pessoa que já usava o app em modo local? Passa os registros
    // dela para a conta do servidor, senão o histórico sumiria.
    try {
      const antiga = await DB.obterUsuarioLocalPorEmail(email);
      if (antiga && antiga.id !== idUsuario) {
        await DB.migrarRegistrosLocais(antiga.id, idUsuario);
      }
    } catch (e) { /* migração é conveniência, não pode travar o login */ }

    const credencial = await hashSenha(senha);
    const nova = {
      email: email,
      usuarioId: idUsuario,
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiraEm: agora() + ((j.expires_in || 3600) * 1000),
      validadeOffline: agora() + CONFIG.auth.diasSessaoOffline * 86400000,
      manterConectado: manterConectado !== false,
      credencial: credencial,
      perfil: linha,
      entrouEm: new Date().toISOString(),
      desconectado: false
    };
    await gravarSessao(nova);
    marcarUltimoAcesso();     // não bloqueia o login se falhar
    return estado();
  }

  /* -------------------------------------------------------------------
   * LOGIN OFFLINE
   * -------------------------------------------------------------------
   * Só funciona para a última conta usada no aparelho e apenas dentro
   * da validade de 30 dias. A senha é conferida contra o hash local.
   * ----------------------------------------------------------------- */
  async function entrarOffline(email, senha) {
    const guardada = sessao || await carregarSessao();
    email = String(email || '').trim().toLowerCase();

    if (!guardada || !guardada.email) {
      throw new Error('Nenhuma conta foi usada neste aparelho ainda. É preciso entrar uma vez com internet.');
    }
    if (guardada.email !== email) {
      throw new Error('Sem internet, só é possível entrar com a última conta usada neste aparelho (' +
                      guardada.email + ').');
    }
    if (!guardada.validadeOffline || agora() >= guardada.validadeOffline) {
      throw new Error('A sessão offline expirou (limite de ' + CONFIG.auth.diasSessaoOffline +
                      ' dias). Conecte-se à internet para entrar novamente.');
    }
    const ok = await conferirSenhaLocal(senha, guardada.credencial);
    if (!ok) throw new Error('Senha incorreta.');

    guardada.desconectado = false;
    await gravarSessao(guardada);
    return estado();
  }

  /** Decide sozinho entre online e offline. */
  async function entrarAuto(email, senha, manterConectado) {
    if (modoLocal()) return entrarLocal(email, senha);
    if (navigator.onLine && configurado()) {
      try {
        return await entrar(email, senha, manterConectado);
      } catch (e) {
        const msg = String(e.message || '');
        // Erro de credencial ou de status: não adianta tentar offline.
        if (msg === 'PENDENTE' || /incorret|recusado|desativado|confirme|cadastro n/i.test(msg)) {
          throw e;
        }
        // Falha de rede disfarçada: cai para o modo offline.
        try {
          return await entrarOffline(email, senha);
        } catch (e2) {
          throw e;
        }
      }
    }
    return entrarOffline(email, senha);
  }

  async function sair() {
    // Revoga no servidor quando dá; localmente mantém a credencial para
    // permitir novo login offline do mesmo usuário.
    try {
      if (navigator.onLine && sessao && sessao.accessToken) {
        await fetchTimeout(base() + '/auth/v1/logout', {
          method: 'POST',
          headers: { apikey: anon(), Authorization: 'Bearer ' + sessao.accessToken }
        }, 8000);
      }
    } catch (e) { /* sair é sempre possível */ }
    await limparSessao(true);
  }

  /* -------------------------------------------------------------------
   * RECUPERAÇÃO DE SENHA (somente online)
   * ----------------------------------------------------------------- */
  async function recuperarSenha(email) {
    if (modoLocal()) throw new Error('MODO_LOCAL');
    if (!navigator.onLine) throw new Error('SEM_REDE');
    const r = await fetchTimeout(base() + '/auth/v1/recover', {
      method: 'POST',
      headers: cabecalhosAnon(),
      body: JSON.stringify({
        email: String(email || '').trim().toLowerCase(),
        // Volta para o próprio app depois de redefinir a senha
        redirect_to: window.location.origin + window.location.pathname
      })
    }, 20000);
    if (!r.ok && r.status !== 200) {
      const j = await r.json().catch(() => ({}));
      throw new Error('Falha ao enviar a recuperação: ' + (j.msg || j.message || r.status));
    }
    return true;
  }

  /* -------------------------------------------------------------------
   * REVALIDAÇÃO SILENCIOSA
   * -------------------------------------------------------------------
   * Roda na abertura e a cada volta de rede: renova o token e relê o
   * perfil (lotes e status podem ter mudado no servidor).
   * ----------------------------------------------------------------- */
  async function revalidar() {
    if (modoLocal() || (sessao && sessao.local)) return true;
    if (!sessao || sessao.desconectado || !sessao.refreshToken) return false;
    if (!navigator.onLine || !configurado()) return false;
    try {
      // Sessão vencida: o token em cache não serve — é preciso trocar de
      // fato com o servidor para recuperar a validade.
      const vencida = !dentroDaValidadeOffline();
      const token = await obterToken(vencida);
      const linha = await carregarPerfil(sessao.usuarioId, token);
      if (linha) {
        sessao.perfil = linha;
        await DB.kvSet(CHAVE_SESSAO, sessao);
        if (linha.status !== 'ativo') { notificar(); return 'BLOQUEADO'; }
      }
      await renovarValidade();
      marcarUltimoAcesso();
      return true;
    } catch (e) {
      return false;
    }
  }

  async function marcarUltimoAcesso() {
    try {
      const cab = await cabecalhosAutenticados({ Prefer: 'return=minimal' });
      await fetchTimeout(base() + '/rest/v1/' + CONFIG.supabase.tabelaUsuarios +
        '?id=eq.' + encodeURIComponent(sessao.usuarioId), {
        method: 'PATCH',
        headers: cab,
        body: JSON.stringify({
          ultimo_acesso: new Date().toISOString(),
          dispositivo: DB.dispositivo()
        })
      }, 10000);
    } catch (e) { /* informativo apenas */ }
  }

  /* ===================================================================
   * ADMINISTRAÇÃO (exige perfil 'admin' — a RLS confirma no servidor)
   * =================================================================== */

  async function listarUsuarios() {
    const cab = await cabecalhosAutenticados();
    const url = base() + '/rest/v1/' + CONFIG.supabase.tabelaUsuarios +
                '?select=*&order=criado_em.desc';
    const r = await fetchTimeout(url, { headers: cab }, 20000);
    const j = await r.json().catch(() => []);
    if (!r.ok) throw new Error('Falha ao listar usuários: ' + (j.message || r.status));
    return j;
  }

  async function atualizarUsuario(id, campos) {
    const cab = await cabecalhosAutenticados({ Prefer: 'return=representation' });
    const url = base() + '/rest/v1/' + CONFIG.supabase.tabelaUsuarios +
                '?id=eq.' + encodeURIComponent(id);
    const r = await fetchTimeout(url, {
      method: 'PATCH', headers: cab, body: JSON.stringify(campos)
    }, 20000);
    const t = await r.text();
    if (!r.ok) throw new Error('Falha ao atualizar: ' + t.slice(0, 180));
    try { return JSON.parse(t); } catch (e) { return true; }
  }

  /** Base de acessos (planilha carregada no banco) — só o admin lê. */
  async function listarAutorizacoes() {
    const cab = await cabecalhosAutenticados();
    const r = await fetchTimeout(base() + '/rest/v1/autorizacoes?select=*', { headers: cab }, 20000);
    if (!r.ok) return [];
    return r.json().catch(() => []);
  }

  /** Quantos cadastros aguardam liberação (0 se não for admin ou sem rede). */
  async function contarPendentes() {
    if (!ehAdmin() || !navigator.onLine) return 0;
    try {
      const cab = await cabecalhosAutenticados();
      const r = await fetchTimeout(base() + '/rest/v1/' + CONFIG.supabase.tabelaUsuarios +
        '?status=eq.pendente&select=id', { headers: cab }, 15000);
      if (!r.ok) return 0;
      return (await r.json()).length;
    } catch (e) { return 0; }
  }

  /* No modo local a administração age sobre as contas do aparelho. */
  const adminLocal = {
    listar: () => DB.listarUsuariosLocais(),
    aprovar: (id, lotes, visao) => DB.atualizarUsuarioLocal(id, Object.assign({ status: 'ativo', lotes: lotes }, visao ? { visao: visao } : {})),
    recusar: (id) => DB.atualizarUsuarioLocal(id, { status: 'recusado' }),
    desativar: (id) => DB.atualizarUsuarioLocal(id, { status: 'inativo' }),
    reativar: (id) => DB.atualizarUsuarioLocal(id, { status: 'ativo' }),
    definirLotes: (id, lotes) => DB.atualizarUsuarioLocal(id, { lotes: lotes }),
    promover: (id) => DB.atualizarUsuarioLocal(id, { perfil: 'admin' }),
    rebaixar: (id) => DB.atualizarUsuarioLocal(id, { perfil: 'inspetor' }),
    definirAcesso: (id, lotes, visao) => DB.atualizarUsuarioLocal(id, { lotes: lotes, visao: visao }),
    baseDeAcessos: async () => [],
    contarPendentes: async () => 0
  };

  const adminServidor = {
    listar: listarUsuarios,
    aprovar: (id, lotes, visao) => atualizarUsuario(id, Object.assign({ status: 'ativo', lotes: lotes }, visao ? { visao: visao } : {})),
    recusar: (id) => atualizarUsuario(id, { status: 'recusado' }),
    desativar: (id) => atualizarUsuario(id, { status: 'inativo' }),
    reativar: (id) => atualizarUsuario(id, { status: 'ativo' }),
    definirLotes: (id, lotes) => atualizarUsuario(id, { lotes: lotes }),
    promover: (id) => atualizarUsuario(id, { perfil: 'admin' }),
    rebaixar: (id) => atualizarUsuario(id, { perfil: 'inspetor' }),
    definirAcesso: (id, lotes, visao) => atualizarUsuario(id, { lotes: lotes, visao: visao }),
    baseDeAcessos: listarAutorizacoes,
    contarPendentes: contarPendentes
  };

  // Fachada: a tela chama AUTH.admin.* sem saber em qual modo está.
  const admin = {};
  ['listar', 'aprovar', 'recusar', 'desativar', 'reativar', 'definirLotes', 'promover',
   'rebaixar', 'definirAcesso', 'baseDeAcessos', 'contarPendentes'].forEach(function (acao) {
    admin[acao] = function () {
      const alvo = modoLocal() ? adminLocal : adminServidor;
      return alvo[acao].apply(null, arguments);
    };
  });

  /* ===================================================================
   * INICIALIZAÇÃO
   * =================================================================== */
  async function iniciar() {
    await carregarSessao();
    // Revalida em segundo plano: a tela não espera pela rede.
    setTimeout(() => { revalidar(); }, 1500);
    window.addEventListener('online', () => { revalidar(); });
    return estado();
  }

  return {
    iniciar: iniciar,
    estado: estado,
    aoMudar: aoMudar,
    configurado: configurado,
    modoLocal: modoLocal,

    cadastrar: cadastrar,
    validarSenha: validarSenha,
    validarCadastro: validarCadastro,
    entrar: entrar,
    entrarOffline: entrarOffline,
    entrarAuto: entrarAuto,
    sair: sair,
    recuperarSenha: recuperarSenha,
    revalidar: revalidar,
    renovarValidade: renovarValidade,

    autenticado: autenticado,
    podeEnviar: podeEnviar,
    usuarioId: usuarioId,
    perfil: perfil,
    ehAdmin: ehAdmin,
    veTodas: veTodas,
    lotes: lotes,

    obterToken: obterToken,
    cabecalhosAutenticados: cabecalhosAutenticados,
    admin: admin
  };
})();

window.AUTH = AUTH;
