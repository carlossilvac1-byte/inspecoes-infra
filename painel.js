/* =====================================================================
 * painel.js — PAINEL DE INDICADORES (visão BI, página única)
 * ---------------------------------------------------------------------
 * Layout no padrão de BI: menu lateral (Resumo / Análises / Canteiros),
 * barra superior com Período, Filtros e Última atualização, faixa de
 * KPIs, painéis de lote / situação / NCs, análises e a tabela de
 * cobertura dos canteiros com abas por lote e paginação.
 *
 * Tudo é calculado a partir da base do aparelho (IndexedDB), que já
 * contém o que o usuário pode ver (próprias, do lote, ou tudo para o
 * administrador). Funciona offline. Gráficos em SVG/HTML puros.
 *
 * Regras de gráfico: um único eixo por gráfico; "Com NC" sempre em
 * vermelho e "Sem NC" em verde-água (par validado para daltonismo),
 * sempre com legenda e rótulo — cor nunca é a única pista; dica ao
 * passar o dedo/mouse.
 * ===================================================================== */

const PAINEL = (function () {

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dataBR = (s) => PDFGEN.dataBR(s);

  const COR_OK = '#1F9E8F';      // Sem NC / conforme
  const COR_NC = '#D64545';      // Com NC
  const POR_PAGINA = 10;

  let periodo = 'mes';
  let dadosAtuais = null;
  let empresasDisponiveis = [];
  const filtro = { lote: '', empresa: '' };
  const tabela = { lote: '', pagina: 1 };

  /* ===================================================================
   * PERÍODO
   * =================================================================== */
  function hojeISO() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  function isoLocal(d) {
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function intervalo() {
    const hoje = new Date();
    const fim = hojeISO();
    if (periodo === 'mes') return { de: fim.slice(0, 8) + '01', ate: fim };
    if (periodo === '3meses') return { de: isoLocal(new Date(hoje.getFullYear(), hoje.getMonth() - 2, 1)), ate: fim };
    if (periodo === '12meses') return { de: isoLocal(new Date(hoje.getFullYear(), hoje.getMonth() - 11, 1)), ate: fim };
    if (periodo === 'ano') return { de: fim.slice(0, 4) + '-01-01', ate: fim };
    const de = $('#pa-de').value || (fim.slice(0, 4) + '-01-01');
    return { de: de, ate: $('#pa-ate').value || fim };
  }

  const NOMES_PERIODO = { mes: 'Mês atual', '3meses': 'Últimos 3 meses', '12meses': 'Últimos 12 meses',
                          ano: 'Ano corrente', custom: 'Personalizado' };
  function rotuloPeriodo(iv) {
    return NOMES_PERIODO[periodo] + ' — ' + dataBR(iv.de) + ' a ' + dataBR(iv.ate);
  }

  /* ===================================================================
   * CÁLCULO DOS INDICADORES
   * =================================================================== */
  async function calcular() {
    const iv = intervalo();
    const lotesUsuario = AUTH.lotes().filter(l => !filtro.lote || l === filtro.lote);

    const todas = (await DB.listarInspecoes({}))                     // base visível ao usuário
      .filter(r => (!filtro.lote || r.lote === filtro.lote) &&
                   (!filtro.empresa || DB.nomeEmpresa(r) === filtro.empresa));
    empresasDisponiveis = Array.from(new Set((await DB.listarInspecoes({})).map(r => DB.nomeEmpresa(r))
      .concat(CONFIG.empresas))).filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const noPeriodo = todas.filter(r => r.dataInspecao >= iv.de && r.dataInspecao <= iv.ate);

    // Total de fotos do período — é o volume de evidência do dossiê.
    let totalFotos = 0;
    for (const r of noPeriodo) totalFotos += await DB.contarFotos(r.id);

    const comNC = noPeriodo.filter(r => r.naoConformidade === 'Sim');
    const ncAcumuladas = todas.filter(r => r.naoConformidade === 'Sim');

    // --- Cobertura de canteiros -----------------------------------
    const canteirosCadastrados = [];
    lotesUsuario.forEach(l => {
      CONFIG.listarCanteiros(l).forEach(c => canteirosCadastrados.push({ canteiro: c, lote: l }));
    });
    // Canteiros digitados como "Outro" também entram na cobertura
    todas.forEach(r => {
      const nome = DB.nomeCanteiro(r);
      if (!canteirosCadastrados.some(c => c.canteiro === nome && c.lote === r.lote)) {
        canteirosCadastrados.push({ canteiro: nome, lote: r.lote, foraDoCadastro: true });
      }
    });

    const hoje = new Date(hojeISO() + 'T00:00:00');
    const cobertura = canteirosCadastrados.map(c => {
      const doCanteiro = todas.filter(r => DB.nomeCanteiro(r) === c.canteiro && r.lote === c.lote);
      const doPeriodo = noPeriodo.filter(r => DB.nomeCanteiro(r) === c.canteiro && r.lote === c.lote);
      const ultima = doCanteiro.length
        ? doCanteiro.map(r => r.dataInspecao).sort().slice(-1)[0] : null;
      const dias = ultima
        ? Math.round((hoje - new Date(ultima + 'T00:00:00')) / 86400000) : null;
      const cor = (dias === null || dias > CONFIG.limites.diasSemaforoAmarelo) ? 'vermelho'
                : (dias <= CONFIG.limites.diasSemaforoVerde) ? 'verde' : 'amarelo';
      return {
        canteiro: c.canteiro, lote: c.lote, ultima: ultima, dias: dias,
        noPeriodo: doPeriodo.length,
        ncs: doPeriodo.filter(r => r.naoConformidade === 'Sim').length,
        semaforo: cor
      };
    }).sort((a, b) => (b.dias === null ? 99999 : b.dias) - (a.dias === null ? 99999 : a.dias));

    const inspecionadosNoPeriodo = new Set(noPeriodo.map(r => r.lote + '|' + DB.nomeCanteiro(r))).size;
    const totalCanteiros = canteirosCadastrados.filter(c => !c.foraDoCadastro).length || canteirosCadastrados.length;

    // --- Dias desde a última inspeção -----------------------------
    const ultimaGeral = todas.length ? todas.map(r => r.dataInspecao).sort().slice(-1)[0] : null;
    const diasUltima = ultimaGeral
      ? Math.round((hoje - new Date(ultimaGeral + 'T00:00:00')) / 86400000) : null;

    // --- Séries dos gráficos --------------------------------------
    const porLote = lotesUsuario.map(l => {
      const doLote = noPeriodo.filter(r => r.lote === l);
      return { rotulo: l, total: doLote.length, nc: doLote.filter(r => r.naoConformidade === 'Sim').length };
    }).filter(x => x.total > 0 || lotesUsuario.length <= 4);

    const mapaCanteiroNC = {};
    comNC.forEach(r => {
      const k = DB.nomeCanteiro(r);
      mapaCanteiroNC[k] = (mapaCanteiroNC[k] || 0) + 1;
    });
    const rankingCanteiros = Object.keys(mapaCanteiroNC)
      .map(k => ({ rotulo: k, valor: mapaCanteiroNC[k] }))
      .sort((a, b) => b.valor - a.valor).slice(0, 8);

    const empresas = CONFIG.empresas.slice();
    noPeriodo.forEach(r => {
      const e = DB.nomeEmpresa(r);
      if (e && empresas.indexOf(e) === -1) empresas.push(e);
    });
    const porEmpresa = empresas.map(e => {
      const daEmpresa = noPeriodo.filter(r => DB.nomeEmpresa(r) === e);
      return { rotulo: e, total: daEmpresa.length, nc: daEmpresa.filter(r => r.naoConformidade === 'Sim').length };
    }).filter(x => x.total > 0);

    // Evolução: 12 meses até o fim do período
    const evolucao = [];
    const refFim = new Date(iv.ate + 'T00:00:00');
    for (let i = 11; i >= 0; i--) {
      const d = new Date(refFim.getFullYear(), refFim.getMonth() - i, 1);
      const chave = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      const doMes = todas.filter(r => (r.dataInspecao || '').slice(0, 7) === chave);
      const nc = doMes.filter(r => r.naoConformidade === 'Sim').length;
      evolucao.push({
        rotulo: String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getFullYear()).slice(2),
        total: doMes.length,
        nc: nc,
        pctNc: doMes.length ? Math.round(nc * 100 / doMes.length) : 0
      });
    }

    const porItem = {};
    noPeriodo.forEach(r => {
      (r.inspecionado || []).forEach(i => { porItem[i] = (porItem[i] || 0) + 1; });
    });
    const itens = Object.keys(porItem).map(k => ({ rotulo: k, valor: porItem[k] }))
      .sort((a, b) => b.valor - a.valor);

    const porResponsavel = {};
    noPeriodo.forEach(r => {
      porResponsavel[r.responsavel] = (porResponsavel[r.responsavel] || 0) + 1;
    });
    const responsaveis = Object.keys(porResponsavel)
      .map(k => ({ rotulo: k, valor: porResponsavel[k] }))
      .sort((a, b) => b.valor - a.valor);

    // Checklist SIM/NÃO do período: perguntas com mais NÃO e % geral de SIM
    const mapaCk = {};
    let respSim = 0, respTotal = 0;
    noPeriodo.forEach(r => {
      const ck = r.checklist || {};
      Object.keys(ck).forEach(item => (ck[item] || []).forEach(q => {
        if (!q.resposta) return;
        respTotal++;
        if (q.resposta === 'SIM') respSim++;
        else {
          const k = item + '|' + q.pergunta;
          mapaCk[k] = mapaCk[k] || { item: item, pergunta: q.pergunta, valor: 0 };
          mapaCk[k].valor++;
        }
      }));
    });
    const checklistNao = Object.keys(mapaCk).map(k => mapaCk[k])
      .sort((a, b) => b.valor - a.valor).slice(0, 8)
      .map(x => ({ rotulo: x.item + ' — ' + x.pergunta, valor: x.valor }));

    dadosAtuais = {
      checklistNao: checklistNao,
      conformes: noPeriodo.length - comNC.length,
      inspecoesPeriodo: noPeriodo,
      totalAcumulado: todas.length,
      filtro: Object.assign({}, filtro),
      checklistRespostas: respTotal,
      pctChecklistSim: respTotal ? Math.round(respSim * 100 / respTotal) : null,
      periodo: periodo,
      rotuloPeriodo: rotuloPeriodo(iv),
      de: iv.de, ate: iv.ate,
      lotes: lotesUsuario,
      total: noPeriodo.length,
      comNC: comNC.length,
      pctNC: noPeriodo.length ? Math.round(comNC.length * 100 / noPeriodo.length) : 0,
      ncAcumuladas: ncAcumuladas.length,
      canteirosInspecionados: inspecionadosNoPeriodo,
      totalCanteiros: totalCanteiros,
      pctCobertura: totalCanteiros ? Math.round(inspecionadosNoPeriodo * 100 / totalCanteiros) : 0,
      diasUltima: diasUltima,
      ultimaData: ultimaGeral,
      fotos: totalFotos,
      porLote: porLote,
      rankingCanteiros: rankingCanteiros,
      porEmpresa: porEmpresa,
      evolucao: evolucao,
      itens: itens,
      responsaveis: responsaveis,
      cobertura: cobertura,
      ehAdmin: AUTH.ehAdmin(),
      responsavelAtual: AUTH.perfil() ? AUTH.perfil().nome : ''
    };
    return dadosAtuais;
  }

  /* ===================================================================
   * ÍCONES (traço, herdam a cor do texto)
   * =================================================================== */
  const ICONE = {
    prancheta: '<path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1z"/><path d="M8 5H6.5A1.5 1.5 0 0 0 5 6.5v13A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17.5 5H16"/><path d="M9 11h6M9 15h4"/>',
    escudo: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
    documento: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    capacete: '<path d="M4 17h16v2H4z"/><path d="M5 17a7 7 0 0 1 14 0"/><path d="M10 10V7h4v3"/>',
    calendario: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    ok: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
    vazio: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 14h6"/>'
  };
  const icone = (n, cls) => '<svg class="' + (cls || 'bi-ic') + '" viewBox="0 0 24 24" aria-hidden="true">' + ICONE[n] + '</svg>';

  function vazio(msg, nomeIcone) {
    return '<div class="bi-vazio">' + icone(nomeIcone || 'vazio', 'bi-ic-vazio') + '<span>' + esc(msg) + '</span></div>';
  }
  const pct = (a, b) => b ? Math.round(a * 100 / b) : 0;
  const dicaNC = (rot, total, nc) => rot + ' — ' + total + ' inspeção(ões) • ' + (total - nc) + ' sem NC • ' +
    nc + ' com NC (' + pct(nc, total) + '%)';

  /* ===================================================================
   * KPIs
   * =================================================================== */
  function kpi(nomeIcone, rotulo, valor, sub, classe) {
    return '<div class="bi-kpi ' + (classe || '') + '">' + icone(nomeIcone, 'bi-kpi-ic') +
      '<div class="bi-kpi-txt"><span class="bi-kpi-rot">' + esc(rotulo) + '</span>' +
      '<b class="bi-kpi-val">' + valor + '</b>' +
      '<span class="bi-kpi-sub">' + sub + '</span></div></div>';
  }

  function desenharKpis(d) {
    $('#bi-kpis').innerHTML =
      kpi('prancheta', 'Inspeções no período', d.total, d.totalAcumulado + ' no acumulado') +
      kpi('escudo', 'Com não conformidade', d.pctNC + '%', d.comNC + ' de ' + d.total + ' inspeções',
          d.comNC ? 'k-alerta' : '') +
      kpi('documento', 'NCs em aberto (acumulado)', d.ncAcumuladas, 'em ' + d.totalAcumulado + ' inspeções registradas',
          d.ncAcumuladas ? 'k-alerta' : '') +
      kpi('capacete', 'Canteiros inspecionados', d.pctCobertura + '%',
          d.canteirosInspecionados + ' de ' + d.totalCanteiros + ' canteiros (cobertura)') +
      kpi('calendario', 'Última inspeção', d.ultimaData ? dataBR(d.ultimaData) : '—',
          d.diasUltima === null ? 'nenhuma registrada' : (d.diasUltima === 0 ? 'hoje' : 'há ' + d.diasUltima + ' dia(s)'),
          d.diasUltima !== null && d.diasUltima > CONFIG.limites.diasSemaforoVerde ? 'k-atencao' : '') +
      kpi('camera', 'Fotos registradas', d.fotos, 'evidências no período');
  }

  /* ===================================================================
   * BARRAS HORIZONTAIS (HTML) — empilhadas Sem NC / Com NC
   * =================================================================== */
  function barrasEmpilhadas(dados, msgVazio) {
    if (!dados.length || !dados.some(x => x.total)) return vazio(msgVazio || 'Sem dados no período.');
    const max = Math.max.apply(null, dados.map(x => x.total)) || 1;
    return '<div class="bi-barras">' + dados.map(x => {
      const ok = x.total - x.nc;
      return '<div class="bi-barra-linha" data-dica="' + esc(dicaNC(x.rotulo, x.total, x.nc)) + '">' +
        '<span class="bi-barra-rot" title="' + esc(x.rotulo) + '">' + esc(x.rotulo) + '</span>' +
        '<span class="bi-barra-trilho">' +
          (ok ? '<i class="seg-ok" style="width:' + (ok / max * 100) + '%"></i>' : '') +
          (x.nc ? '<i class="seg-nc" style="width:' + (x.nc / max * 100) + '%"></i>' : '') +
        '</span>' +
        '<span class="bi-barra-val">' + x.total + (x.nc ? ' <small>(' + x.nc + ' NC)</small>' : '') + '</span>' +
      '</div>';
    }).join('') + '</div>';
  }

  function barrasSimples(dados, cor, opcoes) {
    opcoes = opcoes || {};
    if (!dados.length) return vazio(opcoes.vazio || 'Sem dados no período.', opcoes.icone);
    const max = Math.max.apply(null, dados.map(x => x.valor)) || 1;
    const total = opcoes.pctDe || 0;
    return '<div class="bi-barras">' + dados.map(x =>
      '<div class="bi-barra-linha' + (opcoes.longo ? ' longo' : '') + '" data-dica="' + esc(x.rotulo + ' — ' + x.valor +
        (opcoes.sufixo || '') + (total ? ' (' + pct(x.valor, total) + '%)' : '')) + '">' +
        '<span class="bi-barra-rot" title="' + esc(x.rotulo) + '">' + esc(x.rotulo) + '</span>' +
        '<span class="bi-barra-trilho"><i style="width:' + (x.valor / max * 100) + '%;background:' + cor + '"></i></span>' +
        '<span class="bi-barra-val">' + x.valor + (total ? ' <small>' + pct(x.valor, total) + '%</small>' : '') + '</span>' +
      '</div>').join('') + '</div>';
  }

  /* ===================================================================
   * ROSCA — situação das inspeções do período
   * =================================================================== */
  function rosca(d) {
    const total = d.total, ok = d.conformes, nc = d.comNC;
    const R = 46, C = 2 * Math.PI * R;
    let arcos = '';
    if (!total) {
      arcos = '<circle cx="60" cy="60" r="' + R + '" fill="none" stroke="#E6ECF1" stroke-width="16"/>';
    } else {
      const gap = (ok && nc) ? 2 : 0;          // 2px de respiro entre os segmentos
      const lOk = ok / total * C, lNc = nc / total * C;
      if (ok) arcos += '<circle cx="60" cy="60" r="' + R + '" fill="none" stroke="' + COR_OK + '" stroke-width="16" ' +
        'stroke-dasharray="' + Math.max(0, lOk - gap) + ' ' + C + '" transform="rotate(-90 60 60)">' +
        '<title>Conforme: ' + ok + ' (' + pct(ok, total) + '%)</title></circle>';
      if (nc) arcos += '<circle cx="60" cy="60" r="' + R + '" fill="none" stroke="' + COR_NC + '" stroke-width="16" ' +
        'stroke-dasharray="' + Math.max(0, lNc - gap) + ' ' + C + '" stroke-dashoffset="' + (-lOk) + '" transform="rotate(-90 60 60)">' +
        '<title>Com NC: ' + nc + ' (' + pct(nc, total) + '%)</title></circle>';
    }
    return '<div class="bi-rosca">' +
      '<svg viewBox="0 0 120 120" role="img" aria-label="Situação das inspeções: ' + ok + ' conformes, ' + nc + ' com NC">' + arcos +
        '<text x="60" y="60" text-anchor="middle" class="bi-rosca-num">' + total + '</text>' +
        '<text x="60" y="78" text-anchor="middle" class="bi-rosca-rot">Total</text></svg>' +
      '<ul class="bi-rosca-leg">' +
        '<li data-dica="Inspeções sem não conformidade no período"><i style="background:' + COR_OK + '"></i>Conforme<b>' + ok + ' <small>(' + pct(ok, total) + '%)</small></b></li>' +
        '<li data-dica="Inspeções com não conformidade no período"><i style="background:' + COR_NC + '"></i>Com NC<b>' + nc + ' <small>(' + pct(nc, total) + '%)</small></b></li>' +
        '<li class="sep" data-dica="Inspeções com NC em toda a base visível"><i class="anel"></i>NC em aberto (acumulado)<b>' + d.ncAcumuladas + '</b></li>' +
      '</ul></div>';
  }

  /* ===================================================================
   * COLUNAS — evolução mensal (um eixo; empilhado Sem NC / Com NC)
   * =================================================================== */
  function evolucao(dados, L) {
    if (!dados.some(m => m.total)) return vazio('Sem inspeções nos últimos 12 meses.');
    const A = 210, mE = 30, mD = 8, mT = 18, mB = 24;
    const w = Math.max(280, L);
    const area = w - mE - mD, alt = A - mT - mB;
    const max = Math.max.apply(null, dados.map(m => m.total));
    const passo = max <= 4 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : Math.ceil(max / 5 / 10) * 10;
    const topo = Math.ceil(max / passo) * passo || 1;
    const y = v => mT + alt - v / topo * alt;
    const col = area / dados.length;
    const bw = Math.min(26, col * 0.58);
    let g = '';
    for (let v = 0; v <= topo; v += passo) {
      g += '<line x1="' + mE + '" x2="' + (w - mD) + '" y1="' + y(v) + '" y2="' + y(v) + '" class="bi-linha-grade"/>' +
           '<text x="' + (mE - 6) + '" y="' + (y(v) + 3.5) + '" text-anchor="end" class="bi-eixo">' + v + '</text>';
    }
    const ultimo = dados.length - 1;
    dados.forEach((m, i) => {
      const x = mE + i * col + (col - bw) / 2;
      const ok = m.total - m.nc;
      const hOk = ok / topo * alt, hNc = m.nc / topo * alt;
      const base = mT + alt;
      let barras = '';
      if (ok) barras += '<rect x="' + x + '" y="' + (base - hOk) + '" width="' + bw + '" height="' + hOk + '" rx="' + (m.nc ? 0 : 3) + '" fill="' + COR_OK + '"/>';
      if (m.nc) barras += '<rect x="' + x + '" y="' + (base - hOk - hNc - (ok ? 2 : 0)) + '" width="' + bw + '" height="' + hNc + '" rx="3" fill="' + COR_NC + '"/>';
      g += '<g class="bi-col' + (i === ultimo ? ' atual' : '') + '" data-dica="' + esc(dicaNC(m.rotulo, m.total, m.nc)) + '">' +
        '<rect x="' + (mE + i * col) + '" y="' + mT + '" width="' + col + '" height="' + alt + '" class="bi-col-alvo"/>' + barras +
        (m.total ? '<text x="' + (x + bw / 2) + '" y="' + (base - hOk - hNc - (m.nc && ok ? 2 : 0) - 5) + '" text-anchor="middle" class="bi-col-val">' + m.total + '</text>' : '') +
        ((dados.length <= 12 && (col >= 34 || i % 2 === ultimo % 2))
          ? '<text x="' + (x + bw / 2) + '" y="' + (A - 7) + '" text-anchor="middle" class="bi-eixo' + (i === ultimo ? ' forte' : '') + '">' + m.rotulo + '</text>' : '') +
        '</g>';
    });
    return '<svg class="bi-svg" viewBox="0 0 ' + w + ' ' + A + '" width="100%" height="' + A + '" role="img" aria-label="Evolução mensal de inspeções">' + g + '</svg>';
  }

  /* ===================================================================
   * TABELA DE COBERTURA (abas por lote + paginação)
   * =================================================================== */
  function desenharTabela(d) {
    const lotes = Array.from(new Set(d.cobertura.map(c => c.lote)));
    if (tabela.lote && lotes.indexOf(tabela.lote) === -1) tabela.lote = '';
    $('#bi-abas-lote').innerHTML = ['<button type="button" class="bi-aba' + (!tabela.lote ? ' ativa' : '') + '" data-lote="">Todos</button>']
      .concat(lotes.map(l => '<button type="button" class="bi-aba' + (tabela.lote === l ? ' ativa' : '') + '" data-lote="' + esc(l) + '">' + esc(l) + '</button>')).join('');
    const lista = d.cobertura.filter(c => !tabela.lote || c.lote === tabela.lote);
    const paginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA));
    tabela.pagina = Math.min(Math.max(1, tabela.pagina), paginas);
    $('#bi-pag-txt').textContent = tabela.pagina + '/' + paginas;
    $('#bi-pag-ant').disabled = tabela.pagina <= 1;
    $('#bi-pag-prox').disabled = tabela.pagina >= paginas;
    const corpo = $('#bi-cobertura tbody');
    const pagina = lista.slice((tabela.pagina - 1) * POR_PAGINA, tabela.pagina * POR_PAGINA);
    if (!pagina.length) {
      corpo.innerHTML = '<tr><td colspan="6" class="bi-td-vazio">Nenhum canteiro cadastrado para os lotes selecionados.</td></tr>';
      return;
    }
    const rot = { verde: 'Em dia', amarelo: 'Atenção', vermelho: 'Crítico' };
    corpo.innerHTML = pagina.map(c =>
      '<tr><td title="' + esc(c.canteiro) + '">' + esc(String(c.canteiro).replace(/^Canteiro\s+/i, '')) + '</td>' +
      '<td>' + esc(c.lote) + '</td>' +
      '<td>' + (c.ultima ? dataBR(c.ultima) : '—') + '</td>' +
      '<td class="bi-n">' + c.noPeriodo + '</td>' +
      '<td class="bi-n' + (c.ncs ? ' nc' : '') + '">' + c.ncs + '</td>' +
      '<td><span class="semaforo ' + c.semaforo + '"><i></i>' +
        (c.dias === null ? 'Nunca inspecionado' : (c.dias === 0 ? 'Hoje' : 'Há ' + c.dias + ' dia(s)')) +
        ' <small class="bi-sit">' + rot[c.semaforo] + '</small></span></td></tr>').join('');
  }

  /* ===================================================================
   * MONTAGEM
   * =================================================================== */
  function largura(sel) {
    const el = $(sel);
    return el ? Math.floor(el.clientWidth) : 600;
  }

  function preencherFiltros() {
    const lotes = AUTH.lotes();
    const sl = $('#bi-f-lote');
    sl.innerHTML = '<option value="">Todos os lotes</option>' + lotes.map(l => '<option value="' + esc(l) + '">' + esc(l) + '</option>').join('');
    sl.value = filtro.lote;
    const se = $('#bi-f-empresa');
    se.innerHTML = '<option value="">Todas as empresas</option>' + empresasDisponiveis.map(e => '<option value="' + esc(e) + '">' + esc(e) + '</option>').join('');
    se.value = filtro.empresa;
    const n = (filtro.lote ? 1 : 0) + (filtro.empresa ? 1 : 0);
    $('#bi-filtros-qtd').textContent = n ? n : '';
    $('#bi-filtros-qtd').hidden = !n;
  }

  async function atualizarCarimbo() {
    let quando = new Date();
    if (window.SYNC && SYNC.ativo()) {
      const u = await SYNC.ultimaSincronizacao();
      if (u) quando = new Date(u);
    }
    $('#bi-atualizacao').textContent = quando.toLocaleDateString('pt-BR') + ', ' +
      quando.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  async function montar() {
    const d = await calcular();
    const p = AUTH.perfil() || {};
    $('#bi-usuario-nome').textContent = p.nome || '—';
    $('#bi-usuario-funcao').textContent = (p.funcao || '') + (AUTH.ehAdmin() ? ' • Administrador' : '');
    $('#bi-periodo-txt').textContent = dataBR(d.de) + ' a ' + dataBR(d.ate);
    $('#bi-periodo-nome').textContent = NOMES_PERIODO[periodo];
    $$('[data-periodo]').forEach(b => b.classList.toggle('ativo', b.dataset.periodo === periodo));
    $('#periodo-custom').hidden = periodo !== 'custom';
    preencherFiltros();
    atualizarCarimbo();
    desenharKpis(d);
    desenharGraficos(d);
    desenharTabela(d);
    return d;
  }

  function desenharGraficos(d) {
    d = d || dadosAtuais;
    if (!d) return;
    $('#pa-graf-lote').innerHTML = barrasEmpilhadas(d.porLote.map(x => ({ rotulo: x.rotulo, total: x.total, nc: x.nc })));
    $('#pa-graf-status').innerHTML = rosca(d);
    $('#pa-graf-canteiros').innerHTML = d.rankingCanteiros.length
      ? barrasSimples(d.rankingCanteiros.map(x => ({ rotulo: String(x.rotulo).replace(/^Canteiro\s+/i, ''), valor: x.valor })), COR_NC,
                      { sufixo: ' inspeção(ões) com NC' })
      : '<div class="bi-tudo-ok">' + icone('ok', 'bi-ic-ok') + '<div><b>Nenhuma não conformidade no período.</b>' +
        '<span>Todas as inspeções do período estão conformes.</span></div></div>';
    $('#pa-graf-evolucao').innerHTML = evolucao(d.evolucao, largura('#pa-graf-evolucao'));
    $('#pa-graf-empresa').innerHTML = barrasEmpilhadas(d.porEmpresa);
    const totalItens = d.itens.reduce((t, x) => t + x.valor, 0);
    $('#pa-graf-itens').innerHTML = barrasSimples(d.itens, COR_OK, { pctDe: totalItens });
    $('#pa-graf-checklist').innerHTML = barrasSimples((d.checklistNao || []).slice(0, 5), COR_NC, {
      longo: true, sufixo: ' resposta(s) NÃO',
      vazio: d.checklistRespostas ? 'Nenhuma resposta NÃO no período.' : 'Nenhum checklist respondido no período.' });
    $('#pa-ck-sub').textContent = d.pctChecklistSim === null ? '' : d.pctChecklistSim + '% das respostas conformes (SIM)';
    if (window.MAPA) {
      const info = MAPA.painel(document.getElementById('bi-mapa-area'), d.inspecoesPeriodo || []);
      $('#bi-mapa-info').textContent = info.total + ' local(is) no período' +
        (info.semCoord ? ' • ' + info.semCoord + ' sem GPS' : '');
    }
    $('#cartao-graf-responsavel').hidden = !d.ehAdmin;
    if (d.ehAdmin) $('#pa-graf-responsavel').innerHTML = barrasSimples(d.responsaveis, COR_OK, { sufixo: ' inspeção(ões)' });
  }

  // Redesenha a evolução ao mudar a largura (girar o celular, maximizar…)
  let esperaResize = null, larguraAnterior = 0;
  window.addEventListener('resize', () => {
    clearTimeout(esperaResize);
    esperaResize = setTimeout(() => {
      const tela = document.getElementById('tela-painel');
      if (!tela || tela.hidden || !dadosAtuais) return;
      if (Math.abs(window.innerWidth - larguraAnterior) < 8) return;
      larguraAnterior = window.innerWidth;
      desenharGraficos();
    }, 180);
  });

  function definirPeriodo(novo) {
    periodo = novo;
    if (novo === 'custom' && !$('#pa-de').value) {
      const fim = hojeISO();
      $('#pa-de').value = fim.slice(0, 4) + '-01-01';
      $('#pa-ate').value = fim;
    }
    if (novo !== 'custom') fecharMenus();
    montar();
  }

  async function exportarPDF() {
    APP.carregando(true, 'Montando o PDF do painel…');
    try {
      const d = dadosAtuais || await calcular();
      const r = await PDFGEN.gerarPainel(d);
      APP.avisoEntrega(r);
    } catch (e) {
      APP.aviso('Falha ao gerar o PDF: ' + (e.message || e), 'erro', 0);
    } finally {
      APP.carregando(false);
    }
  }

  /* ===================================================================
   * DICA FLUTUANTE (mouse e toque)
   * =================================================================== */
  function ligarDica() {
    const dica = document.createElement('div');
    dica.className = 'bi-dica'; dica.hidden = true; dica.setAttribute('role', 'tooltip');
    document.body.appendChild(dica);
    const tela = $('#tela-painel');
    const mostrar = (ev) => {
      const alvo = ev.target.closest && ev.target.closest('[data-dica]');
      if (!alvo || !tela.contains(alvo)) { dica.hidden = true; return; }
      dica.textContent = alvo.dataset.dica;
      dica.hidden = false;
      const x = ev.clientX, y = ev.clientY;
      const lw = dica.offsetWidth, lh = dica.offsetHeight;
      dica.style.left = Math.max(8, Math.min(window.innerWidth - lw - 8, x - lw / 2)) + 'px';
      dica.style.top = (y - lh - 14 < 8 ? y + 18 : y - lh - 14) + 'px';
    };
    tela.addEventListener('pointermove', mostrar);
    tela.addEventListener('pointerdown', mostrar);
    tela.addEventListener('pointerleave', () => { dica.hidden = true; });
    window.addEventListener('scroll', () => { dica.hidden = true; }, { passive: true });
  }

  /* ===================================================================
   * EVENTOS
   * =================================================================== */
  function fecharMenus() {
    $('#bi-menu-periodo').hidden = true;
    $('#bi-menu-filtros').hidden = true;
    $('#bi-btn-periodo').setAttribute('aria-expanded', 'false');
    $('#bi-btn-filtros').setAttribute('aria-expanded', 'false');
  }
  function alternar(menu, botao) {
    const abrir = $(menu).hidden;
    fecharMenus();
    $(menu).hidden = !abrir;
    $(botao).setAttribute('aria-expanded', String(abrir));
  }

  function ligarEventos() {
    if (!$('#tela-painel')) return;
    $('#bi-btn-periodo').addEventListener('click', (e) => { e.stopPropagation(); alternar('#bi-menu-periodo', '#bi-btn-periodo'); });
    $('#bi-btn-filtros').addEventListener('click', (e) => { e.stopPropagation(); alternar('#bi-menu-filtros', '#bi-btn-filtros'); });
    ['#bi-menu-periodo', '#bi-menu-filtros'].forEach(m => $(m).addEventListener('click', e => e.stopPropagation()));
    document.addEventListener('click', fecharMenus);
    $$('[data-periodo]').forEach(b => b.addEventListener('click', () => definirPeriodo(b.dataset.periodo)));
    ['#pa-de', '#pa-ate'].forEach(s => $(s).addEventListener('change', () => { periodo = 'custom'; montar(); }));
    $('#bi-f-lote').addEventListener('change', e => { filtro.lote = e.target.value; tabela.pagina = 1; montar(); });
    $('#bi-f-empresa').addEventListener('change', e => { filtro.empresa = e.target.value; tabela.pagina = 1; montar(); });
    $('#bi-f-limpar').addEventListener('click', () => { filtro.lote = ''; filtro.empresa = ''; fecharMenus(); montar(); });
    $('#btn-pdf-painel').addEventListener('click', exportarPDF);
    $('#bi-abas-lote').addEventListener('click', e => {
      const b = e.target.closest('[data-lote]'); if (!b) return;
      tabela.lote = b.dataset.lote; tabela.pagina = 1; desenharTabela(dadosAtuais);
    });
    $('#bi-pag-ant').addEventListener('click', () => { tabela.pagina--; desenharTabela(dadosAtuais); });
    $('#bi-pag-prox').addEventListener('click', () => { tabela.pagina++; desenharTabela(dadosAtuais); });
    // Menu lateral: rola até a seção e marca a ativa
    $$('[data-bi-ir]').forEach(b => b.addEventListener('click', () => {
      const alvo = document.getElementById(b.dataset.biIr);
      if (alvo) window.scrollTo({ top: alvo.getBoundingClientRect().top + window.scrollY - 70, behavior: 'smooth' });
    }));
    window.addEventListener('scroll', () => {
      if ($('#tela-painel').hidden) return;
      let atual = 'bi-resumo';
      ['bi-resumo', 'bi-analises', 'bi-mapa', 'bi-canteiros'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top < 140) atual = id;
      });
      $$('[data-bi-ir]').forEach(b => b.classList.toggle('ativo', b.dataset.biIr === atual));
    }, { passive: true });
    ligarDica();
  }

  document.addEventListener('DOMContentLoaded', ligarEventos);

  return {
    montar: montar,
    calcular: calcular,
    definirPeriodo: definirPeriodo,
    exportarPDF: exportarPDF,
    dados: () => dadosAtuais
  };
})();

window.PAINEL = PAINEL;
