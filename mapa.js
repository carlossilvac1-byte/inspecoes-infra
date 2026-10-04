/* =====================================================================
 * mapa.js — MAPAS DA INSPEÇÃO (Leaflet)
 * ---------------------------------------------------------------------
 *  • Nova inspeção: mapa com o ponto do GPS; o inspetor arrasta o pino
 *    (ou toca no mapa) para ajustar o local exato.
 *  • Detalhe: mapa do local + "Abrir no Google Maps".
 *  • PDF: miniatura do mapa montada a partir das imagens do mapa.
 *  • Painel: todos os locais inspecionados — verde sem NC, vermelho com NC.
 *
 * Duas camadas: "Mapa" (ruas — CARTO/OpenStreetMap) e "Satélite" (Esri).
 * O mapa precisa de internet para baixar as imagens; o GPS não. Sem
 * sinal, as coordenadas continuam registradas e o mapa aparece quando a
 * conexão voltar (as imagens já vistas ficam guardadas no aparelho).
 * ===================================================================== */

const MAPA = (function () {

  const CENTRO_PADRAO = [-7.5, -44.5];   // região dos lotes (PI / MA / GO / TO)
  const ZOOM_PADRAO = 5;
  const COR_OK = '#1F9E8F', COR_NC = '#D64545';

  const CAMADAS = {
    mapa: {
      url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
      opcoes: { subdomains: 'abcd', maxZoom: 19, crossOrigin: true,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>' }
    },
    satelite: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      opcoes: { maxZoom: 19, crossOrigin: true, attribution: 'Imagens &copy; Esri, Maxar, Earthstar Geographics' }
    }
  };

  const disponivel = () => typeof window.L !== 'undefined';
  const temCoord = (r) => r && r.latitude !== null && r.latitude !== undefined && r.longitude !== null && r.longitude !== undefined;
  const fmt = (v) => Number(v).toFixed(6);

  function linkGoogle(lat, lng) {
    return 'https://www.google.com/maps/search/?api=1&query=' + fmt(lat) + ',' + fmt(lng);
  }

  /** Cria um mapa com as duas camadas e o seletor Mapa / Satélite. */
  function novoMapa(el, opcoes) {
    const m = L.map(el, Object.assign({ zoomControl: true, attributionControl: true, scrollWheelZoom: false }, opcoes || {}));
    m.attributionControl.setPrefix('');
    const ruas = L.tileLayer(CAMADAS.mapa.url, CAMADAS.mapa.opcoes);
    const sat = L.tileLayer(CAMADAS.satelite.url, CAMADAS.satelite.opcoes);
    ruas.addTo(m);
    L.control.layers({ 'Mapa': ruas, 'Satélite': sat }, null, { position: 'topright' }).addTo(m);
    // Aviso quando as imagens não carregam (sem internet)
    let avisou = false;
    [ruas, sat].forEach(c => c.on('tileerror', () => {
      if (avisou) return; avisou = true;
      const box = el.parentNode && el.parentNode.querySelector('.mapa-offline');
      if (box) box.hidden = false;
    }));
    m.whenReady(() => setTimeout(() => m.invalidateSize(), 60));
    return m;
  }

  /** Pino no padrão do app (sem depender de imagem externa). */
  function pino(cor) {
    return L.divIcon({
      className: 'pino-mapa',
      html: '<span style="--cor:' + (cor || COR_OK) + '"></span>',
      iconSize: [26, 34], iconAnchor: [13, 32], popupAnchor: [0, -28]
    });
  }

  /* ===================================================================
   * 1) FORMULÁRIO — ajuste do ponto
   * =================================================================== */
  const form = { mapa: null, marcador: null, circulo: null, aoMudar: null };

  /**
   * Mostra / atualiza o mapa do formulário.
   * @param {object} reg      registro em edição (latitude, longitude, precisaoGps)
   * @param {function} aoMudar callback(lat, lng) quando o inspetor ajusta o pino
   */
  function formulario(reg, aoMudar) {
    const el = document.getElementById('mapa-form');
    if (!el) return;
    form.aoMudar = aoMudar;
    if (!disponivel()) { el.parentNode.hidden = true; return; }
    el.parentNode.hidden = false;
    if (!form.mapa) {
      form.mapa = novoMapa(el, { tap: true });
      form.mapa.on('click', (e) => posicionar(e.latlng.lat, e.latlng.lng, true));
    }
    const box = el.parentNode.querySelector('.mapa-offline');
    if (box) box.hidden = navigator.onLine;
    setTimeout(() => form.mapa.invalidateSize(), 80);
    if (temCoord(reg)) {
      colocarPino(reg.latitude, reg.longitude, reg.precisaoGps);
      form.mapa.setView([reg.latitude, reg.longitude], 17);
    } else {
      limparPino();
      form.mapa.setView(CENTRO_PADRAO, ZOOM_PADRAO);
    }
  }

  function colocarPino(lat, lng, precisao) {
    if (!form.marcador) {
      form.marcador = L.marker([lat, lng], { draggable: true, icon: pino(COR_OK), autoPan: true }).addTo(form.mapa);
      form.marcador.on('dragend', () => {
        const p = form.marcador.getLatLng();
        posicionar(p.lat, p.lng, true);
      });
    } else {
      form.marcador.setLatLng([lat, lng]);
    }
    if (form.circulo) { form.mapa.removeLayer(form.circulo); form.circulo = null; }
    if (precisao) {
      form.circulo = L.circle([lat, lng], { radius: precisao, color: COR_OK, weight: 1, fillOpacity: 0.08 }).addTo(form.mapa);
    }
  }
  function limparPino() {
    if (form.marcador) { form.mapa.removeLayer(form.marcador); form.marcador = null; }
    if (form.circulo) { form.mapa.removeLayer(form.circulo); form.circulo = null; }
  }

  /** Ajuste manual: tocar no mapa ou arrastar o pino. */
  function posicionar(lat, lng, manual) {
    lat = Number(fmt(lat)); lng = Number(fmt(lng));
    colocarPino(lat, lng, manual ? null : undefined);
    if (form.aoMudar) form.aoMudar(lat, lng, manual);
  }

  /* ===================================================================
   * 2) DETALHE — mapa do local, somente leitura
   * =================================================================== */
  let mapaDetalhe = null;
  function detalhe(el, reg, nc) {
    if (!el) return;
    if (mapaDetalhe) { mapaDetalhe.remove(); mapaDetalhe = null; }
    if (!disponivel() || !temCoord(reg)) { el.parentNode.hidden = true; return; }
    el.parentNode.hidden = false;
    const box = el.parentNode.querySelector('.mapa-offline');
    if (box) box.hidden = navigator.onLine;
    mapaDetalhe = novoMapa(el, { dragging: true });
    L.marker([reg.latitude, reg.longitude], { icon: pino(nc ? COR_NC : COR_OK) }).addTo(mapaDetalhe);
    if (reg.precisaoGps) L.circle([reg.latitude, reg.longitude], { radius: reg.precisaoGps, color: nc ? COR_NC : COR_OK, weight: 1, fillOpacity: 0.08 }).addTo(mapaDetalhe);
    mapaDetalhe.setView([reg.latitude, reg.longitude], 16);
    setTimeout(() => mapaDetalhe && mapaDetalhe.invalidateSize(), 120);
  }

  /* ===================================================================
   * 3) PAINEL — todos os locais do período
   * =================================================================== */
  let mapaPainel = null, grupoPainel = null;
  function painel(el, lista) {
    if (!el) return { total: 0, semCoord: 0 };
    const comCoord = lista.filter(temCoord);
    const info = { total: comCoord.length, semCoord: lista.length - comCoord.length };
    if (!disponivel()) { el.innerHTML = '<div class="bi-vazio"><span>Mapa indisponível neste navegador.</span></div>'; return info; }
    if (!mapaPainel) {
      mapaPainel = novoMapa(el, { scrollWheelZoom: false });
    }
    const box = el.parentNode.querySelector('.mapa-offline');
    if (box) box.hidden = navigator.onLine;
    if (grupoPainel) mapaPainel.removeLayer(grupoPainel);
    grupoPainel = L.featureGroup();
    comCoord.forEach(r => {
      const nc = r.naoConformidade === 'Sim';
      const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      L.marker([r.latitude, r.longitude], { icon: pino(nc ? COR_NC : COR_OK), title: DB.nomeCanteiro(r) })
        .bindPopup('<b>' + esc(DB.nomeCanteiro(r)) + '</b><br>' + esc(r.lote) + ' • ' + esc(PDFGEN.dataBR(r.dataInspecao)) +
          '<br><span style="color:' + (nc ? COR_NC : COR_OK) + ';font-weight:700">' + (nc ? 'Com não conformidade' : 'Sem NC') + '</span>' +
          (r.responsavel ? '<br><small>' + esc(r.responsavel) + '</small>' : '') +
          '<br><a href="' + linkGoogle(r.latitude, r.longitude) + '" target="_blank" rel="noopener">Abrir no Google Maps</a>')
        .addTo(grupoPainel);
    });
    grupoPainel.addTo(mapaPainel);
    setTimeout(() => {
      mapaPainel.invalidateSize();
      if (comCoord.length) mapaPainel.fitBounds(grupoPainel.getBounds().pad(0.25), { maxZoom: 14 });
      else mapaPainel.setView(CENTRO_PADRAO, ZOOM_PADRAO);
    }, 120);
    return info;
  }
  function redimensionar() { [form.mapa, mapaDetalhe, mapaPainel].forEach(m => { if (m) m.invalidateSize(); }); }

  /* ===================================================================
   * 4) IMAGEM ESTÁTICA PARA O PDF
   * -------------------------------------------------------------------
   * Monta a imagem juntando os "ladrilhos" do mapa num canvas (os
   * servidores de mapa permitem esse uso — CORS liberado). Sem internet,
   * devolve null e o PDF sai só com as coordenadas.
   * =================================================================== */
  function lon2x(lon, z) { return (lon + 180) / 360 * Math.pow(2, z) * 256; }
  function lat2y(lat, z) {
    const r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z) * 256;
  }
  function carregarImg(url) {
    return new Promise((ok, falha) => {
      const img = new Image(); img.crossOrigin = 'anonymous';
      const t = setTimeout(() => falha(new Error('tempo')), 8000);
      img.onload = () => { clearTimeout(t); ok(img); };
      img.onerror = () => { clearTimeout(t); falha(new Error('imagem')); };
      img.src = url;
    });
  }
  async function imagemEstatica(lat, lng, opcoes) {
    opcoes = opcoes || {};
    const z = opcoes.zoom || 16, W = opcoes.largura || 640, H = opcoes.altura || 360;
    const camada = opcoes.satelite ? CAMADAS.satelite : CAMADAS.mapa;
    if (!navigator.onLine) return null;
    const cx = lon2x(lng, z), cy = lat2y(lat, z);
    const x0 = cx - W / 2, y0 = cy - H / 2;
    const tx0 = Math.floor(x0 / 256), ty0 = Math.floor(y0 / 256), tx1 = Math.floor((x0 + W) / 256), ty1 = Math.floor((y0 + H) / 256);
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#E8EEF2'; ctx.fillRect(0, 0, W, H);
    const tarefas = [];
    let i = 0;
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const url = camada.url.replace('{s}', 'abcd'[(i++) % 4]).replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
        tarefas.push(carregarImg(url).then(img => ctx.drawImage(img, tx * 256 - x0, ty * 256 - y0)).catch(() => null));
      }
    }
    const res = await Promise.all(tarefas);
    if (res.every(r => r === null)) return null;
    // Pino
    const px = W / 2, py = H / 2;
    ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.beginPath(); ctx.ellipse(px, py + 2, 7, 3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = opcoes.nc ? COR_NC : COR_OK; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(px, py);
    ctx.bezierCurveTo(px - 4, py - 10, px - 13, py - 16, px - 13, py - 26);
    ctx.arc(px, py - 26, 13, Math.PI, 0); ctx.bezierCurveTo(px + 13, py - 16, px + 4, py - 10, px, py);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px, py - 26, 5, 0, Math.PI * 2); ctx.fill();
    // Atribuição
    ctx.font = '11px Arial'; const atrib = opcoes.satelite ? '© Esri' : '© OpenStreetMap © CARTO';
    const lw = ctx.measureText(atrib).width + 10;
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(W - lw, H - 16, lw, 16);
    ctx.fillStyle = '#333'; ctx.fillText(atrib, W - lw + 5, H - 4.5);
    try { return canvas.toDataURL('image/jpeg', 0.85); } catch (e) { return null; }
  }

  return {
    disponivel: disponivel,
    formulario: formulario,
    detalhe: detalhe,
    painel: painel,
    redimensionar: redimensionar,
    imagemEstatica: imagemEstatica,
    linkGoogle: linkGoogle
  };
})();

window.MAPA = MAPA;
