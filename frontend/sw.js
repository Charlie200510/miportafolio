/* Service Worker — Mi Portafolio
   Estrategia:
   - Shell (HTML, CSS inline, JS) → cache-first con revalidación en background
   - APIs (/api/*) → network-only (datos siempre frescos)
   - Static assets (logo, fonts) → cache-first largo
*/
// IMPORTANTE: Bumpear esta versión cada vez que cambies JS/CSS críticos
// para forzar invalidación del cache en todos los usuarios.
const VERSION = 'mp-v1.30.0';
const SHELL_CACHE  = `${VERSION}-shell`;
const STATIC_CACHE = `${VERSION}-static`;
const ASSETS_CACHE = `${VERSION}-assets`;

const PRECACHE_URLS = [
  '/',
  '/landing',
  '/signup',
  '/static/logo.png',
  '/static/manifest.webmanifest',
  // Sistema editorial: hojas + los subsets latin de las tres familias.
  // Se precachean para que el primer render offline ya salga con la
  // tipografía correcta y no con el fallback del sistema.
  '/static/css/mp-tokens.css',
  '/static/css/mp-editorial.css',
  '/static/fonts/source-serif-4-400-700-latin.woff2',
  '/static/fonts/ibm-plex-sans-400-700-latin.woff2',
  '/static/fonts/ibm-plex-mono-400-latin.woff2',
  '/static/fonts/ibm-plex-mono-500-latin.woff2',
  '/static/fonts/ibm-plex-mono-600-latin.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(PRECACHE_URLS).catch(() => {})
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys
        .filter((k) => !k.startsWith(VERSION))
        .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // APIs y POSTs → red siempre, sin cache
  if (url.pathname.startsWith('/api/')) {
    return; // dejar al navegador que vaya a la red
  }

  // HTML + JS + CSS → stale-while-revalidate: sirve del caché AL INSTANTE
  // (la app siempre carga rápido, aunque el server del free tier esté lento o
  // reiniciándose) y actualiza en segundo plano para la próxima carga. El bump
  // de VERSION en cada deploy purga los cachés viejos, así que los fixes llegan
  // sin que el usuario se quede atorado en una pantalla en blanco.
  if (req.mode === 'navigate' || url.pathname.match(/\.(html)$/)) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }
  if (url.pathname.match(/\.(js|css)$/)) {
    event.respondWith(staleWhileRevalidate(req, STATIC_CACHE));
    return;
  }

  // Imágenes, fonts y otros assets pesados → cache-first (rara vez cambian)
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(cacheFirst(req, ASSETS_CACHE));
    return;
  }
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.status === 200) cache.put(request, fresh.clone());
    return fresh;
  } catch (_) {
    return cached || new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response && response.status === 200) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}

// Red primero CON timeout: intenta la red y actualiza el caché; pero si el
// servidor tarda más de timeoutMs (típico del free tier en arranque en frío) y
// HAY copia en caché, sirve la caché al instante para no dejar la app trabada.
// Si no hay caché, espera la red. Si la red falla, cae a la caché.
// Resultado: siempre fresco cuando el server responde rápido, y nunca se traba.
async function networkFirst(request, cacheName, timeoutMs = 3500) {
  const cache = await caches.open(cacheName);
  const fromNet = fetch(request)
    .then((r) => { if (r && r.status === 200) cache.put(request, r.clone()); return r; });
  const cached = await cache.match(request);
  try {
    if (cached) {
      // Carrera: lo que llegue primero entre la red y el timeout (→ caché).
      const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), timeoutMs));
      return await Promise.race([fromNet.catch(() => cached), timeout]);
    }
    return await fromNet;   // sin caché: hay que esperar a la red
  } catch (_) {
    return cached || new Response('Offline', { status: 503 });
  }
}


// ============================================================
//  WEB PUSH NOTIFICATIONS
// ============================================================
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Mi Portafolio', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Mi Portafolio';
  const options = {
    body:    data.body || '',
    icon:    data.icon || '/static/logo.png',
    badge:   data.badge || '/static/logo.png',
    tag:     data.tag || 'miportafolio',
    data:    { url: data.url || '/' },
    vibrate: [100, 50, 100],
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Si hay una ventana abierta de la app, enfócala
      for (const c of clients) {
        if (c.url.includes(self.location.host) && 'focus' in c) {
          c.navigate(url);
          return c.focus();
        }
      }
      // Si no, abre una nueva
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
