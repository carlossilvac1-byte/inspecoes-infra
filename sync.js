/* =====================================================================
 * sync.js — SINCRONIZAÇÃO COM A BASE CENTRAL (Supabase)
 * ---------------------------------------------------------------------
 * IDA   — cada inspeção salva no aparelho entra numa fila e sobe para a
 *         base central assim que houver internet (fotos no Storage).
 * VOLTA — a cada 30 s (e ao abrir o app) o aparelho busca na base as
 *         inspeções que o usuário tem direito de ver. Quem decide é o
 *         SERVIDOR (regras do banco):
 *           • administrador ............ todas
 *           • visão "todas" ............. todas dos seus lotes
 *           • visão "próprias" .......... só as que ele mesmo fez
 *         As fotos das inspeções recebidas são baixadas sob demanda
 *         (ao abrir o detalhe ou gerar o PDF).
 *
 * Sem internet nada se perde: a fila espera e o app segue funcionando.
 * Sem Supabase configurado em config.js este módulo fica inativo e o
 * app trabalha no modo local (cada aparelho com os próprios dados).
 * ===================================================================== */

const SYNC = (function () {

  let emExecucao = false;
  let timer = null;
  const ouvintes = [];

  const S = () => CONFIG.supabase || {};
  function base() { return String(S().url || '').replace(/\/+$/, ''); }
  function ativo() { return !!(window.AUTH && AUTH.configurado() && !AUTH.modoLocal()); }

  async function fetchTimeout(url, opcoes, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms || 20000);
    try {
      return await fetch(url, Object.assign({}, opcoes || {}, { signal: ctrl.signal }));
    } finally {
      clearTimeout(t);
    }
  }

  /** Há conexão de verdade com a base? (navigator.onLine engana em campo) */
  async function online() {
    if (!navigator.onLine || !ativo()) return false;
    try {
      const r = await fetchTimeout(base() + '/auth/v1/health', {
        headers: { apikey: S().anonKey }, cache: 'no-store'
      }, 6000);
      return !!r && r.status < 500;
    } catch (e) {
      return false;
    }
  }

  function aoMudar(fn) { ouvintes.push(fn); }
  function notificar(evento, dados) {
    ouvintes.forEach(fn => { try { fn(evento, dados); } catch (e) { /* tela não pode derrubar o sync */ } });
  }

  /* ===================================================================
   * IDA — envio da fila
   * =================================================================== */

  async function enviarFotos(reg, fotos) {
    const meta = [];
    for (const f of fotos) {
      const nome = String(f.ordem).padStart(2, '0') + '_' + String(f.id).slice(0, 8) + '.jpg';
      const caminho = reg.lote + '/' + reg.id + '/' + nome;
      // Foto que veio da base (já existe lá): só repete os metadados.
      if (f.caminhoRemoto) {
        meta.push({ caminho: f.caminhoRemoto, legenda: f.legenda || '', ordem: f.ordem, bytes: f.bytes || 0 });
        continue;
      }
      const url = base() + '/storage/v1/object/' + S().bucketFotos + '/' +
                  caminho.split('/').map(encodeURIComponent).join('/');
      const cab = await AUTH.cabecalhosAutenticados({ 'x-upsert': 'true' });
      cab['Content-Type'] = 'image/jpeg';
      const r = await fetchTimeout(url, { method: 'POST', headers: cab, body: f.blob }, 90000);
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        if (r.status === 401) throw new Error('SESSAO_EXPIRADA');
        if (r.status === 403 || /row-level security|policy|unauthorized/i.test(t)) {
          throw new Error('Foto recusada pela base: sem permissão no lote ' + reg.lote + '.');
        }
        throw new Error('Falha ao enviar foto (HTTP ' + r.status + ').');
      }
      meta.push({ caminho: caminho, legenda: f.legenda || '', ordem: f.ordem, bytes: f.bytes || 0 });
    }
    return meta;
  }

  async function enviar(reg) {
    const fotos = reg.excluido ? [] : await DB.listarFotos(reg.id);
    const fotosMeta = fotos.length ? await enviarFotos(reg, fotos) : (reg.fotosRemotas || []);

    const linha = {
      id_local: reg.id,
      usuario_id: AUTH.usuarioId(),            // o banco reconfirma: autor = quem está logado
      responsavel: reg.responsavel,
      funcao_responsavel: reg.funcaoResponsavel || null,
      data_inspecao: reg.dataInspecao,
      lote: reg.lote,
      canteiro: DB.nomeCanteiro(reg),
      construtora: DB.nomeEmpresa(reg),
      o_que_inspecionado: DB.itensInspecionados(reg),
      checklist: reg.checklist || {},
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

    const cab = await AUTH.cabecalhosAutenticados({ Prefer: 'resolution=merge-duplicates,return=minimal' });
    const r = await fetchTimeout(base() + '/rest/v1/' + S().tabelaInspecoes + '?on_conflict=id_local', {
      method: 'POST', headers: cab, body: JSON.stringify(linha)
    }, 30000);
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      if (r.status === 401) throw new Error('SESSAO_EXPIRADA');
      if (r.status === 403 || /row-level security|violates/i.test(t)) {
        throw new Error('Gravação recusada pela base: seu usuário não tem permissão no lote ' + reg.lote + '.');
      }
      throw new Error('Base respondeu ' + r.status + ': ' + t.slice(0, 160));
    }
    // Guarda o caminho remoto nas fotos locais (evita reenviar)
    for (const m of fotosMeta) {
      const f = fotos.find(x => x.ordem === m.ordem);
      if (f && !f.caminhoRemoto) await DB.marcarFotoRemota(f.id, m.caminho);
    }
  }

  async function enviarFila(manual) {
    let fila = await DB.listarPendentes();
    if (!manual) fila = fila.filter(r => (r.tentativas || 0) < CONFIG.sync.maxTentativas);
    const resumo = { enviados: 0, falhas: 0 };
    for (const reg of fila) {
      try {
        await enviar(reg);
        await DB.marcarStatus(reg.id, 'sincronizado', '', null, reg.atualizadoEm);
        resumo.enviados++;
      } catch (e) {
        const msg = (e && e.message) || String(e);
        await DB.marcarStatus(reg.id, 'erro', msg === 'SESSAO_EXPIRADA' ? 'Sessão expirada — entre novamente.' : msg);
        resumo.falhas++;
        if (msg === 'SESSAO_EXPIRADA') break;
      }
    }
    return resumo;
  }

  /* ===================================================================
   * VOLTA — recebimento do que o usuário pode ver
   * =================================================================== */

  function chaveCursor() { return 'cursorRecebimento:' + AUTH.usuarioId(); }

  async function receber() {
    let cursor = await DB.kvGet(chaveCursor(), '1970-01-01T00:00:00Z');
    let total = 0;
    for (let pagina = 0; pagina < 20; pagina++) {
      const url = base() + '/rest/v1/' + S().tabelaInspecoes +
        '?select=*&recebido_em=gt.' + encodeURIComponent(cursor) +
        '&order=recebido_em.asc&limit=200';
      const cab = await AUTH.cabecalhosAutenticados();
      const r = await fetchTimeout(url, { headers: cab }, 30000);
      if (!r.ok) {
        if (r.status === 401) throw new Error('SESSAO_EXPIRADA');
        throw new Error('Falha ao receber inspeções (HTTP ' + r.status + ').');
      }
      const linhas = await r.json();
      for (const l of linhas) {
        if (await DB.salvarRecebida(l)) total++;
        cursor = l.recebido_em;
      }
      await DB.kvSet(chaveCursor(), cursor);
      if (linhas.length < 200) break;
    }
    return total;
  }

  /** Baixa as fotos de uma inspeção recebida (quando ainda não estão no aparelho). */
  async function baixarFotos(reg) {
    if (!ativo() || !reg || !Array.isArray(reg.fotosRemotas) || !reg.fotosRemotas.length) return 0;
    const locais = await DB.listarFotos(reg.id);
    const faltam = reg.fotosRemotas.filter(m => !locais.some(f => f.caminhoRemoto === m.caminho));
    if (!faltam.length || !navigator.onLine) return 0;
    let n = 0;
    for (const m of faltam) {
      try {
        const url = base() + '/storage/v1/object/authenticated/' + S().bucketFotos + '/' +
                    String(m.caminho).split('/').map(encodeURIComponent).join('/');
        const cab = await AUTH.cabecalhosAutenticados();
        delete cab['Content-Type'];
        const r = await fetchTimeout(url, { headers: cab }, 60000);
        if (!r.ok) continue;
        const blob = await r.blob();
        await DB.salvarFotoRecebida(reg.id, m, blob);
        n++;
      } catch (e) { /* segue com as demais */ }
    }
    return n;
  }

  /* ===================================================================
   * CICLO COMPLETO
   * =================================================================== */
  async function sincronizar(manual) {
    if (emExecucao || !ativo() || !AUTH.autenticado()) return { pulado: true };
    if (!AUTH.podeEnviar() && navigator.onLine) await AUTH.revalidar();
    if (!AUTH.podeEnviar()) return { pulado: true, sessaoExpirada: true };
    if (!(await online())) { notificar('rede', { online: false }); return { pulado: true, offline: true }; }

    emExecucao = true;
    notificar('inicio');
    const resumo = { enviados: 0, falhas: 0, recebidas: 0 };
    try {
      const st = await AUTH.revalidar();
      if (st === 'BLOQUEADO') { resumo.bloqueado = true; return resumo; }
      Object.assign(resumo, await enviarFila(manual));
      resumo.recebidas = await receber();
      // Cronograma: falha aqui não pode travar as inspeções.
      if (window.CRONO) {
        try { resumo.cronograma = await CRONO.sincronizar(); }
        catch (e) { if (String(e.message) === 'SESSAO_EXPIRADA') throw e; resumo.cronograma = { erro: e.message }; }
      }
      await DB.kvSet('ultimaSincronizacao:' + AUTH.usuarioId(), new Date().toISOString());
    } catch (e) {
      resumo.erro = (e && e.message) || String(e);
    } finally {
      emExecucao = false;
      notificar('fim', resumo);
    }
    return resumo;
  }

  async function ultimaSincronizacao() {
    if (!AUTH.usuarioId()) return null;
    return DB.kvGet('ultimaSincronizacao:' + AUTH.usuarioId(), null);
  }

  function iniciar() {
    if (!ativo()) return;
    window.addEventListener('online', () => { notificar('rede', { online: true }); sincronizar(false); });
    window.addEventListener('offline', () => notificar('rede', { online: false }));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') sincronizar(false);
    });
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') sincronizar(false);
    }, (CONFIG.sync.intervaloSegundos || 30) * 1000);
    setTimeout(() => sincronizar(false), 1500);
  }

  return {
    iniciar: iniciar,
    sincronizar: sincronizar,
    baixarFotos: baixarFotos,
    online: online,
    ativo: ativo,
    aoMudar: aoMudar,
    ultimaSincronizacao: ultimaSincronizacao
  };
})();

window.SYNC = SYNC;
