/* =====================================================================
 * app.js — INTERFACE E REGRAS DE TELA
 * ---------------------------------------------------------------------
 * Orquestra as camadas: CONFIG (domínios), AUTH (acesso), DB
 * (persistência local), SYNC (envio), PAINEL (indicadores) e PDFGEN
 * (relatórios). Este arquivo não fala com a rede nem com o IndexedDB
 * diretamente.
 * ===================================================================== */

const APP = (function () {

  const estado = {
    tela: 'tela-login',
    registro: null,
    ehNovo: true,
    salvo: false,
    detalheId: null,
    listaHistorico: [],
    promptInstalacao: null,
    usuarios: [],
    baseAcessos: [],
    filtroLib: 'pendente',
    syncIniciado: false,
    sincronizando: false,
    ultimoResumo: null
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

  const TELAS_PUBLICAS = ['tela-login', 'tela-cadastro', 'tela-recuperar'];
  // Telas com o visual de acesso (foto de fundo, sem cabeçalho e sem barra inferior)
  const TELAS_VISUAL_ACESSO = TELAS_PUBLICAS.concat(['tela-boasvindas']);

  /* ===================================================================
   * UTILIDADES DE INTERFACE
   * =================================================================== */

  function aviso(mensagem, tipo, segundos) {
    const div = document.createElement('div');
    div.className = 'aviso ' + (tipo || '');
    div.innerHTML = '<span></span><button type="button" aria-label="Fechar">×</button>';
    div.querySelector('span').textContent = mensagem;
    div.querySelector('button').onclick = () => div.remove();
    $('#avisos').appendChild(div);
    if (segundos !== 0) setTimeout(() => div.remove(), (segundos || 6) * 1000);
  }

  function carregando(ligado, texto) {
    $('#txt-carregando').textContent = texto || 'Processando…';
    $('#carregando').hidden = !ligado;
  }

  function confirmar(titulo, texto, comCampo, rotuloOk) {
    return new Promise((resolve) => {
      $('#modal-titulo').textContent = titulo;
      $('#modal-texto').textContent = texto;
      $('#modal-campo').hidden = !comCampo;
      $('#modal-input').value = '';
      $('#modal-sim').textContent = rotuloOk || 'Confirmar';
      $('#modal').hidden = false;
      const fechar = (ok) => {
        $('#modal').hidden = true;
        $('#modal-sim').onclick = null;
        $('#modal-nao').onclick = null;
        resolve({ ok: ok, valor: $('#modal-input').value.trim() });
      };
      $('#modal-sim').onclick = () => fechar(true);
      $('#modal-nao').onclick = () => fechar(false);
    });
  }

  function mostrarTela(id) {
    // Nenhuma tela interna abre sem sessão válida.
    if (TELAS_PUBLICAS.indexOf(id) === -1 && !AUTH.autenticado()) id = 'tela-login';
    estado.tela = id;
    $$('.tela').forEach(t => { t.hidden = (t.id !== id); });
    $$('.nav-item').forEach(b => b.classList.toggle('ativa', b.dataset.ir === id));
    $('#navegacao').hidden = TELAS_VISUAL_ACESSO.indexOf(id) !== -1;
    document.body.classList.toggle('modo-publico', TELAS_VISUAL_ACESSO.indexOf(id) !== -1);
    window.scrollTo(0, 0);
    if (id === 'tela-historico') carregarHistorico();
    if (id === 'tela-sync') atualizarTelaSync();
    if (id === 'tela-painel') PAINEL.montar();
    if (id === 'tela-mais') montarTelaMais();
    if (id === 'tela-admin') carregarUsuarios();
    if (id === 'tela-cronograma' && window.CRONO) CRONO.montar();
  }

  function hojeISO() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  /* -----------------------------------------------------------------
   * ENTREGA DE ARQUIVOS (PDF, planilha, backup)
   * -----------------------------------------------------------------
   * No celular — principalmente com o app instalado na tela de início —
   * o sistema bloqueia download ou nova aba que não nasçam de um toque
   * do usuário, e o PDF leva alguns segundos para ficar pronto. Por isso,
   * no celular o arquivo é oferecido numa janela "Arquivo pronto": o
   * toque no botão é que dispara o compartilhamento (folha nativa com
   * Salvar em Arquivos, WhatsApp, e-mail, Drive…) ou o download.
   * No computador o download continua direto.
   * ----------------------------------------------------------------- */
  const UA = navigator.userAgent || '';
  const EH_IOS = /iPhone|iPad|iPod/i.test(UA) || (/Macintosh/i.test(UA) && navigator.maxTouchPoints > 1);
  const EH_ANDROID = /Android/i.test(UA);
  const EH_MOVEL = EH_IOS || EH_ANDROID;
  const EH_INSTALADO = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  function downloadDireto(blob, nome) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nome; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  function podeCompartilhar(arquivo) {
    try {
      return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [arquivo] }));
    } catch (e) { return false; }
  }

  function tamanhoLegivel(b) {
    return b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' KB'
                           : (b / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
  }

  /**
   * @returns Promise<{modo: 'download'|'compartilhado'|'baixado'|'aberto'|'fechado', nome}>
   */
  function entregarArquivo(blob, nome, tipo) {
    tipo = tipo || blob.type || 'application/octet-stream';
    if (!EH_MOVEL) {
      downloadDireto(blob, nome);
      return Promise.resolve({ modo: 'download', nome: nome });
    }

    carregando(false);   // tira o "Montando…" da frente da janela
    const arquivo = new File([blob], nome, { type: tipo, lastModified: Date.now() });
    const compartilha = podeCompartilhar(arquivo);
    const ehPdf = /pdf/i.test(tipo);

    const bt = {
      comp: $('#arq-compartilhar'), baixar: $('#arq-baixar'),
      abrir: $('#arq-abrir'), fechar: $('#arq-fechar')
    };
    $('#arq-titulo').textContent = ehPdf ? 'PDF pronto' : 'Arquivo pronto';
    $('#arq-nome').textContent = nome + '  ·  ' + tamanhoLegivel(blob.size);

    bt.comp.hidden = !compartilha;
    // No iPhone com o app instalado, "baixar" e "abrir" não funcionam:
    // o caminho é o compartilhamento (que tem "Salvar em Arquivos").
    bt.baixar.hidden = EH_IOS && EH_INSTALADO && compartilha;
    bt.abrir.hidden = !(ehPdf && !EH_IOS);          // Android: abre no leitor de PDF
    bt.baixar.classList.toggle('btn-primario', bt.comp.hidden);
    bt.baixar.classList.toggle('btn-secundario', !bt.comp.hidden);

    $('#arq-dica').textContent = compartilha
      ? (EH_IOS ? 'Toque em "Salvar / Compartilhar" e escolha "Salvar em Arquivos", WhatsApp ou e-mail.'
                : 'Compartilhe (WhatsApp, e-mail, Drive) ou baixe para a pasta Downloads.')
      : 'O arquivo vai para a pasta de downloads do aparelho.';

    return new Promise((resolve) => {
      const caixa = $('#modal-arquivo');
      let url = null;
      const fim = (modo) => {
        caixa.hidden = true;
        [bt.comp, bt.baixar, bt.abrir, bt.fechar].forEach(b => { b.onclick = null; });
        if (url) setTimeout(() => URL.revokeObjectURL(url), 120000);
        resolve({ modo: modo, nome: nome });
      };

      bt.comp.onclick = async () => {
        try {
          await navigator.share({ files: [arquivo], title: nome });
          fim('compartilhado');
        } catch (e) {
          if (e && e.name === 'AbortError') return;          // usuário fechou a folha: janela continua
          // Sem permissão para compartilhar: cai para o download
          downloadDireto(blob, nome);
          fim('baixado');
        }
      };
      bt.baixar.onclick = () => { downloadDireto(blob, nome); fim('baixado'); };
      bt.abrir.onclick = () => {
        url = url || URL.createObjectURL(blob);
        const w = window.open(url, '_blank');
        if (!w) { downloadDireto(blob, nome); fim('baixado'); return; }
        fim('aberto');
      };
      bt.fechar.onclick = () => fim('fechado');

      caixa.hidden = false;
      setTimeout(() => (bt.comp.hidden ? bt.baixar : bt.comp).focus(), 50);
    });
  }

  /** Mensagem de retorno padrão depois da entrega. */
  function avisoEntrega(r) {
    if (!r) return;
    const txt = {
      download: 'Arquivo gerado: ' + r.nome,
      compartilhado: 'Arquivo enviado/salvo: ' + r.nome,
      baixado: 'Arquivo baixado: ' + r.nome + ' (pasta Downloads).',
      aberto: 'PDF aberto: ' + r.nome
    }[r.modo];
    if (txt) aviso(txt, 'sucesso', 5);
  }

  function baixarTexto(nomeArquivo, conteudo, mime) {
    const blob = new Blob([conteudo], { type: mime + ';charset=utf-8' });
    return entregarArquivo(blob, nomeArquivo, mime);
  }

  function escapar(t) {
    return String(t === null || t === undefined ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function dataBR(iso) { return PDFGEN.dataBR(iso); }

  function preencherSelect(el, valores, textoVazio, valorAtual) {
    el.innerHTML = '';
    const op0 = document.createElement('option');
    op0.value = ''; op0.textContent = textoVazio;
    el.appendChild(op0);
    valores.forEach(v => {
      const o = document.createElement('option');
      o.value = (typeof v === 'string') ? v : v.valor;
      o.textContent = (typeof v === 'string') ? v : v.texto;
      el.appendChild(o);
    });
    if (valorAtual) el.value = valorAtual;
  }

  function marcarErro(idCampo, mensagem) {
    const campo = document.getElementById(idCampo);
    if (!campo) return;
    const cont = campo.closest('.campo') || campo.parentElement;
    if (mensagem) {
      cont.classList.add('invalido');
      const span = cont.querySelector('.erro');
      if (span) span.textContent = mensagem;
    } else {
      cont.classList.remove('invalido');
    }
  }

  function limparErros(seletor) {
    $$((seletor || '') + ' .campo').forEach(c => c.classList.remove('invalido'));
  }

  /* ===================================================================
   * INDICADOR DO CABEÇALHO
   * -------------------------------------------------------------------
   * Sem sincronização, o que interessa no alto da tela é quanto já foi
   * registrado neste aparelho.
   * =================================================================== */
  async function atualizarBadges() {
    if (!AUTH.autenticado()) { $('#txt-rede').textContent = '—'; return; }
    const lista = await DB.listarInspecoes({});
    const badge = $('#badge-rede');
    badge.classList.remove('offline', 'erro', 'online');

    if (SYNC.ativo()) {
      // Base central: o selo mostra a situação da fila de envio.
      const pend = await DB.listarPendentes();
      const comErro = pend.filter(r => r.status === 'erro').length;
      if (estado.sincronizando) {
        badge.classList.add('online');
        $('#txt-rede').textContent = 'Sincronizando…';
      } else if (!navigator.onLine) {
        badge.classList.add('offline');
        $('#txt-rede').textContent = pend.length ? 'Offline • ' + pend.length + ' na fila' : 'Offline';
      } else if (comErro) {
        badge.classList.add('erro');
        $('#txt-rede').textContent = comErro + ' com erro';
      } else if (pend.length) {
        badge.classList.add('offline');
        $('#txt-rede').textContent = pend.length + ' na fila';
      } else {
        badge.classList.add('online');
        $('#txt-rede').textContent = 'Sincronizado';
      }
    } else {
      badge.classList.add('online');
      $('#txt-rede').textContent = lista.length === 1 ? '1 inspeção' : lista.length + ' inspeções';
    }

    if ($('#n-total')) {
      let fotos = 0;
      for (const r of lista) fotos += await DB.contarFotos(r.id);
      $('#n-total').textContent = lista.length;
      $('#n-nc').textContent = lista.filter(r => r.naoConformidade === 'Sim').length;
      $('#n-fotos').textContent = fotos;
    }
  }

  async function verificarArmazenamento(silencioso) {
    const e = await DB.estimativaArmazenamento();
    const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
    const barra = $('#barra-uso');
    if (barra) {
      const pct = Math.min(100, Math.round(e.percentual));
      barra.style.width = (e.suportado ? Math.max(2, pct) : 2) + '%';
      barra.classList.toggle('cheio', pct >= CONFIG.limites.alertaArmazenamentoPct);
      $('#txt-armazenamento').textContent = e.suportado
        ? (mb(e.usado) + ' usados de ' + mb(e.cota) + ' disponíveis (' + pct + '%).')
        : ('Aproximadamente ' + mb(e.usado) + ' em fotos. Este navegador não informa a cota total (comum no iPhone).');
    }
    if (!silencioso && e.suportado && e.percentual >= CONFIG.limites.alertaArmazenamentoPct) {
      aviso('Atenção: o armazenamento do navegador está em ' + Math.round(e.percentual) +
            '%. Sincronize e exporte um backup antes de continuar registrando fotos.', 'alerta', 0);
    }
    return e;
  }

  /* ===================================================================
   * ACESSO — LOGIN, CADASTRO E RECUPERAÇÃO
   * =================================================================== */

  function alternarSenha(botao) {
    const alvo = document.getElementById(botao.dataset.alvo);
    if (!alvo) return;
    const mostrando = alvo.type === 'text';
    alvo.type = mostrando ? 'password' : 'text';
    botao.classList.toggle('visivel', !mostrando);
    botao.setAttribute('aria-label', mostrando ? 'Mostrar senha' : 'Ocultar senha');
  }

  function atualizarAvisosDeRede() {
    const off = !navigator.onLine;
    const local = AUTH.modoLocal();

    // No modo local nada depende de internet — nem cadastro, nem login.
    $('#aviso-offline-login').hidden = local || !off;
    $('#aviso-offline-recuperar').hidden = local || !off;
    $('#btn-recuperar').disabled = local ? false : off;
    $('#btn-cadastrar').disabled = local ? false : off;

    $('#aviso-modo-local').hidden = !local;
    $('#aviso-cadastro-local').hidden = !local;
    $('#aviso-recuperar-local').hidden = !local;
    $('#apoio-cadastro-rede').hidden = local;
    $('#apoio-cadastro-aprovacao').hidden = local;
    $('#apoio-admin').innerHTML = local
      ? 'Contas criadas neste aparelho: lotes de atuação, visão e situação. Não exige internet.'
      : 'Todo novo cadastro chega aqui <b>bloqueado</b>. Só o administrador libera o acesso, ' +
        'define os lotes e o que cada colaborador enxerga: <b>somente as próprias inspeções</b> ' +
        'ou <b>todas as inspeções dos seus lotes</b>.';
  }

  async function fazerLogin() {
    limparErros('#tela-login');
    const email = $('#login-email').value.trim();
    const senha = $('#login-senha').value;
    let erro = false;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { marcarErro('login-email', 'Informe um e-mail válido.'); erro = true; }
    if (!senha) { marcarErro('login-senha', 'Informe a senha.'); erro = true; }
    if (erro) return;

    carregando(true, navigator.onLine ? 'Entrando…' : 'Validando acesso offline…');
    try {
      await AUTH.entrarAuto(email, senha, $('#login-manter').checked);
      $('#login-senha').value = '';
      await aoAutenticar();
    } catch (e) {
      const msg = String(e.message || e);
      if (msg === 'PENDENTE') {
        aviso('Seu cadastro está aguardando a liberação do administrador. ' +
              'Você será liberado assim que ele aprovar o acesso.', 'alerta', 0);
      } else {
        aviso(msg, 'erro', 10);
      }
    } finally {
      carregando(false);
    }
  }

  function montarLotesCadastro() {
    const cont = $('#cad-lotes');
    cont.innerHTML = '';
    const itens = [{ valor: '__todos__', texto: 'Todos os lotes' }]
      .concat(CONFIG.listarLotes().map(l => ({ valor: l, texto: CONFIG.rotuloLote(l) })));

    itens.forEach((item, i) => {
      const lab = document.createElement('label');
      if (item.valor === '__todos__') lab.classList.add('destaque');
      lab.innerHTML = '<input type="checkbox" id="cad-lote-' + i + '" value="' +
                      escapar(item.valor) + '"><span>' + escapar(item.texto) + '</span>';
      const inp = lab.querySelector('input');
      inp.addEventListener('change', () => {
        lab.classList.toggle('marcado', inp.checked);
        if (item.valor === '__todos__') {
          // "Todos os lotes" marca (ou desmarca) os quatro de uma vez
          $$('#cad-lotes input').forEach(o => {
            if (o.value !== '__todos__') {
              o.checked = inp.checked;
              o.closest('label').classList.toggle('marcado', inp.checked);
            }
          });
        } else {
          const todosMarcados = $$('#cad-lotes input')
            .filter(o => o.value !== '__todos__').every(o => o.checked);
          const master = $('#cad-lotes input[value="__todos__"]');
          master.checked = todosMarcados;
          master.closest('label').classList.toggle('marcado', todosMarcados);
        }
      });
      cont.appendChild(lab);
    });
  }

  function lotesSelecionadosCadastro() {
    return $$('#cad-lotes input:checked')
      .map(i => i.value)
      .filter(v => v !== '__todos__');
  }

  async function fazerCadastro() {
    limparErros('#tela-cadastro');
    const funcaoSel = $('#cad-funcao').value;
    const dados = {
      nome: $('#cad-nome').value.trim().replace(/\s+/g, ' '),
      email: $('#cad-email').value.trim().toLowerCase(),
      funcao: funcaoSel === 'Outro' ? $('#cad-funcao-outro').value.trim() : funcaoSel,
      lotes: lotesSelecionadosCadastro(),
      senha: $('#cad-senha').value,
      confirmacao: $('#cad-senha2').value
    };

    let erro = false;
    if (dados.nome.length < 5) { marcarErro('cad-nome', 'Informe o nome completo.'); erro = true; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dados.email)) { marcarErro('cad-email', 'E-mail inválido.'); erro = true; }
    if (!funcaoSel) { marcarErro('cad-funcao', 'Selecione a função.'); erro = true; }
    if (funcaoSel === 'Outro' && !dados.funcao) { marcarErro('cad-funcao-outro', 'Informe a função.'); erro = true; }
    if (!dados.lotes.length) { marcarErro('cad-lotes', 'Selecione ao menos um lote.'); erro = true; }
    if (!AUTH.validarSenha(dados.senha)) {
      marcarErro('cad-senha', 'Mínimo de ' + CONFIG.auth.minimoSenha + ' caracteres, com letra e número.');
      erro = true;
    }
    if (dados.senha !== dados.confirmacao) { marcarErro('cad-senha2', 'A confirmação não confere.'); erro = true; }
    if (erro) { aviso('Corrija os campos destacados.', 'erro'); return; }

    carregando(true, 'Enviando cadastro…');
    try {
      const r = await AUTH.cadastrar(dados);
      $('#cad-senha').value = ''; $('#cad-senha2').value = '';

      if (r.entrou) {
        // Modo local: a conta já nasce ativa e a pessoa entra na hora.
        await aoAutenticar();
        aviso('Cadastro criado neste aparelho' +
              (r.admin ? ' com perfil de administrador' : '') +
              '. Você já pode registrar inspeções.', 'sucesso', 8);
        return;
      }

      mostrarTela('tela-login');
      $('#login-email').value = dados.email;
      aviso(r.precisaConfirmarEmail
        ? 'Cadastro enviado. Confirme o e-mail que você recebeu e aguarde a liberação do administrador.'
        : 'Cadastro enviado. Aguarde a liberação do administrador.', 'sucesso', 0);
    } catch (e) {
      const msg = String(e.message || e);
      aviso(msg === 'SEM_REDE'
        ? 'O cadastro exige internet. Conecte-se à rede e tente novamente.'
        : msg, 'erro', 10);
    } finally {
      carregando(false);
    }
  }

  async function fazerRecuperacao() {
    limparErros('#tela-recuperar');
    const email = $('#rec-email').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      marcarErro('rec-email', 'Informe um e-mail válido.');
      return;
    }
    carregando(true, 'Enviando…');
    try {
      await AUTH.recuperarSenha(email);
      mostrarTela('tela-login');
      aviso('Se o e-mail estiver cadastrado, o link de redefinição chegará em instantes.', 'sucesso', 10);
    } catch (e) {
      const msg = String(e.message || e);
      aviso(msg === 'MODO_LOCAL'
        ? 'Sem servidor configurado, a recuperação por e-mail não existe. A conta é deste ' +
          'aparelho: crie outra com um e-mail diferente, ou peça ao administrador do ' +
          'aparelho para reativar a sua.'
        : msg === 'SEM_REDE'
          ? 'Recuperação de senha exige internet. Conecte-se à rede e tente novamente.'
          : msg, 'erro', 12);
    } finally {
      carregando(false);
    }
  }

  /** Executado assim que existe sessão válida. */
  async function aoAutenticar() {
    const p = AUTH.perfil();
    $('#txt-responsavel').textContent = p ? p.nome : '—';
    $('#txt-funcao').textContent = p ? p.funcao : '';
    $('#cartao-admin-atalho').hidden = !AUTH.ehAdmin();
    $('#cartao-graf-responsavel').hidden = !AUTH.ehAdmin();
    await DB.solicitarPersistencia();
    await atualizarBadges();
    mostrarBoasVindas();
    if (SYNC.ativo() && !estado.syncIniciado) {
      estado.syncIniciado = true;
      SYNC.iniciar();
    }
  }

  /* ===================================================================
   * SINCRONIZAÇÃO — reflexo na tela
   * =================================================================== */
  function aoMudarSync(evento, resumo) {
    if (evento === 'inicio') { estado.sincronizando = true; atualizarBadges(); return; }
    if (evento === 'rede') { atualizarBadges(); return; }
    if (evento !== 'fim') return;
    estado.sincronizando = false;
    estado.ultimoResumo = resumo || null;
    if (resumo && resumo.bloqueado) {
      // Acesso suspenso/recusado pelo administrador durante o uso.
      AUTH.sair().then(() => {
        mostrarTela('tela-login');
        aviso('Seu acesso foi suspenso pelo administrador.', 'erro', 0);
      });
      return;
    }
    if (resumo && resumo.recebidas) {
      aviso(resumo.recebidas === 1 ? '1 inspeção atualizada da base central.'
                                   : resumo.recebidas + ' inspeções atualizadas da base central.', 'sucesso', 4);
      if (estado.tela === 'tela-historico') carregarHistorico();
      if (estado.tela === 'tela-painel') PAINEL.montar();
    }
    if (resumo && resumo.enviados && estado.tela === 'tela-historico') carregarHistorico();
    if (resumo && resumo.cronograma && estado.tela === 'tela-cronograma' &&
        (resumo.cronograma.recebidos || resumo.cronograma.semTabela)) CRONO.montar();
    atualizarBadges();
    if (estado.tela === 'tela-sync') atualizarTelaSync();
    verificarLiberacoes();
  }

  /** Dispara um ciclo logo após gravar (sem travar a tela). */
  function sincronizarEmSegundoPlano() {
    if (SYNC.ativo()) setTimeout(() => SYNC.sincronizar(false), 300);
  }

  async function sincronizarAgora() {
    if (!SYNC.ativo()) return;
    if (!navigator.onLine) { aviso('Sem internet. Os registros continuam na fila do aparelho.', 'alerta', 6); return; }
    carregando(true, 'Sincronizando com a base central…');
    try {
      const r = await SYNC.sincronizar(true);
      if (r.offline) aviso('A base central não respondeu. Tente de novo em instantes.', 'alerta', 6);
      else if (r.sessaoExpirada) aviso('Sessão expirada. Saia e entre novamente para sincronizar.', 'erro', 0);
      else if (r.erro) aviso('Falha na sincronização: ' + r.erro, 'erro', 10);
      else if (!r.pulado) aviso('Sincronizado: ' + (r.enviados || 0) + ' enviada(s), ' + (r.recebidas || 0) +
                                ' recebida(s)' + (r.falhas ? ', ' + r.falhas + ' com erro' : '') + '.',
                                r.falhas ? 'alerta' : 'sucesso', 6);
    } finally {
      carregando(false);
      atualizarTelaSync();
    }
  }

  /** Administrador: alerta de cadastros aguardando liberação. */
  async function verificarLiberacoes() {
    const caixa = $('#bv-liberacoes');
    const selo = $('#selo-pendentes-mais');
    if (!AUTH.autenticado() || !AUTH.ehAdmin()) { caixa.hidden = true; selo.hidden = true; return 0; }
    const n = await AUTH.admin.contarPendentes();
    caixa.hidden = !n;
    selo.hidden = !n;
    $('#bv-lib-qtd').textContent = n;
    $('#bv-lib-rotulo').textContent = n === 1 ? 'cadastro aguardando sua liberação'
                                              : 'cadastros aguardando sua liberação';
    selo.textContent = n + (n === 1 ? ' pendente' : ' pendentes');
    if (n && estado.pendentesAvisados !== n) {
      estado.pendentesAvisados = n;
      aviso(n === 1 ? 'Há 1 novo cadastro aguardando liberação de acesso.'
                    : 'Há ' + n + ' novos cadastros aguardando liberação de acesso.', 'alerta', 8);
    }
    return n;
  }

  /** Tela de boas-vindas: primeira tela após o login (e ao abrir o app já logado). */
  function mostrarBoasVindas() {
    const p = AUTH.perfil();
    const primeiro = p && p.nome ? String(p.nome).trim().split(/\s+/)[0] : '';
    $('#bv-nome').textContent = primeiro ? ', ' + primeiro : '';
    mostrarTela('tela-boasvindas');
    verificarLiberacoes();
  }

  async function sairDaConta() {
    const pend = await DB.listarPendentes();
    const texto = pend.length
      ? 'Você tem ' + pend.length + ' registro(s) ainda não enviado(s). Eles continuam ' +
        'guardados neste aparelho e voltam quando você entrar de novo com a mesma conta.'
      : 'Seus registros continuam guardados neste aparelho.';
    const c = await confirmar('Sair da conta?', texto, false, 'Sair');
    if (!c.ok) return;
    await AUTH.sair();
    $('#login-senha').value = '';
    mostrarTela('tela-login');
    aviso('Sessão encerrada.', 'sucesso', 4);
  }

  /* ===================================================================
   * FORMULÁRIO DE INSPEÇÃO
   * =================================================================== */

  /**
   * Monta os itens inspecionáveis. Item com lista em CONFIG.checklists
   * abre, ao ser marcado, as perguntas SIM / NÃO logo abaixo dele.
   * @param {string[]} marcados  - itens já marcados (edição)
   * @param {object}   respostas - { item: [{pergunta, resposta}] } (edição)
   */
  function montarChecklist(marcados, respostas) {
    const cont = $('#f-inspecionado');
    cont.innerHTML = '';
    respostas = respostas || {};
    CONFIG.itensInspecao.forEach((item, i) => {
      const bloco = document.createElement('div');
      bloco.className = 'item-insp';

      const lab = document.createElement('label');
      lab.innerHTML = '<input type="checkbox" id="chk-insp-' + i + '" value="' + escapar(item) +
                      '"><span>' + escapar(item) + '</span>';
      const inp = lab.querySelector('input');
      bloco.appendChild(lab);

      const perguntas = CONFIG.perguntasDoItem(item);
      let sub = null;
      if (perguntas.length) {
        lab.querySelector('span').insertAdjacentHTML('afterend',
          '<small class="cont-check" data-item="' + escapar(item) + '"></small>');
        sub = document.createElement('div');
        sub.className = 'sub-checklist';
        sub.dataset.item = item;
        sub.hidden = true;
        const anteriores = {};
        (respostas[item] || []).forEach(r => { anteriores[r.pergunta] = r.resposta; });
        perguntas.forEach((perg, k) => {
          const nome = 'ck-' + i + '-' + k;
          const resp = anteriores[perg] || '';
          const div = document.createElement('div');
          div.className = 'pergunta' + (resp === 'NÃO' ? ' resp-nao' : resp === 'SIM' ? ' resp-sim' : '');
          div.dataset.pergunta = perg;
          div.innerHTML =
            '<p><b>' + (k + 1) + '.</b> ' + escapar(perg) + '</p>' +
            '<div class="sim-nao">' +
              '<label class="bt-sim"><input type="radio" name="' + nome + '" value="SIM"' +
                (resp === 'SIM' ? ' checked' : '') + '><span>SIM</span></label>' +
              '<label class="bt-nao"><input type="radio" name="' + nome + '" value="NÃO"' +
                (resp === 'NÃO' ? ' checked' : '') + '><span>NÃO</span></label>' +
            '</div>';
          div.querySelectorAll('input').forEach(rd => rd.addEventListener('change', () => {
            div.classList.toggle('resp-sim', rd.value === 'SIM');
            div.classList.toggle('resp-nao', rd.value === 'NÃO');
            div.classList.remove('sem-resposta');
            atualizarContadorChecklist(item);
            sincronizarNCComChecklist();
          }));
          sub.appendChild(div);
        });
        bloco.appendChild(sub);
      }

      if (marcados && marcados.indexOf(item) !== -1) {
        inp.checked = true;
        lab.classList.add('marcado');
        if (sub) sub.hidden = false;
      }
      inp.addEventListener('change', () => {
        lab.classList.toggle('marcado', inp.checked);
        if (sub) {
          sub.hidden = !inp.checked;
          if (inp.checked) {
            sub.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          } else {
            // Desmarcou o item: descarta as respostas dele
            sub.querySelectorAll('input').forEach(r => { r.checked = false; });
            sub.querySelectorAll('.pergunta').forEach(p =>
              p.classList.remove('resp-sim', 'resp-nao', 'sem-resposta'));
          }
          atualizarContadorChecklist(item);
          sincronizarNCComChecklist();
        }
        if (item === CONFIG.itemOutro) {
          $('#campo-inspecionado-outro').hidden = !inp.checked;
          if (!inp.checked) $('#f-inspecionado-outro').value = '';
        }
      });
      cont.appendChild(bloco);
      if (sub) atualizarContadorChecklist(item);
    });
    $('#campo-inspecionado-outro').hidden =
      !(marcados && marcados.indexOf(CONFIG.itemOutro) !== -1);
    estado.textoAutoNC = textoNCChecklist();
  }

  function itensMarcados() {
    return $$('#f-inspecionado > .item-insp > label input:checked').map(i => i.value);
  }

  /** Respostas dos itens marcados: { item: [{pergunta, resposta}] }. */
  function respostasChecklist() {
    const marcados = itensMarcados();
    const saida = {};
    $$('#f-inspecionado .sub-checklist').forEach(sub => {
      const item = sub.dataset.item;
      if (marcados.indexOf(item) === -1) return;
      saida[item] = Array.from(sub.querySelectorAll('.pergunta')).map(p => {
        const r = p.querySelector('input:checked');
        return { pergunta: p.dataset.pergunta, resposta: r ? r.value : '' };
      });
    });
    return saida;
  }

  /** "x/y respondidas · n NÃO" ao lado do nome do item. */
  function atualizarContadorChecklist(item) {
    const sub = $$('#f-inspecionado .sub-checklist').filter(s => s.dataset.item === item)[0];
    const tag = $$('#f-inspecionado .cont-check').filter(s => s.dataset.item === item)[0];
    if (!sub || !tag) return;
    if (sub.hidden) { tag.textContent = ''; tag.className = 'cont-check'; return; }
    const total = Array.from(sub.querySelectorAll('.pergunta')).length;
    const resp = Array.from(sub.querySelectorAll('input:checked'));
    const nao = resp.filter(r => r.value === 'NÃO').length;
    tag.textContent = resp.length + '/' + total + ' respondidas' + (nao ? ' · ' + nao + ' NÃO' : '');
    tag.className = 'cont-check' + (nao ? ' tem-nao' : (resp.length === total ? ' completo' : ''));
  }

  /** Texto padrão do "Quais?" a partir das respostas NÃO. */
  function textoNCChecklist() {
    const r = respostasChecklist();
    const linhas = [];
    Object.keys(r).forEach(item => r[item].forEach(q => {
      if (q.resposta === 'NÃO') linhas.push('• ' + item + ' — ' + q.pergunta + ' NÃO');
    }));
    return linhas.join('\n');
  }

  /**
   * Resposta NÃO no checklist = não conformidade. Marca NC = Sim e mantém
   * o "Quais?" atualizado enquanto o inspetor não tiver escrito por conta
   * própria (o texto digitado por ele nunca é sobrescrito).
   */
  function sincronizarNCComChecklist() {
    const novo = textoNCChecklist();
    const campo = $('#f-quais');
    const atual = campo.value.trim();
    const anterior = (estado.textoAutoNC || '').trim();

    if (novo) {
      $$('input[name=nc]').forEach(r => { r.checked = (r.value === 'Sim'); });
      aplicarNC();
    }
    if (!atual || atual === anterior) {
      campo.value = novo;
      // A NC existia só por causa do checklist e não sobrou nenhum NÃO
      if (!novo && anterior) {
        $$('input[name=nc]').forEach(r => { r.checked = (r.value === 'Não'); });
        aplicarNC();
      }
    } else if (anterior && atual.indexOf(anterior) === 0) {
      // Texto automático no início + complemento do inspetor: troca só a parte automática
      campo.value = novo + atual.slice(anterior.length);
    }
    estado.textoAutoNC = novo;
  }

  /** Lotes do usuário — o campo trava quando há apenas um. */
  function montarLotes(valorAtual) {
    const permitidos = AUTH.lotes();
    const sel = $('#f-lote');
    preencherSelect(sel,
      permitidos.map(l => ({ valor: l, texto: CONFIG.rotuloLote(l) })),
      permitidos.length ? 'Selecione…' : 'Nenhum lote vinculado ao seu usuário',
      valorAtual || '');

    const apoio = $('#apoio-lote');
    if (permitidos.length === 1) {
      sel.value = permitidos[0];
      sel.disabled = true;
      apoio.hidden = false;
      apoio.textContent = 'Você está vinculado apenas ao lote ' + permitidos[0] + '.';
    } else {
      sel.disabled = false;
      apoio.hidden = permitidos.length > 0;
      if (!permitidos.length) {
        apoio.hidden = false;
        apoio.textContent = 'Seu usuário não tem lote liberado. Fale com o administrador.';
      }
    }
  }

  function aoMudarLote(canteiroAtual) {
    const lote = $('#f-lote').value;
    const canteiros = CONFIG.listarCanteiros(lote);
    const sel = $('#f-canteiro');
    sel.disabled = !lote;
    preencherSelect(sel, canteiros.concat(['Outro']),
      lote ? (canteiros.length ? 'Selecione…' : 'Nenhum cadastrado — use "Outro"')
           : 'Selecione o lote primeiro',
      canteiroAtual || '');
    aoMudarCanteiro();
  }

  function aoMudarCanteiro(empresaAtual) {
    const lote = $('#f-lote').value;
    const canteiro = $('#f-canteiro').value;
    $('#campo-canteiro-outro').hidden = (canteiro !== 'Outro');

    // Canteiro "Outro" oferece a lista mestra de construtoras; canteiro
    // cadastrado usa a empresa vinculada na tabela de domínio.
    const empresas = (canteiro === 'Outro')
      ? (CONFIG.empresas || []).slice()
      : (canteiro ? CONFIG.listarEmpresas(lote, canteiro) : []);

    const sel = $('#f-empresa');
    sel.disabled = !canteiro;
    preencherSelect(sel, empresas.concat(['Outro']),
      canteiro ? 'Selecione…' : 'Selecione o canteiro primeiro', empresaAtual || '');
    if (empresas.length === 1 && !empresaAtual) sel.value = empresas[0];
    $('#campo-empresa-outro').hidden = ($('#f-empresa').value !== 'Outro');
  }

  function aplicarNC() {
    const nc = $$('input[name=nc]').filter(r => r.checked)[0].value;
    $('.opcao-sim').classList.toggle('escolhida', nc === 'Sim');
    $('.opcao-nao').classList.toggle('escolhida', nc === 'Não');
    $('#campo-quais').hidden = (nc !== 'Sim');
    if (nc !== 'Sim') { $('#f-quais').value = ''; marcarErro('f-quais', null); }
  }

  function validar() {
    limparErros('#form-inspecao');
    const erros = [];

    const data = $('#f-data').value;
    if (!data) { marcarErro('f-data', 'Informe a data.'); erros.push('Data'); }
    else if (data > hojeISO()) { marcarErro('f-data', 'Não é permitida data futura.'); erros.push('Data futura'); }

    const lote = $('#f-lote').value;
    if (!lote) { marcarErro('f-lote', 'Selecione o lote.'); erros.push('Lote'); }
    else if (AUTH.lotes().indexOf(lote) === -1) {
      marcarErro('f-lote', 'Você não tem acesso a este lote.'); erros.push('Lote não autorizado');
    }

    if (!$('#f-canteiro').value) { marcarErro('f-canteiro', 'Selecione o canteiro.'); erros.push('Canteiro'); }
    if ($('#f-canteiro').value === 'Outro' && !$('#f-canteiro-outro').value.trim()) {
      marcarErro('f-canteiro-outro', 'Informe o nome do canteiro.'); erros.push('Canteiro (Outro)');
    }
    if (!$('#f-empresa').value) { marcarErro('f-empresa', 'Selecione a empresa.'); erros.push('Empresa'); }
    if ($('#f-empresa').value === 'Outro' && !$('#f-empresa-outro').value.trim()) {
      marcarErro('f-empresa-outro', 'Informe o nome da empresa.'); erros.push('Empresa (Outro)');
    }

    const itens = itensMarcados();
    if (!itens.length) { marcarErro('f-inspecionado', 'Marque ao menos um item.'); erros.push('O que foi inspecionado'); }
    if (itens.indexOf(CONFIG.itemOutro) !== -1 && !$('#f-inspecionado-outro').value.trim()) {
      marcarErro('f-inspecionado-outro', 'Descreva o item "' + CONFIG.itemOutro + '".');
      erros.push('Item ' + CONFIG.itemOutro);
    }

    // Checklist: toda pergunta do item marcado precisa de SIM ou NÃO
    let semResposta = 0, temNao = false;
    $$('#f-inspecionado .sub-checklist').forEach(sub => {
      if (sub.hidden) return;
      Array.from(sub.querySelectorAll('.pergunta')).forEach(p => {
        const r = p.querySelector('input:checked');
        if (!r) { semResposta++; p.classList.add('sem-resposta'); }
        else if (r.value === 'NÃO') temNao = true;
      });
    });
    if (semResposta) {
      marcarErro('f-inspecionado', 'Responda SIM ou NÃO em todas as perguntas (' +
        semResposta + ' sem resposta).');
      erros.push('Checklist (' + semResposta + ' pergunta(s) sem resposta)');
    }

    // REGRA CRÍTICA: NC = Sim exige a descrição em "Quais?"
    const nc = $$('input[name=nc]').filter(r => r.checked)[0].value;
    if (nc === 'Sim' && $('#f-quais').value.trim().length < 3) {
      marcarErro('f-quais', 'Obrigatório descrever a(s) não conformidade(s).');
      erros.push('Quais');
    }
    if (temNao && nc !== 'Sim') {
      marcarErro('f-quais', null);
      erros.push('Não conformidade deve ser "Sim" — há resposta NÃO no checklist');
    }
    return erros;
  }

  async function novaInspecao() {
    estado.registro = DB.novaInspecao();
    estado.ehNovo = true;
    estado.salvo = false;

    const p = AUTH.perfil();
    $('#titulo-form').textContent = 'Nova inspeção';
    $('#txt-responsavel').textContent = p ? p.nome : '—';
    $('#txt-funcao').textContent = p ? p.funcao : '';
    $('#f-data').value = estado.registro.dataInspecao;
    $('#f-data').max = hojeISO();

    montarLotes(estado.registro.lote);
    aoMudarLote();
    montarChecklist([]);
    $$('input[name=nc]').forEach(r => { r.checked = (r.value === 'Não'); });
    aplicarNC();
    ['#f-quais', '#f-observacoes', '#f-canteiro-outro', '#f-empresa-outro', '#f-inspecionado-outro']
      .forEach(s => { $(s).value = ''; });
    $('#txt-geo').textContent = 'Capturando…';
    limparErros('#form-inspecao');
    await desenharFotos();
    mostrarTela('tela-nova');

    DB.obterGeolocalizacao().then(g => {
      if (!estado.registro) return;
      estado.registro.latitude = g.latitude;
      estado.registro.longitude = g.longitude;
      estado.registro.precisaoGps = g.precisao;
      estado.registro.obsGeo = g.obs;
      mostrarGeo();
    });
  }

  function mostrarGeo() {
    const r = estado.registro;
    if (!r) return;
    $('#txt-geo').textContent = (r.latitude !== null)
      ? ('Lat ' + r.latitude + ' / Long ' + r.longitude +
         (r.precisaoGps ? ' (±' + r.precisaoGps + ' m)' : ''))
      : (r.obsGeo || 'Não capturada.');
  }

  async function editarInspecao(id) {
    const reg = await DB.obterInspecao(id);
    if (!reg) { aviso('Registro não encontrado ou de outro usuário.', 'erro'); return; }
    if (!DB.ehMeu(reg)) { aviso('Somente quem realizou a inspeção pode editá-la.', 'alerta', 6); return; }
    estado.registro = reg;
    estado.ehNovo = false;
    estado.salvo = false;

    const p = AUTH.perfil();
    $('#titulo-form').textContent = 'Editar inspeção';
    $('#txt-responsavel').textContent = reg.responsavel || (p ? p.nome : '—');
    $('#txt-funcao').textContent = reg.funcaoResponsavel || (p ? p.funcao : '');
    $('#f-data').max = hojeISO();
    $('#f-data').value = reg.dataInspecao;

    montarLotes(reg.lote);
    aoMudarLote(reg.canteiro);
    aoMudarCanteiro(reg.empresa);
    $('#f-canteiro-outro').value = reg.canteiroOutro || '';
    $('#f-empresa-outro').value = reg.empresaOutro || '';
    $('#campo-canteiro-outro').hidden = (reg.canteiro !== 'Outro');
    $('#campo-empresa-outro').hidden = (reg.empresa !== 'Outro');
    montarChecklist(reg.inspecionado || [], reg.checklist || {});
    $('#f-inspecionado-outro').value = reg.inspecionadoOutro || '';
    $$('input[name=nc]').forEach(r => { r.checked = (r.value === reg.naoConformidade); });
    aplicarNC();
    $('#f-quais').value = reg.quais || '';
    $('#f-observacoes').value = reg.observacoes || '';
    mostrarGeo();
    limparErros('#form-inspecao');
    await desenharFotos();
    mostrarTela('tela-nova');
  }

  async function salvarFormulario(ev) {
    if (ev) ev.preventDefault();
    const erros = validar();
    if (erros.length) {
      aviso('Não foi possível salvar. Corrija: ' + erros.join(', ') + '.', 'erro', 8);
      const primeiro = $('#form-inspecao .campo.invalido');
      if (primeiro) primeiro.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    const p = AUTH.perfil();
    const r = estado.registro;
    r.dataInspecao = $('#f-data').value;
    r.responsavel = r.responsavel || (p ? p.nome : '');
    r.funcaoResponsavel = r.funcaoResponsavel || (p ? p.funcao : '');
    r.emailResponsavel = r.emailResponsavel || (p ? p.email : '');
    r.lote = $('#f-lote').value;
    r.canteiro = $('#f-canteiro').value;
    r.canteiroOutro = $('#f-canteiro-outro').value.trim();
    r.empresa = $('#f-empresa').value;
    r.empresaOutro = $('#f-empresa-outro').value.trim();
    r.inspecionado = itensMarcados();
    r.inspecionadoOutro = $('#f-inspecionado-outro').value.trim();
    r.checklist = respostasChecklist();
    r.naoConformidade = $$('input[name=nc]').filter(x => x.checked)[0].value;
    r.quais = $('#f-quais').value.trim();
    r.observacoes = $('#f-observacoes').value.trim();

    carregando(true, 'Gravando no aparelho…');
    try {
      await DB.salvarInspecao(r);
      estado.salvo = true;
      const programada = window.CRONO ? await CRONO.aoSalvarInspecao(r) : null;
      const nFotos = await DB.contarFotos(r.id);
      aviso('Inspeção salva no aparelho' + (nFotos ? ' com ' + nFotos + ' foto(s)' : '') +
            (SYNC.ativo() ? (navigator.onLine ? ' e enviada para a base central.' : '. Será enviada quando houver internet.') : '.'),
            'sucesso');
      if (programada) {
        aviso('Cronograma: check automático em ' + programada.canteiro + ' (programado de ' +
              dataBR(programada.inicio) + ' a ' + dataBR(programada.fim) + ').', 'sucesso', 6);
      }
      sincronizarEmSegundoPlano();
      await atualizarBadges();
      await verificarArmazenamento(false);
      await novaInspecao();
    } catch (e) {
      aviso('Falha ao gravar: ' + (e.message || e), 'erro', 0);
    } finally {
      carregando(false);
    }
  }

  async function cancelarFormulario() {
    const c = await confirmar('Descartar?',
      'As informações preenchidas nesta tela serão perdidas.', false, 'Descartar');
    if (!c.ok) return;
    if (estado.ehNovo && !estado.salvo && estado.registro) {
      await DB.removerFotosDaInspecao(estado.registro.id);
    }
    if (estado.ehNovo) await novaInspecao();
    else mostrarTela('tela-historico');
  }

  /* ---------------------------------------------------------------
   * Fotos
   * ------------------------------------------------------------- */
  async function adicionarArquivos(lista) {
    if (!lista || !lista.length) return;
    const arquivos = Array.prototype.slice.call(lista);
    carregando(true, 'Otimizando ' + arquivos.length + ' foto(s)…');
    let ok = 0, falhas = 0;
    for (const arq of arquivos) {
      try {
        if (!/^image\//.test(arq.type)) { falhas++; continue; }
        await DB.adicionarFoto(estado.registro.id, arq, '');
        ok++;
      } catch (e) {
        falhas++;
        aviso(e.message || 'Falha ao processar a foto.', 'erro');
        break;
      }
    }
    carregando(false);
    await desenharFotos();
    if (ok) aviso(ok + ' foto(s) adicionada(s).', 'sucesso', 3);
    if (falhas && !ok) aviso('Nenhuma foto pôde ser adicionada.', 'erro');
    verificarArmazenamento(false);
  }

  async function desenharFotos() {
    const cont = $('#grade-fotos');
    cont.innerHTML = '';
    if (!estado.registro) return;
    const fotos = await DB.listarFotos(estado.registro.id);
    $('#contador-fotos').textContent = '(' + fotos.length + '/' + CONFIG.limites.maxFotos + ')';

    for (const f of fotos) {
      const div = document.createElement('div');
      div.className = 'foto-item';
      const url = URL.createObjectURL(f.blob);
      div.innerHTML =
        '<img src="' + url + '" alt="Foto ' + f.ordem + '">' +
        '<div class="foto-acoes">' +
          '<input type="text" placeholder="Legenda" value="' + escapar(f.legenda) + '">' +
          '<button type="button" class="btn-remover" aria-label="Excluir foto">✕</button>' +
        '</div>' +
        '<div class="apoio pequena" style="padding:0 8px 8px">' +
          f.largura + '×' + f.altura + ' • ' + Math.round(f.bytes / 1024) + ' KB</div>';

      div.querySelector('img').onload = () => URL.revokeObjectURL(url);
      div.querySelector('input').addEventListener('change', (e) => {
        DB.atualizarLegenda(f.id, e.target.value.trim());
      });
      div.querySelector('.btn-remover').addEventListener('click', async () => {
        const c = await confirmar('Excluir foto?', 'A foto ' + f.ordem + ' será removida deste registro.', false, 'Excluir');
        if (!c.ok) return;
        await DB.removerFoto(f.id);
        await desenharFotos();
      });
      cont.appendChild(div);
    }
  }

  /* ===================================================================
   * HISTÓRICO
   * =================================================================== */

  function filtrosAtuais() {
    return {
      de: $('#h-de').value || null,
      ate: $('#h-ate').value || null,
      lote: $('#h-lote').value || null,
      canteiro: $('#h-canteiro').value || null,
      empresa: $('#h-empresa').value || null,
      naoConformidade: $('#h-nc').value || null,
      texto: $('#h-texto').value || null,
      incluirExcluidos: $('#h-excluidos').checked
    };
  }

  function descreverFiltros(f) {
    const p = [];
    if (f.de || f.ate) p.push('Período ' + (f.de ? dataBR(f.de) : 'início') + ' a ' + (f.ate ? dataBR(f.ate) : 'hoje'));
    if (f.lote) p.push('Lote ' + f.lote);
    if (f.canteiro) p.push('Canteiro ' + f.canteiro);
    if (f.empresa) p.push('Empresa ' + f.empresa);
    if (f.naoConformidade) p.push('NC = ' + f.naoConformidade);
    if (f.texto) p.push('Busca "' + f.texto + '"');
    return p.length ? p.join(' | ') : 'Todos os registros';
  }

  async function popularFiltros() {
    const todos = await DB.listarInspecoes({ incluirExcluidos: true });
    const lotes = AUTH.lotes();
    const canteiros = Array.from(new Set(todos.map(DB.nomeCanteiro).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const empresas = Array.from(new Set(todos.map(DB.nomeEmpresa).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));

    const vL = $('#h-lote').value, vC = $('#h-canteiro').value, vE = $('#h-empresa').value;
    preencherSelect($('#h-lote'), lotes, 'Todos', vL);
    preencherSelect($('#h-canteiro'), canteiros, 'Todos', vC);
    preencherSelect($('#h-empresa'), empresas, 'Todas', vE);
  }

  async function carregarHistorico() {
    await popularFiltros();
    const f = filtrosAtuais();
    const lista = await DB.listarInspecoes(f);
    estado.listaHistorico = lista;

    const comNC = lista.filter(r => r.naoConformidade === 'Sim').length;
    $('#h-resumo').textContent = lista.length + ' registro(s) • ' + comNC + ' com NC';

    const cont = $('#lista-historico');
    cont.innerHTML = '';
    if (!lista.length) {
      cont.innerHTML = '<div class="vazio">Nenhuma inspeção encontrada com os filtros atuais.</div>';
      return;
    }

    for (const r of lista) {
      const qtd = await DB.contarFotos(r.id);
      const meu = DB.ehMeu(r);
      const div = document.createElement('div');
      div.className = 'item' + (r.naoConformidade === 'Sim' ? ' com-nc' : '') + (r.excluido ? ' excluido' : '');
      div.innerHTML =
        '<div class="topo">' +
          '<span class="data">' + dataBR(r.dataInspecao) + ' • ' + escapar(r.lote) + '</span>' +
          (meu ? (SYNC.ativo() && r.status !== 'sincronizado'
                  ? '<span class="selo selo-cinza">' + (r.status === 'erro' ? 'ERRO NO ENVIO' : 'NA FILA') + '</span>' : '')
               : '<span class="selo selo-recebida">' + escapar(r.responsavel || 'Equipe') + '</span>') +
        '</div>' +
        '<div class="linha2"><b>' + escapar(DB.nomeCanteiro(r)) + '</b> — ' + escapar(DB.nomeEmpresa(r)) + '</div>' +
        '<div class="linha3">' + escapar(DB.itensInspecionados(r).join(', ')) +
          ' • ' + qtd + ' foto(s) • ' + escapar(r.responsavel) + '</div>' +
        '<div class="linha3">' +
          (r.naoConformidade === 'Sim'
            ? '<span class="selo selo-nc">NÃO CONFORMIDADE</span> ' + escapar((r.quais || '').slice(0, 90))
            : '<span class="selo selo-ok">Sem NC</span>') +
          (r.excluido ? ' <span class="selo selo-nc">EXCLUÍDO</span>' : '') +
        '</div>' +
        '<div class="acoes-item">' +
          '<button type="button" class="btn btn-secundario" data-acao="ver">Ver</button>' +
          (meu ? '<button type="button" class="btn btn-neutro" data-acao="editar">Editar</button>' : '') +
          '<button type="button" class="btn btn-neutro" data-acao="pdf">PDF</button>' +
          (!meu ? '' : r.excluido
            ? '<button type="button" class="btn btn-neutro" data-acao="restaurar">Restaurar</button>'
            : '<button type="button" class="btn btn-neutro" data-acao="excluir">Excluir</button>') +
        '</div>';

      div.addEventListener('click', async (ev) => {
        const acao = ev.target && ev.target.dataset ? ev.target.dataset.acao : null;
        if (!acao) { abrirDetalhe(r.id); return; }
        ev.stopPropagation();
        if (acao === 'ver') abrirDetalhe(r.id);
        if (acao === 'editar') editarInspecao(r.id);
        if (acao === 'pdf') gerarPdfIndividual(r.id);
        if (acao === 'excluir') excluirRegistro(r.id);
        if (acao === 'restaurar') {
          const p = AUTH.perfil();
          await DB.restaurarInspecao(r.id, p ? p.nome : '');
          aviso('Registro restaurado.', 'sucesso', 3);
          sincronizarEmSegundoPlano();
          carregarHistorico();
        }
      });
      cont.appendChild(div);
    }
  }

  async function excluirRegistro(id) {
    const alvo = await DB.obterInspecao(id);
    if (!alvo || !DB.ehMeu(alvo)) { aviso('Somente quem realizou a inspeção pode excluí-la.', 'alerta', 6); return; }
    const c = await confirmar('Excluir inspeção?',
      'A exclusão é lógica: o registro sai da lista, mas continua guardado com a trilha ' +
      'de auditoria e sai no backup.', true, 'Excluir');
    if (!c.ok) return;
    const p = AUTH.perfil();
    await DB.excluirInspecao(id, c.valor, p ? p.nome : '');
    aviso('Registro excluído (exclusão lógica registrada).', 'sucesso', 4);
    sincronizarEmSegundoPlano();
    await atualizarBadges();
    if (estado.tela === 'tela-detalhe') mostrarTela('tela-historico');
    else carregarHistorico();
  }

  /* ===================================================================
   * DETALHE
   * =================================================================== */
  async function abrirDetalhe(id) {
    const r = await DB.obterInspecao(id);
    if (!r) { aviso('Registro não encontrado.', 'erro'); return; }
    estado.detalheId = id;
    await garantirFotos(r);
    const fotos = await DB.listarFotos(id);
    const meu = DB.ehMeu(r);
    $('#btn-editar-detalhe').hidden = !meu;
    $('#btn-excluir-detalhe').hidden = !meu || !!r.excluido;
    const auditoria = await DB.listarAuditoria(id);

    let html = '<h1>Inspeção de ' + dataBR(r.dataInspecao) + '</h1>';

    html += '<table class="tabela-detalhe"><tbody>';
    const linhas = [
      ['Data da inspeção', dataBR(r.dataInspecao)],
      ['Responsável', r.responsavel + (r.funcaoResponsavel ? ' (' + r.funcaoResponsavel + ')' : '')],
      ['Lote', CONFIG.rotuloLote(r.lote)],
      ['Canteiro', DB.nomeCanteiro(r)],
      ['Empresa (construtora)', DB.nomeEmpresa(r)],
      ['O que foi inspecionado', DB.itensInspecionados(r).join('; ')],
      ['Não conformidade', r.naoConformidade]
    ];
    if (r.naoConformidade === 'Sim') linhas.push(['Quais', r.quais]);
    linhas.push(['Observações', r.observacoes || '—']);
    linhas.push(['Coordenadas', (r.latitude !== null)
      ? (r.latitude + ', ' + r.longitude + (r.precisaoGps ? ' (±' + r.precisaoGps + ' m)' : ''))
      : (r.obsGeo || 'Não capturada')]);
    linhas.push(['Criado em', dataBR(r.criadoEm)]);
    linhas.push(['Última edição', dataBR(r.atualizadoEm) + ' (v' + (r.versao || 1) + ')']);
    linhas.push(['Dispositivo', r.dispositivo]);
    if (SYNC.ativo()) linhas.push(['Base central', r.status === 'sincronizado' ? 'Sincronizado'
      : r.status === 'erro' ? 'Erro no envio — ' + (r.erroMsg || '') : 'Na fila de envio']);
    linhas.push(['ID do registro', r.id]);
    if (r.excluido) linhas.push(['Excluído em', dataBR(r.excluidoEm) +
      (r.motivoExclusao ? ' — ' + r.motivoExclusao : '')]);

    linhas.forEach(l => {
      const destaque = (l[0] === 'Não conformidade' && l[1] === 'Sim') || l[0] === 'Quais';
      html += '<tr><th>' + escapar(l[0]) + '</th><td' + (destaque ? ' class="nc-sim"' : '') + '>' +
              escapar(l[1]) + '</td></tr>';
    });
    html += '</tbody></table>';

    // Checklist SIM / NÃO por item
    const ck = r.checklist || {};
    Object.keys(ck).forEach(item => {
      const lista = ck[item] || [];
      if (!lista.length) return;
      const nao = lista.filter(q => q.resposta === 'NÃO').length;
      html += '<h2 style="margin-top:18px">Checklist — ' + escapar(item) +
              ' <small class="apoio">(' + (lista.length - nao) + ' SIM · ' + nao + ' NÃO)</small></h2>';
      html += '<table class="tabela-detalhe tabela-checklist"><tbody>';
      lista.forEach((q, k) => {
        const cls = q.resposta === 'NÃO' ? 'resp-nao' : (q.resposta === 'SIM' ? 'resp-sim' : '');
        html += '<tr><th>' + (k + 1) + '. ' + escapar(q.pergunta) + '</th>' +
                '<td class="' + cls + '">' + escapar(q.resposta || '—') + '</td></tr>';
      });
      html += '</tbody></table>';
    });

    html += '<h2 style="margin-top:18px">Fotos (' + fotos.length + ')</h2>';
    if (!fotos.length) html += '<p class="apoio pequena">Nenhuma foto anexada.</p>';
    else {
      html += '<div class="galeria">';
      fotos.forEach(f => {
        const url = URL.createObjectURL(f.blob);
        html += '<figure><img src="' + url + '" alt="Foto ' + f.ordem + '">' +
                '<figcaption>Foto ' + f.ordem + (f.legenda ? ' — ' + escapar(f.legenda) : '') +
                '</figcaption></figure>';
      });
      html += '</div>';
    }

    html += '<h2 style="margin-top:18px">Auditoria</h2><div class="lista-log">';
    auditoria.forEach(a => {
      html += '<div class="log-item"><b>' + escapar(a.acao) + '</b> — ' + escapar(a.detalhe) +
              '<span class="quando">' + dataBR(a.em) + ' • ' + escapar(a.usuario) + '</span></div>';
    });
    html += '</div>';

    $('#detalhe-conteudo').innerHTML = html;
    mostrarTela('tela-detalhe');
  }

  /* ===================================================================
   * PDF
   * =================================================================== */
  async function gerarPdfIndividual(id) {
    carregando(true, 'Montando o PDF…');
    try {
      const reg = await DB.obterInspecao(id);
      if (reg) await garantirFotos(reg);
      const r = await PDFGEN.gerarIndividual(id);
      avisoEntrega(r);
    } catch (e) {
      aviso('Falha ao gerar o PDF: ' + (e.message || e), 'erro', 0);
    } finally {
      carregando(false);
    }
  }

  /** Inspeção recebida da base: baixa as fotos que ainda não estão no aparelho. */
  async function garantirFotos(reg) {
    if (!SYNC.ativo() || !reg || !Array.isArray(reg.fotosRemotas) || !reg.fotosRemotas.length) return;
    const temLocal = (await DB.listarFotos(reg.id)).length;
    if (temLocal >= reg.fotosRemotas.length || !navigator.onLine) return;
    try { await SYNC.baixarFotos(reg); } catch (e) { /* segue sem as fotos */ }
  }

  async function gerarPdfConsolidado() {
    const f = filtrosAtuais();
    const lista = estado.listaHistorico.length ? estado.listaHistorico : await DB.listarInspecoes(f);
    if (!lista.length) { aviso('Nenhuma inspeção no filtro atual.', 'alerta'); return; }
    carregando(true, 'Montando o consolidado (' + lista.length + ' inspeções)…');
    try {
      for (const reg of lista) await garantirFotos(reg);
      const r = await PDFGEN.gerarConsolidado(lista, descreverFiltros(f));
      avisoEntrega(r);
    } catch (e) {
      aviso('Falha ao gerar o PDF: ' + (e.message || e), 'erro', 0);
    } finally {
      carregando(false);
    }
  }

  /* ===================================================================
   * EXPORTAÇÃO
   * -------------------------------------------------------------------
   * O fluxo desta obra: cada inspetor guarda as próprias inspeções no
   * aparelho, emite os PDFs do dossiê e envia a planilha mensal.
   * =================================================================== */

  /** Intervalo escolhido na tela de exportação. */
  function periodoExportacao() {
    const hoje = new Date();
    const fim = hojeISO();
    const tipo = $('#exp-periodo').value;
    const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString().slice(0, 10);

    if (tipo === 'mes') return { de: fim.slice(0, 8) + '01', ate: fim, rotulo: 'mês atual' };
    if (tipo === 'anterior') {
      return { de: iso(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1)),
               ate: iso(new Date(hoje.getFullYear(), hoje.getMonth(), 0)),
               rotulo: 'mês anterior' };
    }
    if (tipo === 'ano') return { de: fim.slice(0, 4) + '-01-01', ate: fim, rotulo: 'ano corrente' };
    if (tipo === 'tudo') return { de: null, ate: null, rotulo: 'histórico completo' };
    return { de: $('#exp-de').value || null, ate: $('#exp-ate').value || null,
             rotulo: 'período personalizado' };
  }

  async function atualizarTelaSync() {
    await atualizarBadges();
    $('#exp-custom').hidden = ($('#exp-periodo').value !== 'custom');

    const p = periodoExportacao();
    const lista = await DB.listarInspecoes({ de: p.de, ate: p.ate });
    const nc = lista.filter(r => r.naoConformidade === 'Sim').length;
    $('#exp-resumo').textContent = lista.length
      ? (lista.length + ' inspeção(ões) no ' + p.rotulo +
         (p.de ? ' (' + dataBR(p.de) + ' a ' + dataBR(p.ate) + ')' : '') +
         ' • ' + nc + ' com não conformidade')
      : ('Nenhuma inspeção no ' + p.rotulo + '.');

    verificarArmazenamento(true);

    const base = SYNC.ativo();
    $('#cartao-base').hidden = !base;
    $('#apoio-exportar').textContent = base
      ? 'As inspeções ficam no aparelho e na base central. Use a planilha mensal para o consolidado e os PDFs para o dossiê.'
      : 'As inspeções ficam guardadas neste aparelho. Use a planilha mensal para enviar o consolidado e os PDFs para montar o dossiê.';
    if (base) {
      const pend = await DB.listarPendentes();
      const erros = pend.filter(r => r.status === 'erro');
      $('#n-fila').textContent = pend.length - erros.length;
      $('#n-erros').textContent = erros.length;
      const ult = await SYNC.ultimaSincronizacao();
      $('#n-ultima').textContent = ult ? new Date(ult).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—';
      const txt = $('#txt-sync-erro');
      const msg = erros.length ? erros[0].erroMsg : (estado.ultimoResumo && estado.ultimoResumo.erro) || '';
      txt.hidden = !msg;
      txt.textContent = msg ? 'Último erro: ' + msg : '';
    }
  }

  /** Planilha do período, em CSV pronto para o Excel. */
  async function exportarPlanilha() {
    const p = periodoExportacao();
    const lista = await DB.listarInspecoes({ de: p.de, ate: p.ate });
    if (!lista.length) { aviso('Nenhuma inspeção no período escolhido.', 'alerta', 6); return; }

    carregando(true, 'Montando a planilha…');
    try {
      const csv = await DB.exportarCSV({ de: p.de, ate: p.ate });
      const carimbo = p.de ? p.de.slice(0, 7).replace('-', '') : 'completo';
      const r = await baixarTexto('Inspecoes-Infra_' + carimbo + '.csv', csv, 'text/csv');
      if (r.modo !== 'fechado') aviso(lista.length + ' inspeção(ões) exportada(s) para a planilha.', 'sucesso', 5);
    } catch (e) {
      aviso('Falha ao exportar: ' + (e.message || e), 'erro', 0);
    } finally {
      carregando(false);
    }
  }

  /** PDF consolidado do mesmo período da planilha. */
  async function exportarPdfPeriodo() {
    const p = periodoExportacao();
    const lista = await DB.listarInspecoes({ de: p.de, ate: p.ate });
    if (!lista.length) { aviso('Nenhuma inspeção no período escolhido.', 'alerta', 6); return; }
    carregando(true, 'Montando o PDF (' + lista.length + ' inspeções)…');
    try {
      const desc = p.de ? ('Período: ' + dataBR(p.de) + ' a ' + dataBR(p.ate))
                        : 'Histórico completo';
      for (const reg of lista) await garantirFotos(reg);
      const r = await PDFGEN.gerarConsolidado(lista, desc);
      avisoEntrega(r);
    } catch (e) {
      aviso('Falha ao gerar o PDF: ' + (e.message || e), 'erro', 0);
    } finally {
      carregando(false);
    }
  }

  async function exportarBackupJSON() {
    carregando(true, 'Gerando o backup…');
    try {
      const carimbo = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const r = await baixarTexto('Inspecoes-Infra_backup_' + carimbo + '.json',
                  await DB.exportarJSON(true), 'application/json');
      if (r.modo !== 'fechado') aviso('Backup completo gerado (inclui as fotos).', 'sucesso', 5);
    } catch (e) {
      aviso('Falha ao exportar: ' + (e.message || e), 'erro', 0);
    } finally {
      carregando(false);
    }
  }

  /* ===================================================================
   * TELA "MAIS" — CONTA
   * =================================================================== */
  function montarTelaMais() {
    aplicarLogo();
    const p = AUTH.perfil();
    const est = AUTH.estado();
    $('#conta-nome').textContent = p ? p.nome : '—';
    $('#conta-email').textContent = p ? p.email : '—';
    $('#conta-funcao').textContent = p ? p.funcao : '—';
    $('#conta-lotes').textContent = est.lotes.length ? est.lotes.join(', ') : 'nenhum';
    $('#conta-perfil').textContent = est.ehAdmin ? 'Administrador (vê todas as inspeções e libera acessos)'
      : AUTH.veTodas() ? 'Visualiza todas as inspeções dos seus lotes'
      : 'Visualiza somente as próprias inspeções';
    $('#conta-sessao').textContent = AUTH.modoLocal() ? 'conta deste aparelho — não expira'
      : 'vale ' + CONFIG.auth.diasSessaoOffline + ' dias sem internet';
    verificarLiberacoes();
    $('#cartao-admin-atalho').hidden = !est.ehAdmin;
    $('#txt-sobre').textContent = CONFIG.app.nome + ' • versão ' + CONFIG.app.versao;
  }


  /* ===================================================================
   * LOGOTIPO DA EMPRESA
   * -------------------------------------------------------------------
   * A logo escolhida fica gravada no IndexedDB (chave 'logoEmpresa') e
   * é aplicada no cabeçalho, na tela de login e na faixa do PDF. Vale
   * para o aparelho; para valer no time todo, o cartão oferece o
   * download dos arquivos que devem ser publicados na pasta do app.
   * =================================================================== */
  const LOGO_CHAVE = 'logoEmpresa';
  const LOGO_PADRAO = 'assets/edp-logo-neg.png';

  /** Aplica na tela a logo gravada (ou a do pacote). */
  async function aplicarLogo() {
    // A logo oficial da EDP é fixa no pacote: não depende de envio no aparelho.
    $$('.cab-logo, .marca-login, #previa-logo, .fa-logo-img').forEach(img => { img.src = LOGO_PADRAO; });
    document.body.dataset.logo = 'oficial';
    return null;
  }

  /** Lê o arquivo escolhido, normaliza e grava. */
  async function enviarLogo(arquivo) {
    if (!arquivo) return;
    if (!/^image\//.test(arquivo.type)) {
      aviso('Escolha um arquivo de imagem (PNG de preferência).', 'erro');
      return;
    }
    carregando(true, 'Preparando o logotipo…');
    try {
      const img = await carregarImagem(arquivo);
      // Reduz o que for muito grande, sempre proporcionalmente — a
      // marca nunca é esticada nem recortada.
      const maxLargura = 900;
      const escala = img.naturalWidth > maxLargura ? maxLargura / img.naturalWidth : 1;
      const largura = Math.round(img.naturalWidth * escala);
      const altura = Math.round(img.naturalHeight * escala);

      const canvas = document.createElement('canvas');
      canvas.width = largura; canvas.height = altura;
      canvas.getContext('2d').drawImage(img, 0, 0, largura, altura);
      const dataUrl = canvas.toDataURL('image/png');   // PNG preserva a transparência

      await DB.kvSet(LOGO_CHAVE, {
        dataUrl: dataUrl,
        largura: largura,
        altura: altura,
        nome: arquivo.name,
        em: DB.agora()
      });
      PDFGEN.limparCacheLogo();
      await aplicarLogo();
      aviso('Logotipo aplicado neste aparelho. Ele já aparece no cabeçalho, no login e ' +
            'nos PDFs.', 'sucesso', 8);
    } catch (e) {
      aviso('Não foi possível ler a imagem: ' + (e.message || e), 'erro', 8);
    } finally {
      carregando(false);
    }
  }

  function carregarImagem(arquivo) {
    return new Promise((ok, erro) => {
      const url = URL.createObjectURL(arquivo);
      const img = new Image();
      img.onload = () => { ok(img); };
      img.onerror = () => erro(new Error('formato de imagem não reconhecido'));
      img.src = url;
    });
  }

  async function voltarLogoPadrao() {
    const c = await confirmar('Voltar ao logotipo padrão?',
      'A imagem enviada será descartada neste aparelho.', false, 'Voltar ao padrão');
    if (!c.ok) return;
    await DB.kvSet(LOGO_CHAVE, null);
    PDFGEN.limparCacheLogo();
    await aplicarLogo();
    $('#saida-identidade').innerHTML = '';
    aviso('Logotipo padrão restaurado.', 'sucesso', 4);
  }

  /** Ícone do PWA: a logo centralizada sobre o azul-marinho. */
  function gerarIconePWA(img, tamanho, maskable) {
    const c = document.createElement('canvas');
    c.width = c.height = tamanho;
    const ctx = c.getContext('2d');
    ctx.fillStyle = CONFIG.cores.azulMarinho;
    ctx.fillRect(0, 0, tamanho, tamanho);
    // Área de proteção da marca (maior no maskable, que sofre recorte)
    const respiro = maskable ? 0.30 : 0.18;
    const area = tamanho * (1 - respiro * 2);
    const escala = Math.min(area / img.naturalWidth, area / img.naturalHeight);
    const l = img.naturalWidth * escala, alt = img.naturalHeight * escala;
    ctx.drawImage(img, (tamanho - l) / 2, (tamanho - alt) / 2, l, alt);
    return c;
  }

  function linkArquivo(nome, destino, blob) {
    const url = URL.createObjectURL(blob);
    const div = document.createElement('div');
    div.className = 'arquivo-baixar';
    div.innerHTML = '<span><b>' + nome + '</b><span class="destino">pasta ' + destino +
                    '</span></span><a download="' + nome + '" href="' + url + '">Baixar</a>';
    $('#saida-identidade').appendChild(div);
  }

  /** Gera os seis arquivos que devem ser publicados na pasta do app. */
  async function baixarIdentidade() {
    const dados = await DB.kvGet(LOGO_CHAVE, null);
    if (!dados) {
      aviso('Escolha primeiro um arquivo de logotipo.', 'alerta', 6);
      return;
    }
    carregando(true, 'Gerando os arquivos…');
    try {
      const saida = $('#saida-identidade');
      saida.innerHTML = '';

      const img = await new Promise((ok, erro) => {
        const i = new Image();
        i.onload = () => ok(i);
        i.onerror = () => erro(new Error('falha ao reabrir a imagem'));
        i.src = dados.dataUrl;
      });

      // 1) a própria logo
      const cLogo = document.createElement('canvas');
      cLogo.width = img.naturalWidth; cLogo.height = img.naturalHeight;
      cLogo.getContext('2d').drawImage(img, 0, 0);
      await new Promise(ok => cLogo.toBlob(b => {
        linkArquivo('edp-logo-neg.png', 'assets/', b); ok();
      }, 'image/png'));

      // 2) o Base64 usado pelo PDF
      const js = '/* Gerado pelo próprio aplicativo em ' +
        new Date().toLocaleString('pt-BR') + ' */\n\n' +
        'const LOGO_EDP_INFO = { largura: ' + img.naturalWidth +
        ', altura: ' + img.naturalHeight + ', provisoria: false };\n\n' +
        "const LOGO_EDP_BASE64 = '" + dados.dataUrl + "';\n\n" +
        'window.LOGO_EDP_BASE64 = LOGO_EDP_BASE64;\n' +
        'window.LOGO_EDP_INFO = LOGO_EDP_INFO;\n';
      linkArquivo('logo-edp-base64.js', 'assets/',
                  new Blob([js], { type: 'text/javascript' }));

      // 3) ícones do PWA
      const icones = [['icon-192.png', 192, false], ['icon-512.png', 512, false],
                      ['icon-512-maskable.png', 512, true], ['apple-touch-icon.png', 180, false]];
      for (const item of icones) {
        const c = gerarIconePWA(img, item[1], item[2]);
        await new Promise(ok => c.toBlob(b => { linkArquivo(item[0], 'icons/', b); ok(); }, 'image/png'));
      }

      aviso('Arquivos prontos. Baixe todos, substitua nas pastas indicadas e suba a ' +
            'versão em service-worker.js e config.js.', 'sucesso', 12);
    } catch (e) {
      aviso('Falha ao gerar os arquivos: ' + (e.message || e), 'erro', 8);
    } finally {
      carregando(false);
    }
  }

  /* ===================================================================
   * ADMINISTRAÇÃO
   * =================================================================== */
  async function carregarUsuarios() {
    // Somente o administrador abre esta tela (o banco confirma pela RLS).
    if (!AUTH.ehAdmin()) {
      aviso('Área restrita ao administrador.', 'erro', 5);
      mostrarTela('tela-boasvindas');
      return;
    }
    const cont = $('#lista-usuarios');
    cont.innerHTML = '<div class="vazio">Carregando…</div>';
    try {
      const [lista, base] = await Promise.all([AUTH.admin.listar(), AUTH.admin.baseDeAcessos()]);
      estado.usuarios = lista;
      estado.baseAcessos = Array.isArray(base) ? base : [];
      desenharUsuarios(lista);
      verificarLiberacoes();
    } catch (e) {
      cont.innerHTML = '<div class="vazio">Não foi possível carregar a lista.<br>' +
                       escapar(e.message || e) +
                       (AUTH.modoLocal() ? '' : '<br><small>Esta tela precisa de internet.</small>') +
                       '</div>';
    }
  }

  function grupoStatus(st) {
    return st === 'pendente' ? 'pendente' : st === 'ativo' ? 'ativo' : 'bloqueado';
  }

  function desenharUsuarios(lista) {
    const cont = $('#lista-usuarios');
    cont.innerHTML = '';

    const pendentes = lista.filter(u => u.status === 'pendente').length;
    const ativos = lista.filter(u => u.status === 'ativo').length;
    const limite = Date.now() - 7 * 86400000;
    const aparelhos = lista.filter(u => u.ultimo_acesso && new Date(u.ultimo_acesso).getTime() >= limite).length;
    $('#ad-pendentes').textContent = pendentes;
    $('#ad-ativos').textContent = ativos;
    $('#ad-aparelhos').textContent = aparelhos;

    $$('[data-filtro-lib]').forEach(b => b.classList.toggle('ativa', b.dataset.filtroLib === estado.filtroLib));
    const filtrada = estado.filtroLib === 'todos' ? lista
      : lista.filter(u => grupoStatus(u.status) === estado.filtroLib);

    if (!filtrada.length) {
      cont.innerHTML = '<div class="vazio">' + (estado.filtroLib === 'pendente'
        ? 'Nenhum cadastro aguardando liberação.' : 'Nenhum usuário nesta situação.') + '</div>';
      return;
    }

    const ordenada = filtrada.slice().sort((a, b) => {
      const peso = s => (s === 'pendente' ? 0 : s === 'ativo' ? 1 : 2);
      return peso(a.status) - peso(b.status) ||
             String(a.nome).localeCompare(String(b.nome), 'pt-BR');
    });

    const eu = AUTH.usuarioId();

    ordenada.forEach(u => {
      const div = document.createElement('div');
      div.className = 'item usuario-item' + (u.status === 'pendente' ? ' pendente' : '');
      const seloStatus = u.status === 'ativo' ? 'selo-ok'
                       : u.status === 'pendente' ? 'selo-cinza' : 'selo-nc';
      const rotStatus = { ativo: 'LIBERADO', pendente: 'AGUARDANDO', recusado: 'RECUSADO', inativo: 'INATIVO' }[u.status] || String(u.status).toUpperCase();
      const ehEu = u.id === eu;
      const ehAdm = u.perfil === 'admin';

      // Base de acessos (planilha): sugere lotes e visão na liberação.
      const ref = estado.baseAcessos.find(b => String(b.email).toLowerCase() === String(u.email).toLowerCase());
      const lotesPadrao = u.status === 'pendente' && ref && (ref.lotes || []).length ? ref.lotes : (u.lotes || []);
      const visaoPadrao = u.status === 'pendente' && ref ? (ref.visao || 'proprias') : (u.visao || 'proprias');

      let quadroBase = '';
      if (u.status === 'pendente') {
        quadroBase = ref
          ? '<div class="lib-base">Consta na base de acessos como <b>' + escapar(ref.funcao || '—') + '</b> • lotes ' +
            escapar((ref.lotes || []).join(', ') || '—') + ' • ' +
            (ref.visao === 'todas' ? 'vê todas as inspeções' : 'vê só as próprias') + '. Já pré-preenchido abaixo.</div>'
          : '<div class="lib-base sem-base">Este e-mail <b>não consta</b> na base de acessos. Confira com quem é antes de liberar.</div>';
      }

      div.innerHTML =
        '<div class="topo">' +
          '<div><span class="data">' + escapar(u.nome) + '</span>' +
          (ehAdm ? ' <span class="selo selo-ok">ADMIN</span>' : '') +
          '<div class="email">' + escapar(u.email) + '</div></div>' +
          '<span class="selo ' + seloStatus + '">' + escapar(rotStatus) + '</span>' +
        '</div>' +
        '<div class="linha3">' + escapar(u.funcao || '—') +
          ' • cadastro: ' + (u.criado_em ? dataBR(u.criado_em) : '—') +
          ' • último acesso: ' + (u.ultimo_acesso ? dataBR(u.ultimo_acesso) : 'nunca') + '</div>' +
        quadroBase +
        (ehAdm
          ? '<div class="linha3">Administrador: vê todas as inspeções de todos os lotes e libera acessos.</div>'
          : '<div class="lib-grade">' +
              '<div><div class="rotulo">Lotes liberados</div><div class="lista-check" data-lotes></div></div>' +
              '<label><div class="rotulo">O que pode visualizar</div>' +
                '<select data-visao>' +
                  '<option value="proprias"' + (visaoPadrao !== 'todas' ? ' selected' : '') + '>Somente as próprias inspeções</option>' +
                  '<option value="todas"' + (visaoPadrao === 'todas' ? ' selected' : '') + '>Todas as inspeções dos seus lotes</option>' +
                '</select></label>' +
            '</div>') +
        '<div class="acoes-item">' +
          (u.status === 'pendente'
            ? '<button type="button" class="btn btn-primario" data-acao="aprovar">Liberar acesso</button>' +
              '<button type="button" class="btn btn-neutro" data-acao="recusar">Recusar</button>'
            : '') +
          (u.status === 'ativo' && !ehAdm
            ? '<button type="button" class="btn btn-secundario" data-acao="salvar-acesso">Salvar alterações</button>' +
              '<button type="button" class="btn btn-neutro" data-acao="desativar">Bloquear acesso</button>'
            : '') +
          ((u.status === 'inativo' || u.status === 'recusado') && !ehEu
            ? '<button type="button" class="btn btn-primario" data-acao="reativar">Liberar novamente</button>'
            : '') +
        '</div>';

      const cxLotes = div.querySelector('[data-lotes]');
      if (cxLotes) {
        CONFIG.listarLotes().forEach(l => {
          const lab = document.createElement('label');
          const marcado = lotesPadrao.indexOf(l) !== -1;
          lab.innerHTML = '<input type="checkbox" value="' + l + '"' + (marcado ? ' checked' : '') +
                          '><span>' + CONFIG.rotuloLote(l) + '</span>';
          if (marcado) lab.classList.add('marcado');
          lab.querySelector('input').addEventListener('change', (e) => {
            lab.classList.toggle('marcado', e.target.checked);
          });
          cxLotes.appendChild(lab);
        });
      }

      div.addEventListener('click', async (ev) => {
        const acao = ev.target && ev.target.dataset ? ev.target.dataset.acao : null;
        if (!acao) return;
        ev.stopPropagation();
        const lotes = cxLotes ? Array.prototype.slice.call(cxLotes.querySelectorAll('input:checked')).map(i => i.value) : [];
        const sel = div.querySelector('[data-visao]');
        await acaoAdmin(acao, u, lotes, sel ? sel.value : 'proprias');
      });

      cont.appendChild(div);
    });
  }

  async function acaoAdmin(acao, u, lotes, visao) {
    const descVisao = visao === 'todas' ? 'todas as inspeções dos lotes' : 'somente as próprias inspeções';
    const rotulos = {
      aprovar: 'Liberar o acesso de ' + u.nome + ' aos lotes ' + lotes.join(', ') + ', visualizando ' + descVisao + '?',
      recusar: 'Recusar o cadastro de ' + u.nome + '? A pessoa não conseguirá entrar no app.',
      desativar: 'Bloquear o acesso de ' + u.nome + '? Ele perde o acesso na próxima sincronização.',
      reativar: 'Liberar novamente o acesso de ' + u.nome + '?',
      'salvar-acesso': 'Salvar para ' + u.nome + ': lotes ' + lotes.join(', ') + ' e visão de ' + descVisao + '?'
    };
    if ((acao === 'aprovar' || acao === 'salvar-acesso') && u.perfil !== 'admin' && !lotes.length) {
      aviso('Marque ao menos um lote antes de liberar.', 'alerta', 8);
      return;
    }
    const c = await confirmar('Confirmar', rotulos[acao] || 'Confirmar ação?', false, 'Confirmar');
    if (!c.ok) return;

    carregando(true, 'Aplicando…');
    try {
      if (acao === 'aprovar') await AUTH.admin.aprovar(u.id, lotes, visao);
      if (acao === 'recusar') await AUTH.admin.recusar(u.id);
      if (acao === 'desativar') await AUTH.admin.desativar(u.id);
      if (acao === 'reativar') await AUTH.admin.aprovar(u.id, lotes, visao);
      if (acao === 'salvar-acesso') await AUTH.admin.definirAcesso(u.id, lotes, visao);
      aviso(acao === 'aprovar' ? 'Acesso liberado. ' + u.nome.split(' ')[0] + ' já pode entrar no app.'
                               : 'Alteração aplicada.', 'sucesso', 5);
      estado.pendentesAvisados = null;
      await carregarUsuarios();
    } catch (e) {
      aviso('Falha: ' + (e.message || e), 'erro', 10);
    } finally {
      carregando(false);
    }
  }

  /* ===================================================================
   * EVENTOS
   * =================================================================== */
  function ligarEventos() {
    $$('.nav-item').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.ir === 'tela-nova' && estado.tela !== 'tela-nova') novaInspecao();
      else mostrarTela(b.dataset.ir);
    }));
    $('#badge-rede').addEventListener('click', () => mostrarTela('tela-sync'));

    // Acesso
    $('#btn-login').addEventListener('click', fazerLogin);
    $('#login-senha').addEventListener('keydown', e => { if (e.key === 'Enter') fazerLogin(); });
    $('#link-cadastro').addEventListener('click', () => { mostrarTela('tela-cadastro'); atualizarAvisosDeRede(); });
    $('#btn-iniciar-inspecao').addEventListener('click', () => novaInspecao());
    $('#btn-bv-cronograma').addEventListener('click', () => mostrarTela('tela-cronograma'));
    $('#link-esqueci').addEventListener('click', () => { mostrarTela('tela-recuperar'); atualizarAvisosDeRede(); });
    $('#voltar-login-1').addEventListener('click', () => mostrarTela('tela-login'));
    $('#voltar-login-2').addEventListener('click', () => mostrarTela('tela-login'));
    $('#btn-cadastrar').addEventListener('click', fazerCadastro);
    $('#btn-recuperar').addEventListener('click', fazerRecuperacao);
    $('#btn-sair').addEventListener('click', sairDaConta);
    $('#btn-abrir-admin').addEventListener('click', () => mostrarTela('tela-admin'));
    $('#f-logo').addEventListener('change', e => { enviarLogo(e.target.files[0]); e.target.value = ''; });
    $('#btn-logo-padrao').addEventListener('click', voltarLogoPadrao);
    $('#btn-baixar-identidade').addEventListener('click', baixarIdentidade);
    $('#btn-recarregar-usuarios').addEventListener('click', carregarUsuarios);
    $('#btn-bv-liberacoes').addEventListener('click', () => { estado.filtroLib = 'pendente'; mostrarTela('tela-admin'); });
    $('#btn-sincronizar').addEventListener('click', sincronizarAgora);
    $$('[data-filtro-lib]').forEach(b => b.addEventListener('click', () => {
      estado.filtroLib = b.dataset.filtroLib;
      desenharUsuarios(estado.usuarios || []);
    }));
    $$('.btn-olho').forEach(b => b.addEventListener('click', () => alternarSenha(b)));
    $('#cad-funcao').addEventListener('change', () => {
      $('#campo-cad-funcao-outro').hidden = ($('#cad-funcao').value !== 'Outro');
    });

    // Abas do tutorial
    $$('.aba[data-so]').forEach(b => b.addEventListener('click', () => {
      $$('.aba[data-so]').forEach(x => x.classList.toggle('ativa', x === b));
      $$('.aba-conteudo').forEach(c => { c.hidden = (c.dataset.so !== b.dataset.so); });
    }));
    $$('.aba[data-so2]').forEach(b => b.addEventListener('click', () => {
      $$('.aba[data-so2]').forEach(x => x.classList.toggle('ativa', x === b));
      $$('.aba-conteudo2').forEach(c => { c.hidden = (c.dataset.so2 !== b.dataset.so2); });
    }));

    // Formulário
    $('#f-lote').addEventListener('change', () => aoMudarLote());
    $('#f-canteiro').addEventListener('change', () => aoMudarCanteiro());
    $('#f-empresa').addEventListener('change', () => {
      $('#campo-empresa-outro').hidden = ($('#f-empresa').value !== 'Outro');
    });
    $$('input[name=nc]').forEach(r => r.addEventListener('change', aplicarNC));
    $('#form-inspecao').addEventListener('submit', salvarFormulario);
    $('#btn-cancelar').addEventListener('click', cancelarFormulario);
    $('#f-camera').addEventListener('change', e => { adicionarArquivos(e.target.files); e.target.value = ''; });
    $('#f-galeria').addEventListener('change', e => { adicionarArquivos(e.target.files); e.target.value = ''; });
    $('#btn-geo').addEventListener('click', async () => {
      $('#txt-geo').textContent = 'Capturando…';
      const g = await DB.obterGeolocalizacao();
      Object.assign(estado.registro, {
        latitude: g.latitude, longitude: g.longitude, precisaoGps: g.precisao, obsGeo: g.obs
      });
      mostrarGeo();
    });

    // Histórico
    ['#h-de', '#h-ate', '#h-lote', '#h-canteiro', '#h-empresa', '#h-nc', '#h-excluidos']
      .forEach(s => $(s).addEventListener('change', carregarHistorico));
    let temporizador = null;
    $('#h-texto').addEventListener('input', () => {
      clearTimeout(temporizador);
      temporizador = setTimeout(carregarHistorico, 250);
    });
    $('#btn-limpar-filtros').addEventListener('click', () => {
      ['#h-de', '#h-ate', '#h-texto'].forEach(s => { $(s).value = ''; });
      ['#h-lote', '#h-canteiro', '#h-empresa', '#h-nc'].forEach(s => { $(s).value = ''; });
      $('#h-excluidos').checked = false;
      carregarHistorico();
    });
    $('#btn-pdf-consolidado').addEventListener('click', gerarPdfConsolidado);

    // Detalhe
    $('#btn-voltar-detalhe').addEventListener('click', () => mostrarTela('tela-historico'));
    $('#btn-editar-detalhe').addEventListener('click', () => editarInspecao(estado.detalheId));
    $('#btn-excluir-detalhe').addEventListener('click', () => excluirRegistro(estado.detalheId));
    $('#btn-pdf-detalhe').addEventListener('click', () => gerarPdfIndividual(estado.detalheId));

    // Exportação
    $('#exp-periodo').addEventListener('change', atualizarTelaSync);
    ['#exp-de', '#exp-ate'].forEach(s => $(s).addEventListener('change', atualizarTelaSync));
    $('#btn-exp-planilha').addEventListener('click', exportarPlanilha);
    $('#btn-exp-pdf').addEventListener('click', exportarPdfPeriodo);
    $('#btn-exp-json').addEventListener('click', exportarBackupJSON);
    $('#btn-limpar-base').addEventListener('click', async () => {
      const c = await confirmar('Apagar TODA a base local?',
        'Todos os registros e fotos deste aparelho serão apagados, inclusive os ainda não ' +
        'sincronizados. Digite APAGAR para confirmar.', true, 'Apagar tudo');
      if (!c.ok) return;
      if (c.valor.toUpperCase() !== 'APAGAR') { aviso('Confirmação incorreta. Nada foi apagado.', 'alerta'); return; }
      await DB.limparTudo();
      aviso('Base local apagada.', 'sucesso');
      await atualizarBadges();
      atualizarTelaSync();
    });

    // Rede
    window.addEventListener('online', () => {
      atualizarAvisosDeRede(); atualizarBadges();
      aviso('Conexão restabelecida. Sincronizando…', 'sucesso', 4);
    });
    window.addEventListener('offline', () => {
      atualizarAvisosDeRede(); atualizarBadges();
      aviso('Sem conexão. Os registros continuam sendo gravados no aparelho.', 'alerta', 5);
    });

    AUTH.aoMudar((est) => {
      if (!est.autenticado && TELAS_PUBLICAS.indexOf(estado.tela) === -1) {
        mostrarTela('tela-login');
      }
    });

    // Instalação no Android/Chrome
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      estado.promptInstalacao = e;
      $('#btn-instalar').hidden = false;
    });
    $('#btn-instalar').addEventListener('click', async () => {
      if (!estado.promptInstalacao) return;
      estado.promptInstalacao.prompt();
      await estado.promptInstalacao.userChoice;
      estado.promptInstalacao = null;
      $('#btn-instalar').hidden = true;
    });

    window.addEventListener('beforeunload', (e) => {
      if (estado.tela === 'tela-nova' && !estado.salvo && $('#f-lote').value && $('#f-canteiro').value) {
        e.preventDefault(); e.returnValue = '';
      }
    });
  }

  function registrarServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      // Nova versão assumiu o controle: recarrega uma vez para aplicar,
      // desde que não haja formulário em preenchimento.
      let recarregou = false;
      const tinhaControle = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!tinhaControle || recarregou) return;
        const preenchendo = estado.tela === 'tela-nova' && !estado.salvo &&
                            $('#f-lote').value && $('#f-canteiro').value;
        if (preenchendo) {
          aviso('Nova versão instalada. Salve a inspeção e reabra o app para atualizar.', 'alerta', 10);
          return;
        }
        recarregou = true;
        window.location.reload();
      });
      navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' })
        .then(reg => {
          reg.update().catch(() => {});
          reg.addEventListener('updatefound', () => {
            const novo = reg.installing;
            if (!novo) return;
            novo.addEventListener('statechange', () => {
              if (novo.state === 'installed' && navigator.serviceWorker.controller) {
                aviso('Nova versão disponível. Feche e abra o aplicativo para atualizar.', 'alerta', 10);
              }
            });
          });
        })
        .catch(err => console.warn('Service Worker não registrado:', err));
    });
  }

  /* ===================================================================
   * INICIALIZAÇÃO
   * =================================================================== */
  async function iniciar() {
    $('#cab-nome').textContent = 'Inspeções - Infra';
    $('#cab-obra').textContent = 'EDP TRANSMISSÃO CONSTRUÇÃO';
    document.title = CONFIG.app.nome;

    registrarServiceWorker();
    ligarEventos();
    preencherSelect($('#cad-funcao'), CONFIG.auth.funcoes, 'Selecione…');
    montarLotesCadastro();
    atualizarAvisosDeRede();

    try {
      await DB.db.open();
    } catch (e) {
      aviso('Não foi possível abrir o banco local: ' + (e.message || e) +
            '. Em janelas anônimas o armazenamento é bloqueado.', 'erro', 0);
    }

    // Volta do link de confirmação de e-mail: o cadastro já foi confirmado.
    const veioDaConfirmacao = /type=signup|access_token=/.test(window.location.hash);
    if (window.location.hash) history.replaceState(null, '', window.location.pathname);

    await aplicarLogo();     // antes de qualquer tela aparecer
    await AUTH.iniciar();
    SYNC.aoMudar(aoMudarSync);

    if (AUTH.autenticado()) {
      const est = AUTH.estado();
      $('#login-email').value = est.emailUltimaConta || '';
      await aoAutenticar();
    } else {
      const est = AUTH.estado();
      if (est.emailUltimaConta) $('#login-email').value = est.emailUltimaConta;
      const ua = navigator.userAgent;
      const so = /iPhone|iPad|iPod/i.test(ua) ? 'ios' : /Android/i.test(ua) ? 'android' : 'desktop';
      const aba = $$('.aba[data-so]').filter(b => b.dataset.so === so)[0];
      if (aba) aba.click();
      mostrarTela('tela-login');
      if (veioDaConfirmacao) aviso('E-mail confirmado. Entre com seu e-mail e senha.', 'sucesso', 10);
    }

    setInterval(atualizarBadges, 15000);
    // Administrador: confere novos cadastros a cada 60 s com o app aberto.
    setInterval(() => { if (document.visibilityState === 'visible') verificarLiberacoes(); }, 60000);
  }

  /** Abre "Nova inspeção" já preenchida com o canteiro programado no cronograma. */
  async function inspecaoProgramada(item) {
    await novaInspecao();
    const lotes = Array.prototype.map.call($('#f-lote').options, o => o.value);
    if (lotes.indexOf(item.lote) === -1) return;
    $('#f-lote').value = item.lote;
    const cadastrado = CONFIG.listarCanteiros(item.lote).indexOf(item.canteiro) !== -1;
    aoMudarLote(cadastrado ? item.canteiro : 'Outro');
    if (!cadastrado) { $('#f-canteiro-outro').value = item.canteiro; }
    aoMudarCanteiro();
    montarChecklist((item.itens || []).filter(i => CONFIG.itensInspecao.indexOf(i) !== -1));
    aviso('Inspeção programada para ' + item.canteiro + '. Ao salvar, o check entra no cronograma.', 'sucesso', 5);
  }

  return {
    iniciar: iniciar,
    estado: estado,
    confirmar: confirmar,
    inspecaoProgramada: inspecaoProgramada,
    abrirInspecao: abrirDetalhe,
    aviso: aviso,
    carregando: carregando,
    mostrarTela: mostrarTela,
    escapar: escapar,
    entregarArquivo: entregarArquivo,
    avisoEntrega: avisoEntrega
  };
})();

document.addEventListener('DOMContentLoaded', APP.iniciar);
window.APP = APP;
