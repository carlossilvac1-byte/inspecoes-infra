/* =====================================================================
 * cronograma.js — CRONOGRAMA DE INSPEÇÕES (Gantt programado x realizado)
 * ---------------------------------------------------------------------
 * Cada colaborador monta a programação anual das inspeções dos
 * canteiros dos lotes liberados para ele e vai dando "check" conforme
 * realiza. O Gantt mostra, semana a semana:
 *   PROGRAMADO ........ ainda não começou
 *   EM ANDAMENTO ...... dentro do período e ainda não realizado
 *   EM ATRASO ......... período vencido sem realização
 *   REALIZADO ......... marcado dentro do prazo
 *   REALIZADO C/ ATRASO marcado depois do término
 *
 * Quem vê o quê segue a mesma regra das inspeções (o banco decide):
 * administrador vê tudo; visão "todas" vê os seus lotes; os demais
 * veem só a própria programação. Só o autor marca/edita a sua.
 *
 * Funciona offline: tudo grava no aparelho e sobe na sincronização.
 * ===================================================================== */

const CRONO = (function () {

  const DIA = 86400000;
  const LARG_SEMANA = 30;         // px por semana no Gantt
  const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const MESES_LONGOS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto',
                        'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const ROTULO = {
    programado: 'Programado', andamento: 'Em andamento', atrasado: 'Em atraso',
    realizado: 'Realizado', realizado_atraso: 'Realizado c/ atraso'
  };

  const est = {
    ano: new Date().getFullYear(),
    visao: 'gantt',
    lote: '',
    responsavel: '',
    situacao: '',
    tabelaAusente: false,
    sincronizando: false
  };

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const aviso = (...a) => window.APP && APP.aviso(...a);

  /* ===================================================================
   * DATAS (sempre no fuso local, formato AAAA-MM-DD)
   * =================================================================== */
  function hojeISO() {
    const d = new Date();
    return iso(d);
  }
  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }
  function data(s) {
    const p = String(s).slice(0, 10).split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }
  function somaDias(s, n) { const d = data(s); d.setDate(d.getDate() + n); return iso(d); }
  function somaMeses(s, n) {
    const d = data(s); const dia = d.getDate();
    d.setDate(1); d.setMonth(d.getMonth() + n);
    const ult = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(dia, ult));
    return iso(d);
  }
  function br(s) { if (!s) return '—'; const p = String(s).slice(0, 10).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function brCurto(s) { const p = String(s).slice(0, 10).split('-'); return p[2] + '/' + p[1]; }

  /** Primeira segunda-feira da grade (na semana de 1º de janeiro). */
  function inicioGrade(ano) {
    const d = new Date(ano, 0, 1);
    const desloc = (d.getDay() + 6) % 7;          // segunda = 0
    d.setDate(d.getDate() - desloc);
    return d;
  }
  function semanasDoAno(ano) {
    const ini = inicioGrade(ano);
    const fim = new Date(ano, 11, 31);
    return Math.floor((fim - ini) / DIA / 7) + 1;
  }
  function semanaDe(s, ano) {
    return Math.floor((data(s) - inicioGrade(ano)) / DIA / 7);
  }

  /* ===================================================================
   * REGRAS
   * =================================================================== */
  function situacao(r, hoje) {
    hoje = hoje || hojeISO();
    if (r.realizadoEm) return r.realizadoEm > r.fim ? 'realizado_atraso' : 'realizado';
    if (hoje > r.fim) return 'atrasado';
    if (hoje >= r.inicio) return 'andamento';
    return 'programado';
  }
  function ehMeu(r) { return r.usuarioId === DB.usuarioAtual(); }
  function podeVer(r) {
    if (r.excluido) return false;
    if (ehMeu(r)) return true;
    return !!(AUTH.veTodas && AUTH.veTodas() && r.origem === 'servidor');
  }
  function lotesVisiveis() {
    const e = AUTH.estado();
    return CONFIG.lotesPermitidos(e.lotes, AUTH.ehAdmin());
  }
  function lotesQueProgramo() {
    // Programar só nos lotes liberados para o próprio usuário.
    return lotesVisiveis();
  }

  /* ===================================================================
   * DADOS LOCAIS
   * =================================================================== */
  const tabela = () => DB.db.cronograma;

  async function listar(ano) {
    const todos = await tabela().where('ano').equals(Number(ano)).toArray();
    return todos.filter(podeVer);
  }

  function novoItem(campos) {
    const p = AUTH.perfil() || {};
    const agora = new Date().toISOString();
    return Object.assign({
      id: DB.uuid(),
      usuarioId: DB.usuarioAtual(),
      responsavel: p.nome || '',
      ano: est.ano,
      lote: '', canteiro: '', empresa: '',
      itens: [],
      inicio: '', fim: '',
      realizadoEm: null, inspecaoId: null,
      observacao: '',
      excluido: 0,
      criadoEm: agora, atualizadoEm: agora,
      status: 'pendente', erroMsg: '', origem: 'aparelho'
    }, campos || {});
  }

  async function gravar(item) {
    item.atualizadoEm = new Date().toISOString();
    item.ano = Number(String(item.inicio).slice(0, 4));
    item.status = 'pendente';
    item.erroMsg = '';
    await tabela().put(item);
    sincronizarLogo();
    return item;
  }

  async function marcarRealizado(id, dataReal, inspecaoId) {
    const r = await tabela().get(id);
    if (!r || !ehMeu(r)) throw new Error('Somente quem programou pode dar o check.');
    r.realizadoEm = dataReal || hojeISO();
    if (inspecaoId) r.inspecaoId = inspecaoId;
    return gravar(r);
  }
  async function desmarcar(id) {
    const r = await tabela().get(id);
    if (!r || !ehMeu(r)) throw new Error('Somente quem programou pode alterar.');
    r.realizadoEm = null; r.inspecaoId = null;
    return gravar(r);
  }
  async function excluir(id) {
    const r = await tabela().get(id);
    if (!r || !ehMeu(r)) throw new Error('Somente quem programou pode excluir.');
    r.excluido = 1;
    return gravar(r);
  }

  /**
   * Chamado ao salvar uma inspeção: dá o check automático na programação
   * aberta do mesmo canteiro (a mais antiga cujo período já começou, ou
   * que começa em até 7 dias). Devolve o item marcado ou null.
   */
  async function aoSalvarInspecao(reg) {
    try {
      if (!reg || reg.excluido || !reg.dataInspecao) return null;
      const canteiro = DB.nomeCanteiro(reg);
      const ano = Number(String(reg.dataInspecao).slice(0, 4));
      const lista = (await tabela().where('ano').equals(ano).toArray())
        .filter(r => ehMeu(r) && !r.excluido && !r.realizadoEm &&
                     r.lote === reg.lote && r.canteiro === canteiro &&
                     reg.dataInspecao >= somaDias(r.inicio, -7))
        .sort((a, b) => a.inicio < b.inicio ? -1 : 1);
      if (!lista.length) return null;
      return await marcarRealizado(lista[0].id, reg.dataInspecao, reg.id);
    } catch (e) {
      return null;
    }
  }

  /* ===================================================================
   * SINCRONIZAÇÃO COM A BASE CENTRAL
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
    return status === 404 || /PGRST205|cronograma.*(schema cache|does not exist)|relation .*cronograma/i.test(texto || '');
  }

  async function enviar() {
    const uid = DB.usuarioAtual();
    const fila = (await tabela().where('usuarioId').equals(uid).toArray())
      .filter(r => r.status === 'pendente' || r.status === 'erro');
    let n = 0;
    for (const r of fila) {
      const linha = {
        id: r.id, usuario_id: uid, responsavel: r.responsavel, ano: r.ano, lote: r.lote,
        canteiro: r.canteiro, empresa: r.empresa || null, itens: r.itens || [],
        inicio: r.inicio, fim: r.fim, realizado_em: r.realizadoEm || null,
        inspecao_id: r.inspecaoId || null, observacao: r.observacao || null,
        excluido: !!r.excluido, criado_em: r.criadoEm, atualizado_em: r.atualizadoEm
      };
      const cab = await AUTH.cabecalhosAutenticados({ Prefer: 'resolution=merge-duplicates,return=minimal' });
      const resp = await fetchTimeout(base() + '/rest/v1/cronograma?on_conflict=id',
        { method: 'POST', headers: cab, body: JSON.stringify(linha) }, 20000);
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        if (tabelaFalta(resp.status, t)) { est.tabelaAusente = true; return n; }
        if (resp.status === 401) throw new Error('SESSAO_EXPIRADA');
        await tabela().update(r.id, { status: 'erro', erroMsg: resp.status === 403 || /row-level/i.test(t)
          ? 'Sem permissão no lote ' + r.lote + '.' : 'Base respondeu ' + resp.status });
        continue;
      }
      const atual = await tabela().get(r.id);
      if (atual && atual.atualizadoEm === r.atualizadoEm) {
        await tabela().update(r.id, { status: 'sincronizado', erroMsg: '' });
      }
      n++;
    }
    return n;
  }

  async function receber() {
    const uid = DB.usuarioAtual();
    const chave = 'cursorCronograma:' + uid;
    let cursor = await DB.kvGet(chave, '1970-01-01T00:00:00Z');
    let total = 0;
    for (let pag = 0; pag < 20; pag++) {
      const cab = await AUTH.cabecalhosAutenticados();
      const resp = await fetchTimeout(base() + '/rest/v1/cronograma?select=*&recebido_em=gt.' +
        encodeURIComponent(cursor) + '&order=recebido_em.asc&limit=500', { headers: cab }, 30000);
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        if (tabelaFalta(resp.status, t)) { est.tabelaAusente = true; return total; }
        throw new Error('Falha ao receber o cronograma (HTTP ' + resp.status + ').');
      }
      const linhas = await resp.json();
      for (const l of linhas) {
        cursor = l.recebido_em;
        const local = await tabela().get(l.id);
        if (local && local.usuarioId === uid && (local.status === 'pendente' || local.status === 'erro')) continue;
        await tabela().put({
          id: l.id, usuarioId: l.usuario_id, responsavel: l.responsavel || '', ano: l.ano,
          lote: l.lote, canteiro: l.canteiro, empresa: l.empresa || '', itens: l.itens || [],
          inicio: String(l.inicio).slice(0, 10), fim: String(l.fim).slice(0, 10),
          realizadoEm: l.realizado_em ? String(l.realizado_em).slice(0, 10) : null,
          inspecaoId: l.inspecao_id || null, observacao: l.observacao || '',
          excluido: l.excluido ? 1 : 0, criadoEm: l.criado_em, atualizadoEm: l.atualizado_em,
          status: 'sincronizado', erroMsg: '',
          origem: l.usuario_id === uid ? 'aparelho' : 'servidor'
        });
        total++;
      }
      await DB.kvSet(chave, cursor);
      if (linhas.length < 500) break;
    }
    return total;
  }

  /** Chamado dentro do ciclo do SYNC (com internet e sessão válida). */
  async function sincronizar() {
    if (!ativo()) return { pulado: true };
    est.tabelaAusente = false;
    const enviados = await enviar();
    const recebidos = est.tabelaAusente ? 0 : await receber();
    return { enviados: enviados, recebidos: recebidos, semTabela: est.tabelaAusente };
  }

  /* ===================================================================
   * TELA
   * =================================================================== */
  function anosDisponiveis() {
    const a = new Date().getFullYear();
    return [a - 2, a - 1, a, a + 1, a + 2];
  }

  function popularFiltros(itens) {
    const selAno = $('#cr-ano');
    if (!selAno.options.length) {
      anosDisponiveis().forEach(a => selAno.add(new Option(String(a), String(a))));
    }
    if (![].some.call(selAno.options, o => o.value === String(est.ano))) selAno.add(new Option(String(est.ano), String(est.ano)));
    selAno.value = String(est.ano);

    const selLote = $('#cr-lote');
    const lotes = lotesVisiveis();
    selLote.innerHTML = '<option value="">Todos os lotes</option>' +
      lotes.map(l => '<option value="' + esc(l) + '">' + esc(CONFIG.rotuloLote(l)) + '</option>').join('');
    selLote.value = lotes.indexOf(est.lote) !== -1 ? est.lote : '';

    const campoResp = $('#cr-campo-resp');
    const veTodas = AUTH.veTodas && AUTH.veTodas();
    campoResp.hidden = !veTodas;
    if (veTodas) {
      const nomes = Array.from(new Set(itens.map(r => r.responsavel).filter(Boolean)))
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));
      const sel = $('#cr-resp');
      sel.innerHTML = '<option value="">Todos</option><option value="__meus">Somente os meus</option>' +
        nomes.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
      sel.value = est.responsavel && (est.responsavel === '__meus' || nomes.indexOf(est.responsavel) !== -1) ? est.responsavel : '';
    }
    $('#cr-situacao').value = est.situacao;
    $$('[data-cr-visao]').forEach(b => b.classList.toggle('ativa', b.dataset.crVisao === est.visao));
  }

  function aplicarFiltros(itens, hoje) {
    return itens.filter(r =>
      (!est.lote || r.lote === est.lote) &&
      (!est.responsavel || (est.responsavel === '__meus' ? ehMeu(r) : r.responsavel === est.responsavel)) &&
      (!est.situacao || situacao(r, hoje) === est.situacao ||
        (est.situacao === 'realizado' && situacao(r, hoje) === 'realizado_atraso')));
  }

  function desenharIndicadores(itens, hoje) {
    const c = { programado: 0, andamento: 0, atrasado: 0, realizado: 0, realizado_atraso: 0 };
    itens.forEach(r => { c[situacao(r, hoje)]++; });
    const total = itens.length;
    const realizados = c.realizado + c.realizado_atraso;
    const vencidos = c.realizado + c.realizado_atraso + c.atrasado;   // já deveriam ter acontecido ou aconteceram
    const aderencia = vencidos ? Math.round(c.realizado / vencidos * 100) : null;
    const pct = total ? Math.round(realizados / total * 100) : 0;
    $('#cr-k-total').textContent = total;
    $('#cr-k-real').textContent = realizados;
    $('#cr-k-and').textContent = c.andamento;
    $('#cr-k-atr').textContent = c.atrasado;
    $('#cr-k-prog').textContent = c.programado;
    $('#cr-k-ader').textContent = aderencia === null ? '—' : aderencia + '%';
    $('#cr-barra-real').style.width = pct + '%';
    $('#cr-txt-progresso').textContent = total
      ? pct + '% do cronograma de ' + est.ano + ' realizado (' + realizados + ' de ' + total + ')'
      : 'Nenhuma inspeção programada em ' + est.ano + '. Toque em "+ Programar" para montar o cronograma.';
  }

  /** Linhas do Gantt: lote → canteiros (cadastro + os que aparecem na programação). */
  function montarLinhas(itens) {
    const lotes = est.lote ? [est.lote] : lotesVisiveis();
    const linhas = [];
    lotes.forEach(lote => {
      const doLote = itens.filter(r => r.lote === lote);
      let canteiros = CONFIG.listarCanteiros(lote);
      doLote.forEach(r => { if (canteiros.indexOf(r.canteiro) === -1) canteiros.push(r.canteiro); });
      if (est.situacao || est.responsavel) canteiros = canteiros.filter(c => doLote.some(r => r.canteiro === c));
      linhas.push({ tipo: 'lote', lote: lote, qtd: doLote.length });
      if (!canteiros.length) {
        linhas.push({ tipo: 'vazio', lote: lote });
        return;
      }
      canteiros.forEach(c => {
        const daLinha = doLote.filter(r => r.canteiro === c).sort((a, b) => a.inicio < b.inicio ? -1 : 1);
        // Distribui em "faixas" para barras que se sobrepõem não ficarem uma em cima da outra.
        const faixas = [];
        daLinha.forEach(r => {
          let f = faixas.findIndex(fx => fx[fx.length - 1].fim < r.inicio);
          if (f === -1) { faixas.push([r]); } else faixas[f].push(r);
        });
        linhas.push({ tipo: 'canteiro', lote: lote, canteiro: c, faixas: faixas.length ? faixas : [[]] });
      });
    });
    return linhas;
  }

  function desenharGantt(itens, hoje) {
    const ano = est.ano;
    const nSem = semanasDoAno(ano);
    const larg = nSem * LARG_SEMANA;
    const ini = inicioGrade(ano);

    // Cabeçalho: meses (pelo dia 1º de cada mês) e semanas
    let meses = '';
    for (let m = 0; m < 12; m++) {
      const a = Math.max(0, (new Date(ano, m, 1) - ini) / DIA / 7);
      const b = Math.min(nSem, (new Date(ano, m + 1, 1) - ini) / DIA / 7);
      meses += '<div class="gt-mes' + (m % 2 ? ' par' : '') + '" style="left:' + (a * LARG_SEMANA) +
               'px;width:' + ((b - a) * LARG_SEMANA) + 'px">' + MESES[m] + '</div>';
    }
    let semanas = '';
    for (let s = 0; s < nSem; s++) {
      const d = new Date(ini.getTime() + s * 7 * DIA);
      semanas += '<div class="gt-sem" style="left:' + (s * LARG_SEMANA) + 'px;width:' + LARG_SEMANA + 'px" title="Semana de ' +
                 iso(d).split('-').reverse().join('/') + '">' + String(d.getDate()).padStart(2, '0') + '</div>';
    }
    const semHoje = String(hoje).slice(0, 4) === String(ano) ? semanaDe(hoje, ano) : -1;
    const linhaHoje = semHoje >= 0
      ? '<div class="gt-hoje" style="left:' + ((data(hoje) - ini) / DIA / 7 * LARG_SEMANA) + 'px"><span>Hoje</span></div>' : '';

    // Faixas alternadas de mês no corpo (como no modelo)
    let fundos = '';
    for (let m = 0; m < 12; m += 2) {
      const a = Math.max(0, (new Date(ano, m, 1) - ini) / DIA / 7);
      const b = Math.min(nSem, (new Date(ano, m + 1, 1) - ini) / DIA / 7);
      fundos += '<div class="gt-faixa-mes" style="left:' + (a * LARG_SEMANA) + 'px;width:' + ((b - a) * LARG_SEMANA) + 'px"></div>';
    }

    const linhas = montarLinhas(itens);
    let esquerda = '';
    let direita = '';
    linhas.forEach(l => {
      if (l.tipo === 'lote') {
        esquerda += '<div class="gt-l gt-l-lote">' + esc(CONFIG.rotuloLote(l.lote)) +
                    '<small>' + l.qtd + ' programada(s)</small></div>';
        direita += '<div class="gt-r gt-r-lote" style="width:' + larg + 'px"></div>';
        return;
      }
      if (l.tipo === 'vazio') {
        esquerda += '<div class="gt-l gt-l-vazio">Sem canteiros cadastrados</div>';
        direita += '<div class="gt-r gt-r-vazio" data-lote="' + esc(l.lote) + '" style="width:' + larg + 'px">' +
                   '<span>Toque para programar um canteiro neste lote</span></div>';
        return;
      }
      const altura = Math.max(1, l.faixas.length) * 30 + 10;
      const emp = CONFIG.listarEmpresas(l.lote, l.canteiro).join(', ');
      esquerda += '<div class="gt-l gt-l-cant" style="height:' + altura + 'px" title="' + esc(l.canteiro) + '">' +
                  '<b>' + esc(l.canteiro.replace(/^Canteiro\s+/i, '')) + '</b>' +
                  (emp ? '<small>' + esc(emp) + '</small>' : '') + '</div>';
      let barras = '';
      l.faixas.forEach((fx, k) => fx.forEach(r => {
        const a = Math.max(0, (data(r.inicio) - ini) / DIA / 7);
        const b = Math.min(nSem, (data(r.fim) - ini) / DIA / 7 + 1 / 7);
        const st = situacao(r, hoje);
        const meu = ehMeu(r);
        const texto = (r.itens || []).join(', ') || 'Inspeção';
        let marca = '';
        if (r.realizadoEm) {
          const x = ((data(r.realizadoEm) - ini) / DIA / 7 + 0.5 / 7) * LARG_SEMANA;
          marca = '<i class="gt-check" style="left:' + x + 'px;top:' + (k * 30 + 9) + 'px" title="Realizado em ' + br(r.realizadoEm) + '">✓</i>';
        }
        barras += '<button type="button" class="gt-barra st-' + st + (meu ? '' : ' de-outro') + '" data-id="' + esc(r.id) + '" ' +
          'style="left:' + (a * LARG_SEMANA + 1) + 'px;width:' + Math.max(LARG_SEMANA * 0.6, (b - a) * LARG_SEMANA - 2) +
          'px;top:' + (k * 30 + 6) + 'px" title="' + esc(ROTULO[st] + ' • ' + br(r.inicio) + ' a ' + br(r.fim) + ' • ' + texto +
          (r.responsavel ? ' • ' + r.responsavel : '')) + '">' +
          '<span>' + esc((b - a) * LARG_SEMANA < 70 ? (r.itens || []).map(i => i.charAt(0)).join('·') || '•' : texto) +
          '</span></button>' + marca;
      }));
      direita += '<div class="gt-r gt-r-cant" data-lote="' + esc(l.lote) + '" data-canteiro="' + esc(l.canteiro) + '" ' +
                 'style="width:' + larg + 'px;height:' + altura + 'px">' + barras + '</div>';
    });

    $('#cr-gantt').innerHTML =
      '<div class="gt">' +
        '<div class="gt-esq">' +
          '<div class="gt-l gt-l-cab">Lote / Canteiro</div>' + esquerda +
        '</div>' +
        '<div class="gt-dir" id="cr-gantt-rolagem">' +
          '<div class="gt-corpo" style="width:' + larg + 'px">' +
            '<div class="gt-cab"><div class="gt-meses">' + meses + '</div><div class="gt-semanas">' + semanas + '</div></div>' +
            '<div class="gt-linhas">' + fundos + direita + linhaHoje + '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    // Centraliza na semana atual (ou no início do ano)
    const rol = $('#cr-gantt-rolagem');
    if (rol) rol.scrollLeft = semHoje > 2 ? (semHoje - 2) * LARG_SEMANA : 0;
  }

  function desenharLista(itens, hoje) {
    const cont = $('#cr-lista');
    if (!itens.length) {
      cont.innerHTML = '<div class="vazio">Nenhuma inspeção programada para os filtros escolhidos.</div>';
      return;
    }
    const ordem = itens.slice().sort((a, b) => a.inicio < b.inicio ? -1 : a.inicio > b.inicio ? 1 : a.canteiro.localeCompare(b.canteiro));
    let html = ''; let mesAtual = -1;
    ordem.forEach(r => {
      const m = data(r.inicio).getMonth();
      if (m !== mesAtual) { mesAtual = m; html += '<h3 class="cr-mes">' + MESES_LONGOS[m] + ' ' + est.ano + '</h3>'; }
      const st = situacao(r, hoje);
      const meu = ehMeu(r);
      html += '<div class="cr-item st-' + st + '" data-id="' + esc(r.id) + '">' +
        '<div class="cr-item-txt">' +
          '<div class="cr-item-topo"><span class="cr-chip st-' + st + '">' + ROTULO[st] + '</span>' +
            '<span class="cr-periodo">' + brCurto(r.inicio) + ' a ' + brCurto(r.fim) + '</span></div>' +
          '<b>' + esc(r.canteiro) + '</b>' +
          '<small>' + esc(CONFIG.rotuloLote(r.lote)) + ' • ' + esc((r.itens || []).join(', ') || 'Inspeção') +
            (meu ? '' : ' • ' + esc(r.responsavel)) +
            (r.realizadoEm ? ' • realizado em ' + br(r.realizadoEm) : '') + '</small>' +
        '</div>' +
        (meu
          ? (r.realizadoEm
              ? '<button type="button" class="cr-check feito" data-acao="desmarcar" aria-label="Desmarcar">✓</button>'
              : '<button type="button" class="cr-check" data-acao="check" aria-label="Marcar como realizado">✓</button>')
          : '<span class="cr-check so-leitura" aria-hidden="true">' + (r.realizadoEm ? '✓' : '') + '</span>') +
      '</div>';
    });
    cont.innerHTML = html;
  }

  async function montar() {
    const hoje = hojeISO();
    const todos = await listar(est.ano);
    popularFiltros(todos);
    const itens = aplicarFiltros(todos, hoje);
    desenharIndicadores(itens, hoje);
    $('#cr-gantt').hidden = est.visao !== 'gantt';
    $('#cr-legenda').hidden = est.visao !== 'gantt';
    $('#cr-lista').hidden = est.visao !== 'lista';
    if (est.visao === 'gantt') desenharGantt(itens, hoje);
    else desenharLista(itens, hoje);
    $('#cr-aviso-base').hidden = !est.tabelaAusente;
  }

  /* ===================================================================
   * JANELAS (programar / detalhe)
   * =================================================================== */
  function abrirJanela(html) {
    const m = $('#modal-crono');
    $('#modal-crono-conteudo').innerHTML = html;
    m.hidden = false;
    document.body.classList.add('modal-aberto');
  }
  function fecharJanela() {
    $('#modal-crono').hidden = true;
    document.body.classList.remove('modal-aberto');
  }

  function opcoesCanteiros(lote, selecionado) {
    const lista = CONFIG.listarCanteiros(lote);
    let h = '';
    if (lista.length > 1) h += '<option value="__todos">Todos os canteiros do lote (' + lista.length + ')</option>';
    h += lista.map(c => '<option value="' + esc(c) + '"' + (c === selecionado ? ' selected' : '') + '>' + esc(c) + '</option>').join('');
    h += '<option value="__outro"' + (selecionado && lista.indexOf(selecionado) === -1 ? ' selected' : '') + '>Outro (digitar)</option>';
    return h;
  }

  /** Janela "Programar inspeção" (nova ou edição). */
  function abrirProgramar(pre) {
    pre = pre || {};
    const lotes = lotesQueProgramo();
    if (!lotes.length) { aviso('Você não tem lotes liberados para programar.', 'alerta', 6); return; }
    const editando = !!pre.id;
    const lote = pre.lote && lotes.indexOf(pre.lote) !== -1 ? pre.lote : lotes[0];
    const anoAtual = new Date().getFullYear();
    let inicio = pre.inicio;
    if (!inicio) {
      // padrão: próxima segunda-feira dentro do ano escolhido
      const base = est.ano === anoAtual ? new Date() : new Date(est.ano, 0, 1);
      const d = new Date(base); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
      if (d.getFullYear() !== est.ano) d.setTime(new Date(est.ano, 0, 1).getTime());
      inicio = iso(d);
    }
    const fim = pre.fim || somaDias(inicio, 4);
    const itensMarcados = pre.itens || [];

    abrirJanela(
      '<h3>' + (editando ? 'Editar programação' : 'Programar inspeção') + '</h3>' +
      '<label class="campo"><span class="rotulo">Lote</span><select id="pg-lote">' +
        lotes.map(l => '<option value="' + esc(l) + '"' + (l === lote ? ' selected' : '') + '>' + esc(CONFIG.rotuloLote(l)) + '</option>').join('') +
      '</select></label>' +
      '<label class="campo"><span class="rotulo">Canteiro</span><select id="pg-canteiro"></select></label>' +
      '<label class="campo" id="pg-campo-outro" hidden><span class="rotulo">Nome do canteiro</span>' +
        '<input type="text" id="pg-canteiro-outro" placeholder="Ex.: Canteiro COX - Balsas"></label>' +
      '<div class="campo"><span class="rotulo">O que será inspecionado</span><div class="lista-check pg-itens">' +
        CONFIG.itensInspecao.map(i => '<label' + (itensMarcados.indexOf(i) !== -1 ? ' class="marcado"' : '') + '><input type="checkbox" value="' + esc(i) + '"' +
          (itensMarcados.indexOf(i) !== -1 ? ' checked' : '') + '><span>' + esc(i) + '</span></label>').join('') +
      '</div></div>' +
      '<div class="pg-datas">' +
        '<label class="campo"><span class="rotulo">Início</span><input type="date" id="pg-inicio" value="' + inicio + '"></label>' +
        '<label class="campo"><span class="rotulo">Término</span><input type="date" id="pg-fim" value="' + fim + '"></label>' +
      '</div>' +
      (editando ? '' :
        '<label class="campo"><span class="rotulo">Repetir no ano</span><select id="pg-repetir">' +
          '<option value="0">Não repetir</option><option value="1">Todo mês</option><option value="2">A cada 2 meses</option>' +
          '<option value="3">A cada 3 meses</option><option value="6">A cada 6 meses</option></select></label>') +
      '<label class="campo"><span class="rotulo">Observação (opcional)</span><input type="text" id="pg-obs" value="' + esc(pre.observacao || '') + '"></label>' +
      '<p class="apoio pequena" id="pg-resumo"></p>' +
      '<div class="pg-botoes">' +
        '<button type="button" class="btn btn-neutro" id="pg-cancelar">Cancelar</button>' +
        '<button type="button" class="btn btn-primario" id="pg-salvar">' + (editando ? 'Salvar' : 'Programar') + '</button>' +
      '</div>');

    const atualizarCanteiros = (sel) => {
      $('#pg-canteiro').innerHTML = opcoesCanteiros($('#pg-lote').value, sel);
      if (!CONFIG.listarCanteiros($('#pg-lote').value).length) $('#pg-canteiro').value = '__outro';
      const outro = $('#pg-canteiro').value === '__outro';
      $('#pg-campo-outro').hidden = !outro;
      if (outro && sel && CONFIG.listarCanteiros($('#pg-lote').value).indexOf(sel) === -1) $('#pg-canteiro-outro').value = sel;
      resumo();
    };
    const resumo = () => {
      const qtdCant = $('#pg-canteiro').value === '__todos' ? CONFIG.listarCanteiros($('#pg-lote').value).length : 1;
      const rep = $('#pg-repetir') ? Number($('#pg-repetir').value) : 0;
      const ocorr = rep ? datasRepetidas($('#pg-inicio').value, $('#pg-fim').value, rep).length : 1;
      const total = qtdCant * ocorr;
      $('#pg-resumo').textContent = total > 1 ? 'Serão criadas ' + total + ' programações (' + qtdCant +
        ' canteiro(s) × ' + ocorr + ' período(s) em ' + est.ano + ').' : '';
    };
    $('#pg-lote').addEventListener('change', () => atualizarCanteiros(''));
    $('#pg-canteiro').addEventListener('change', () => { $('#pg-campo-outro').hidden = $('#pg-canteiro').value !== '__outro'; resumo(); });
    $('#pg-inicio').addEventListener('change', () => {
      if ($('#pg-fim').value < $('#pg-inicio').value) $('#pg-fim').value = somaDias($('#pg-inicio').value, 4);
      resumo();
    });
    $('#pg-fim').addEventListener('change', resumo);
    if ($('#pg-repetir')) $('#pg-repetir').addEventListener('change', resumo);
    $$('.pg-itens input').forEach(i => i.addEventListener('change', e => e.target.parentNode.classList.toggle('marcado', e.target.checked)));
    $('#pg-cancelar').addEventListener('click', fecharJanela);
    $('#pg-salvar').addEventListener('click', () => salvarProgramacao(pre));
    atualizarCanteiros(pre.canteiro || '');
    if (pre.canteiro) $('#pg-canteiro').value = CONFIG.listarCanteiros(lote).indexOf(pre.canteiro) !== -1 ? pre.canteiro : '__outro';
    $('#pg-campo-outro').hidden = $('#pg-canteiro').value !== '__outro';
  }

  /** Períodos repetidos dentro do mesmo ano, mantendo a duração. */
  function datasRepetidas(inicio, fim, passoMeses) {
    if (!inicio || !fim) return [];
    const dur = Math.round((data(fim) - data(inicio)) / DIA);
    const ano = Number(inicio.slice(0, 4));
    const out = [];
    for (let k = 0; k < 12; k++) {
      const ini = somaMeses(inicio, k * passoMeses);
      if (Number(ini.slice(0, 4)) !== ano) break;
      out.push([ini, somaDias(ini, dur)]);
      if (!passoMeses) break;
    }
    return out;
  }

  async function salvarProgramacao(pre) {
    const lote = $('#pg-lote').value;
    let canteiro = $('#pg-canteiro').value;
    const outro = $('#pg-canteiro-outro').value.trim();
    const itens = $$('.pg-itens input:checked').map(i => i.value);
    const inicio = $('#pg-inicio').value;
    const fim = $('#pg-fim').value;
    const obs = $('#pg-obs').value.trim();
    const rep = $('#pg-repetir') ? Number($('#pg-repetir').value) : 0;

    if (canteiro === '__outro') canteiro = outro;
    if (!canteiro) { aviso('Informe o canteiro.', 'erro', 5); return; }
    if (!itens.length) { aviso('Marque o que será inspecionado.', 'erro', 5); return; }
    if (!inicio || !fim) { aviso('Informe início e término.', 'erro', 5); return; }
    if (fim < inicio) { aviso('O término não pode ser antes do início.', 'erro', 5); return; }
    if (inicio.slice(0, 4) !== fim.slice(0, 4)) { aviso('Início e término precisam estar no mesmo ano.', 'erro', 6); return; }

    try {
      if (pre.id) {
        const r = await tabela().get(pre.id);
        if (!r || !ehMeu(r)) throw new Error('Somente quem programou pode editar.');
        Object.assign(r, {
          lote: lote, canteiro: canteiro, empresa: CONFIG.listarEmpresas(lote, canteiro).join(', '),
          itens: itens, inicio: inicio, fim: fim, observacao: obs
        });
        await gravar(r);
        aviso('Programação atualizada.', 'sucesso', 3);
      } else {
        const canteiros = canteiro === '__todos' ? CONFIG.listarCanteiros(lote) : [canteiro];
        const periodos = rep ? datasRepetidas(inicio, fim, rep) : [[inicio, fim]];
        let n = 0;
        for (const c of canteiros) {
          for (const p of periodos) {
            await gravar(novoItem({
              lote: lote, canteiro: c, empresa: CONFIG.listarEmpresas(lote, c).join(', '),
              itens: itens.slice(), inicio: p[0], fim: p[1], observacao: obs
            }));
            n++;
          }
        }
        aviso(n === 1 ? 'Inspeção programada.' : n + ' inspeções programadas.', 'sucesso', 4);
      }
      est.ano = Number(inicio.slice(0, 4));
      fecharJanela();
      montar();
    } catch (e) {
      aviso(e.message || String(e), 'erro', 8);
    }
  }

  async function abrirDetalhe(id) {
    const r = await tabela().get(id);
    if (!r) return;
    const hoje = hojeISO();
    const st = situacao(r, hoje);
    const meu = ehMeu(r);
    const dias = st === 'atrasado' ? Math.round((data(hoje) - data(r.fim)) / DIA) : 0;
    abrirJanela(
      '<div class="cr-det-topo"><span class="cr-chip st-' + st + '">' + ROTULO[st] + '</span>' +
        (dias ? '<span class="cr-atraso">' + dias + ' dia(s) de atraso</span>' : '') + '</div>' +
      '<h3>' + esc(r.canteiro) + '</h3>' +
      '<table class="tabela-detalhe"><tbody>' +
        '<tr><th>Lote</th><td>' + esc(CONFIG.rotuloLote(r.lote)) + '</td></tr>' +
        (r.empresa ? '<tr><th>Empresa</th><td>' + esc(r.empresa) + '</td></tr>' : '') +
        '<tr><th>Inspecionar</th><td>' + esc((r.itens || []).join(', ')) + '</td></tr>' +
        '<tr><th>Programado</th><td>' + br(r.inicio) + ' a ' + br(r.fim) + '</td></tr>' +
        '<tr><th>Realizado</th><td>' + (r.realizadoEm ? br(r.realizadoEm) + (r.inspecaoId ? ' (inspeção registrada)' : '') : '—') + '</td></tr>' +
        '<tr><th>Responsável</th><td>' + esc(r.responsavel || '—') + '</td></tr>' +
        (r.observacao ? '<tr><th>Observação</th><td>' + esc(r.observacao) + '</td></tr>' : '') +
      '</tbody></table>' +
      (meu && !r.realizadoEm
        ? '<label class="campo"><span class="rotulo">Data da realização</span><input type="date" id="dt-real" value="' +
          (hoje > r.fim || hoje < r.inicio ? (hoje < r.inicio ? r.inicio : hoje) : hoje) + '" max="' + hoje + '"></label>' : '') +
      '<div class="pg-botoes pg-botoes-det">' +
        (meu
          ? (r.realizadoEm
              ? '<button type="button" class="btn btn-neutro" data-acao="desmarcar">Desfazer check</button>'
              : '<button type="button" class="btn btn-primario" data-acao="check">✓ Marcar como realizado</button>' +
                '<button type="button" class="btn btn-secundario" data-acao="registrar">Registrar inspeção agora</button>') +
            '<button type="button" class="btn btn-neutro" data-acao="editar">Editar</button>' +
            '<button type="button" class="btn btn-neutro" data-acao="excluir">Excluir</button>'
          : (r.inspecaoId ? '<button type="button" class="btn btn-secundario" data-acao="ver-insp">Ver inspeção</button>' : '')) +
        (meu && r.inspecaoId ? '<button type="button" class="btn btn-secundario" data-acao="ver-insp">Ver inspeção</button>' : '') +
        '<button type="button" class="btn btn-neutro" data-acao="fechar">Fechar</button>' +
      '</div>');

    $('#modal-crono-conteudo').querySelector('.pg-botoes').addEventListener('click', async (ev) => {
      const acao = ev.target.dataset && ev.target.dataset.acao;
      if (!acao) return;
      try {
        if (acao === 'fechar') return fecharJanela();
        if (acao === 'check') {
          const d = $('#dt-real') ? $('#dt-real').value : hojeISO();
          if (!d) { aviso('Informe a data da realização.', 'erro', 4); return; }
          await marcarRealizado(r.id, d);
          aviso('Check registrado.', 'sucesso', 3);
        }
        if (acao === 'desmarcar') { await desmarcar(r.id); aviso('Check desfeito.', 'sucesso', 3); }
        if (acao === 'excluir') {
          fecharJanela();
          const c = await APP.confirmar('Excluir programação?', 'A programação de ' + r.canteiro + ' (' + br(r.inicio) +
            ' a ' + br(r.fim) + ') sai do cronograma.', false, 'Excluir');
          if (!c.ok) return;
          await excluir(r.id);
          aviso('Programação excluída.', 'sucesso', 3);
        }
        if (acao === 'editar') { fecharJanela(); abrirProgramar(r); return; }
        if (acao === 'registrar') { fecharJanela(); APP.inspecaoProgramada(r); return; }
        if (acao === 'ver-insp') { fecharJanela(); APP.abrirInspecao(r.inspecaoId); return; }
        fecharJanela();
        montar();
      } catch (e) {
        aviso(e.message || String(e), 'erro', 6);
      }
    });
  }

  /* ===================================================================
   * EVENTOS
   * =================================================================== */
  function ligar() {
    $('#cr-ano').addEventListener('change', e => { est.ano = Number(e.target.value); montar(); });
    $('#cr-ano-ant').addEventListener('click', () => { est.ano--; montar(); });
    $('#cr-ano-prox').addEventListener('click', () => { est.ano++; montar(); });
    $('#cr-lote').addEventListener('change', e => { est.lote = e.target.value; montar(); });
    $('#cr-resp').addEventListener('change', e => { est.responsavel = e.target.value; montar(); });
    $('#cr-situacao').addEventListener('change', e => { est.situacao = e.target.value; montar(); });
    $$('[data-cr-visao]').forEach(b => b.addEventListener('click', () => { est.visao = b.dataset.crVisao; montar(); }));
    $('#cr-programar').addEventListener('click', () => abrirProgramar({ lote: est.lote }));
    $('#modal-crono').addEventListener('click', e => { if (e.target.id === 'modal-crono') fecharJanela(); });

    // Gantt: barra abre o detalhe; espaço vazio programa naquela semana
    $('#cr-gantt').addEventListener('click', e => {
      const barra = e.target.closest('.gt-barra');
      if (barra) { abrirDetalhe(barra.dataset.id); return; }
      const linha = e.target.closest('.gt-r-cant, .gt-r-vazio');
      if (!linha) return;
      if (lotesQueProgramo().indexOf(linha.dataset.lote) === -1) return;
      const x = e.clientX - linha.getBoundingClientRect().left;
      const sem = Math.max(0, Math.floor(x / LARG_SEMANA));
      const seg = new Date(inicioGrade(est.ano).getTime() + sem * 7 * DIA);
      let ini = iso(seg);
      if (ini.slice(0, 4) !== String(est.ano)) ini = est.ano + '-01-01';
      let fim = somaDias(ini, 4);
      if (fim.slice(0, 4) !== String(est.ano)) fim = est.ano + '-12-31';
      abrirProgramar({ lote: linha.dataset.lote, canteiro: linha.dataset.canteiro || '', inicio: ini, fim: fim });
    });

    // Lista: botão de check direto
    $('#cr-lista').addEventListener('click', async e => {
      const item = e.target.closest('.cr-item');
      if (!item) return;
      const acao = e.target.dataset && e.target.dataset.acao;
      try {
        if (acao === 'check') {
          await marcarRealizado(item.dataset.id, hojeISO());
          aviso('Check registrado (' + br(hojeISO()) + ').', 'sucesso', 3);
          montar();
          return;
        }
        if (acao === 'desmarcar') {
          const c = await APP.confirmar('Desfazer o check?', 'A programação volta a contar como não realizada.', false, 'Desfazer');
          if (!c.ok) return;
          await desmarcar(item.dataset.id);
          montar();
          return;
        }
        abrirDetalhe(item.dataset.id);
      } catch (err) {
        aviso(err.message || String(err), 'erro', 6);
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => { if ($('#tela-cronograma')) ligar(); });

  return {
    montar: montar,
    sincronizar: sincronizar,
    aoSalvarInspecao: aoSalvarInspecao,
    situacao: situacao,
    datasRepetidas: datasRepetidas,
    listar: listar,
    estado: est
  };
})();

window.CRONO = CRONO;
