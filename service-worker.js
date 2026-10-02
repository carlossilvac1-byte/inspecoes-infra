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

const VERSAO = 'v4.0.0';
const CACHE = 'inspecao-infra-' + VERSAO;

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
  './icons/apple-touch-icon.png'
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
      .filter(k => k.startsWith('inspecao-infra-') && k !== CACHE)
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

/* Permite que a página force a ativação de uma nova versão. */
self.addEventListener('message', (evento) => {
  if (evento.data && evento.data.tipo === 'pular-espera') self.skipWaiting();
});
