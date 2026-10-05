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

    // Logo oficial fixa no pacote (assets/logo-edp-base64.js).
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
    doc.setFont('helvetica', destaque ? 'bold' : 'normal');   // mede com a mesma fonte que vai escrever
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
    const ehNao = resposta === 'NÃO', ehSim = resposta === 'SIM', ehNa = resposta === 'NA';
    if (ehNao) doc.setFillColor(253, 236, 236);
    else if (ehSim) doc.setFillColor(234, 244, 235);
    else if (ehNa) doc.setFillColor(238, 242, 245);
    else doc.setFillColor(248, 249, 250);
    doc.rect(M + larguraPerg, y, larguraResp, alt, 'FD');

    doc.setTextColor(20, 24, 31);
    doc.text(linhas, M + 3, y + 5.4);
    doc.setFont('helvetica', 'bold');
    if (ehNao) cor(doc, CONFIG.cores.naoConforme, 'texto');
    else if (ehSim) cor(doc, CONFIG.cores.conforme, 'texto');
    else if (ehNa) doc.setTextColor(91, 107, 120);
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
      const na = lista.filter(q => q.resposta === 'NA').length;
      y = secaoBloco(doc, y + 2, 'Checklist — ' + item + '  (' + (lista.length - nao - na) +
                     ' SIM · ' + nao + ' NÃO' + (na ? ' · ' + na + ' NA' : '') + ')', 16);
      lista.forEach((q, k) => { y = linhaChecklist(doc, y, k + 1, q.pergunta, q.resposta); });
    });
    return y;
  }

  /**
   * Não conformidades consolidadas: cada pergunta respondida com NÃO vira
   * um bloco numerado (NC 1, NC 2…) com o item, a pergunta, a descrição
   * e as fotos de evidência vinculadas a ela.
   */
  async function blocoNaoConformidades(doc, y, reg, fotos) {
    const ck = reg.checklist || {};
    const ncs = [];
    Object.keys(ck).forEach(item => (ck[item] || []).forEach(q => { if (q.resposta === 'NÃO') ncs.push({ item: item, q: q }); }));
    if (!ncs.length) return y;
    const colLarg = (LARG - 8 - 6) / 2, imgAlt = 48;
    // Mede cada bloco antes de desenhar: o cabeçalho da NC nunca fica
    // separado da primeira linha de fotos, nem o título da seção da NC 1.
    const medir = n => {
      const fs = fotos.filter(f => f.vinculo && f.vinculo.item === n.item && f.vinculo.pergunta === n.q.pergunta);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      const linhasPerg = doc.splitTextToSize(n.q.pergunta, LARG - 30);
      doc.setFont('helvetica', 'italic'); doc.setFontSize(8.6);
      const linhasObs = n.q.obs ? doc.splitTextToSize('Descrição: ' + n.q.obs, LARG - 12) : [];
      const altTexto = 9 + linhasPerg.length * 4.3 + (linhasObs.length ? linhasObs.length * 4.2 + 2 : 0);
      const altCab = altTexto + 3 + (fs.length ? imgAlt + 7 : 6);
      return { fs, linhasPerg, linhasObs, altTexto, altCab };
    };
    y = secaoBloco(doc, y + 2, 'Não conformidades identificadas (' + ncs.length + ')', medir(ncs[0]).altCab + 1);
    for (let k = 0; k < ncs.length; k++) {
      const n = ncs[k];
      const { fs, linhasPerg, linhasObs, altTexto, altCab } = medir(n);
      y = novaPaginaSePreciso(doc, y + 1, altCab);
      // Cabeçalho do bloco
      doc.setFillColor(253, 236, 236); cor(doc, '#F0BDBD', 'traco'); doc.setLineWidth(0.3);
      doc.rect(M, y, LARG, altTexto, 'FD');
      cor(doc, CONFIG.cores.naoConforme, 'preenchimento'); doc.rect(M, y, 1.6, altTexto, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); cor(doc, CONFIG.cores.naoConforme, 'texto');
      doc.text('NC ' + (k + 1), M + 4.5, y + 5.6);
      doc.setTextColor(90, 102, 114); doc.setFontSize(8.5);
      doc.text(n.item.toUpperCase(), M + 18, y + 5.6);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(20, 24, 31);
      doc.text(linhasPerg, M + 4.5, y + 10.6);
      doc.setFont('helvetica', 'bold'); cor(doc, CONFIG.cores.naoConforme, 'texto');
      doc.text('NÃO', M + LARG - 4, y + 10.6, { align: 'right' });
      let yy = y + 10.6 + linhasPerg.length * 4.3;
      if (linhasObs.length) {
        doc.setFont('helvetica', 'italic'); doc.setFontSize(8.6); doc.setTextColor(60, 70, 80);
        doc.text(linhasObs, M + 4.5, yy + 1); yy += linhasObs.length * 4.2 + 2;
      }
      y += altTexto + 3;
      if (!fs.length) {
        doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(120, 130, 140);
        doc.text('Sem foto de evidência vinculada.', M + 4.5, y + 2); doc.setTextColor(20, 24, 31);
        y += 6;
        continue;
      }
      for (let i = 0; i < fs.length; i += 2) {
        y = novaPaginaSePreciso(doc, y, imgAlt + 8);
        for (let j = 0; j < 2 && i + j < fs.length; j++) {
          const f = fs[i + j];
          const x = M + 3 + j * (colLarg + 8);
          try {
            const dataUrl = await DB.blobParaDataUrl(f.blob);
            const prop = (f.largura && f.altura) ? f.largura / f.altura : 4 / 3;
            let w = colLarg, h = w / prop;
            if (h > imgAlt) { h = imgAlt; w = h * prop; }
            const offX = x + (colLarg - w) / 2;
            doc.addImage(dataUrl, 'JPEG', offX, y, w, h, undefined, 'FAST');
            cor(doc, '#F0BDBD', 'traco'); doc.setLineWidth(0.4); doc.rect(offX, y, w, h, 'D');
          } catch (e) {
            doc.setFontSize(8); doc.text('(falha ao renderizar a foto)', x + 3, y + imgAlt / 2);
          }
          doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(120, 130, 140);
          doc.text('Evidência NC ' + (k + 1) + '.' + (i + j + 1) + (f.legenda ? ' — ' + f.legenda : ''), x, y + imgAlt + 3.8);
          doc.setTextColor(20, 24, 31);
        }
        y += imgAlt + 7;
      }
    }
    return y + 2;
  }

  async function galeria(doc, y, fotos) {
    if (!fotos.length) return y;
    const colLarg = (LARG - 8) / 2;
    const imgAlt = 55;
    const blocoAlt = imgAlt + 12;

    if (y + 12 + blocoAlt + 4 > LIMITE_INFERIOR) { doc.addPage(); y = TOPO_CONTEUDO; }
    y = secao(doc, y, 'Registro fotográfico geral (' + fotos.length + ')');

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
        const leg = 'Foto ' + (i + j + 1) + (f.legenda ? ' — ' + f.legenda : '');
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
    y = await blocoNaoConformidades(doc, y, reg, fotos);

    y = secao(doc, y + 2, 'Registro');
    y = linha(doc, y, 'Coordenadas',
      (reg.latitude !== null && reg.longitude !== null)
        ? (reg.latitude + ', ' + reg.longitude + (reg.precisaoGps ? '  (±' + reg.precisaoGps + ' m)' : ''))
        : (reg.obsGeo || 'Não capturada'));
    if (reg.latitude !== null && reg.longitude !== null && reg.latitude !== undefined && window.MAPA) {
      // Miniatura do mapa do local (precisa de internet; sem rede sai só a coordenada)
      try {
        const img = await MAPA.imagemEstatica(reg.latitude, reg.longitude,
          { zoom: 16, largura: 900, altura: 360, nc: reg.naoConformidade === 'Sim' });
        if (img) {
          const altMapa = LARG * 360 / 900;
          y = novaPaginaSePreciso(doc, y + 2, altMapa + 9);
          cor(doc, CONFIG.cores.borda, 'traco'); doc.setLineWidth(0.3);
          doc.addImage(img, 'JPEG', M, y, LARG, altMapa);
          doc.rect(M, y, LARG, altMapa);
          y += altMapa + 4;
          doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(11, 127, 112);
          doc.textWithLink('Abrir este local no Google Maps', M, y + 1, { url: MAPA.linkGoogle(reg.latitude, reg.longitude) });
          doc.setTextColor(20, 24, 31);
          y += 5;
        }
      } catch (e) { /* segue sem o mapa */ }
    }
    y = linha(doc, y, 'Registrado em', dataBR(reg.criadoEm));
    if ((reg.versao || 1) > 1) y = linha(doc, y, 'Última edição', dataBR(reg.atualizadoEm));
    if (reg.excluido) y = linha(doc, y, 'Registro excluído em', dataBR(reg.excluidoEm), true);

    y = await galeria(doc, y + 2, fotos.filter(f => !f.vinculo));
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
      'Inspeção de ' + dataBR(reg.dataInspecao) + '  •  ' + reg.lote + '  •  ' + DB.nomeCanteiro(reg));

    const nome = 'Inspecao_' + limpar(reg.lote) + '_' +
                 limpar(String(DB.nomeCanteiro(reg)).replace(/^Canteiro\s+/i, '')) +
                 '_' + reg.dataInspecao + '.pdf';
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

  /* ===================================================================
   * PAINEL EM PÁGINA ÚNICA (A4 paisagem, estilo Power BI)
   * -------------------------------------------------------------------
   * Mesma composição da tela do painel: faixa de identidade, 6 KPIs,
   * lote / status / NCs, evolução / empresa / itens e a cobertura de
   * canteiros. Gerado por desenho vetorial (jsPDF), então o arquivo é
   * idêntico no notebook e no celular.
   * =================================================================== */
  let emblemaCache = null;
  async function emblemaApp() {
    if (emblemaCache !== null) return emblemaCache;
    try {
      const r = await fetch('assets/app-emblema.png');
      emblemaCache = await DB.blobParaDataUrl(await r.blob());
    } catch (e) { emblemaCache = ''; }
    return emblemaCache;
  }

  async function gerarPainel(d) {
    const W = 297, H = 210, MG = 8, LW = W - MG * 2;
    const doc = new jspdf.jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape', compress: true });
    const OK = '#1F9E8F', NC = '#D64545', TX = '#0F2233', TX2 = '#5B6B78', BD = '#E1E7EC', NAVY = '#0B1B2D';
    const p = (window.AUTH && AUTH.perfil) ? AUTH.perfil() : null;
    const fill = (hex) => cor(doc, hex, 'preenchimento');
    const stroke = (hex) => cor(doc, hex, 'traco');
    const txt = (hex) => { const c = rgb(hex); doc.setTextColor(c[0], c[1], c[2]); };
    const fonte = (tam, peso) => { doc.setFont('helvetica', peso || 'normal'); doc.setFontSize(tam); };
    const corta = (t, larg) => {
      t = texto(String(t == null ? '' : t));
      if (doc.getTextWidth(t) <= larg) return t;
      while (t.length > 1 && doc.getTextWidth(t + '...') > larg) t = t.slice(0, -1);
      return t + '...';
    };
    const pct = (a, b) => b ? Math.round(a * 100 / b) : 0;
    function texto(v) { return String(v == null ? '' : v); }

    // ---- Fundo e faixa superior ------------------------------------
    fill('#F3F6F9'); doc.rect(0, 0, W, H, 'F');
    fill(NAVY); doc.rect(0, 0, W, 17, 'F');
    // Logo oficial da EDP à esquerda (a logo do app é só o ícone de instalação)
    const lg = await logo();
    let xTit = MG;
    if (lg.dataUrl) {
      const a = 7, l = a * ((lg.largura && lg.altura) ? lg.largura / lg.altura : 3.3);
      try { doc.addImage(lg.dataUrl, 'PNG', MG, 5, l, a); xTit = MG + l + 7; } catch (e) { /* sem logo */ }
      stroke('#2A3F55'); doc.setLineWidth(0.3); doc.line(xTit - 3.5, 4, xTit - 3.5, 13);
    }
    fonte(13, 'bold'); txt('#FFFFFF'); doc.text('Painel de Inspeções de Campo', xTit, 8.2);
    fonte(7, 'bold'); txt('#93A7BA'); doc.text(texto(CONFIG.app.obra), xTit, 12.6);
    const xDir = W - MG + 2;
    fonte(6.5, 'normal'); txt('#93A7BA');
    doc.text('PERÍODO', xDir - 2, 6.6, { align: 'right' });
    fonte(8.5, 'bold'); txt('#FFFFFF');
    doc.text(texto(d.rotuloPeriodo), xDir - 2, 10.6, { align: 'right' });
    fonte(6.5, 'normal'); txt('#93A7BA');
    const filtros = (d.filtro && (d.filtro.lote || d.filtro.empresa))
      ? 'Filtro: ' + [d.filtro.lote, d.filtro.empresa].filter(Boolean).join(' • ') : 'Lotes: ' + (d.lotes.join(', ') || '—');
    doc.text(texto(filtros), xDir - 2, 14.2, { align: 'right' });

    // ---- Cartão base ------------------------------------------------
    const cartao = (x, y, w, h, titulo) => {
      fill('#FFFFFF'); stroke(BD); doc.setLineWidth(0.25);
      doc.roundedRect(x, y, w, h, 2.2, 2.2, 'FD');
      if (titulo) { fonte(8.2, 'bold'); txt(TX); doc.text(titulo, x + 3.5, y + 6); }
    };
    const vazio = (x, y, w, h, msg) => {
      fonte(7.2, 'normal'); txt(TX2); doc.text(msg, x + w / 2, y + h / 2, { align: 'center' });
    };

    // ---- KPIs (6) ---------------------------------------------------
    const yK = 20, hK = 19, gap = 3.5, wK = (LW - gap * 5) / 6;
    const kpis = [
      ['Inspeções no período', String(d.total), (d.totalAcumulado || d.total) + ' no acumulado', OK],
      ['Com não conformidade', d.pctNC + '%', d.comNC + ' de ' + d.total + ' inspeções', d.comNC ? NC : OK],
      ['NCs em aberto (acumulado)', String(d.ncAcumuladas), 'em toda a base', d.ncAcumuladas ? NC : OK],
      ['Canteiros inspecionados', d.pctCobertura + '%', d.canteirosInspecionados + ' de ' + d.totalCanteiros + ' (cobertura)', OK],
      ['Última inspeção', d.ultimaData ? dataBR(d.ultimaData) : '—',
        d.diasUltima === null ? 'nenhuma registrada' : (d.diasUltima === 0 ? 'hoje' : 'há ' + d.diasUltima + ' dia(s)'),
        d.diasUltima !== null && d.diasUltima > CONFIG.limites.diasSemaforoVerde ? '#E8A317' : OK],
      ['Fotos registradas', String(d.fotos), 'evidências no período', OK]
    ];
    kpis.forEach((k, i) => {
      const x = MG + i * (wK + gap);
      cartao(x, yK, wK, hK);
      fill(k[3]); doc.rect(x, yK + 1, 1.1, hK - 2, 'F');
      fonte(6.6, 'bold'); txt(TX2); doc.text(corta(k[0].toUpperCase(), wK - 6), x + 3.5, yK + 5.2);
      fonte(k[1].length > 7 ? 13 : 16, 'bold'); txt(k[3] === NC ? NC : TX); doc.text(k[1], x + 3.5, yK + 12.6);
      fonte(6.4, 'normal'); txt(TX2); doc.text(corta(k[2], wK - 6), x + 3.5, yK + 16.6);
    });

    // ---- Barras horizontais empilhadas (Sem NC / Com NC) ------------
    function barrasEmp(x, y, w, h, dados, msg) {
      if (!dados.length || !dados.some(t => t.total)) return vazio(x, y, w, h, msg || 'Sem dados no período.');
      const n = Math.min(dados.length, Math.floor(h / 6.2));
      const lr = Math.min(30, w * 0.34), lv = 13, lb = w - lr - lv - 3;
      const max = Math.max.apply(null, dados.map(t => t.total)) || 1;
      dados.slice(0, n).forEach((t, i) => {
        const yy = y + i * 6.2;
        fonte(6.8, 'bold'); txt(TX); doc.text(corta(t.rotulo, lr - 2), x, yy + 3.4);
        fill('#EEF2F5'); doc.roundedRect(x + lr, yy + 0.9, lb, 3.4, 0.8, 0.8, 'F');
        const wOk = (t.total - t.nc) / max * lb, wNc = t.nc / max * lb;
        if (wOk > 0) { fill(OK); doc.rect(x + lr, yy + 0.9, wOk, 3.4, 'F'); }
        if (wNc > 0) { fill(NC); doc.rect(x + lr + wOk + (wOk > 0 ? 0.4 : 0), yy + 0.9, wNc, 3.4, 'F'); }
        fonte(6.8, 'bold'); txt(TX); doc.text(String(t.total), x + lr + lb + 2, yy + 3.4);
        if (t.nc) { fonte(5.6, 'normal'); txt(TX2); doc.text('(' + t.nc + ' NC)', x + lr + lb + 2 + doc.getTextWidth(String(t.total)) + 2.2, yy + 3.4); }
      });
    }
    function barrasSim(x, y, w, h, dados, corB, msg, total) {
      if (!dados.length) return vazio(x, y, w, h, msg || 'Sem dados no período.');
      const n = Math.min(dados.length, Math.floor(h / 6.2));
      const lr = Math.min(34, w * 0.4), lv = total ? 14 : 8, lb = w - lr - lv - 2;
      const max = Math.max.apply(null, dados.map(t => t.valor)) || 1;
      dados.slice(0, n).forEach((t, i) => {
        const yy = y + i * 6.2;
        fonte(6.8, 'bold'); txt(TX); doc.text(corta(t.rotulo, lr - 2), x, yy + 3.4);
        fill('#EEF2F5'); doc.roundedRect(x + lr, yy + 0.9, lb, 3.4, 0.8, 0.8, 'F');
        fill(corB); doc.roundedRect(x + lr, yy + 0.9, Math.max(0.8, t.valor / max * lb), 3.4, 0.8, 0.8, 'F');
        fonte(6.8, 'bold'); txt(TX); doc.text(String(t.valor) + (total ? '  ' + pct(t.valor, total) + '%' : ''), x + lr + lb + 2, yy + 3.4);
      });
    }
    function legendaNC(x, y) {
      fill(OK); doc.rect(x, y - 2.2, 2.6, 2.6, 'F'); fonte(6.3, 'normal'); txt(TX2); doc.text('Sem NC', x + 3.6, y);
      fill(NC); doc.rect(x + 17, y - 2.2, 2.6, 2.6, 'F'); doc.text('Com NC', x + 20.6, y);
    }

    // ---- Linha 2: lote | status | canteiros NC ----------------------
    const y2 = yK + hK + 3.5, h2 = 50;
    const w2a = 92, w2b = 86, w2c = LW - w2a - w2b - gap * 2;
    const x2a = MG, x2b = x2a + w2a + gap, x2c = x2b + w2b + gap;
    cartao(x2a, y2, w2a, h2, 'Inspeções por lote');
    barrasEmp(x2a + 3.5, y2 + 10, w2a - 7, h2 - 17, d.porLote);
    legendaNC(x2a + 3.5, y2 + h2 - 3.5);

    cartao(x2b, y2, w2b, h2, 'Status das inspeções');
    (function rosca() {
      const cx = x2b + 21, cy = y2 + 29, R = 15, r = 9.5;
      const tot = d.total, ok = d.conformes != null ? d.conformes : d.total - d.comNC, nc = d.comNC;
      const fatias = tot ? [[ok, OK], [nc, NC]] : [[1, '#E6ECF1']];
      let ang = -Math.PI / 2;
      const soma = fatias.reduce((a, f) => a + f[0], 0) || 1;
      fatias.forEach(f => {
        if (!f[0]) return;
        const fim = ang + f[0] / soma * Math.PI * 2;
        fill(f[1]);
        for (let a = ang; a < fim - 1e-6; a += Math.PI / 90) {
          const b = Math.min(fim, a + Math.PI / 90 + 0.004);
          doc.triangle(cx, cy, cx + R * Math.cos(a), cy + R * Math.sin(a), cx + R * Math.cos(b), cy + R * Math.sin(b), 'F');
        }
        ang = fim;
      });
      if (tot && ok && nc) {   // respiro branco entre as fatias
        stroke('#FFFFFF'); doc.setLineWidth(0.6);
        [-Math.PI / 2, -Math.PI / 2 + ok / soma * Math.PI * 2].forEach(a => doc.line(cx + r * Math.cos(a), cy + r * Math.sin(a), cx + R * Math.cos(a), cy + R * Math.sin(a)));
      }
      fill('#FFFFFF'); doc.circle(cx, cy, r, 'F');
      fonte(13, 'bold'); txt(TX); doc.text(String(tot), cx, cy + 1.6, { align: 'center' });
      fonte(5.8, 'normal'); txt(TX2); doc.text('Total', cx, cy + 5, { align: 'center' });
      const lx = x2b + 42, lw = w2b - 46;
      const itens = [['Conforme', ok, pct(ok, tot), OK], ['Com NC', nc, pct(nc, tot), NC]];
      itens.forEach((it, i) => {
        const yy = y2 + 20 + i * 8;
        fill(it[3]); doc.circle(lx + 1.3, yy - 1.1, 1.3, 'F');
        fonte(7.2, 'bold'); txt(TX); doc.text(it[0], lx + 4, yy);
        doc.text(String(it[1]), lx + lw - 9, yy, { align: 'right' });
        fonte(6, 'normal'); txt(TX2); doc.text('(' + it[2] + '%)', lx + lw, yy, { align: 'right' });
      });
      stroke(BD); doc.setLineWidth(0.2); doc.setLineDashPattern([0.8, 0.8], 0);
      doc.line(lx, y2 + 32, lx + lw, y2 + 32); doc.setLineDashPattern([], 0);
      stroke(NC); doc.setLineWidth(0.6); fill('#FFFFFF'); doc.circle(lx + 1.3, y2 + 37 - 1.1, 1.1, 'FD');
      fonte(7, 'bold'); txt(TX); doc.text('NC em aberto (acum.)', lx + 4, y2 + 37);
      doc.text(String(d.ncAcumuladas), lx + lw, y2 + 37, { align: 'right' });
    })();

    cartao(x2c, y2, w2c, h2, 'Canteiros com mais não conformidades');
    if (d.rankingCanteiros.length) {
      barrasSim(x2c + 3.5, y2 + 10, w2c - 7, h2 - 13, d.rankingCanteiros.map(t => ({ rotulo: String(t.rotulo).replace(/^Canteiro\s+/i, ''), valor: t.valor })), NC);
    } else {
      fill('#ECF7F2'); doc.roundedRect(x2c + 3.5, y2 + 11, w2c - 7, 14, 1.5, 1.5, 'F');
      fonte(7.6, 'bold'); txt('#13795B'); doc.text('Nenhuma não conformidade no período.', x2c + 7, y2 + 17);
      fonte(6.6, 'normal'); txt(TX2); doc.text('Todas as inspeções do período estão conformes.', x2c + 7, y2 + 21.5);
    }

    // ---- Linha 3: evolução | empresa | itens ------------------------
    const y3 = y2 + h2 + 3.5, h3 = 50;
    const w3a = 138, w3b = 70, w3c = LW - w3a - w3b - gap * 2;
    const x3a = MG, x3b = x3a + w3a + gap, x3c = x3b + w3b + gap;
    cartao(x3a, y3, w3a, h3, 'Evolução mensal (últimos 12 meses)');
    legendaNC(x3a + w3a - 40, y3 + 6);
    (function colunas() {
      const ev = d.evolucao || [];
      if (!ev.some(m => m.total)) return vazio(x3a, y3 + 4, w3a, h3, 'Sem inspeções nos últimos 12 meses.');
      const gx = x3a + 10, gy = y3 + 11, gw = w3a - 14, gh = h3 - 20;
      const max = Math.max.apply(null, ev.map(m => m.total));
      const passo = max <= 4 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : Math.ceil(max / 5 / 5) * 5;
      const topo = Math.ceil(max / passo) * passo || 1;
      fonte(5.6, 'normal');
      for (let v = 0; v <= topo; v += passo) {
        const yy = gy + gh - v / topo * gh;
        stroke('#E7EDF1'); doc.setLineWidth(0.15); doc.line(gx, yy, gx + gw, yy);
        txt('#6B7B88'); doc.text(String(v), gx - 1.5, yy + 1, { align: 'right' });
      }
      const col = gw / ev.length, bw = Math.min(6.5, col * 0.58);
      ev.forEach((m, i) => {
        const x = gx + i * col + (col - bw) / 2, base = gy + gh;
        const hOk = (m.total - m.nc) / topo * gh, hNc = m.nc / topo * gh;
        if (hOk > 0) { fill(OK); doc.rect(x, base - hOk, bw, hOk, 'F'); }
        if (hNc > 0) { fill(NC); doc.rect(x, base - hOk - hNc - (hOk > 0 ? 0.4 : 0), bw, hNc, 'F'); }
        if (m.total) { fonte(5.8, 'bold'); txt(TX); doc.text(String(m.total), x + bw / 2, base - hOk - hNc - 1.3, { align: 'center' }); }
        fonte(5.4, i === ev.length - 1 ? 'bold' : 'normal'); txt(i === ev.length - 1 ? TX : '#6B7B88');
        doc.text(m.rotulo, x + bw / 2, base + 4, { align: 'center' });
      });
    })();

    cartao(x3b, y3, w3b, h3, 'Inspeções por empresa');
    barrasEmp(x3b + 3.5, y3 + 10, w3b - 7, h3 - 13, d.porEmpresa);
    cartao(x3c, y3, w3c, h3, 'Distribuição por item inspecionado');
    const totItens = d.itens.reduce((t, x) => t + x.valor, 0);
    barrasSim(x3c + 3.5, y3 + 10, w3c - 7, h3 - 13, d.itens, OK, null, totItens);

    // ---- Linha 4: cobertura de canteiros (3 colunas) ----------------
    const y4 = y3 + h3 + 3.5, h4 = H - 9 - y4;
    cartao(MG, y4, LW, h4, 'Cobertura de canteiros');
    const cont = { verde: 0, amarelo: 0, vermelho: 0 };
    d.cobertura.forEach(c => { cont[c.semaforo]++; });
    const SEM = { verde: '#2E7D32', amarelo: '#E8A317', vermelho: NC };
    let lx = MG + 52;
    [['verde', 'Em dia (até 30 dias)'], ['amarelo', 'Atenção (31 a 60)'], ['vermelho', 'Crítico (+60 ou nunca)']].forEach(s => {
      fill(SEM[s[0]]); doc.circle(lx, y4 + 5, 1.2, 'F');
      fonte(6.6, 'bold'); txt(TX); doc.text(String(cont[s[0]]), lx + 2.6, y4 + 6);
      fonte(6.4, 'normal'); txt(TX2); doc.text(s[1], lx + 2.6 + doc.getTextWidth(String(cont[s[0]])) + 1.6, y4 + 6);
      lx += 50;
    });
    const colW = (LW - 7 - 8) / 3, linhaH = 3.75, yT = y4 + 9;
    const porColuna = Math.max(1, Math.floor((h4 - 15) / linhaH));
    const capac = porColuna * 3;
    const lista = d.cobertura.slice(0, capac);
    for (let c = 0; c < 3; c++) {
      const cx = MG + 3.5 + c * (colW + 4);
      fill(NAVY); doc.rect(cx, yT, colW, 4.6, 'F');
      fonte(5.8, 'bold'); txt('#FFFFFF');
      doc.text('Canteiro', cx + 1.6, yT + 3.2); doc.text('Lote', cx + colW * 0.52, yT + 3.2);
      doc.text('Última', cx + colW * 0.64, yT + 3.2); doc.text('Situação', cx + colW * 0.8, yT + 3.2);
      lista.slice(c * porColuna, (c + 1) * porColuna).forEach((it, k) => {
        const yy = yT + 4.6 + k * linhaH;
        if (k % 2) { fill('#F7FAFB'); doc.rect(cx, yy, colW, linhaH, 'F'); }
        fonte(6, 'bold'); txt(TX); doc.text(corta(String(it.canteiro).replace(/^Canteiro\s+/i, ''), colW * 0.5 - 2), cx + 1.6, yy + 2.7);
        fonte(6, 'normal'); doc.text(String(it.lote), cx + colW * 0.52, yy + 2.7);
        doc.text(it.ultima ? dataBR(it.ultima).slice(0, 5) + '/' + dataBR(it.ultima).slice(8, 10) : '—', cx + colW * 0.64, yy + 2.7);
        fill(SEM[it.semaforo]); doc.circle(cx + colW * 0.8 + 0.9, yy + 1.85, 0.9, 'F');
        txt(TX2); doc.text(it.dias === null ? 'nunca' : (it.dias === 0 ? 'hoje' : it.dias + ' d'), cx + colW * 0.8 + 3, yy + 2.7);
      });
    }
    if (d.cobertura.length > capac) {
      fonte(6, 'normal'); txt(TX2);
      doc.text('+ ' + (d.cobertura.length - capac) + ' canteiro(s) — lista completa no painel do app.', W - MG - 3.5, y4 + h4 - 1.8, { align: 'right' });
    }

    // ---- Rodapé -----------------------------------------------------
    const emissao = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    fonte(6.4, 'normal'); txt(TX2);
    doc.text('Emitido em ' + emissao + (p ? ' por ' + texto(p.nome) + (p.funcao ? ' — ' + texto(p.funcao) : '') : ''), MG, H - 3.6);
    doc.text(texto(CONFIG.app.nome) + '  •  versão ' + CONFIG.app.versao, W - MG, H - 3.6, { align: 'right' });

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
