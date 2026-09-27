/* =====================================================================
 * painel.js — PAINEL DE INDICADORES
 * ---------------------------------------------------------------------
 * Tudo é calculado a partir da BASE LOCAL (IndexedDB), portanto o
 * painel funciona integralmente offline, e sempre restrito aos lotes
 * do usuário autenticado (o DB.listarInspecoes já aplica esse filtro).
 *
 * Os gráficos são desenhados em SVG puro, sem biblioteca externa —
 * nada para baixar, nada para quebrar sem rede.
 * ===================================================================== */

const PAINEL = (function () {

  const $ = (s) => document.querySelector(s);
  const C = () => CONFIG.cores;

  let periodo = 'mes';
  let dadosAtuais = null;

  /* ===================================================================
   * PERÍODO
   * =================================================================== */
  function hojeISO() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function intervalo() {
    const hoje = new Date();
    const fim = hojeISO();
    let ini;
    if (periodo === 'mes') {
      ini = fim.slice(0, 8) + '01';
    } else if (periodo === '3meses') {
      const d = new Date(hoje.getFullYear(), hoje.getMonth() - 2, 1);
      ini = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    } else if (periodo === 'ano') {
      ini = fim.slice(0, 4) + '-01-01';
    } else {
      ini = $('#pa-de').value || (fim.slice(0, 4) + '-01-01');
      return { de: ini, ate: $('#pa-ate').value || fim };
    }
    return { de: ini, ate: fim };
  }

  function rotuloPeriodo(iv) {
    const nomes = { mes: 'Mês atual', '3meses': 'Últimos 3 meses', ano: 'Ano corrente', custom: 'Período personalizado' };
    return nomes[periodo] + ' — ' + PDFGEN.dataBR(iv.de) + ' a ' + PDFGEN.dataBR(iv.ate);
  }

  /* ===================================================================
   * CÁLCULO DOS INDICADORES
   * =================================================================== */
  async function calcular() {
    const iv = intervalo();
    const lotesUsuario = AUTH.lotes();

    const todas = await DB.listarInspecoes({});                    // base inteira do usuário
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
   * DESENHO DOS GRÁFICOS (SVG puro)
   * -------------------------------------------------------------------
   * Cada gráfico é desenhado na largura REAL do cartão (1 unidade = 1 px),
   * então o texto fica sempre no mesmo tamanho legível, seja qual for a
   * coluna da grade. Ao redimensionar a janela, os gráficos são refeitos.
   * Um único eixo por gráfico; valores escritos nas marcas; dica (title)
   * ao passar o mouse.
   * =================================================================== */
  const FONTE = 'Calibri, Arial, sans-serif';
  const COR_TRILHO = '#EEF2F5';

  function svg(largura, altura, conteudo, titulo) {
    return '<svg viewBox="0 0 ' + largura + ' ' + altura + '" width="' + largura + '" height="' + altura +
           '" role="img" aria-label="' + escaparSvg(titulo || '') + '" style="max-width:100%;height:auto">' +
           conteudo + '</svg>';
  }

  function texto(x, y, txt, opcoes) {
    const o = opcoes || {};
    return '<text x="' + x + '" y="' + y + '" ' +
      'font-family="' + FONTE + '" ' +
      'font-size="' + (o.tamanho || 12) + '" ' +
      'font-weight="' + (o.peso || 'normal') + '" ' +
      'fill="' + (o.cor || C().textoApoio) + '" ' +
      'text-anchor="' + (o.ancora || 'start') + '"' +
      '>' + escaparSvg(txt) + '</text>';
  }

  function escaparSvg(t) {
    return String(t === null || t === undefined ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** Retângulo com cantos arredondados só no topo (barra vertical) ou na ponta (horizontal). */
  function barra(x, y, l, a, cor, dica, direcao) {
    l = Math.max(0, l); a = Math.max(0, a);
    if (!l || !a) return '';
    const r = Math.min(4, l / 2, a / 2);
    let d;
    if (direcao === 'h') {
      d = 'M' + x + ',' + y + ' H' + (x + l - r) + ' Q' + (x + l) + ',' + y + ' ' + (x + l) + ',' + (y + r) +
          ' V' + (y + a - r) + ' Q' + (x + l) + ',' + (y + a) + ' ' + (x + l - r) + ',' + (y + a) + ' H' + x + ' Z';
    } else if (direcao === 'reto') {
      d = 'M' + x + ',' + y + ' H' + (x + l) + ' V' + (y + a) + ' H' + x + ' Z';
    } else {
      d = 'M' + x + ',' + (y + a) + ' V' + (y + r) + ' Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
          ' H' + (x + l - r) + ' Q' + (x + l) + ',' + y + ' ' + (x + l) + ',' + (y + r) + ' V' + (y + a) + ' Z';
    }
    return '<path d="' + d + '" fill="' + cor + '">' + (dica ? '<title>' + escaparSvg(dica) + '</title>' : '') + '</path>';
  }

  /** Encurta rótulos para caber na largura disponível (≈ 6,2 px por caractere a 12 px). */
  function encurtar(txt, larguraPx, tamanho, manterPrefixo) {
    const s = manterPrefixo ? String(txt) : String(txt).replace(/^Canteiro\s+(?=[A-ZÀ-Ú]{2})/, '');
    const max = Math.max(4, Math.floor(larguraPx / ((tamanho || 12) * 0.52)));
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function semDados(msg) { return '<p class="apoio pequena sem-dados">' + msg + '</p>'; }

  /** Escala "redonda" para o eixo: 1, 2, 5, 10, 20… */
  function passoEixo(max) {
    const bruto = max / 4;
    const pot = Math.pow(10, Math.floor(Math.log10(Math.max(1, bruto))));
    const n = [1, 2, 5, 10].find(m => m * pot >= bruto) * pot;
    return Math.max(1, n);
  }

  /* --- Colunas: total com a parcela de NC empilhada na base --------- */
  function graficoColunas(dados, L, opcoes) {
    const o = opcoes || {};
    if (!dados.length || !dados.some(d => d.total)) return semDados(o.vazio || 'Sem inspeções no período.');
    const A = o.altura || 230;
    const mE = 30, mD = 6, mT = 20, mB = o.rotuloDuplo ? 40 : 28;
    const lu = L - mE - mD, au = A - mT - mB;
    const passo = passoEixo(Math.max(1, ...dados.map(d => d.total)));
    const topo = Math.ceil(Math.max(1, ...dados.map(d => d.total)) / passo) * passo;
    const slot = lu / dados.length;
    const lb = Math.max(6, Math.min(56, slot * 0.6));
    const base = mT + au;

    let s = '';
    for (let v = 0; v <= topo; v += passo) {
      const y = base - (v / topo) * au;
      s += '<line x1="' + mE + '" y1="' + y + '" x2="' + (L - mD) + '" y2="' + y + '" stroke="' +
           (v === 0 ? '#C9D2D9' : C().borda) + '" stroke-width="1"' + (v === 0 ? '' : ' stroke-dasharray="2 3"') + '/>';
      s += texto(mE - 6, y + 4, String(v), { ancora: 'end', tamanho: 11 });
    }
    dados.forEach((d, i) => {
      const x = mE + slot * i + (slot - lb) / 2;
      const nc = d.nc || 0, ok = d.total - nc;
      const hNc = (nc / topo) * au, hOk = (ok / topo) * au;
      const dica = d.rotulo + ': ' + d.total + ' inspeç' + (d.total === 1 ? 'ão' : 'ões') +
                   (nc ? ' · ' + nc + ' com NC' : '');
      // NC na base (vermelho), conformes acima (verde-água), 2 px de respiro entre as partes
      if (hNc > 0) s += barra(x, base - hNc, lb, hNc, C().naoConforme, dica, ok ? 'reto' : undefined);
      if (hOk > 0) s += barra(x, base - hNc - hOk + (hNc > 0 ? 0 : 0), lb, hOk - (hNc > 0 ? 2 : 0), C().verdeAgua, dica);
      if (d.total) {
        s += texto(x + lb / 2, base - hNc - hOk - 6, String(d.total),
                   { ancora: 'middle', tamanho: 12, peso: '700', cor: C().texto });
      }
      const mostrarRotulo = !o.rotuloACada || (dados.length - 1 - i) % o.rotuloACada === 0;  // o mês mais recente sempre aparece
      if (mostrarRotulo) {
        s += texto(x + lb / 2, base + 16, encurtar(d.rotulo, slot * (o.rotuloACada || 1) - 4, 11.5),
                   { ancora: 'middle', tamanho: 11.5, cor: C().texto });
      }
      if (o.rotuloDuplo && nc) {
        s += texto(x + lb / 2, base + 31, nc + ' NC', { ancora: 'middle', tamanho: 10.5, peso: '600', cor: C().naoConforme });
      }
      // área de toque maior que a barra, para a dica
      s += '<rect x="' + (mE + slot * i) + '" y="' + mT + '" width="' + slot + '" height="' + au +
           '" fill="transparent"><title>' + escaparSvg(dica) + '</title></rect>';
    });
    return svg(L, A, s, o.titulo);
  }

  /* --- Barras horizontais: rótulo acima da barra (textos longos) ----- */
  function graficoBarrasH(dados, L, cor, opcoes) {
    const o = opcoes || {};
    if (!dados.length) return semDados(o.vazio || 'Sem dados no período.');
    const linha = 38, mT = 2;
    const A = dados.length * linha + mT;
    const max = Math.max(1, ...dados.map(d => d.valor));
    const txtValor = d => String(d.valor) + (o.pct ? ' (' + Math.round(d.valor * 100 / o.pct) + '%)' : '');
    const larguraValor = 14 + Math.max(...dados.map(d => txtValor(d).length)) * 7.2;
    const lu = L - larguraValor;

    let s = '';
    dados.forEach((d, i) => {
      const y = mT + i * linha;
      const l = Math.max(3, (d.valor / max) * lu);
      const dica = d.rotulo + ': ' + d.valor + (o.sufixo || '');
      s += texto(0, y + 12, encurtar(d.rotulo, L - 4, 12.5, o.manterPrefixo), { tamanho: 12.5, cor: C().texto });
      s += barra(0, y + 17, lu, 12, COR_TRILHO, dica, 'h');
      s += barra(0, y + 17, l, 12, cor, dica, 'h');
      s += texto(L, y + 27, txtValor(d),
                 { ancora: 'end', tamanho: 12, peso: '700', cor: C().texto });
      s += '<rect x="0" y="' + y + '" width="' + L + '" height="' + linha + '" fill="transparent"><title>' +
           escaparSvg(dica) + '</title></rect>';
    });
    return svg(L, A, s, o.titulo);
  }

  function legenda(itens) {
    return '<div class="legenda-grafico">' + itens.map(i =>
      '<span><i style="background:' + i[0] + '"></i>' + i[1] + '</span>').join('') + '</div>';
  }

  /** Largura útil do contêiner do gráfico (com valor mínimo razoável). */
  function largura(sel) {
    const el = $(sel);
    return Math.max(260, Math.floor((el && el.clientWidth) || 480));
  }

  /* ===================================================================
   * MONTAGEM DA TELA
   * =================================================================== */
  function cartaoIndicador(valor, rotulo, complemento, classe) {
    return '<div class="indicador ' + (classe || '') + '">' +
      '<span class="valor">' + valor + '</span>' +
      '<span class="rotulo-ind">' + rotulo + '</span>' +
      (complemento ? '<span class="complemento">' + complemento + '</span>' : '') +
      '</div>';
  }

  async function montar() {
    const d = await calcular();

    $('#pa-descricao').textContent = d.rotuloPeriodo +
      ' • lotes: ' + (d.lotes.length ? d.lotes.join(', ') : 'nenhum vinculado');

    $('#pa-cartoes').innerHTML =
      cartaoIndicador(d.total, 'Inspeções no período') +
      cartaoIndicador(d.comNC, 'Com não conformidade', d.pctNC + '% das inspeções do período', 'destaque-nc') +
      cartaoIndicador(d.ncAcumuladas, 'NCs em aberto', 'acumulado de toda a base', 'destaque-nc') +
      cartaoIndicador(d.pctChecklistSim === null ? '—' : d.pctChecklistSim + '%', 'Checklist conforme',
                      d.checklistRespostas ? d.checklistRespostas + ' respostas SIM/NÃO' : 'sem respostas no período',
                      d.pctChecklistSim === null ? '' : (d.pctChecklistSim >= 90 ? 'destaque-ok' : 'destaque-nc')) +
      cartaoIndicador(d.canteirosInspecionados + '/' + d.totalCanteiros, 'Canteiros inspecionados',
                      d.pctCobertura + '% de cobertura', 'destaque-ok') +
      cartaoIndicador(d.diasUltima === null ? '—' : d.diasUltima, 'Dias desde a última inspeção',
                      d.ultimaData ? 'em ' + PDFGEN.dataBR(d.ultimaData) : 'nenhuma registrada',
                      d.diasUltima !== null && d.diasUltima > CONFIG.limites.diasSemaforoVerde ? 'destaque-pendente' : '') +
      cartaoIndicador(d.fotos, 'Fotos registradas', 'evidências no período');

    desenharGraficos(d);
    const corpo = $('#pa-cobertura tbody');
    corpo.innerHTML = '';
    if (!d.cobertura.length) {
      corpo.innerHTML = '<tr><td colspan="6" class="vazio">Nenhum canteiro cadastrado para os seus lotes.</td></tr>';
    }
    d.cobertura.forEach(c => {
      const tr = document.createElement('tr');
      const rotulo = c.dias === null ? 'Nunca inspecionado' : ('há ' + c.dias + ' dia(s)');
      tr.innerHTML =
        '<td>' + APP.escapar(String(c.canteiro).replace(/^Canteiro\s+/i, '')) + '</td>' +
        '<td>' + APP.escapar(c.lote) + '</td>' +
        '<td>' + (c.ultima ? PDFGEN.dataBR(c.ultima) : '—') + '</td>' +
        '<td>' + c.noPeriodo + '</td>' +
        '<td>' + c.ncs + '</td>' +
        '<td><span class="semaforo ' + c.semaforo + '"><i></i>' + rotulo + '</span></td>';
      corpo.appendChild(tr);
    });

    return d;
  }

  /** Desenha (ou redesenha, ao redimensionar) todos os gráficos. */
  function desenharGraficos(d) {
    d = d || dadosAtuais;
    if (!d) return;
    const legNC = legenda([[C().verdeAgua, 'Sem NC'], [C().naoConforme, 'Com NC']]);

    $('#pa-graf-lote').innerHTML =
      graficoColunas(d.porLote, largura('#pa-graf-lote'), { rotuloDuplo: true, titulo: 'Inspeções por lote' }) + legNC;

    $('#pa-graf-empresa').innerHTML =
      graficoColunas(d.porEmpresa, largura('#pa-graf-empresa'), { rotuloDuplo: true, titulo: 'Inspeções por empresa' }) +
      (d.porEmpresa.length ? legNC : '');

    const totalItens = d.itens.reduce((t, x) => t + x.valor, 0);
    $('#pa-graf-itens').innerHTML = graficoBarrasH(d.itens, largura('#pa-graf-itens'), C().verdeAgua,
      { pct: totalItens, vazio: 'Sem inspeções no período.', titulo: 'O que foi inspecionado' });

    const Lev = largura('#pa-graf-evolucao');
    const evol = d.evolucao.map(m => ({ rotulo: m.rotulo, total: m.total, nc: m.nc || 0 }));
    $('#pa-graf-evolucao').innerHTML =
      graficoColunas(evol, Lev, { altura: 300, rotuloACada: Lev < 520 ? 2 : 1,
        vazio: 'Sem inspeções nos últimos 12 meses.', titulo: 'Evolução mensal' }) +
      (evol.some(m => m.total) ? legNC : '');

    $('#pa-graf-canteiros').innerHTML = graficoBarrasH(d.rankingCanteiros, largura('#pa-graf-canteiros'),
      C().naoConforme, { vazio: 'Nenhuma não conformidade no período.', sufixo: ' inspeção(ões) com NC',
                          titulo: 'Canteiros com mais não conformidades' });

    $('#pa-graf-checklist').innerHTML = graficoBarrasH(d.checklistNao || [], largura('#pa-graf-checklist'),
      C().naoConforme, { vazio: d.checklistRespostas ? 'Nenhuma resposta NÃO no período.' :
                                'Nenhum checklist respondido no período.',
                          sufixo: ' resposta(s) NÃO', manterPrefixo: true, titulo: 'Checklist — perguntas com NÃO' });

    $('#cartao-graf-responsavel').hidden = !d.ehAdmin;
    if (d.ehAdmin) {
      $('#pa-graf-responsavel').innerHTML = graficoBarrasH(d.responsaveis, largura('#pa-graf-responsavel'),
        C().verdeAgua, { titulo: 'Inspeções por responsável' });
    }
  }

  // Redesenha ao mudar o tamanho da janela (girar o celular, maximizar…)
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
    document.querySelectorAll('#periodo-botoes .chip').forEach(b => {
      b.classList.toggle('ativo', b.dataset.periodo === novo);
    });
    $('#periodo-custom').hidden = (novo !== 'custom');
    if (novo === 'custom' && !$('#pa-de').value) {
      const iv = intervalo();
      $('#pa-de').value = iv.de;
      $('#pa-ate').value = iv.ate;
    }
    montar();
  }

  async function exportarPDF() {
    APP.carregando(true, 'Montando o PDF do painel…');
    try {
      const d = dadosAtuais || await calcular();
      const r = await PDFGEN.gerarPainel(d);
      APP.aviso(r.modo === 'aba'
        ? 'PDF aberto em nova aba. Use Compartilhar → Salvar em Arquivos.'
        : 'PDF gerado: ' + r.nome, 'sucesso');
    } catch (e) {
      APP.aviso('Falha ao gerar o PDF: ' + (e.message || e), 'erro', 0);
    } finally {
      APP.carregando(false);
    }
  }

  function ligarEventos() {
    document.querySelectorAll('#periodo-botoes .chip').forEach(b => {
      b.addEventListener('click', () => definirPeriodo(b.dataset.periodo));
    });
    ['#pa-de', '#pa-ate'].forEach(s => {
      const el = document.querySelector(s);
      if (el) el.addEventListener('change', () => { periodo = 'custom'; montar(); });
    });
    const btn = document.querySelector('#btn-pdf-painel');
    if (btn) btn.addEventListener('click', exportarPDF);
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
