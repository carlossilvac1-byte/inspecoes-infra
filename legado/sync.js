/* =====================================================================
 * sync.js — FILA DE SINCRONIZAÇÃO (destino único: Supabase)
 * ---------------------------------------------------------------------
 * Cada aparelho tem a sua fila local; todos os registros convergem para
 * a MESMA tabela central (public.inspecoes), carimbados com o
 * usuario_id de quem está autenticado.
 *
 * Regras que este arquivo garante:
 *  - Envio só acontece com sessão utilizável (AUTH.podeEnviar()).
 *    Sessão vencida bloqueia o ENVIO, nunca o preenchimento.
 *  - Nenhum dado se perde: falha marca o registro como 'erro' com a
 *    mensagem e mantém na fila para reenvio.
 *  - Conflito entre aparelhos: o upsert por id_local leva o
 *    atualizado_em; o gatilho do banco mantém a versão mais recente e
 *    arquiva a anterior em inspecoes_historico.
 *  - As fotos vão para o Storage em {lote}/{id_local}/{arquivo}, que é
 *    o caminho conferido pela política de acesso por lote.
 *
 * Os adaptadores antigos (SharePoint e Google Sheets) foram movidos
 * para legado/sync-legado.js — ficam fora da aplicação, sem uso.
 * ===================================================================== */

const SYNC = (function () {

  let emExecucao = false;
  let timerPolling = null;
  const ouvintes = [];

  /* ===================================================================
   * REDE
   * =================================================================== */

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
   * Conectividade REAL. navigator.onLine só diz que existe interface de
   * rede — em campo isso é falso positivo constante (rádio conectado,
   * sem trânsito de dados).
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
   * ADAPTADOR SUPABASE
   * =================================================================== */
  const Supabase = (function () {
    const S = () => CONFIG.supabase;
    function base() { return S().url.replace(/\/+$/, ''); }

    function configurado() {
      return !!S().url && S().url.indexOf('SEUPROJETO') === -1 &&
             !!S().anonKey && S().anonKey.indexOf('COLOQUE-AQUI') === -1;
    }

    async function preparar() {
      if (!configurado()) throw new Error('SEM_BACKEND');
      if (!AUTH.autenticado()) throw new Error('SEM_LOGIN');
      if (!AUTH.podeEnviar()) throw new Error('SESSAO_EXPIRADA');
    }

    /** Envia as fotos e devolve os metadados gravados na coluna jsonb. */
    async function enviarFotos(reg, fotos) {
      const enviadas = [];
      for (const f of fotos) {
        const nome = String(f.ordem).padStart(2, '0') + '_' + f.id.slice(0, 8) + '.jpg';
        // Caminho exigido pela política de Storage: o LOTE é o primeiro
        // segmento, e é ele que autoriza (ou barra) a gravação.
        const caminho = encodeURIComponent(reg.lote) + '/' + reg.id + '/' + nome;
        const url = base() + '/storage/v1/object/' + S().bucketFotos + '/' + caminho;

        const cab = await AUTH.cabecalhosAutenticados({ 'Content-Type': 'image/jpeg', 'x-upsert': 'true' });
        delete cab['Content-Type'];                       // Blob define sozinho
        cab['Content-Type'] = 'image/jpeg';

        const r = await fetchTimeout(url, { method: 'POST', headers: cab, body: f.blob }, 60000);
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          if (r.status === 403 || /row-level security|policy/i.test(t)) {
            throw new Error('Envio da foto bloqueado pelo servidor: seu usuário não tem acesso ao lote ' +
                            reg.lote + '.');
          }
          throw new Error('Falha ao enviar a foto ' + nome + ' (HTTP ' + r.status + '): ' + t.slice(0, 160));
        }
        enviadas.push({
          caminho: decodeURIComponent(caminho),
          arquivo: nome,
          legenda: f.legenda || '',
          ordem: f.ordem,
          bytes: f.bytes
        });
      }
      return enviadas;
    }

    /** Grava a inspeção (upsert por id_local) na tabela central. */
    async function enviar(reg, fotos) {
      await preparar();

      const fotosMeta = (fotos && fotos.length) ? await enviarFotos(reg, fotos) : [];

      const linha = {
        id_local: reg.id,
        usuario_id: AUTH.usuarioId(),       // o gatilho reconfirma no servidor
        responsavel: reg.responsavel,
        funcao_responsavel: reg.funcaoResponsavel || null,
        data_inspecao: reg.dataInspecao,
        lote: reg.lote,
        canteiro: DB.nomeCanteiro(reg),
        construtora: DB.nomeEmpresa(reg),
        o_que_inspecionado: DB.itensInspecionados(reg),
        nao_conformidade: reg.naoConformidade === 'Sim',
        quais: reg.quais || null,
        observacoes: reg.observacoes || null,
        latitude: reg.latitude,
        longitude: reg.longitude,
        precisao_gps: reg.precisaoGps,
        dispositivo: reg.dispositivo,
        fotos: fotosMeta,
        versao: reg.versao || 1,
        criado_em: reg.criadoEm,
        atualizado_em: reg.atualizadoEm,
        excluido: !!reg.excluido,
        motivo_exclusao: reg.motivoExclusao || null,
        excluido_em: reg.excluidoEm || null
      };

      const url = base() + '/rest/v1/' + S().tabelaInspecoes + '?on_conflict=id_local';
      const cab = await AUTH.cabecalhosAutenticados({
        Prefer: 'resolution=merge-duplicates,return=representation'
      });
      const r = await fetchTimeout(url, {
        method: 'POST', headers: cab, body: JSON.stringify(linha)
      }, 30000);
      const txt = await r.text();

      if (!r.ok) {
        if (r.status === 401) throw new Error('SESSAO_EXPIRADA');
        if (r.status === 403 || /row-level security|violates/i.test(txt)) {
          throw new Error('Gravação recusada pelo servidor: seu usuário não tem permissão no lote ' +
                          reg.lote + '.');
        }
        throw new Error('Supabase ' + r.status + ': ' + txt.slice(0, 200));
      }

      let remotoId = reg.id;
      try {
        const j = JSON.parse(txt);
        if (j && j[0] && j[0].id) remotoId = String(j[0].id);
      } catch (e) { /* return=minimal ou corpo vazio */ }
      return { remotoId: remotoId };
    }

    /* A exclusão é lógica: o registro vai com excluido = true pelo
       mesmo caminho de envio. Não existe DELETE na API. */
    async function excluir(reg) {
      return enviar(reg, []);
    }

    return {
      nome: 'Supabase',
      configurado: configurado,
      preparar: preparar,
      enviar: enviar,
      excluir: excluir
    };
  })();

  function adaptador() { return Supabase; }

  /* ===================================================================
   * MOTOR DA FILA
   * =================================================================== */

  function aoMudar(fn) { ouvintes.push(fn); }
  function notificar(evento, dados) {
    ouvintes.forEach(fn => { try { fn(evento, dados); } catch (e) {} });
  }

  /**
   * Processa a fila do usuário autenticado.
   * @param {boolean} manual - disparada pelo botão (reprocessa erros
   *                           que já esgotaram as tentativas).
   */
  async function sincronizar(manual) {
    if (emExecucao) return { pulado: true };
    const ad = adaptador();

    if (!AUTH.autenticado()) return { pulado: true, semLogin: true };

    if (!ad.configurado()) {
      if (manual) {
        await DB.registrarLogSync({ tipo: 'aviso', mensagem:
          'Supabase não configurado em config.js. Os registros ficam no aparelho; ' +
          'use a exportação CSV/JSON para backup.' });
        notificar('log');
      }
      return { pulado: true, semBackend: true };
    }

    // Sessão vencida mas com rede: tenta renovar antes de desistir.
    if (!AUTH.podeEnviar() && navigator.onLine) {
      await AUTH.revalidar();
    }

    if (!AUTH.podeEnviar()) {
      if (manual) {
        await DB.registrarLogSync({ tipo: 'erro', mensagem:
          'Sessão expirada. Conecte-se à internet e entre novamente para enviar. ' +
          'Os registros continuam guardados no aparelho.' });
        notificar('log');
      }
      return { pulado: true, sessaoExpirada: true };
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
      // Renova o token e relê o perfil antes do lote (lotes e status
      // podem ter mudado no servidor desde o último envio).
      await AUTH.revalidar();

      try {
        await ad.preparar();
      } catch (e) {
        const m = String(e.message);
        if (m === 'SEM_LOGIN' || m === 'SESSAO_EXPIRADA') {
          await DB.registrarLogSync({ tipo: 'erro',
            mensagem: 'Sessão expirada — entre novamente para liberar o envio.' });
          notificar('log');
          return { pulado: true, sessaoExpirada: true };
        }
        throw e;
      }

      let fila = await DB.listarPendentes();
      if (!manual) {
        fila = fila.filter(r => (r.tentativas || 0) < CONFIG.sync.maxTentativas);
      }
      resumo.total = fila.length;

      for (const reg of fila) {
        try {
          const fotos = reg.excluido ? [] : await DB.listarFotos(reg.id);
          const r = await ad.enviar(reg, fotos);
          await DB.marcarStatus(reg.id, 'sincronizado', '', r && r.remotoId);
          await DB.auditar(reg.id, 'sync', 'Enviado para ' + ad.nome +
            (r && r.remotoId ? ' (ID remoto ' + r.remotoId + ')' : ''), reg.responsavel);
          resumo.enviados++;
          notificar('progresso', { id: reg.id, ok: true });
        } catch (e) {
          const msg = (e && e.message) ? e.message : String(e);
          await DB.marcarStatus(reg.id, 'erro',
            msg === 'SESSAO_EXPIRADA' ? 'Sessão expirada — entre novamente.' : msg);
          resumo.falhas++;
          resumo.mensagens.push(reg.id.slice(0, 8) + ': ' + msg);
          notificar('progresso', { id: reg.id, ok: false, erro: msg });
          if (msg === 'SESSAO_EXPIRADA' || msg === 'SEM_LOGIN') break;
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
   * 1) evento 'online'
   * 2) Background Sync API (Chrome/Android)
   * 3) polling periódico — caminho usado no iOS, que não tem a API
   * 4) volta do app ao primeiro plano
   * =================================================================== */

  async function pedirBackgroundSync() {
    if (!('serviceWorker' in navigator)) return false;
    try {
      const reg = await navigator.serviceWorker.ready;
      if ('sync' in reg) {
        await reg.sync.register('sincronizar-inspecoes');
        return true;
      }
    } catch (e) { /* iOS cai aqui: vale o polling */ }
    return false;
  }

  function iniciarPolling() {
    if (timerPolling) clearInterval(timerPolling);
    timerPolling = setInterval(async () => {
      if (!AUTH.autenticado() || !AUTH.podeEnviar()) return;
      const pend = await DB.listarPendentes();
      if (pend.length && (await online())) sincronizar(false);
    }, CONFIG.sync.intervaloPollingMs);
  }

  async function iniciar() {
    window.addEventListener('online', async () => {
      notificar('rede', { online: true });
      await AUTH.revalidar();
      pedirBackgroundSync();
      sincronizar(false);
    });
    window.addEventListener('offline', () => notificar('rede', { online: false }));

    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible') return;
      if (!AUTH.autenticado()) return;
      const pend = await DB.listarPendentes();
      if (pend.length && (await online())) sincronizar(false);
    });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (ev) => {
        if (ev.data && ev.data.tipo === 'sincronizar') sincronizar(false);
      });
    }

    iniciarPolling();

    setTimeout(async () => {
      if (!AUTH.autenticado()) return;
      const pend = await DB.listarPendentes();
      if (pend.length && (await online())) sincronizar(false);
    }, 4000);
  }

  return {
    iniciar: iniciar,
    sincronizar: sincronizar,
    online: online,
    adaptador: adaptador,
    pedirBackgroundSync: pedirBackgroundSync,
    aoMudar: aoMudar,
    fetchTimeout: fetchTimeout
  };
})();

window.SYNC = SYNC;
