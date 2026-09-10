// Service Worker v7 — Sin caché, con reintentos y fallback seguro
const VERSION = 'v7-retry-safe';

const FETCH_TIMEOUT_MS = 8000;   // tiempo máx. por intento antes de darlo por fallido
const MAX_RETRIES = 2;           // reintentos adicionales (3 intentos en total)
const RETRY_DELAY_MS = 600;      // espera entre reintentos

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => {
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => client.navigate(client.url).catch(() => {}));
        });
      })
  );
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Intenta la petición con un tiempo límite; si se agota o falla, reintenta
// unas cuantas veces antes de darse por vencido. Esto evita que un simple
// "parpadeo" de señal (muy común en datos móviles) tumbe la app entera,
// y evita que una petición se quede colgada para siempre sin avisar.
async function fetchWithRetry(request) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(request.clone(), { cache: 'no-store', signal: controller.signal });
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError;
}

// Página de respaldo — SOLO para la navegación principal (cuando ni
// reintentando se pudo cargar la página). Nunca se usa para archivos
// internos como app.js o app.css: sustituir esos por texto rompería
// la app en silencio (el navegador intentaría ejecutar/aplicar ese
// texto como si fuera código o estilos válidos).
function offlinePage() {
  const html = '<!doctype html>' +
'<html lang="es"><head>' +
'<meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1">' +
'<title>Sin conexión</title>' +
'<style>' +
'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
'background:#1B1035;color:#fff;font-family:-apple-system,Segoe UI,Roboto,sans-serif;' +
'text-align:center;padding:24px;box-sizing:border-box;}' +
'.box{max-width:340px}' +
'.icon{font-size:44px;margin-bottom:12px}' +
'h1{font-size:19px;margin:0 0 8px}' +
'p{font-size:14px;color:#cfc4e8;margin:0 0 20px;line-height:1.4}' +
'button{background:#7C4DFF;color:#fff;border:none;border-radius:10px;padding:12px 22px;' +
'font-size:15px;font-weight:600}' +
'</style></head><body>' +
'<div class="box">' +
'<div class="icon">\u{1F4F6}</div>' +
'<h1>Sin conexión</h1>' +
'<p>No se pudo cargar Registro Matrimonial. Verifica tu señal o datos móviles e intenta de nuevo.</p>' +
'<button onclick="location.reload()">Reintentar</button>' +
'</div>' +
'<script>window.addEventListener("online", function(){ location.reload(); });</' + 'script>' +
'</body></html>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  const isNavigation = e.request.mode === 'navigate';

  e.respondWith(
    fetchWithRetry(e.request).catch(() => {
      // Página principal: mostramos una pantalla clara con botón de
      // "Reintentar" (y reintento automático al recuperar señal).
      if (isNavigation) return offlinePage();
      // Recursos internos (app.js, app.css, manifest, etc.): dejamos que
      // fallen de forma normal, tal como si no hubiera Service Worker.
      return Response.error();
    })
  );
});