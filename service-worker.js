/* =====================================================================
 * service-worker.js — CACHE OFFLINE E SINCRONIZAÇÃO EM SEGUNDO PLANO
 * ---------------------------------------------------------------------
 * Estratégia: CACHE-FIRST para todos os arquivos da aplicação.
 * O precache acontece na instalação, então já no PRIMEIRO acesso após
 * a instalação o app abre integralmente sem rede.
 *
 * IMPORTANTE AO PUBLICAR UMA NOVA VERSÃO:
 * altere VERSAO abaixo — é o que dispara a limpeza dos caches antigos.
 * ===================================================================== */

const VERSAO = 'v4.5.0';
const CACHE = 'inspecao-infra-' + VERSAO;
const CACHE_MAPA = 'inspecao-infra-mapa-v2';      // não muda com a versão: preserva as imagens
const LIMITE_MAPA = 1500;                      // ~25 MB no máximo

async function limitarCacheMapa(cache) {
  try {
    const chaves = await cache.keys();
    if (chaves.length > LIMITE_MAPA) {
      await Promise.all(chaves.slice(0, chaves.length - LIMITE_MAPA).map(k => cache.delete(k)));
    }
  } catch (e) { /* manutenção opcional */ }
}

/* Todos os arquivos necessários para o app funcionar 100% offline —
   incluindo a logo EDP, que precisa aparecer sem rede.
   Qualquer arquivo novo precisa ser acrescentado aqui.               */
const ARQUIVOS = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './db.js',
  './auth.js',
  './sync.js',
  './cronograma.js',
  './mapa.js',
  './leaflet.js',
  './leaflet.css',
  './images/layers.png',
  './images/layers-2x.png',
  './pdf.js',
  './painel.js',
  './app.js',
  './manifest.json',
  './assets/edp-logo-neg.png',
  './assets/logo-edp50.png',
  './assets/login-fundo.jpg',
  './assets/login-fundo-largo.jpg',
  './assets/logo-edp-base64.js',
  './vendor/dexie.min.js',
  './vendor/jspdf.umd.min.js',
  './vendor/html2canvas.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-64.png',
  './assets/app-emblema.png'
];

/* ---------------------------------------------------------------------
 * INSTALAÇÃO — baixa e guarda tudo
 * ------------------------------------------------------------------- */
self.addEventListener('install', (evento) => {
  evento.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll falha inteiro se um arquivo falhar; adicionamos um a um para
    // que um item ausente não impeça a instalação do restante.
    await Promise.all(ARQUIVOS.map(async (url) => {
      try {
        const resp = await fetch(url, { cache: 'reload' });
        if (resp && (resp.ok || resp.type === 'opaque')) await cache.put(url, resp);
      } catch (e) {
        console.warn('[SW] não foi possível pré-carregar:', url, e);
      }
    }));
    self.skipWaiting();   // ativa a nova versão assim que terminar
  })());
});

/* ---------------------------------------------------------------------
 * ATIVAÇÃO — remove caches de versões anteriores
 * ------------------------------------------------------------------- */
self.addEventListener('activate', (evento) => {
  evento.waitUntil((async () => {
    const chaves = await caches.keys();
    await Promise.all(chaves
      .filter(k => k.startsWith('inspecao-infra-') && k !== CACHE && k !== CACHE_MAPA)
      .map(k => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch (e) {}
    }
    await self.clients.claim();
  })());
});

/* ---------------------------------------------------------------------
 * REQUISIÇÕES
 * -------------------------------------------------------------------
 *  - Navegação (abrir o app): cache do index.html primeiro.
 *  - Arquivos da aplicação: rede primeiro (3 s), cache sem rede.
 *  - Esta versão não fala com servidor nenhum: tudo o que o app
 *    precisa está no cache.
 * ------------------------------------------------------------------- */
self.addEventListener('fetch', (evento) => {
  const req = evento.request;
  if (req.method !== 'GET') return;                 // POST/PATCH: direto à rede

  const url = new URL(req.url);
  const mesmaOrigem = (url.origin === self.location.origin);

  // Imagens do mapa: guardadas no aparelho depois da 1ª vez (cache primeiro),
  // para o mapa de um canteiro já visto abrir mesmo sem sinal.
  if (/^tile\.openstreetmap\.org$|^server\.arcgisonline\.com$/.test(url.hostname)) {
    evento.respondWith((async () => {
      const cache = await caches.open(CACHE_MAPA);
      const guardado = await cache.match(req);
      // Resposta "opaca" não serve para pedido com CORS (miniatura do PDF)
      if (guardado && !(req.mode === 'cors' && guardado.type === 'opaque')) return guardado;
      try {
        const rede = await fetch(req);
        if (rede && (rede.ok || rede.type === 'opaque')) {
          cache.put(req, rede.clone());
          limitarCacheMapa(cache);
        }
        return rede;
      } catch (e) {
        return new Response('', { status: 504, statusText: 'Offline' });
      }
    })());
    return;
  }
  if (!mesmaOrigem) return;                          // APIs externas: sem cache

  // Navegação: devolve o index.html mesmo sem rede
  if (req.mode === 'navigate') {
    evento.respondWith((async () => {
      try {
        const rede = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', rede.clone());
        return rede;
      } catch (e) {
        const cache = await caches.open(CACHE);
        return (await cache.match('./index.html')) ||
               (await cache.match('./')) ||
               new Response('Aplicativo indisponível offline.', { status: 503 });
      }
    })());
    return;
  }

  // Demais arquivos: REDE PRIMEIRO (com limite de 3 s) e cache como reserva.
  // Assim, com o servidor no ar, qualquer alteração publicada aparece já
  // no próximo carregamento; sem rede, o app abre normalmente pelo cache.
  evento.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const rede = await Promise.race([
        fetch(req, { cache: 'no-store' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('tempo')), 3000))
      ]);
      if (rede && rede.ok) { cache.put(req, rede.clone()); return rede; }
      throw new Error('resposta ' + (rede && rede.status));
    } catch (e) {
      const emCache = await cache.match(req, { ignoreSearch: true });
      return emCache || new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});

/* ---------------------------------------------------------------------
 * ENVIO EM SEGUNDO PLANO (Background Sync — Android / Chrome)
 * -------------------------------------------------------------------
 * O app registra o pedido "enviar-inspecoes" sempre que sobra algo na
 * fila. Quando o sinal volta — mesmo com o app FECHADO — o Chrome acorda
 * este service worker, que envia a fila com o mesmo código do app.
 * Com o app aberto, só avisa a janela para sincronizar.
 * Falhou (sem rede, sessão)? O navegador tenta de novo mais tarde.
 * ------------------------------------------------------------------- */
let moduloEnvio = false;
try {
  self.window = self;   // os módulos do app usam "window" como namespace
  importScripts('./vendor/dexie.min.js', './config.js', './db.js', './auth.js', './sync.js');
  moduloEnvio = true;
} catch (e) {
  console.warn('[SW] envio em segundo plano indisponível:', e && e.message);
}

async function enviarEmSegundoPlano() {
  const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (janelas.length) {
    janelas.forEach(c => c.postMessage({ tipo: 'sincronizar' }));
    return;
  }
  if (!moduloEnvio || !self.AUTH || !self.SYNC) return;
  await AUTH.iniciar();
  if (!AUTH.autenticado() || AUTH.modoLocal()) return;
  const r = await SYNC.sincronizar(true);
  const restantes = (await DB.listarPendentes()).length;
  if (restantes && (r.offline || r.falhas || r.erro || r.pulado)) {
    throw new Error('fila ainda pendente — o navegador tenta de novo');
  }
}

self.addEventListener('sync', (evento) => {
  if (evento.tag === 'enviar-inspecoes') evento.waitUntil(enviarEmSegundoPlano());
});

/* Permite que a página force a ativação de uma nova versão. */
self.addEventListener('message', (evento) => {
  if (evento.data && evento.data.tipo === 'pular-espera') self.skipWaiting();
});
