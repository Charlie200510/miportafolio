/* Service Worker — Mi Portafolio
   Estrategia:
   - Shell (HTML, CSS inline, JS) → cache-first con revalidación en background
   - APIs (/api/*) → network-only (datos siempre frescos)
   - Static assets (logo, fonts) → cache-first largo
*/
// IMPORTANTE: Bumpear esta versión cada vez que cambies JS/CSS críticos
// para forzar invalidación del cache en todos los usuarios.
const VERSION = 'mp-v1.7.7';
const SHELL_CACHE  = `${VERSION}-shell`;
const STATIC_CACHE = `${VERSION}-static`;
const ASSETS_CACHE = `${VERSION}-assets`;

const PRECACHE_URLS = [
  '/',
  '/landing',
  '/signup',
  '/static/logo.png',
  '/static/manifest.webmanifest',
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

  // Páginas HTML del shell → stale-while-revalidate
  if (req.mode === 'navigate' || url.pathname.match(/\.(html)$/)) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }

  // JS y CSS → stale-while-revalidate (cache para velocidad, pero siempre
  // actualiza en background. Así los fixes llegan al usuario sin que tenga
  // que limpiar el cache manualmente).
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
