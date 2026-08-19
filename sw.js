// Service Worker v5 — Sin caché, siempre red
const CACHE = 'rm-v5';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Borrar TODOS los cachés anteriores
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Siempre ir a la red, nunca usar caché
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Solo interceptar recursos propios, no externos
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .catch(() => caches.match(e.request))
  );
});
