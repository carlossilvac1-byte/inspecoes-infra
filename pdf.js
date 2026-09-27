/* =====================================================================
 * pdf.js — RELATÓRIOS EM PDF (100% no dispositivo)
 * ---------------------------------------------------------------------
 * jsPDF embarcado localmente (vendor/jspdf.umd.min.js). Nada é buscado
 * na rede: funciona em modo avião.
 *
 * Identidade EDP: faixa horizontal #1A1F2E em TODAS as páginas, com a
 * logo negativa à esquerda e o título à direita, em branco; rodapé com
 * a mesma faixa, identificação do documento, data/hora de emissão e
 * numeração de páginas.
 *
 * A logo vem em Base64 (assets/logo-edp-base64.js) para o jsPDF não
 * depender de carregamento de arquivo; se o Base64 ainda for o
 * provisório, o arquivo assets/edp-logo-neg.png é usado como origem.
 *
 * Três relatórios:
 *   gerarIndividual(id)        -> uma inspeção, com galeria de fotos
 *   gerarConsolidado(lista, f) -> resumo do período + 1 página por inspeção
 *   gerarPainel(dados)         -> indicadores e gráficos do painel
 * ===================================================================== */

const PDFGEN = (function () {

  const A4 = { largura: 210, altura: 297 };
  const M = 14;                              // margem lateral
  const LARG = A4.largura - M * 2;
  const FAIXA_TOPO = 22;                     // altura da faixa superior
  const FAIXA_BASE = 15;                     // altura da faixa inferior
  const TOPO_CONTEUDO = FAIXA_TOPO + 10;     // primeiro Y utilizável
  const LIMITE_INFERIOR = A4.altura - FAIXA_BASE - 6;

  let logoCache = null;                      // { dataUrl, largura, altura }

  /* ---------------------------------------------------------------
   * Utilitários
   * ------------------------------------------------------------- */
  function rgb(hex) {
    return [parseInt(hex.substr(1, 2), 16),
            parseInt(hex.substr(3, 2), 16),
            parseInt(hex.substr(5, 2), 16)];
  }

  function cor(doc, hex, tipo) {
    const c = rgb(hex);
    if (tipo === 'preenchimento') doc.setFillColor(c[0], c[1], c[2]);
    else if (tipo === 'traco') doc.setDrawColor(c[0], c[1], c[2]);
    else doc.setTextColor(c[0], c[1], c[2]);
  }

  /** Data/hora no padrão brasileiro. */
  function dataBR(iso) {
    if (!iso) return '';
    if (String(iso).length === 10) {
      const p = String(iso).split('-');
      return p[2] + '/' + p[1] + '/' + p[0];
    }
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  }

  function limpar(txt) {
    return String(txt || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'SEM';
  }

  /** Descarta o cache — chamado quando o usuário troca o logotipo. */
  function limparCacheLogo() { logoCache = null; }

  /**
   * Carrega a logo, nesta ordem:
   *   1. a enviada pelo usuário na tela "Mais" (IndexedDB)
   *   2. o Base64 publicado em assets/logo-edp-base64.js
   *   3. o arquivo assets/edp-logo-neg.png
   */
  async function logo() {
    if (logoCache !== null) return logoCache;

    try {
      const propria = await DB.kvGet('logoEmpresa', null);
      if (propria && propria.dataUrl) {
        logoCache = {
          dataUrl: propria.dataUrl,
          largura: propria.largura || 400,
          altura: propria.altura || 120
        };
        return logoCache;
      }
    } catch (e) { /* segue para o embutido */ }

    if (typeof LOGO_EDP_BASE64 === 'string' && LOGO_EDP_BASE64.length > 100) {
      logoCache = {
        dataUrl: LOGO_EDP_BASE64.indexOf('data:') === 0
          ? LOGO_EDP_BASE64 : 'data:image/png;base64,' + LOGO_EDP_BASE64,
        largura: (typeof LOGO_EDP_INFO === 'object' && LOGO_EDP_INFO.largura) || 400,
        altura: (typeof LOGO_EDP_INFO === 'object' && LOGO_EDP_INFO.altura) || 120
      };
      return logoCache;
    }
    try {
      const r = await fetch('assets/edp-logo-neg.png');
      const b = await r.blob();
      const dataUrl = await DB.blobParaDataUrl(b);
      const dim = await new Promise((ok) => {
        const img = new Image();
        img.onload = () => ok({ largura: img.naturalWidth, altura: img.naturalHeight });
        img.onerror = () => ok({ largura: 400, altura: 120 });
        img.src = dataUrl;
      });
      logoCache = { dataUrl: dataUrl, largura: dim.largura, altura: dim.altura };
    } catch (e) {
      logoCache = { dataUrl: '', largura: 0, altura: 0 };
    }
    return logoCache;
  }

  /* ---------------------------------------------------------------
   * Faixas de identidade (aplicadas em todas as páginas no fim)
   * ------------------------------------------------------------- */
  async function aplicarFaixas(doc, titulo, identificacao) {
    const lg = await logo();
    const total = doc.internal.getNumberOfPages();
    const emissao = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

    // Altura da logo na faixa e área de proteção da marca: a margem
    // livre ao redor equivale à altura do símbolo.
    const alturaLogo = 8;
    const proporcao = (lg.largura && lg.altura) ? (lg.largura / lg.altura) : 3.3;
    const larguraLogo = alturaLogo * proporcao;
    const respiro = alturaLogo;              // área de proteção

    for (let p = 1; p <= total; p++) {
      doc.setPage(p);

      // ---- Faixa superior --------------------------------------
      cor(doc, CONFIG.cores.azulMarinho, 'preenchimento');
      doc.rect(0, 0, A4.largura, FAIXA_TOPO, 'F');

      if (lg.dataUrl) {
        try {
          doc.addImage(lg.dataUrl, 'PNG', respiro, (FAIXA_TOPO - alturaLogo) / 2,
                       larguraLogo, alturaLogo);
        } catch (e) { /* segue sem a logo */ }
      }

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12.5);
      doc.setTextColor(255, 255, 255);
      doc.text(titulo, A4.largura - M, FAIXA_TOPO / 2 + 1.2, { align: 'right' });

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(159, 178, 188);
      doc.text(CONFIG.app.obra, A4.largura - M, FAIXA_TOPO / 2 + 6.4, { align: 'right' });

      // ---- Faixa inferior --------------------------------------
      cor(doc, CONFIG.cores.azulMarinho, 'preenchimento');
      doc.rect(0, A4.altura - FAIXA_BASE, A4.largura, FAIXA_BASE, 'F');

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(255, 255, 255);
      doc.text(identificacao || CONFIG.app.nome, M, A4.altura - FAIXA_BASE + 6);
      // O nome da empresa já aparece na faixa superior; aqui fica só a
      // emissão, para não repetir três vezes na mesma página.
      doc.setTextColor(159, 178, 188);
      doc.text('Emitido em ' + emissao, M, A4.altura - FAIXA_BASE + 10.6);

      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.text('Página ' + p + ' de ' + total,
               A4.largura - M, A4.altura - FAIXA_BASE + 8.5, { align: 'right' });

      doc.setTextColor(20, 24, 31);
    }
  }

  /* ---------------------------------------------------------------
   * Blocos de conteúdo
   * ------------------------------------------------------------- */
  function novaPaginaSePreciso(doc, y, altura) {
    if (y + altura > LIMITE_INFERIOR) {
      doc.addPage();
      return TOPO_CONTEUDO;
    }
    return y;
  }

  function secao(doc, y, texto) {
    y = novaPaginaSePreciso(doc, y, 14);
    cor(doc, CONFIG.cores.cabecalho, 'preenchimento');
    doc.rect(M, y, 3, 7, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    cor(doc, CONFIG.cores.cabecalho, 'texto');
    doc.text(texto, M + 6, y + 5.6);
    doc.setTextColor(20, 24, 31);
    return y + 12;
  }

  /**
   * Título de seção que só é escrito se o bloco correspondente couber
   * na mesma página — evita cabeçalho órfão no pé do relatório.
   */
  function secaoBloco(doc, y, titulo, alturaNecessaria) {
    if (y + 12 + (alturaNecessaria || 0) > LIMITE_INFERIOR) {
      doc.addPage();
      y = TOPO_CONTEUDO;
    }
    return secao(doc, y, titulo);
  }

  function faixaIdentificacao(doc, y, reg) {
    doc.setFillColor(233, 246, 244);
    cor(doc, CONFIG.cores.verdeAgua, 'traco');
    doc.setLineWidth(0.4);
    doc.rect(M, y, LARG, 14, 'FD');

    const larguraCol = LARG / 3;
    const rotulos = ['LOTE', 'CANTEIRO', 'EMPRESA'];
    const valores = [reg.lote, DB.nomeCanteiro(reg), DB.nomeEmpresa(reg)];
    for (let i = 0; i < 3; i++) {
      const x = M + larguraCol * i + 3;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      cor(doc, CONFIG.cores.textoApoio, 'texto');
      doc.text(rotulos[i], x, y + 5);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      cor(doc, CONFIG.cores.azulMarinho, 'texto');
      doc.text(doc.splitTextToSize(String(valores[i] || '—'), larguraCol - 6)[0], x, y + 11);
    }
    doc.setTextColor(20, 24, 31);
    return y + 20;
  }

  function linha(doc, y, rotulo, valor, destaque) {
    const larguraRot = 55;
    const larguraVal = LARG - larguraRot;
    const texto = (valor === null || valor === undefined || valor === '') ? '—' : String(valor);

    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'normal');
    const linhas = doc.splitTextToSize(texto, larguraVal - 6);
    const alt = Math.max(9, linhas.length * 4.6 + 4);

    y = novaPaginaSePreciso(doc, y, alt);

    cor(doc, CONFIG.cores.borda, 'traco');
    doc.setLineWidth(0.2);
    doc.setFillColor(238, 242, 245);
    doc.rect(M, y, larguraRot, alt, 'FD');
    doc.rect(M + larguraRot, y, larguraVal, alt, 'D');

    doc.setFont('helvetica', 'bold');
    cor(doc, CONFIG.cores.azulMarinho, 'texto');
    doc.text(doc.splitTextToSize(rotulo, larguraRot - 6), M + 3, y + 6);

    doc.setFont('helvetica', destaque ? 'bold' : 'normal');
    if (destaque) cor(doc, CONFIG.cores.naoConforme, 'texto');
    else doc.setTextColor(20, 24, 31);
    doc.text(linhas, M + larguraRot + 3, y + 6);
    doc.setTextColor(20, 24, 31);
    return y + alt;
  }

  /** Linha do checklist: pergunta larga à esquerda, SIM/NÃO à direita. */
  function linhaChecklist(doc, y, num, pergunta, resposta) {
    const larguraResp = 24;
    const larguraPerg = LARG - larguraResp;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    const linhas = doc.splitTextToSize(num + '. ' + pergunta, larguraPerg - 6);
    const alt = Math.max(8, linhas.length * 4.4 + 3.6);
    y = novaPaginaSePreciso(doc, y, alt);

    cor(doc, CONFIG.cores.borda, 'traco');
    doc.setLineWidth(0.2);
    doc.rect(M, y, larguraPerg, alt, 'D');
    const ehNao = resposta === 'NÃO', ehSim = resposta === 'SIM';
    if (ehNao) doc.setFillColor(253, 236, 236);
    else if (ehSim) doc.setFillColor(234, 244, 235);
    else doc.setFillColor(248, 249, 250);
    doc.rect(M + larguraPerg, y, larguraResp, alt, 'FD');

    doc.setTextColor(20, 24, 31);
    doc.text(linhas, M + 3, y + 5.4);
    doc.setFont('helvetica', 'bold');
    if (ehNao) cor(doc, CONFIG.cores.naoConforme, 'texto');
    else if (ehSim) cor(doc, CONFIG.cores.conforme, 'texto');
    doc.text(resposta || '—', M + larguraPerg + larguraResp / 2, y + alt / 2 + 1.4, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(20, 24, 31);
    return y + alt;
  }

  function blocoChecklist(doc, y, reg) {
    const ck = reg.checklist || {};
    Object.keys(ck).forEach(item => {
      const lista = ck[item] || [];
      if (!lista.length) return;
      const nao = lista.filter(q => q.resposta === 'NÃO').length;
      y = secaoBloco(doc, y + 2, 'Checklist — ' + item + '  (' + (lista.length - nao) +
                     ' SIM · ' + nao + ' NÃO)', 16);
      lista.forEach((q, k) => { y = linhaChecklist(doc, y, k + 1, q.pergunta, q.resposta); });
    });
    return y;
  }

  async function galeria(doc, y, fotos) {
    if (!fotos.length) return y;
    const colLarg = (LARG - 8) / 2;
    const imgAlt = 55;
    const blocoAlt = imgAlt + 12;

    if (y + 12 + blocoAlt + 4 > LIMITE_INFERIOR) { doc.addPage(); y = TOPO_CONTEUDO; }
    y = secao(doc, y, 'Registro fotográfico (' + fotos.length + ')');

    for (let i = 0; i < fotos.length; i += 2) {
      y = novaPaginaSePreciso(doc, y, blocoAlt + 4);
      for (let j = 0; j < 2 && i + j < fotos.length; j++) {
        const f = fotos[i + j];
        const x = M + j * (colLarg + 8);
        try {
          const dataUrl = await DB.blobParaDataUrl(f.blob);
          const prop = (f.largura && f.altura) ? f.largura / f.altura : 4 / 3;
          let w = colLarg, h = w / prop;
          if (h > imgAlt) { h = imgAlt; w = h * prop; }
          const offX = x + (colLarg - w) / 2;
          const offY = y + (imgAlt - h) / 2;
          doc.addImage(dataUrl, 'JPEG', offX, offY, w, h, undefined, 'FAST');
          doc.setDrawColor(150, 160, 170);
          doc.setLineWidth(0.3);
          doc.rect(offX, offY, w, h, 'D');
        } catch (e) {
          doc.setFontSize(8);
          doc.text('(falha ao renderizar a foto)', x + 3, y + imgAlt / 2);
        }
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        cor(doc, CONFIG.cores.textoApoio, 'texto');
        const leg = 'Foto ' + f.ordem + (f.legenda ? ' — ' + f.legenda : '');
        doc.text(doc.splitTextToSize(leg, colLarg)[0], x, y + imgAlt + 5);
        doc.setTextColor(20, 24, 31);
      }
      y += blocoAlt;
    }
    return y + 2;
  }

  async function corpoInspecao(doc, y, reg, fotos) {
    y = faixaIdentificacao(doc, y, reg);

    y = secao(doc, y, 'Dados da inspeção');
    y = linha(doc, y, 'Data da inspeção', dataBR(reg.dataInspecao));
    y = linha(doc, y, 'Responsável',
      reg.responsavel + (reg.funcaoResponsavel ? '  (' + reg.funcaoResponsavel + ')' : ''));
    y = linha(doc, y, 'Lote', CONFIG.rotuloLote(reg.lote));
    y = linha(doc, y, 'Canteiro', DB.nomeCanteiro(reg));
    y = linha(doc, y, 'Empresa (construtora)', DB.nomeEmpresa(reg));
    y = linha(doc, y, 'O que foi inspecionado', DB.itensInspecionados(reg).join('; '));
    y = linha(doc, y, 'Não conformidade', reg.naoConformidade, reg.naoConformidade === 'Sim');
    if (reg.naoConformidade === 'Sim') y = linha(doc, y, 'Quais não conformidades', reg.quais, true);
    y = linha(doc, y, 'Observações', reg.observacoes);

    y = blocoChecklist(doc, y, reg);

    y = secao(doc, y + 2, 'Rastreabilidade');
    y = linha(doc, y, 'Coordenadas',
      (reg.latitude !== null && reg.longitude !== null)
        ? (reg.latitude + ', ' + reg.longitude + (reg.precisaoGps ? '  (±' + reg.precisaoGps + ' m)' : ''))
        : (reg.obsGeo || 'Não capturada'));
    y = linha(doc, y, 'Criado em', dataBR(reg.criadoEm));
    y = linha(doc, y, 'Última edição', dataBR(reg.atualizadoEm) + '  (versão ' + (reg.versao || 1) + ')');
    y = linha(doc, y, 'Dispositivo', reg.dispositivo);
    if (reg.excluido) y = linha(doc, y, 'Registro excluído em', dataBR(reg.excluidoEm), true);

    y = await galeria(doc, y + 2, fotos);
    return y;
  }

  /* ---------------------------------------------------------------
   * Saída do arquivo
   * ------------------------------------------------------------- */
  /**
   * Entrega o PDF pelo mecanismo único do app (APP.entregarArquivo), que
   * funciona no navegador, no computador e no app instalado no celular
   * (iPhone e Android): compartilhar / salvar / baixar a partir de um toque.
   */
  function baixar(doc, nomeArquivo) {
    const blob = doc.output('blob');
    return window.APP.entregarArquivo(blob, nomeArquivo, 'application/pdf');
  }

  /* ---------------------------------------------------------------
   * RELATÓRIO INDIVIDUAL
   * ------------------------------------------------------------- */
  async function gerarIndividual(idInspecao) {
    const reg = await DB.obterInspecao(idInspecao);
    if (!reg) throw new Error('Registro não encontrado.');
    const fotos = await DB.listarFotos(idInspecao);

    const doc = new jspdf.jsPDF({ unit: 'mm', format: 'a4', compress: true });
    await corpoInspecao(doc, TOPO_CONTEUDO, reg, fotos);
    await aplicarFaixas(doc, 'Relatório de Inspeção de Campo',
      'Inspeção ' + reg.id + '  •  ' + reg.lote + ' / ' + DB.nomeCanteiro(reg));

    const nome = 'Inspecao_' + limpar(reg.lote) + '_' + limpar(DB.nomeCanteiro(reg)) +
                 '_' + reg.dataInspecao + '_' + reg.id.slice(0, 8) + '.pdf';
    return baixar(doc, nome);
  }

  /* ---------------------------------------------------------------
   * RELATÓRIO CONSOLIDADO
   * ------------------------------------------------------------- */
  async function gerarConsolidado(lista, descricaoFiltro) {
    if (!lista || !lista.length) throw new Error('Nenhuma inspeção no filtro atual.');

    const doc = new jspdf.jsPDF({ unit: 'mm', format: 'a4', compress: true });
    let y = TOPO_CONTEUDO;

    const comNC = lista.filter(r => r.naoConformidade === 'Sim').length;
    const p = (window.AUTH && AUTH.perfil) ? AUTH.perfil() : null;

    y = secao(doc, y, 'Resumo do período');
    y = linha(doc, y, 'Filtro aplicado', descricaoFiltro || 'Todos os registros');
    y = linha(doc, y, 'Total de inspeções', String(lista.length));
    y = linha(doc, y, 'Com não conformidade',
      comNC + ' (' + (lista.length ? Math.round(comNC * 100 / lista.length) : 0) + '%)', comNC > 0);
    y = linha(doc, y, 'Sem não conformidade', String(lista.length - comNC));
    y = linha(doc, y, 'Emitido por', p ? (p.nome + ' — ' + p.funcao) : '—');

    y = secao(doc, y + 2, 'Inspeções do período');
    const cols = [
      { t: 'Data', l: 20 }, { t: 'Lote', l: 16 }, { t: 'Canteiro', l: 44 },
      { t: 'Empresa', l: 28 }, { t: 'Inspecionado', l: 40 }, { t: 'NC', l: 12 }, { t: 'Fotos', l: 22 }
    ];

    function cabecalhoTabela(yy) {
      cor(doc, CONFIG.cores.azulMarinho, 'preenchimento');
      doc.rect(M, yy, LARG, 8, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      let x = M;
      cols.forEach(c => { doc.text(c.t, x + 2, yy + 5.5); x += c.l; });
      doc.setTextColor(20, 24, 31);
      return yy + 8;
    }

    y = cabecalhoTabela(y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);

    let alterna = false;
    for (const r of lista) {
      const qtdFotos = await DB.contarFotos(r.id);
      const valores = [
        dataBR(r.dataInspecao), r.lote, DB.nomeCanteiro(r), DB.nomeEmpresa(r),
        DB.itensInspecionados(r).join(', '), r.naoConformidade, String(qtdFotos)
      ];
      let maxLinhas = 1;
      const partidos = valores.map((v, i) => {
        const pp = doc.splitTextToSize(String(v || '—'), cols[i].l - 3);
        maxLinhas = Math.max(maxLinhas, pp.length);
        return pp;
      });
      const alt = maxLinhas * 3.9 + 3;

      if (y + alt > LIMITE_INFERIOR) {
        doc.addPage();
        y = cabecalhoTabela(TOPO_CONTEUDO);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
      }

      if (alterna) { doc.setFillColor(244, 247, 249); doc.rect(M, y, LARG, alt, 'F'); }
      alterna = !alterna;

      cor(doc, CONFIG.cores.borda, 'traco');
      doc.setLineWidth(0.15);
      doc.line(M, y + alt, M + LARG, y + alt);

      let x = M;
      partidos.forEach((pp, i) => {
        if (cols[i].t === 'NC' && pp[0] === 'Sim') {
          cor(doc, CONFIG.cores.naoConforme, 'texto');
          doc.setFont('helvetica', 'bold');
        }
        doc.text(pp, x + 2, y + 4.5);
        doc.setTextColor(20, 24, 31);
        doc.setFont('helvetica', 'normal');
        x += cols[i].l;
      });
      y += alt;
    }

    for (const r of lista) {
      doc.addPage();
      const fotos = await DB.listarFotos(r.id);
      await corpoInspecao(doc, TOPO_CONTEUDO, r, fotos);
    }

    await aplicarFaixas(doc, 'Relatório Consolidado de Inspeções',
      'Consolidado  •  ' + (descricaoFiltro || 'todos os registros'));

    const nome = 'Inspecoes-Infra_Consolidado_' + new Date().toISOString().slice(0, 10) + '.pdf';
    return baixar(doc, nome);
  }

  /* ---------------------------------------------------------------
   * PAINEL DE INDICADORES
   * ------------------------------------------------------------- */

  /** Cartão de indicador desenhado no PDF. */
  function cartaoPDF(doc, x, y, largura, valor, rotulo, complemento, corTopo) {
    const alt = 24;
    doc.setFillColor(255, 255, 255);
    cor(doc, CONFIG.cores.borda, 'traco');
    doc.setLineWidth(0.3);
    doc.rect(x, y, largura, alt, 'FD');
    cor(doc, corTopo || CONFIG.cores.verdeAgua, 'preenchimento');
    doc.rect(x, y, largura, 1.6, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    cor(doc, corTopo === CONFIG.cores.naoConforme ? CONFIG.cores.naoConforme : CONFIG.cores.azulMarinho, 'texto');
    doc.text(String(valor), x + 4, y + 11);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    cor(doc, CONFIG.cores.textoApoio, 'texto');
    doc.text(doc.splitTextToSize(rotulo, largura - 8), x + 4, y + 16);
    if (complemento) {
      doc.setFontSize(6.8);
      doc.text(doc.splitTextToSize(complemento, largura - 8)[0], x + 4, y + 21);
    }
    doc.setTextColor(20, 24, 31);
    return y + alt;
  }

  /** Barras verticais com a parcela de NC destacada. */
  function barrasPDF(doc, y, dados, altura) {
    if (!dados.length) {
      doc.setFontSize(9); cor(doc, CONFIG.cores.textoApoio, 'texto');
      doc.text('Sem dados no período.', M, y + 5);
      doc.setTextColor(20, 24, 31);
      return y + 10;
    }
    const alt = altura || 42;
    y = novaPaginaSePreciso(doc, y, alt + 14);
    const max = Math.max(1, ...dados.map(d => d.total));
    const passo = LARG / dados.length;
    const larg = Math.min(26, passo * 0.55);
    const base = y + alt;

    cor(doc, CONFIG.cores.borda, 'traco');
    doc.setLineWidth(0.2);
    doc.line(M, base, M + LARG, base);

    dados.forEach((d, i) => {
      const x = M + passo * i + (passo - larg) / 2;
      const h = (d.total / max) * alt;
      const hNC = ((d.nc || 0) / max) * alt;
      cor(doc, CONFIG.cores.verdeAgua, 'preenchimento');
      doc.rect(x, base - h, larg, h, 'F');
      if (hNC > 0) {
        cor(doc, CONFIG.cores.naoConforme, 'preenchimento');
        doc.rect(x, base - hNC, larg, hNC, 'F');
      }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      cor(doc, CONFIG.cores.azulMarinho, 'texto');
      doc.text(String(d.total), x + larg / 2, base - h - 1.5, { align: 'center' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      cor(doc, CONFIG.cores.textoApoio, 'texto');
      const rot = doc.splitTextToSize(String(d.rotulo).replace(/^Canteiro\s+/i, ''), passo - 2);
      doc.text(rot.slice(0, 2), x + larg / 2, base + 4, { align: 'center' });
    });
    doc.setTextColor(20, 24, 31);
    return base + 12;
  }

  /** Barras horizontais (ranking). */
  function barrasHPDF(doc, y, dados, corBarra, vazio) {
    if (!dados.length) {
      doc.setFontSize(9); cor(doc, CONFIG.cores.textoApoio, 'texto');
      doc.text(vazio || 'Sem dados no período.', M, y + 5);
      doc.setTextColor(20, 24, 31);
      return y + 10;
    }
    const rotuloLarg = 70;
    const barraLarg = LARG - rotuloLarg - 12;
    const max = Math.max(1, ...dados.map(d => d.valor));

    dados.forEach(d => {
      y = novaPaginaSePreciso(doc, y, 8);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      cor(doc, CONFIG.cores.texto, 'texto');
      doc.text(doc.splitTextToSize(String(d.rotulo).replace(/^Canteiro\s+/i, ''), rotuloLarg - 3)[0],
               M, y + 4.2);
      doc.setFillColor(238, 242, 245);
      doc.rect(M + rotuloLarg, y, barraLarg, 5, 'F');
      cor(doc, corBarra || CONFIG.cores.naoConforme, 'preenchimento');
      doc.rect(M + rotuloLarg, y, (d.valor / max) * barraLarg, 5, 'F');
      doc.setFont('helvetica', 'bold');
      cor(doc, CONFIG.cores.azulMarinho, 'texto');
      doc.text(String(d.valor), M + rotuloLarg + barraLarg + 3, y + 4.2);
      y += 7.5;
    });
    doc.setTextColor(20, 24, 31);
    return y + 3;
  }

  /** Linha de evolução mensal (total) com o % de NC pontilhado. */
  function linhaPDF(doc, y, dados) {
    if (!dados.length) return y;
    const alt = 42;
    y = novaPaginaSePreciso(doc, y, alt + 14);
    const max = Math.max(1, ...dados.map(d => d.total));
    const passo = dados.length > 1 ? LARG / (dados.length - 1) : 0;
    const base = y + alt;

    cor(doc, CONFIG.cores.borda, 'traco');
    doc.setLineWidth(0.2);
    doc.line(M, base, M + LARG, base);

    const pts = dados.map((d, i) => [M + passo * i, base - (d.total / max) * alt]);
    const ptsPct = dados.map((d, i) => [M + passo * i, base - (d.pctNc / 100) * alt]);

    cor(doc, CONFIG.cores.verdeAgua, 'traco');
    doc.setLineWidth(0.8);
    for (let i = 1; i < pts.length; i++) doc.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);

    cor(doc, CONFIG.cores.naoConforme, 'traco');
    doc.setLineWidth(0.5);
    for (let i = 1; i < ptsPct.length; i++) {
      doc.line(ptsPct[i - 1][0], ptsPct[i - 1][1], ptsPct[i][0], ptsPct[i][1]);
    }

    doc.setFontSize(6.5);
    dados.forEach((d, i) => {
      cor(doc, CONFIG.cores.verdeAgua, 'preenchimento');
      doc.circle(pts[i][0], pts[i][1], 0.8, 'F');
      cor(doc, CONFIG.cores.textoApoio, 'texto');
      doc.text(d.rotulo, pts[i][0], base + 4, { align: 'center' });
      if (d.total) {
        cor(doc, CONFIG.cores.azulMarinho, 'texto');
        doc.text(String(d.total), pts[i][0], pts[i][1] - 1.6, { align: 'center' });
      }
    });
    doc.setTextColor(20, 24, 31);
    return base + 12;
  }

  async function gerarPainel(d) {
    const doc = new jspdf.jsPDF({ unit: 'mm', format: 'a4', compress: true });
    let y = TOPO_CONTEUDO;

    const p = (window.AUTH && AUTH.perfil) ? AUTH.perfil() : null;
    y = secao(doc, y, 'Período e escopo');
    y = linha(doc, y, 'Período', d.rotuloPeriodo);
    y = linha(doc, y, 'Lotes considerados', d.lotes.length ? d.lotes.join(', ') : 'nenhum');
    y = linha(doc, y, 'Emitido por', p ? (p.nome + ' — ' + p.funcao) : '—');

    // ---- Cartões (3 por linha) ---------------------------------
    y = secao(doc, y + 2, 'Indicadores');
    const larguraCartao = (LARG - 8) / 3;
    const cartoes = [
      [d.total, 'Inspeções no período', '', CONFIG.cores.verdeAgua],
      [d.comNC, 'Com não conformidade', d.pctNC + '% do total', CONFIG.cores.naoConforme],
      [d.ncAcumuladas, 'NCs em aberto (acumulado)', '', CONFIG.cores.naoConforme],
      [d.canteirosInspecionados + '/' + d.totalCanteiros, 'Canteiros inspecionados',
       d.pctCobertura + '% de cobertura', CONFIG.cores.conforme],
      [d.diasUltima === null ? '—' : d.diasUltima, 'Dias desde a última inspeção',
       d.ultimaData ? dataBR(d.ultimaData) : 'nenhuma', CONFIG.cores.verdeAgua],
      [d.fotos, 'Fotos registradas', 'evidências no período', CONFIG.cores.conforme]
    ];
    for (let i = 0; i < cartoes.length; i++) {
      const col = i % 3;
      if (col === 0) y = novaPaginaSePreciso(doc, y, 28);
      const x = M + col * (larguraCartao + 4);
      const fim = cartaoPDF(doc, x, y, larguraCartao, cartoes[i][0], cartoes[i][1], cartoes[i][2], cartoes[i][3]);
      if (col === 2 || i === cartoes.length - 1) y = fim + 4;
    }

    // ---- Gráficos ----------------------------------------------
    const alturaBarras = 58;
    const alturaLista = (n) => Math.min(10, Math.max(1, n)) * 7.5 + 6;

    y = secaoBloco(doc, y + 2, 'Inspeções por lote', alturaBarras);
    y = barrasPDF(doc, y, d.porLote);

    y = secaoBloco(doc, y, 'Canteiros com mais não conformidades',
                   alturaLista(d.rankingCanteiros.length));
    y = barrasHPDF(doc, y, d.rankingCanteiros, CONFIG.cores.naoConforme,
                   'Nenhuma não conformidade no período.');

    y = secaoBloco(doc, y, 'Inspeções por empresa', alturaBarras);
    y = barrasPDF(doc, y, d.porEmpresa);

    y = secaoBloco(doc, y, 'Evolução mensal (total e % com NC)', alturaBarras);
    y = linhaPDF(doc, y, d.evolucao);

    y = secaoBloco(doc, y, 'Distribuição por item inspecionado', alturaLista(d.itens.length));
    y = barrasHPDF(doc, y, d.itens, CONFIG.cores.verdeAgua);

    if (d.ehAdmin && d.responsaveis.length) {
      y = secaoBloco(doc, y, 'Inspeções por responsável', alturaLista(d.responsaveis.length));
      y = barrasHPDF(doc, y, d.responsaveis, CONFIG.cores.cabecalho);
    }

    // ---- Tabela de cobertura -----------------------------------
    doc.addPage();
    y = secao(doc, TOPO_CONTEUDO, 'Cobertura de canteiros');
    const cols = [
      { t: 'Canteiro', l: 74 }, { t: 'Lote', l: 16 }, { t: 'Última', l: 22 },
      { t: 'Período', l: 18 }, { t: 'NCs', l: 14 }, { t: 'Situação', l: 38 }
    ];
    function cabTab(yy) {
      cor(doc, CONFIG.cores.azulMarinho, 'preenchimento');
      doc.rect(M, yy, LARG, 7.5, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      let x = M;
      cols.forEach(c => { doc.text(c.t, x + 2, yy + 5.2); x += c.l; });
      doc.setTextColor(20, 24, 31);
      return yy + 7.5;
    }
    y = cabTab(y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);

    d.cobertura.forEach(c => {
      const alt = 6.5;
      if (y + alt > LIMITE_INFERIOR) {
        doc.addPage();
        y = cabTab(TOPO_CONTEUDO);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
      }
      const situacao = c.dias === null ? 'Nunca inspecionado' : ('há ' + c.dias + ' dia(s)');
      const corSem = c.semaforo === 'verde' ? CONFIG.cores.conforme
                   : c.semaforo === 'amarelo' ? CONFIG.cores.pendente : CONFIG.cores.naoConforme;

      cor(doc, CONFIG.cores.borda, 'traco');
      doc.setLineWidth(0.15);
      doc.line(M, y + alt, M + LARG, y + alt);

      const valores = [
        String(c.canteiro).replace(/^Canteiro\s+/i, ''), c.lote,
        c.ultima ? dataBR(c.ultima) : '—', String(c.noPeriodo), String(c.ncs), situacao
      ];
      let x = M;
      valores.forEach((v, i) => {
        if (i === 5) {
          cor(doc, corSem, 'preenchimento');
          doc.circle(x + 3, y + 3.4, 1.3, 'F');
          doc.setTextColor(20, 24, 31);
          doc.text(doc.splitTextToSize(v, cols[i].l - 8)[0], x + 6, y + 4.5);
        } else {
          doc.text(doc.splitTextToSize(String(v), cols[i].l - 3)[0], x + 2, y + 4.5);
        }
        x += cols[i].l;
      });
      y += alt;
    });

    await aplicarFaixas(doc, 'Painel de Indicadores de Inspeção',
      'Painel  •  ' + d.rotuloPeriodo);

    const nome = 'Inspecoes-Infra_Painel_' + new Date().toISOString().slice(0, 10) + '.pdf';
    return baixar(doc, nome);
  }

  return {
    limparCacheLogo: limparCacheLogo,
    gerarIndividual: gerarIndividual,
    gerarConsolidado: gerarConsolidado,
    gerarPainel: gerarPainel,
    dataBR: dataBR
  };
})();

window.PDFGEN = PDFGEN;
