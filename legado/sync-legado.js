/* =====================================================================
 * sync.js — CAMADA DE SINCRONIZAÇÃO (arquitetura desacoplada)
 * ---------------------------------------------------------------------
 * O motor de fila não conhece o destino. Cada destino é um ADAPTADOR que
 * implementa a mesma interface:
 *
 *   {
 *     nome: 'texto',
 *     async preparar()                 -> autenticação/inicialização
 *     async enviar(registro, fotos)    -> { remotoId }   (lança Error em falha)
 *     async excluir(registro)          -> remove/marca no destino (opcional)
 *   }
 *
 * Trocar de backend = alterar CONFIG.sync.backend em config.js.
 * ===================================================================== */

const SYNC = (function () {

  let emExecucao = false;          // trava simples contra execuções paralelas
  let timerPolling = null;
  const ouvintes = [];             // callbacks de mudança de estado (UI)

  /* ===================================================================
   * UTILITÁRIOS DE REDE
   * =================================================================== */

  /** fetch com timeout (o AbortController evita travar em rede fantasma). */
  async function fetchTimeout(url, opcoes, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms || 20000);
    try {
      return await fetch(url, Object.assign({}, opcoes || {}, { signal: ctrl.signal }));
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Conectividade REAL. navigator.onLine só informa que existe uma
   * interface de rede ativa — em campo isso é frequentemente falso
   * positivo (conectado ao rádio, sem trânsito de dados).
   */
  async function online() {
    if (!navigator.onLine) return false;
    try {
      const url = CONFIG.sync.urlTesteConectividade +
                  (CONFIG.sync.urlTesteConectividade.indexOf('?') === -1 ? '?' : '&') +
                  '_=' + Date.now();
      const r = await fetchTimeout(url, { method: 'GET', cache: 'no-store' }, 6000);
      return !!r && (r.ok || r.status === 304);
    } catch (e) {
      return false;
    }
  }

  /* ===================================================================
   * ADAPTADOR 1 — MICROSOFT SHAREPOINT ONLINE
   * -------------------------------------------------------------------
   * Item da lista: criado via Microsoft Graph API.
   * Fotos: enviadas como ANEXOS do item. Atenção — o Graph NÃO expõe
   * anexos de item de lista; por isso os anexos usam a API REST nativa
   * do SharePoint (_api/web/lists/.../AttachmentFiles/add), com um token
   * emitido para o recurso do SharePoint. Ambos os tokens saem do mesmo
   * login (fluxo Authorization Code + PKCE, sem biblioteca externa).
   * =================================================================== */
  const AdaptadorSharePoint = (function () {
    const C = () => CONFIG.sync.sharepoint;
    const CHAVE_TOKENS = 'sp_tokens';       // guardado no IndexedDB (kv)
    const CHAVE_PKCE = 'sp_pkce_verifier';  // guardado no sessionStorage

    let siteId = '';
    let listaId = '';

    function autoridade() {
      return 'https://login.microsoftonline.com/' + C().tenantId;
    }

    // ---- PKCE -----------------------------------------------------
    function base64url(buf) {
      return btoa(String.fromCharCode.apply(null, new Uint8Array(buf)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    async function gerarPkce() {
      const arr = new Uint8Array(32);
      crypto.getRandomValues(arr);
      const verifier = base64url(arr);
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      return { verifier: verifier, challenge: base64url(hash) };
    }

    /** Redireciona o navegador para a tela de login da Microsoft. */
    async function login() {
      const pkce = await gerarPkce();
      sessionStorage.setItem(CHAVE_PKCE, pkce.verifier);
      const p = new URLSearchParams({
        client_id: C().clientId,
        response_type: 'code',
        redirect_uri: C().redirectUri,
        response_mode: 'query',
        scope: C().escopos.join(' '),
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account'
      });
      window.location.href = autoridade() + '/oauth2/v2.0/authorize?' + p.toString();
    }

    /** Chamado na abertura do app: troca o ?code= por tokens. */
    async function tratarRetornoLogin() {
      const q = new URLSearchParams(window.location.search);
      const code = q.get('code');
      if (!code) return false;
      const verifier = sessionStorage.getItem(CHAVE_PKCE);
      const corpo = new URLSearchParams({
        client_id: C().clientId,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: C().redirectUri,
        code_verifier: verifier || '',
        scope: C().escopos.join(' ')
      });
      const r = await fetchTimeout(autoridade() + '/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: corpo.toString()
      }, 20000);
      const j = await r.json();
      if (!r.ok) throw new Error('Falha no login Microsoft: ' + (j.error_description || r.status));
      await guardarTokens('graph', j);
      sessionStorage.removeItem(CHAVE_PKCE);
      // Limpa o ?code= da barra de endereço
      window.history.replaceState({}, document.title, C().redirectUri);
      return true;
    }

    async function guardarTokens(recurso, j) {
      const tokens = (await DB.kvGet(CHAVE_TOKENS, {})) || {};
      tokens[recurso] = {
        access_token: j.access_token,
        expira_em: Date.now() + ((j.expires_in || 3600) - 120) * 1000
      };
      if (j.refresh_token) tokens.refresh_token = j.refresh_token;
      await DB.kvSet(CHAVE_TOKENS, tokens);
      return tokens;
    }

    /**
     * Devolve um access_token válido para o recurso pedido.
     * recurso: 'graph' | 'sharepoint'
     * Usa o refresh_token (escopo offline_access) para emitir tokens de
     * recursos diferentes sem novo login interativo.
     */
    async function obterToken(recurso) {
      const tokens = (await DB.kvGet(CHAVE_TOKENS, {})) || {};
      const atual = tokens[recurso];
      if (atual && atual.access_token && atual.expira_em > Date.now()) {
        return atual.access_token;
      }
      if (!tokens.refresh_token) {
        throw new Error('SEM_LOGIN'); // a UI trata pedindo login ao usuário
      }
      const escopos = recurso === 'graph'
        ? C().escopos.join(' ')
        : ('https://' + C().hostname + '/AllSites.Manage offline_access');
      const corpo = new URLSearchParams({
        client_id: C().clientId,
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        scope: escopos
      });
      const r = await fetchTimeout(autoridade() + '/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: corpo.toString()
      }, 20000);
      const j = await r.json();
      if (!r.ok) {
        await DB.kvSet(CHAVE_TOKENS, {}); // refresh inválido: força novo login
        throw new Error('SEM_LOGIN');
      }
      const novos = await guardarTokens(recurso, j);
      return novos[recurso].access_token;
    }

    async function estaAutenticado() {
      const tokens = (await DB.kvGet(CHAVE_TOKENS, {})) || {};
      return !!(tokens && tokens.refresh_token);
    }

    async function sair() {
      await DB.kvSet(CHAVE_TOKENS, {});
    }

    // ---- Resolução de IDs do site e da lista ----------------------
    async function resolverIds() {
      if (siteId && listaId) return;
      if (C().siteId && C().listaId) {
        siteId = C().siteId; listaId = C().listaId; return;
      }
      const token = await obterToken('graph');
      const cab = { Authorization: 'Bearer ' + token };

      if (!siteId) {
        siteId = C().siteId;
        if (!siteId) {
          const url = 'https://graph.microsoft.com/v1.0/sites/' +
                      C().hostname + ':' + C().caminhoSite;
          const r = await fetchTimeout(url, { headers: cab }, 20000);
          const j = await r.json();
          if (!r.ok) throw new Error('Site não encontrado: ' + (j.error && j.error.message));
          siteId = j.id;
        }
      }
      if (!listaId) {
        listaId = C().listaId;
        if (!listaId) {
          const url = 'https://graph.microsoft.com/v1.0/sites/' + siteId +
                      "/lists?$filter=displayName eq '" +
                      C().nomeLista.replace(/'/g, "''") + "'";
          const r = await fetchTimeout(url, { headers: cab }, 20000);
          const j = await r.json();
          if (!r.ok || !j.value || !j.value.length) {
            throw new Error('Lista "' + C().nomeLista + '" não encontrada no site.');
          }
          listaId = j.value[0].id;
        }
      }
    }

    async function preparar() {
      if (!(await estaAutenticado())) throw new Error('SEM_LOGIN');
      await resolverIds();
    }

    /** Cria o item na Lista e anexa as fotos. */
    async function enviar(reg, fotos) {
      await preparar();
      const col = C().colunas;
      const campos = {};
      campos[col.dataInspecao]    = reg.dataInspecao;           // coluna Data
      campos[col.responsavel]     = reg.responsavel;
      campos[col.lote]            = reg.lote;
      campos[col.canteiro]        = DB.nomeCanteiro(reg);
      campos[col.empresa]         = DB.nomeEmpresa(reg);
      campos[col.inspecionado]    = DB.itensInspecionados(reg).join('; ');
      campos[col.naoConformidade] = reg.naoConformidade;        // texto "Sim"/"Não"
      campos[col.quais]           = reg.quais || '';
      campos[col.observacoes]     = reg.observacoes || '';
      campos[col.latitude]        = reg.latitude === null ? '' : String(reg.latitude);
      campos[col.longitude]       = reg.longitude === null ? '' : String(reg.longitude);
      campos[col.idLocal]         = reg.id;
      campos[col.dataCriacao]     = reg.criadoEm;

      const token = await obterToken('graph');
      const base = 'https://graph.microsoft.com/v1.0/sites/' + siteId + '/lists/' + listaId;

      let itemId = reg.remotoId;
      if (itemId) {
        // Reenvio de um registro já existente: atualiza (o local mais
        // recente prevalece, conforme regra de conflito).
        const r = await fetchTimeout(base + '/items/' + itemId + '/fields', {
          method: 'PATCH',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(campos)
        }, 30000);
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error('Graph PATCH ' + r.status + ': ' + ((j.error && j.error.message) || ''));
        }
      } else {
        const r = await fetchTimeout(base + '/items', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: campos })
        }, 30000);
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error('Graph POST ' + r.status + ': ' + ((j.error && j.error.message) || ''));
        }
        itemId = j.id;
      }

      // ---- Anexos (API REST do SharePoint) ------------------------
      if (fotos && fotos.length) {
        const tokenSp = await obterToken('sharepoint');
        const raiz = 'https://' + C().hostname + C().caminhoSite;
        for (const f of fotos) {
          if (f.enviada) continue;
          const nome = 'foto_' + f.ordem + '_' + f.id.slice(0, 8) + '.jpg';
          const url = raiz + "/_api/web/lists/getbytitle('" +
                      encodeURIComponent(C().nomeLista) + "')/items(" + itemId +
                      ")/AttachmentFiles/add(FileName='" + nome + "')";
          const buf = await f.blob.arrayBuffer();
          const r = await fetchTimeout(url, {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + tokenSp,
              Accept: 'application/json;odata=verbose',
              'Content-Type': 'application/octet-stream'
            },
            body: buf
          }, 60000);
          if (!r.ok && r.status !== 409) { // 409 = anexo já existe
            const txt = await r.text().catch(() => '');
            throw new Error('Falha ao anexar ' + nome + ' (HTTP ' + r.status + '): ' + txt.slice(0, 180));
          }
        }
      }

      return { remotoId: String(itemId) };
    }

    /** Exclusão lógica no destino: remove o item da lista. */
    async function excluir(reg) {
      if (!reg.remotoId) return;
      await preparar();
      const token = await obterToken('graph');
      const url = 'https://graph.microsoft.com/v1.0/sites/' + siteId +
                  '/lists/' + listaId + '/items/' + reg.remotoId;
      const r = await fetchTimeout(url, {
        method: 'DELETE', headers: { Authorization: 'Bearer ' + token }
      }, 20000);
      if (!r.ok && r.status !== 404) throw new Error('Graph DELETE ' + r.status);
    }

    return {
      nome: 'SharePoint Online',
      precisaLogin: true,
      login: login,
      sair: sair,
      estaAutenticado: estaAutenticado,
      tratarRetornoLogin: tratarRetornoLogin,
      preparar: preparar,
      enviar: enviar,
      excluir: excluir
    };
  })();

  /* ===================================================================
   * ADAPTADOR 2 — SUPABASE (PostgreSQL + Storage)
   * -------------------------------------------------------------------
   * Usa a API REST (PostgREST) e a API de Storage diretamente, sem SDK.
   * O script SQL da tabela, do bucket e das políticas de RLS está em
   * backend/supabase.sql.
   * =================================================================== */
  const AdaptadorSupabase = (function () {
    const C = () => CONFIG.sync.supabase;

    function cabecalhos(extra) {
      return Object.assign({
        apikey: C().anonKey,
        Authorization: 'Bearer ' + C().anonKey
      }, extra || {});
    }

    async function preparar() {
      if (!C().url || C().url.indexOf('SEUPROJETO') !== -1) {
        throw new Error('Supabase não configurado em config.js.');
      }
    }

    async function enviar(reg, fotos) {
      await preparar();

      // 1) Envia as fotos para o Storage e monta a lista de caminhos
      const caminhos = [];
      for (const f of fotos) {
        const caminho = reg.id + '/' + f.ordem + '_' + f.id.slice(0, 8) + '.jpg';
        const url = C().url + '/storage/v1/object/' + C().bucket + '/' + caminho;
        const r = await fetchTimeout(url, {
          method: 'POST',
          headers: cabecalhos({ 'Content-Type': 'image/jpeg', 'x-upsert': 'true' }),
          body: f.blob
        }, 60000);
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          throw new Error('Storage ' + r.status + ': ' + t.slice(0, 180));
        }
        caminhos.push({
          caminho: caminho,
          legenda: f.legenda || '',
          url_publica: C().url + '/storage/v1/object/public/' + C().bucket + '/' + caminho
        });
      }

      // 2) Grava/atualiza a linha da inspeção (upsert por id_local)
      const linha = {
        id_local: reg.id,
        data_inspecao: reg.dataInspecao,
        responsavel: reg.responsavel,
        lote: reg.lote,
        canteiro: DB.nomeCanteiro(reg),
        construtora: DB.nomeEmpresa(reg),
        o_que_inspecionado: DB.itensInspecionados(reg),
        nao_conformidade: reg.naoConformidade === 'Sim',
        quais: reg.quais || null,
        observacoes: reg.observacoes || null,
        latitude: reg.latitude,
        longitude: reg.longitude,
        dispositivo: reg.dispositivo,
        data_criacao: reg.criadoEm,
        data_edicao: reg.atualizadoEm,
        versao: reg.versao || 1,
        excluido: !!reg.excluido,
        fotos: caminhos
      };

      const url = C().url + '/rest/v1/' + C().tabela + '?on_conflict=id_local';
      const r = await fetchTimeout(url, {
        method: 'POST',
        headers: cabecalhos({
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=representation'
        }),
        body: JSON.stringify(linha)
      }, 30000);
      const txt = await r.text();
      if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + txt.slice(0, 200));
      let id = reg.id;
      try { const j = JSON.parse(txt); if (j && j[0] && j[0].id) id = String(j[0].id); } catch (e) {}
      return { remotoId: id };
    }

    async function excluir(reg) {
      await preparar();
      const url = C().url + '/rest/v1/' + C().tabela + '?id_local=eq.' + encodeURIComponent(reg.id);
      const r = await fetchTimeout(url, {
        method: 'PATCH',
        headers: cabecalhos({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ excluido: true, data_edicao: reg.atualizadoEm })
      }, 20000);
      if (!r.ok) throw new Error('Supabase DELETE ' + r.status);
    }

    return {
      nome: 'Supabase',
      precisaLogin: false,
      preparar: preparar,
      enviar: enviar,
      excluir: excluir
    };
  })();

  /* ===================================================================
   * ADAPTADOR 3 — GOOGLE SHEETS + DRIVE (Apps Script Web App)
   * -------------------------------------------------------------------
   * Envia um único JSON com as fotos em Base64. O Content-Type é
   * text/plain de propósito: evita o preflight CORS, que o Apps Script
   * não responde. O código do Web App está em backend/apps-script.gs.
   * =================================================================== */
  const AdaptadorGSheets = (function () {
    const C = () => CONFIG.sync.gsheets;

    async function preparar() {
      if (!C().urlWebApp || C().urlWebApp.indexOf('SEU_ID_DE_IMPLANTACAO') !== -1) {
        throw new Error('Web App do Apps Script não configurado em config.js.');
      }
    }

    async function postar(carga) {
      const r = await fetchTimeout(C().urlWebApp, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(carga),
        redirect: 'follow'
      }, 60000);
      const txt = await r.text();
      let j = null;
      try { j = JSON.parse(txt); } catch (e) {
        throw new Error('Resposta inesperada do Apps Script: ' + txt.slice(0, 160));
      }
      if (!r.ok || !j.ok) throw new Error('Apps Script: ' + (j.erro || r.status));
      return j;
    }

    async function enviar(reg, fotos) {
      await preparar();
      const anexos = [];
      for (const f of fotos) {
        anexos.push({
          nome: 'foto_' + f.ordem + '_' + f.id.slice(0, 8) + '.jpg',
          legenda: f.legenda || '',
          mime: 'image/jpeg',
          base64: await DB.blobParaBase64(f.blob)
        });
      }
      const j = await postar({
        token: C().token,
        acao: 'gravar',
        inspecao: {
          idLocal: reg.id,
          dataInspecao: reg.dataInspecao,
          responsavel: reg.responsavel,
          lote: reg.lote,
          canteiro: DB.nomeCanteiro(reg),
          construtora: DB.nomeEmpresa(reg),
          inspecionado: DB.itensInspecionados(reg).join('; '),
          naoConformidade: reg.naoConformidade,
          quais: reg.quais || '',
          observacoes: reg.observacoes || '',
          latitude: reg.latitude,
          longitude: reg.longitude,
          dispositivo: reg.dispositivo,
          dataCriacao: reg.criadoEm,
          dataEdicao: reg.atualizadoEm,
          versao: reg.versao || 1
        },
        fotos: anexos
      });
      return { remotoId: String(j.linha || reg.id) };
    }

    async function excluir(reg) {
      await preparar();
      await postar({ token: C().token, acao: 'excluir', idLocal: reg.id });
    }

    return {
      nome: 'Google Sheets + Drive',
      precisaLogin: false,
      preparar: preparar,
      enviar: enviar,
      excluir: excluir
    };
  })();

  /* ===================================================================
   * ADAPTADOR 0 — NENHUM (modo 100% local)
   * =================================================================== */
  const AdaptadorNenhum = {
    nome: 'Somente local (sem backend)',
    precisaLogin: false,
    async preparar() { throw new Error('SEM_BACKEND'); },
    async enviar() { throw new Error('SEM_BACKEND'); },
    async excluir() {}
  };

  const ADAPTADORES = {
    nenhum: AdaptadorNenhum,
    sharepoint: AdaptadorSharePoint,
    supabase: AdaptadorSupabase,
    gsheets: AdaptadorGSheets
  };

  /** Adaptador ativo conforme config.js. */
  function adaptador() {
    return ADAPTADORES[CONFIG.sync.backend] || AdaptadorNenhum;
  }

  /* ===================================================================
   * MOTOR DA FILA
   * =================================================================== */

  function aoMudar(fn) { ouvintes.push(fn); }
  function notificar(evento, dados) {
    ouvintes.forEach(fn => { try { fn(evento, dados); } catch (e) {} });
  }

  /**
   * Processa a fila inteira.
   * @param {boolean} manual - true quando disparada pelo botão do usuário
   *                           (nesse caso reprocessa também os 'erro'
   *                            que já esgotaram as tentativas).
   */
  async function sincronizar(manual) {
    if (emExecucao) return { pulado: true };
    const ad = adaptador();

    if (CONFIG.sync.backend === 'nenhum') {
      if (manual) {
        await DB.registrarLogSync({ tipo: 'aviso', mensagem:
          'Nenhum backend configurado (CONFIG.sync.backend = "nenhum"). ' +
          'Os registros permanecem no dispositivo; use a exportação CSV/JSON.' });
        notificar('log');
      }
      return { pulado: true, semBackend: true };
    }

    if (!(await online())) {
      if (manual) {
        await DB.registrarLogSync({ tipo: 'erro', mensagem: 'Sem conexão real com a rede.' });
        notificar('log');
      }
      return { pulado: true, offline: true };
    }

    emExecucao = true;
    notificar('inicio');
    const resumo = { enviados: 0, falhas: 0, total: 0, mensagens: [] };

    try {
      try {
        await ad.preparar();
      } catch (e) {
        if (String(e.message) === 'SEM_LOGIN') {
          await DB.registrarLogSync({ tipo: 'erro',
            mensagem: 'Autenticação necessária no ' + ad.nome + '. Toque em "Conectar" na tela de Sincronização.' });
          notificar('log');
          return { pulado: true, precisaLogin: true };
        }
        throw e;
      }

      let fila = await DB.listarPendentes();
      if (!manual) {
        // No automático, ignora os que já estouraram o limite de tentativas
        fila = fila.filter(r => (r.tentativas || 0) < CONFIG.sync.maxTentativas);
      }
      resumo.total = fila.length;

      for (const reg of fila) {
        try {
          if (reg.excluido) {
            if (reg.remotoId && ad.excluir) await ad.excluir(reg);
            await DB.marcarStatus(reg.id, 'sincronizado', '', reg.remotoId);
          } else {
            const fotos = await DB.listarFotos(reg.id);
            const r = await ad.enviar(reg, fotos);
            await DB.marcarStatus(reg.id, 'sincronizado', '', r && r.remotoId);
            await DB.auditar(reg.id, 'sync', 'Enviado para ' + ad.nome +
              (r && r.remotoId ? ' (ID remoto ' + r.remotoId + ')' : ''), reg.responsavel);
          }
          resumo.enviados++;
          notificar('progresso', { id: reg.id, ok: true });
        } catch (e) {
          const msg = (e && e.message) ? e.message : String(e);
          await DB.marcarStatus(reg.id, 'erro', msg);
          resumo.falhas++;
          resumo.mensagens.push(reg.id.slice(0, 8) + ': ' + msg);
          notificar('progresso', { id: reg.id, ok: false, erro: msg });
          // Erro de autenticação interrompe o lote (evita 20 falhas iguais)
          if (msg === 'SEM_LOGIN') break;
        }
      }

      await DB.registrarLogSync({
        tipo: resumo.falhas ? (resumo.enviados ? 'parcial' : 'erro') : 'ok',
        destino: ad.nome,
        origem: manual ? 'manual' : 'automática',
        mensagem: resumo.total === 0
          ? 'Nada pendente para enviar.'
          : resumo.enviados + ' de ' + resumo.total + ' registro(s) enviado(s)' +
            (resumo.falhas ? '; ' + resumo.falhas + ' falha(s).' : '.'),
        detalhe: resumo.mensagens.join(' | ')
      });
    } catch (e) {
      await DB.registrarLogSync({ tipo: 'erro', destino: ad.nome,
        mensagem: 'Falha geral: ' + ((e && e.message) || e) });
      resumo.erroGeral = (e && e.message) || String(e);
    } finally {
      emExecucao = false;
      notificar('fim', resumo);
    }
    return resumo;
  }

  /* ===================================================================
   * GATILHOS AUTOMÁTICOS
   * -------------------------------------------------------------------
   * 1) Evento 'online' do navegador
   * 2) Background Sync API (Chrome/Android) — sobrevive ao app fechado
   * 3) Polling periódico — obrigatório no iOS/Safari, que não implementa
   *    a Background Sync API
   * 4) Retorno do app ao primeiro plano (visibilitychange)
   * =================================================================== */

  async function pedirBackgroundSync() {
    if (!('serviceWorker' in navigator)) return false;
    try {
      const reg = await navigator.serviceWorker.ready;
      if ('sync' in reg) {
        await reg.sync.register('sincronizar-inspecoes');
        return true;
      }
    } catch (e) { /* iOS cai aqui: seguimos com o polling */ }
    return false;
  }

  function iniciarPolling() {
    if (timerPolling) clearInterval(timerPolling);
    timerPolling = setInterval(async () => {
      const pend = await DB.listarPendentes();
      if (pend.length && (await online())) sincronizar(false);
    }, CONFIG.sync.intervaloPollingMs);
  }

  /** Inicializa a camada de sincronização. Chamado uma vez pelo app.js. */
  async function iniciar() {
    // Retorno do login Microsoft (?code=...) — precisa rodar cedo
    if (CONFIG.sync.backend === 'sharepoint') {
      try { await AdaptadorSharePoint.tratarRetornoLogin(); }
      catch (e) {
        await DB.registrarLogSync({ tipo: 'erro', mensagem: e.message });
      }
    }

    window.addEventListener('online', async () => {
      notificar('rede', { online: true });
      if (!(await pedirBackgroundSync())) sincronizar(false);
      else sincronizar(false); // tenta também de imediato
    });
    window.addEventListener('offline', () => notificar('rede', { online: false }));

    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible') {
        const pend = await DB.listarPendentes();
        if (pend.length && (await online())) sincronizar(false);
      }
    });

    // O service worker avisa quando o Background Sync dispara
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (ev) => {
        if (ev.data && ev.data.tipo === 'sincronizar') sincronizar(false);
      });
    }

    iniciarPolling();

    // Primeira tentativa alguns segundos após abrir (dá tempo à rede)
    setTimeout(async () => {
      const pend = await DB.listarPendentes();
      if (pend.length && (await online())) sincronizar(false);
    }, 4000);
  }

  return {
    iniciar: iniciar,
    sincronizar: sincronizar,
    online: online,
    adaptador: adaptador,
    adaptadores: ADAPTADORES,
    pedirBackgroundSync: pedirBackgroundSync,
    aoMudar: aoMudar,
    fetchTimeout: fetchTimeout
  };
})();

window.SYNC = SYNC;
