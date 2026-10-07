/* =====================================================================
 * tratativas.js — NÃO CONFORMIDADES EM ABERTO (tratativa e retorno)
 * ---------------------------------------------------------------------
 * Toda pergunta do checklist respondida com NÃO vira uma não
 * conformidade (NC). Aqui cada NC recebe a sua TRATATIVA:
 *   • ação corretiva e responsável pela ação;
 *   • data prevista de conclusão;
 *   • retorno: descrição da correção, data real de conclusão e fotos.
 *
 * Situações:  ABERTA → EM ANDAMENTO → CONCLUÍDA
 * Prazo:      no prazo · vence em breve · vencida · sem prazo
 *
 * Quem vê/trata segue a regra das inspeções (o banco decide): vê quem
 * pode ver a inspeção de origem; trata quem atua no lote dela.
 * Funciona offline: grava no aparelho e sobe na sincronização.
 * ===================================================================== */

const TRAT = (function () {

  const DIA = 86400000;
  const SIT = { aberta: 'Aberta', andamento: 'Em andamento', concluida: 'Concluída' };
  const MAX_FOTOS = 10;

  const est = {
    filtro: 'abertas',       // abertas | vencidas | semprazo | concluidas | todas
    lote: '',
    busca: '',
    tabelaAusente: false,
    atual: null,             // NC aberta na janela
    novasFotos: []           // fotos anexadas na janela ainda não salvas
  };

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const aviso = (...a) => window.APP && APP.aviso(...a);

  /* ===================================================================
   * DATAS
   * =================================================================== */
  function hojeISO() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  function data(s) { const p = String(s).slice(0, 10).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function dias(de, ate) { return Math.round((data(ate) - data(de)) / DIA); }
  function br(s) { if (!s) return '—'; const p = String(s).slice(0, 10).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function plural(n, um, varios) { return n + ' ' + (Math.abs(n) === 1 ? um : varios); }

  /* ===================================================================
   * IDENTIDADE DA NC (estável: inspeção + item + pergunta)
   * =================================================================== */
  function hash(s) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }
  function idNC(inspecaoId, item, pergunta) { return 'nc-' + inspecaoId + '-' + hash(item + '|' + pergunta); }

  /* ===================================================================
   * DADOS
   * =================================================================== */
  const T = () => DB.db.tratativas;
  const F = () => DB.db.fotosNc;

  /** Pode registrar a tratativa? Atua no lote (ou é administrador). */
  function podeTratar(nc) {
    if (!nc) return false;
    if (AUTH.ehAdmin && AUTH.ehAdmin()) return true;
    const e = AUTH.estado ? AUTH.estado() : {};
    return Array.isArray(e.lotes) && e.lotes.indexOf(nc.lote) !== -1;
  }

  /** Todas as NCs visíveis, montadas a partir das inspeções + tratativas. */
  async function listarNCs() {
    const insp = await DB.listarInspecoes({});
    const trats = await T().toArray();
    const mapa = new Map(trats.map(t => [t.id, t]));
    const lista = [];
    for (const r of insp) {
      if (r.excluido) continue;
      const ck = r.checklist || {};
      let k = 0;
      Object.keys(ck).forEach(item => (ck[item] || []).forEach(q => {
        if (q.resposta !== 'NÃO') return;
        k++;
        const id = idNC(r.id, item, q.pergunta);
        const t = mapa.get(id) || null;
        lista.push({
          id: id, numero: k, inspecaoId: r.id, lote: r.lote,
          canteiro: DB.nomeCanteiro(r), empresa: DB.nomeEmpresa(r),
          dataInspecao: r.dataInspecao, inspetor: r.responsavel || '',
          item: item, pergunta: q.pergunta, obs: q.obs || '',
          trat: t, situacao: t ? t.situacao : 'aberta'
        });
      }));
    }
    return lista;
  }

  /** Situação do prazo de uma NC. */
  function prazo(nc, hoje) {
    const t = nc.trat || {};
    if (nc.situacao === 'concluida') {
      if (!t.dataPrevista) return { cls: 'ok', chave: 'concluida', txt: 'Concluída em ' + br(t.dataConclusao) };
      const atraso = dias(t.dataPrevista, t.dataConclusao);
      return atraso > 0
        ? { cls: 'atraso', chave: 'concluida_atraso', txt: 'Concluída em ' + br(t.dataConclusao) + ' · ' + plural(atraso, 'dia', 'dias') + ' de atraso' }
        : { cls: 'ok', chave: 'concluida_prazo', txt: 'Concluída em ' + br(t.dataConclusao) + ' · no prazo' };
    }
    if (!t.dataPrevista) return { cls: 'sem', chave: 'semprazo', txt: 'Sem prazo definido' };
    const d = dias(hoje, t.dataPrevista);
    if (d < 0) return { cls: 'vencida', chave: 'vencida', txt: 'Vencida há ' + plural(-d, 'dia', 'dias') + ' (' + br(t.dataPrevista) + ')' };
    if (d === 0) return { cls: 'proximo', chave: 'noprazo', txt: 'Vence hoje' };
    if (d <= 3) return { cls: 'proximo', chave: 'noprazo', txt: 'Vence em ' + plural(d, 'dia', 'dias') + ' (' + br(t.dataPrevista) + ')' };
    return { cls: 'noprazo', chave: 'noprazo', txt: 'Prazo ' + br(t.dataPrevista) + ' · faltam ' + d + ' dias' };
  }
  const emAberto = nc => nc.situacao !== 'concluida';
  const vencida = (nc, hoje) => emAberto(nc) && nc.trat && nc.trat.dataPrevista && nc.trat.dataPrevista < hoje;
  function idade(nc, hoje) {
    const fim = nc.situacao === 'concluida' && nc.trat && nc.trat.dataConclusao ? nc.trat.dataConclusao : hoje;
    return Math.max(0, dias(nc.dataInspecao, fim));
  }

  async function fotosDaNC(ncId) {
    const fs = await F().where('ncId').equals(ncId).toArray();
    fs.forEach(DB.prepararFoto);
    fs.sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
    return fs;
  }

  /** Tratativas e fotos de retorno de uma inspeção (para detalhe e PDF). */
  async function daInspecao(inspecaoId) {
    const trats = await T().where('inspecaoId').equals(inspecaoId).toArray();
    const saida = {};
    for (const t of trats) {
      await baixarFotos(t).catch(() => 0);
      saida[t.id] = { trat: t, fotos: await fotosDaNC(t.id) };
    }
    return saida;
  }

  /** Grava a tratativa e registra no histórico o que mudou. */
  async function salvar(nc, campos, qtdFotosNovas) {
    const ant = await T().get(nc.id);
    const agora = new Date().toISOString();
    const p = (AUTH.perfil && AUTH.perfil()) || {};
    const base = ant || {
      id: nc.id, inspecaoId: nc.inspecaoId, lote: nc.lote, canteiro: nc.canteiro,
      item: nc.item, pergunta: nc.pergunta, situacao: 'aberta',
      acao: '', responsavelAcao: '', dataPrevista: null, dataConclusao: null, retorno: '',
      fotos: [], historico: [], criadoEm: agora
    };
    const novo = Object.assign({}, base, campos);
    const ev = [];
    if (!ant) ev.push('Tratativa registrada');
    if (base.situacao !== novo.situacao) ev.push('Situação: ' + SIT[base.situacao] + ' → ' + SIT[novo.situacao]);
    if ((base.acao || '') !== (novo.acao || '') && novo.acao) ev.push(base.acao ? 'Ação corretiva atualizada' : 'Ação corretiva definida');
    if ((base.responsavelAcao || '') !== (novo.responsavelAcao || '') && novo.responsavelAcao) ev.push('Responsável pela ação: ' + novo.responsavelAcao);
    if ((base.dataPrevista || null) !== (novo.dataPrevista || null)) {
      ev.push(novo.dataPrevista ? (base.dataPrevista ? 'Prazo alterado de ' + br(base.dataPrevista) + ' para ' + br(novo.dataPrevista)
                                                     : 'Prazo definido para ' + br(novo.dataPrevista)) : 'Prazo removido');
    }
    if (novo.situacao === 'concluida' && (base.dataConclusao || null) !== novo.dataConclusao) ev.push('Concluída em ' + br(novo.dataConclusao));
    if ((base.retorno || '') !== (novo.retorno || '') && novo.retorno && novo.situacao !== 'concluida') ev.push('Retorno atualizado');
    if (qtdFotosNovas) ev.push(plural(qtdFotosNovas, 'foto de retorno anexada', 'fotos de retorno anexadas'));
    novo.historico = (base.historico || []).concat(ev.map(e => ({ em: agora, por: p.nome || '', evento: e })));
    novo.atualizadoEm = agora;
    novo.atualizadoPorNome = p.nome || '';
    novo.usuarioId = DB.usuarioAtual();
    novo.status = 'pendente';
    novo.erroMsg = '';
    await T().put(novo);
    sincronizarLogo();
    return novo;
  }

  async function adicionarFoto(nc, arquivo) {
    const qtd = await F().where('ncId').equals(nc.id).count();
    if (qtd >= MAX_FOTOS) throw new Error('Limite de ' + MAX_FOTOS + ' fotos de retorno por NC.');
    const comp = await DB.comprimirImagem(arquivo);
    const dados = await DB.lerBytes(comp.blob);
    if (!DB.imagemValida(dados)) throw new Error('A foto não pôde ser processada. Tire novamente.');
    const ultima = (await F().where('ncId').equals(nc.id).toArray()).reduce((m, f) => Math.max(m, f.ordem || 0), 0);
    const foto = {
      id: DB.uuid(), ncId: nc.id, inspecaoId: nc.inspecaoId, lote: nc.lote,
      dados: dados, tipo: 'image/jpeg', largura: comp.largura, altura: comp.altura,
      bytes: dados.byteLength, ordem: ultima + 1, criadoEm: new Date().toISOString()
    };
    await F().add(foto);
    const conf = await F().get(foto.id);
    if (!conf || !conf.dados || conf.dados.byteLength !== dados.byteLength) {
      await F().delete(foto.id).catch(() => {});
      throw new Error('O aparelho não conseguiu salvar a foto. Tente novamente.');
    }
    return foto;
  }

  /** Remove a foto; se ela já estava na base, tira também dos metadados. */
  async function removerFoto(fotoId) {
    const f = await F().get(fotoId);
    if (!f) return;
    await F().delete(fotoId);
    if (f.caminhoRemoto) {
      const t = await T().get(f.ncId);
      if (t) {
        t.fotos = (t.fotos || []).filter(m => m.caminho !== f.caminhoRemoto);
        t.atualizadoEm = new Date().toISOString();
        t.status = 'pendente';
        await T().put(t);
      }
    }
  }

  /* ===================================================================
   * SINCRONIZAÇÃO
   * =================================================================== */
  function ativo() { return !!(window.SYNC && SYNC.ativo()); }
  function base() { return String(CONFIG.supabase.url || '').replace(/\/+$/, ''); }
  let timerSync = null;
  function sincronizarLogo() {
    if (!ativo()) return;
    clearTimeout(timerSync);
    timerSync = setTimeout(() => SYNC.sincronizar(false), 600);
  }
  async function fetchTimeout(url, op, ms) {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), ms || 20000);
    try { return await fetch(url, Object.assign({}, op || {}, { signal: c.signal })); }
    finally { clearTimeout(t); }
  }
  function tabelaFalta(status, texto) {
    return status === 404 || /PGRST205|nc_tratativas.*(schema cache|does not exist)|relation .*nc_tratativas/i.test(texto || '');
  }
  const caminhoFoto = (t, f) => 'tratativas/' + t.lote + '/' + t.inspecaoId + '/' +
    hash(t.id).slice(0, 8) + '_' + String(f.ordem).padStart(2, '0') + '_' + String(f.id).slice(0, 8) + '.jpg';

  async function enviarFotos(t) {
    const fotos = await fotosDaNC(t.id);
    const meta = (t.fotos || []).slice();
    for (const f of fotos) {
      if (f.caminhoRemoto || f.indisponivel || !f.dados || !DB.imagemValida(f.dados)) continue;
      const caminho = caminhoFoto(t, f);
      const cab = await AUTH.cabecalhosAutenticados({ 'x-upsert': 'true' });
      cab['Content-Type'] = 'image/jpeg';
      const r = await fetchTimeout(base() + '/storage/v1/object/' + CONFIG.supabase.bucketFotos + '/' +
        caminho.split('/').map(encodeURIComponent).join('/'),
        { method: 'POST', headers: cab, body: new Uint8Array(f.dados) }, 90000);
      if (!r.ok) {
        if (r.status === 401) throw new Error('SESSAO_EXPIRADA');
        throw new Error(r.status === 403 ? 'Sem permissão para anexar fotos no lote ' + t.lote + '.' : 'Falha ao enviar foto (HTTP ' + r.status + ').');
      }
      await F().update(f.id, { caminhoRemoto: caminho });
      meta.push({ caminho: caminho, ordem: f.ordem, bytes: f.bytes || 0 });
    }
    return meta;
  }

  async function enviar() {
    const fila = (await T().toArray()).filter(t => t.status === 'pendente' || t.status === 'erro');
    let n = 0;
    for (const t of fila) {
      try {
        const fotos = await enviarFotos(t);
        const linha = {
          id: t.id, inspecao_id: t.inspecaoId, lote: t.lote, canteiro: t.canteiro || null,
          item: t.item, pergunta: t.pergunta, situacao: t.situacao,
          acao: t.acao || null, responsavel_acao: t.responsavelAcao || null,
          data_prevista: t.dataPrevista || null, data_conclusao: t.dataConclusao || null,
          retorno: t.retorno || null, fotos: fotos, historico: t.historico || [],
          atualizado_por_nome: t.atualizadoPorNome || null,
          criado_em: t.criadoEm, atualizado_em: t.atualizadoEm
        };
        const cab = await AUTH.cabecalhosAutenticados({ Prefer: 'resolution=merge-duplicates,return=minimal' });
        const resp = await fetchTimeout(base() + '/rest/v1/nc_tratativas?on_conflict=id',
          { method: 'POST', headers: cab, body: JSON.stringify(linha) }, 20000);
        if (!resp.ok) {
          const tx = await resp.text().catch(() => '');
          if (tabelaFalta(resp.status, tx)) { est.tabelaAusente = true; return n; }
          if (resp.status === 401) throw new Error('SESSAO_EXPIRADA');
          await T().update(t.id, { status: 'erro', erroMsg: resp.status === 403 || /row-level/i.test(tx)
            ? 'Sem permissão para tratar NC do lote ' + t.lote + '.' : 'Base respondeu ' + resp.status });
          continue;
        }
        const atual = await T().get(t.id);
        if (atual && atual.atualizadoEm === t.atualizadoEm) await T().update(t.id, { status: 'sincronizado', erroMsg: '', fotos: fotos });
        else if (atual) await T().update(t.id, { fotos: fotos });
        n++;
      } catch (e) {
        if (String(e.message) === 'SESSAO_EXPIRADA') throw e;
        await T().update(t.id, { status: 'erro', erroMsg: e.message || String(e) });
      }
    }
    return n;
  }

  async function receber() {
    const chave = 'cursorNC:' + DB.usuarioAtual();
    let cursor = await DB.kvGet(chave, '1970-01-01T00:00:00Z');
    let total = 0;
    for (let pag = 0; pag < 20; pag++) {
      const cab = await AUTH.cabecalhosAutenticados();
      const resp = await fetchTimeout(base() + '/rest/v1/nc_tratativas?select=*&recebido_em=gt.' +
        encodeURIComponent(cursor) + '&order=recebido_em.asc&limit=500', { headers: cab }, 30000);
      if (!resp.ok) {
        const tx = await resp.text().catch(() => '');
        if (tabelaFalta(resp.status, tx)) { est.tabelaAusente = true; return total; }
        if (resp.status === 401) throw new Error('SESSAO_EXPIRADA');
        throw new Error('Falha ao receber as tratativas (HTTP ' + resp.status + ').');
      }
      const linhas = await resp.json();
      for (const l of linhas) {
        cursor = l.recebido_em;
        const local = await T().get(l.id);
        if (local && (local.status === 'pendente' || local.status === 'erro')) continue;   // edição local ainda não subiu
        await T().put({
          id: l.id, inspecaoId: l.inspecao_id, lote: l.lote, canteiro: l.canteiro || '',
          item: l.item, pergunta: l.pergunta, situacao: l.situacao,
          acao: l.acao || '', responsavelAcao: l.responsavel_acao || '',
          dataPrevista: l.data_prevista ? String(l.data_prevista).slice(0, 10) : null,
          dataConclusao: l.data_conclusao ? String(l.data_conclusao).slice(0, 10) : null,
          retorno: l.retorno || '', fotos: Array.isArray(l.fotos) ? l.fotos : [],
          historico: Array.isArray(l.historico) ? l.historico : [],
          atualizadoPorNome: l.atualizado_por_nome || '', usuarioId: l.atualizado_por || null,
          criadoEm: l.criado_em, atualizadoEm: l.atualizado_em,
          status: 'sincronizado', erroMsg: ''
        });
        // Fotos removidas em outro aparelho: tira daqui também
        const caminhos = (l.fotos || []).map(m => m.caminho);
        const locais = await F().where('ncId').equals(l.id).toArray();
        for (const f of locais) if (f.caminhoRemoto && caminhos.indexOf(f.caminhoRemoto) === -1) await F().delete(f.id);
        total++;
      }
      await DB.kvSet(chave, cursor);
      if (linhas.length < 500) break;
    }
    await DB.kvSet('tabelaNC', 'ok');
    return total;
  }

  /** Baixa as fotos do retorno que ainda não estão no aparelho. */
  async function baixarFotos(t) {
    if (!ativo() || !t || !Array.isArray(t.fotos) || !t.fotos.length || !navigator.onLine) return 0;
    const locais = await F().where('ncId').equals(t.id).toArray();
    const faltam = t.fotos.filter(m => !locais.some(f => f.caminhoRemoto === m.caminho && f.dados));
    let n = 0;
    for (const m of faltam) {
      try {
        const cab = await AUTH.cabecalhosAutenticados();
        delete cab['Content-Type'];
        const r = await fetchTimeout(base() + '/storage/v1/object/authenticated/' + CONFIG.supabase.bucketFotos + '/' +
          String(m.caminho).split('/').map(encodeURIComponent).join('/'), { headers: cab }, 60000);
        if (!r.ok) continue;
        const dados = await DB.lerBytes(await r.blob());
        if (!DB.imagemValida(dados)) continue;
        await F().put({ id: 'r-' + hash(m.caminho), ncId: t.id, inspecaoId: t.inspecaoId, lote: t.lote,
          dados: dados, tipo: 'image/jpeg', bytes: dados.byteLength, ordem: m.ordem || 0,
          criadoEm: new Date().toISOString(), caminhoRemoto: m.caminho });
        n++;
      } catch (e) { /* segue com as demais */ }
    }
    return n;
  }

  /** Chamado dentro do ciclo do SYNC (com internet e sessão válida). */
  async function sincronizar() {
    if (!ativo()) return { pulado: true };
    est.tabelaAusente = false;
    const enviados = await enviar();
    const recebidos = est.tabelaAusente ? 0 : await receber();
    if (est.tabelaAusente) await DB.kvSet('tabelaNC', '');
    return { enviados: enviados, recebidos: recebidos, semTabela: est.tabelaAusente };
  }
  let tabelaOk = false;
  async function carregarSituacaoTabela() { tabelaOk = (await DB.kvGet('tabelaNC', '')) === 'ok'; }
  function tabelaDisponivel() { return tabelaOk; }

  /* ===================================================================
   * TELA — LISTA
   * =================================================================== */
  function aplicarBusca(lista) {
    const b = est.busca.trim().toLowerCase();
    return lista.filter(nc => (!est.lote || nc.lote === est.lote) &&
      (!b || [nc.canteiro, nc.empresa, nc.item, nc.pergunta, nc.obs, nc.inspetor,
              nc.trat && nc.trat.acao, nc.trat && nc.trat.responsavelAcao].join(' ').toLowerCase().indexOf(b) !== -1));
  }

  function desenharIndicadores(lista, hoje) {
    const abertas = lista.filter(emAberto);
    const venc = abertas.filter(nc => vencida(nc, hoje));
    const semPrazo = abertas.filter(nc => !(nc.trat && nc.trat.dataPrevista));
    const concl = lista.filter(nc => !emAberto(nc));
    const comPrazo = concl.filter(nc => nc.trat && nc.trat.dataPrevista);
    const noPrazo = comPrazo.filter(nc => nc.trat.dataConclusao <= nc.trat.dataPrevista);
    const tempos = concl.map(nc => idade(nc, hoje));
    $('#nc-k-abertas').textContent = abertas.length;
    $('#nc-k-vencidas').textContent = venc.length;
    $('#nc-k-semprazo').textContent = semPrazo.length;
    $('#nc-k-concluidas').textContent = concl.length;
    $('#nc-k-noprazo').textContent = comPrazo.length ? Math.round(noPrazo.length / comPrazo.length * 100) + '%' : '—';
    $('#nc-k-tempo').textContent = tempos.length ? Math.round(tempos.reduce((a, b) => a + b, 0) / tempos.length) + ' d' : '—';
    const total = lista.length;
    const pct = total ? Math.round(concl.length / total * 100) : 0;
    $('#nc-barra').style.width = pct + '%';
    $('#nc-txt-progresso').textContent = total
      ? pct + '% das NCs apontadas já foram tratadas (' + concl.length + ' de ' + total + ')'
      : 'Nenhuma não conformidade apontada nas inspeções visíveis para você.';
    $$('[data-nc-filtro]').forEach(b => {
      const n = { abertas: abertas.length, vencidas: venc.length, semprazo: semPrazo.length, concluidas: concl.length, todas: total }[b.dataset.ncFiltro];
      b.querySelector('i').textContent = n;
      b.classList.toggle('ativa', b.dataset.ncFiltro === est.filtro);
    });
  }

  function filtrarPorSituacao(lista, hoje) {
    switch (est.filtro) {
      case 'vencidas': return lista.filter(nc => vencida(nc, hoje));
      case 'semprazo': return lista.filter(nc => emAberto(nc) && !(nc.trat && nc.trat.dataPrevista));
      case 'concluidas': return lista.filter(nc => !emAberto(nc));
      case 'todas': return lista;
      default: return lista.filter(emAberto);
    }
  }

  /** Ordem de urgência: vencidas (mais atrasada primeiro) → prazo mais próximo → sem prazo (mais antiga) → concluídas. */
  function ordenar(lista, hoje) {
    const peso = nc => {
      if (!emAberto(nc)) return 3;
      if (vencida(nc, hoje)) return 0;
      return nc.trat && nc.trat.dataPrevista ? 1 : 2;
    };
    return lista.slice().sort((a, b) => {
      const pa = peso(a), pb = peso(b);
      if (pa !== pb) return pa - pb;
      if (pa === 0 || pa === 1) return a.trat.dataPrevista < b.trat.dataPrevista ? -1 : a.trat.dataPrevista > b.trat.dataPrevista ? 1 : 0;
      if (pa === 2) return a.dataInspecao < b.dataInspecao ? -1 : 1;
      return (b.trat.dataConclusao || '') < (a.trat.dataConclusao || '') ? -1 : 1;
    });
  }

  function cartao(nc, hoje) {
    const t = nc.trat || {};
    const pz = prazo(nc, hoje);
    const id = idade(nc, hoje);
    const pend = t.status === 'pendente' ? '<span class="nc-t-sync" title="Aguardando envio à base central">● não enviada</span>'
               : t.status === 'erro' ? '<span class="nc-t-sync erro" title="' + esc(t.erroMsg) + '">● erro no envio</span>' : '';
    return '<article class="nc-t-card sit-' + pz.cls + '" data-id="' + esc(nc.id) + '" tabindex="0">' +
      '<div class="nc-t-topo"><span class="nc-t-cod">NC ' + nc.numero + ' · ' + esc(nc.lote) + '</span>' +
      '<span class="nc-t-sit s-' + nc.situacao + '">' + SIT[nc.situacao] + '</span></div>' +
      '<div class="nc-t-local">' + esc(nc.canteiro) + (nc.empresa ? ' · ' + esc(nc.empresa) : '') + '</div>' +
      '<p class="nc-t-perg"><span class="nc-t-item">' + esc(nc.item) + '</span> ' + esc(nc.pergunta) + '</p>' +
      (nc.obs ? '<p class="nc-t-obs">' + esc(nc.obs) + '</p>' : '') +
      (t.acao ? '<p class="nc-t-acao"><b>Ação:</b> ' + esc(t.acao) + (t.responsavelAcao ? ' <span>— ' + esc(t.responsavelAcao) + '</span>' : '') + '</p>' : '') +
      '<div class="nc-t-rodape"><span class="nc-t-meta">Apontada em ' + br(nc.dataInspecao) + ' por ' + esc(nc.inspetor) +
      ' · ' + (emAberto(nc) ? plural(id, 'dia', 'dias') + ' em aberto' : 'tratada em ' + plural(id, 'dia', 'dias')) + '</span>' +
      '<span class="nc-t-prazo p-' + pz.cls + '">' + esc(pz.txt) + '</span>' + pend + '</div>' +
      '</article>';
  }

  async function montar() {
    const hoje = hojeISO();
    const todas = await listarNCs();
    // filtro de lote
    const lotes = Array.from(new Set(todas.map(n => n.lote))).sort();
    const sel = $('#nc-lote');
    sel.innerHTML = '<option value="">Todos os lotes</option>' +
      lotes.map(l => '<option value="' + esc(l) + '">' + esc(CONFIG.rotuloLote ? CONFIG.rotuloLote(l) : l) + '</option>').join('');
    sel.value = lotes.indexOf(est.lote) !== -1 ? est.lote : '';
    if (!sel.value) est.lote = '';
    const base = aplicarBusca(todas);
    desenharIndicadores(base, hoje);
    const lista = ordenar(filtrarPorSituacao(base, hoje), hoje);
    const cont = $('#nc-lista');
    if (!lista.length) {
      const msg = {
        abertas: 'Nenhuma não conformidade em aberto. 👏',
        vencidas: 'Nenhuma NC vencida.',
        semprazo: 'Todas as NCs em aberto já têm prazo definido.',
        concluidas: 'Nenhuma NC concluída ainda.',
        todas: 'Nenhuma não conformidade apontada.'
      }[est.filtro];
      cont.innerHTML = '<div class="nc-vazio">' + msg + '</div>';
    } else {
      cont.innerHTML = lista.map(nc => cartao(nc, hoje)).join('');
    }
    $('#nc-aviso-base').hidden = !est.tabelaAusente;
    atualizarBadge(todas, hoje);
  }

  /** Número no ícone da aba: NCs em aberto (vermelho se houver vencida). */
  async function atualizarBadge(lista, hoje) {
    try {
      hoje = hoje || hojeISO();
      lista = lista || await listarNCs();
      const abertas = lista.filter(emAberto);
      const b = $('#nav-nc-badge');
      if (!b) return;
      b.hidden = !abertas.length;
      b.textContent = abertas.length > 99 ? '99+' : String(abertas.length);
      b.classList.toggle('alerta', abertas.some(nc => vencida(nc, hoje)));
    } catch (e) { /* informativo */ }
  }

  /* ===================================================================
   * JANELA — TRATAR A NC
   * =================================================================== */
  function fecharJanela() {
    $('#modal-nc').hidden = true;
    document.body.classList.remove('modal-aberto');
  }

  async function descartarNovasFotos() {
    for (const id of est.novasFotos) await F().delete(id).catch(() => {});
    est.novasFotos = [];
  }

  async function abrir(ncId) {
    const lista = await listarNCs();
    const nc = lista.find(n => n.id === ncId);
    if (!nc) { aviso('Não conformidade não encontrada (a inspeção pode ter sido alterada).', 'alerta', 6); return; }
    est.atual = nc;
    est.novasFotos = [];
    const t = nc.trat || {};
    const pode = podeTratar(nc);
    const hoje = hojeISO();
    const pz = prazo(nc, hoje);
    if (t.id) await baixarFotos(t).catch(() => 0);
    const evid = (await DB.listarFotos(nc.inspecaoId))
      .filter(f => f.vinculo && f.vinculo.item === nc.item && f.vinculo.pergunta === nc.pergunta);
    const dis = pode ? '' : ' disabled';
    const sit = t.situacao || 'aberta';

    const html =
      '<div class="nc-j-cab"><div><div class="nc-t-cod">NC ' + nc.numero + ' · ' + esc(nc.lote) + ' · ' + esc(nc.item) + '</div>' +
      '<h3>' + esc(nc.canteiro) + '</h3><div class="apoio pequena">' + esc(nc.empresa) + '</div></div>' +
      '<button type="button" class="nc-j-fechar" data-nc-acao="fechar" aria-label="Fechar">✕</button></div>' +

      '<div class="nc-j-origem">' +
      '<p class="nc-t-perg">' + esc(nc.pergunta) + ' <b class="txt-nao">NÃO</b></p>' +
      (nc.obs ? '<p class="nc-t-obs">' + esc(nc.obs) + '</p>' : '') +
      '<p class="apoio pequena">Apontada em ' + br(nc.dataInspecao) + ' por ' + esc(nc.inspetor) + ' · ' +
      '<a href="#" data-nc-acao="inspecao">ver inspeção</a></p>' +
      (evid.length ? '<div class="nc-j-fotos">' + evid.map(f => '<img src="' + srcFoto(f) + '" alt="Evidência">').join('') + '</div>' : '') +
      '<span class="nc-t-prazo p-' + pz.cls + '">' + esc(pz.txt) + '</span>' +
      '</div>' +

      (pode ? '' : '<div class="nc-j-somente">Somente leitura: você não atua no lote ' + esc(nc.lote) + '.</div>') +

      '<h4 class="nc-j-sec">Tratativa</h4>' +
      '<div class="nc-j-sit" role="radiogroup" aria-label="Situação">' +
      ['aberta', 'andamento', 'concluida'].map(s => '<label class="s-' + s + '"><input type="radio" name="nc-sit" value="' + s + '"' +
        (s === sit ? ' checked' : '') + dis + '><span>' + SIT[s] + '</span></label>').join('') + '</div>' +
      '<label class="campo"><span class="rotulo">Ação corretiva <em>*</em></span>' +
      '<textarea id="nc-acao" rows="3" maxlength="1000" placeholder="O que será feito para corrigir"' + dis + '>' + esc(t.acao) + '</textarea></label>' +
      '<div class="pg-datas">' +
      '<label class="campo"><span class="rotulo">Responsável pela ação</span><input type="text" id="nc-resp" maxlength="120" placeholder="Nome / empresa" value="' + esc(t.responsavelAcao) + '"' + dis + '></label>' +
      '<label class="campo"><span class="rotulo">Data prevista de conclusão</span><input type="date" id="nc-prevista" min="' + esc(nc.dataInspecao) + '" value="' + esc(t.dataPrevista || '') + '"' + dis + '></label>' +
      '</div>' +

      '<h4 class="nc-j-sec">Retorno</h4>' +
      '<label class="campo"><span class="rotulo">Descrição do retorno / correção realizada</span>' +
      '<textarea id="nc-retorno" rows="3" maxlength="1500" placeholder="Como a NC foi corrigida"' + dis + '>' + esc(t.retorno) + '</textarea></label>' +
      '<label class="campo"><span class="rotulo">Data real de conclusão</span><input type="date" id="nc-conclusao" min="' + esc(nc.dataInspecao) + '" max="' + hoje + '" value="' + esc(t.dataConclusao || '') + '"' + dis + '></label>' +
      '<div class="nc-j-fotos-cab"><span class="rotulo">Fotos do retorno</span><span class="apoio pequena" id="nc-qtd-fotos"></span></div>' +
      '<div class="nc-j-fotos" id="nc-fotos-retorno"></div>' +
      (pode ? '<div class="evid-botoes"><button type="button" class="btn btn-neutro" data-nc-acao="camera">📷 Tirar foto</button>' +
              '<button type="button" class="btn btn-neutro" data-nc-acao="galeria">🖼 Da galeria</button></div>' : '') +
      '<p class="apoio pequena nc-j-regra">Para concluir: ação corretiva, descrição do retorno, data real de conclusão e ao menos 1 foto do retorno.</p>' +

      ((t.historico || []).length ? '<h4 class="nc-j-sec">Histórico</h4><div class="nc-j-hist">' +
        t.historico.slice().reverse().map(h => '<div><b>' + esc(h.evento) + '</b><span>' + dataHora(h.em) + (h.por ? ' · ' + esc(h.por) : '') + '</span></div>').join('') + '</div>' : '') +

      '<div class="pg-botoes">' +
      '<button type="button" class="btn btn-neutro" data-nc-acao="fechar">' + (pode ? 'Cancelar' : 'Fechar') + '</button>' +
      (pode ? '<button type="button" class="btn btn-primario" data-nc-acao="salvar">Salvar tratativa</button>' : '') +
      '</div>';

    $('#modal-nc-conteudo').innerHTML = html;
    $('#modal-nc').hidden = false;
    document.body.classList.add('modal-aberto');
    $('#modal-nc-conteudo').scrollTop = 0;
    await desenharFotosRetorno();
  }

  function dataHora(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  const SEM_FOTO = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#F3F5F7"/>' +
    '<text x="200" y="160" font-family="Arial" font-size="22" font-weight="700" fill="#4A5763" text-anchor="middle">Foto indisponível</text></svg>');
  function srcFoto(f) { return f && f.blob && !f.indisponivel ? URL.createObjectURL(f.blob) : SEM_FOTO; }

  async function desenharFotosRetorno() {
    const nc = est.atual;
    if (!nc) return;
    const cont = $('#nc-fotos-retorno');
    if (!cont) return;
    const fotos = await fotosDaNC(nc.id);
    const pode = podeTratar(nc);
    $('#nc-qtd-fotos').textContent = fotos.length ? plural(fotos.length, 'foto', 'fotos') : 'nenhuma foto';
    cont.innerHTML = fotos.length ? '' : '<div class="nc-j-sem-foto">Nenhuma foto do retorno anexada.</div>';
    fotos.forEach(f => {
      const d = document.createElement('div');
      d.className = 'evid-foto';
      d.innerHTML = '<img src="' + srcFoto(f) + '" alt="Foto do retorno">' +
        (pode ? '<button type="button" aria-label="Excluir foto">✕</button>' : '');
      const bt = d.querySelector('button');
      if (bt) bt.addEventListener('click', async () => {
        const c = await APP.confirmar('Excluir foto?', 'A foto do retorno será removida.', false, 'Excluir');
        if (!c.ok) return;
        await removerFoto(f.id);
        est.novasFotos = est.novasFotos.filter(x => x !== f.id);
        desenharFotosRetorno();
      });
      cont.appendChild(d);
    });
  }

  async function aoEscolherFotos(lista) {
    const nc = est.atual;
    if (!nc || !lista || !lista.length) return;
    APP.carregando(true, 'Otimizando ' + lista.length + ' foto(s)…');
    let ok = 0;
    try {
      for (const arq of Array.prototype.slice.call(lista)) {
        if (!/^image\//.test(arq.type)) continue;
        const f = await adicionarFoto(nc, arq);
        est.novasFotos.push(f.id);
        ok++;
      }
    } catch (e) {
      aviso(e.message || 'Falha ao processar a foto.', 'erro', 6);
    } finally {
      APP.carregando(false);
    }
    if (ok) aviso(plural(ok, 'foto anexada', 'fotos anexadas') + ' ao retorno.', 'sucesso', 3);
    desenharFotosRetorno();
  }

  async function salvarJanela() {
    const nc = est.atual;
    if (!nc || !podeTratar(nc)) return;
    const hoje = hojeISO();
    const sit = ($('input[name="nc-sit"]:checked') || {}).value || 'aberta';
    const campos = {
      situacao: sit,
      acao: $('#nc-acao').value.trim(),
      responsavelAcao: $('#nc-resp').value.trim(),
      dataPrevista: $('#nc-prevista').value || null,
      retorno: $('#nc-retorno').value.trim(),
      dataConclusao: $('#nc-conclusao').value || null
    };
    const erro = (msg, campo) => { aviso(msg, 'alerta', 6); if (campo) { const c = $(campo); c.focus(); c.classList.add('invalido'); setTimeout(() => c.classList.remove('invalido'), 2500); } };
    if (sit !== 'aberta' && !campos.acao) return erro('Descreva a ação corretiva.', '#nc-acao');
    if (campos.dataPrevista && campos.dataPrevista < nc.dataInspecao) return erro('A data prevista não pode ser anterior à inspeção (' + br(nc.dataInspecao) + ').', '#nc-prevista');
    if (sit === 'concluida') {
      if (!campos.retorno) return erro('Descreva o retorno: como a NC foi corrigida.', '#nc-retorno');
      if (!campos.dataConclusao) return erro('Informe a data real de conclusão.', '#nc-conclusao');
      if (campos.dataConclusao < nc.dataInspecao) return erro('A conclusão não pode ser anterior à inspeção (' + br(nc.dataInspecao) + ').', '#nc-conclusao');
      if (campos.dataConclusao > hoje) return erro('A data real de conclusão não pode ser futura.', '#nc-conclusao');
      const fotos = (await fotosDaNC(nc.id)).filter(f => !f.indisponivel);
      if (!fotos.length) return erro('Anexe ao menos 1 foto do retorno para concluir a NC.');
    } else {
      campos.dataConclusao = null;     // reaberta / ainda em tratativa
    }
    const novas = est.novasFotos.length;
    est.novasFotos = [];
    await salvar(nc, campos, novas);
    fecharJanela();
    aviso(sit === 'concluida' ? 'NC concluída. ✔' : 'Tratativa salva.', 'sucesso', 3);
    if (window.APP && APP.estado && APP.estado.tela === 'tela-detalhe' && APP.estado.detalheId === nc.inspecaoId) APP.abrirInspecao(nc.inspecaoId);
    if (!$('#tela-nc').hidden) montar();
    else atualizarBadge();
  }

  /* ===================================================================
   * EXPORTAÇÃO (Excel / Power BI)
   * =================================================================== */
  async function exportarCSV() {
    const hoje = hojeISO();
    const lista = ordenar(filtrarPorSituacao(aplicarBusca(await listarNCs()), hoje), hoje);
    if (!lista.length) { aviso('Nenhuma NC no filtro atual.', 'alerta'); return; }
    const cab = ['ID NC', 'Nº na inspeção', 'Lote', 'Canteiro', 'Empresa', 'Item', 'Pergunta', 'Descrição da NC',
      'Data da inspeção', 'Inspetor', 'Situação', 'Status do prazo', 'Ação corretiva', 'Responsável pela ação',
      'Data prevista', 'Data de conclusão', 'Dias em aberto / para tratar', 'Retorno', 'Fotos do retorno',
      'Atualizado por', 'Atualizado em'];
    const q = v => { const s = String(v == null ? '' : v).replace(/\r?\n/g, ' '); return /[;"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const rot = { vencida: 'Vencida', noprazo: 'No prazo', semprazo: 'Sem prazo', concluida: 'Concluída', concluida_prazo: 'Concluída no prazo', concluida_atraso: 'Concluída com atraso' };
    const linhas = [];
    for (const nc of lista) {
      const t = nc.trat || {};
      const qtdFotos = t.id ? await F().where('ncId').equals(nc.id).count() || (t.fotos || []).length : 0;
      linhas.push([nc.id, nc.numero, nc.lote, nc.canteiro, nc.empresa, nc.item, nc.pergunta, nc.obs,
        br(nc.dataInspecao), nc.inspetor, SIT[nc.situacao], rot[prazo(nc, hoje).chave] || '', t.acao, t.responsavelAcao,
        t.dataPrevista ? br(t.dataPrevista) : '', t.dataConclusao ? br(t.dataConclusao) : '', idade(nc, hoje),
        t.retorno, qtdFotos, t.atualizadoPorNome, t.atualizadoEm ? dataHora(t.atualizadoEm) : ''].map(q).join(';'));
    }
    const csv = '﻿' + cab.join(';') + '\r\n' + linhas.join('\r\n');
    const r = await APP.entregarArquivo(new Blob([csv], { type: 'text/csv;charset=utf-8' }),
      'NaoConformidades_' + hoje + '.csv', 'text/csv');
    APP.avisoEntrega && APP.avisoEntrega(r);
  }

  /* ===================================================================
   * LIGAÇÕES
   * =================================================================== */
  function ligar() {
    $$('[data-nc-filtro]').forEach(b => b.addEventListener('click', () => { est.filtro = b.dataset.ncFiltro; montar(); }));
    $('#nc-lote').addEventListener('change', e => { est.lote = e.target.value; montar(); });
    let tb = null;
    $('#nc-busca').addEventListener('input', e => { clearTimeout(tb); tb = setTimeout(() => { est.busca = e.target.value; montar(); }, 250); });
    $('#nc-exportar').addEventListener('click', () => exportarCSV().catch(e => aviso(e.message || String(e), 'erro')));
    $('#nc-lista').addEventListener('click', e => { const c = e.target.closest('.nc-t-card'); if (c) abrir(c.dataset.id); });
    $('#nc-lista').addEventListener('keydown', e => { if (e.key === 'Enter') { const c = e.target.closest('.nc-t-card'); if (c) abrir(c.dataset.id); } });

    $('#modal-nc').addEventListener('click', async e => {
      if (e.target.id === 'modal-nc') { await descartarNovasFotos(); fecharJanela(); return; }
      const a = e.target.closest('[data-nc-acao]');
      if (!a) return;
      const acao = a.dataset.ncAcao;
      if (acao === 'fechar') { e.preventDefault(); await descartarNovasFotos(); fecharJanela(); }
      if (acao === 'salvar') salvarJanela().catch(err => aviso(err.message || String(err), 'erro', 6));
      if (acao === 'camera') $('#nc-r-camera').click();
      if (acao === 'galeria') $('#nc-r-galeria').click();
      if (acao === 'inspecao') { e.preventDefault(); const id = est.atual.inspecaoId; await descartarNovasFotos(); fecharJanela(); APP.abrirInspecao(id); }
    });
    // Ao marcar "Concluída", sugere hoje como data real de conclusão
    $('#modal-nc').addEventListener('change', e => {
      if (e.target.name === 'nc-sit' && e.target.value === 'concluida' && !$('#nc-conclusao').value) $('#nc-conclusao').value = hojeISO();
    });
    ['#nc-r-camera', '#nc-r-galeria'].forEach(s => $(s).addEventListener('change', async e => {
      await aoEscolherFotos(e.target.files);
      e.target.value = '';
    }));
  }

  document.addEventListener('DOMContentLoaded', () => {
    if ($('#tela-nc')) ligar();
    carregarSituacaoTabela().catch(() => {});
  });

  return {
    montar: montar,
    abrir: abrir,
    idNC: idNC,
    listarNCs: listarNCs,
    prazo: prazo,
    daInspecao: daInspecao,
    sincronizar: sincronizar,
    atualizarBadge: atualizarBadge,
    tabelaDisponivel: tabelaDisponivel,
    rotuloSituacao: s => SIT[s] || s,
    hojeISO: hojeISO,
    _salvar: salvar, _adicionarFoto: adicionarFoto
  };
})();

window.TRAT = TRAT;
