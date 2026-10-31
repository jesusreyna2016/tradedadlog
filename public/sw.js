// TradeDadLog service worker: makes the hub installable and work offline.
// Network-first (revalidated against the server) for pages and every file without a content
// hash, so a deploy shows on the next load with no hard refresh. Cache-first ONLY for Vite's
// hashed files under /assets/ (a new build gets new names). NETWORK-ONLY for live data
// (/api/*, functions). Never intercepts other origins (fonts, analytics, TV).
// Bump CACHE when this file changes: activate deletes every older cache.
const CACHE = 'tdl-v3';
const SHELL = ['/', '/index.html', '/indicators.html', '/manifest.webmanifest'];

// Live endpoints: must always hit the network, never be served from Cache Storage.
// (Cache Storage ignores HTTP cache-control and the {cache:'no-store'} fetch option,
// so without this a cached /api/cc-plan sticks forever until a hard reload.)
function isLiveData(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/');
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== location.origin) return; // let cross-origin (fonts, analytics, TV) hit the network

  // Live data: network-only. On failure, surface the error (do NOT fall back to a stale cache).
  if (isLiveData(url)) {
    e.respondWith(fetch(req));
    return;
  }

  // Hashed build files never change under the same name: cache-first is safe.
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(req).then((c) => c || fetch(req).then((r) => {
        if (r && r.status === 200) { const cp = r.clone(); caches.open(CACHE).then((ca) => ca.put(req, cp)); }
        return r;
      }))
    );
    return;
  }

  // Pages and every unhashed file (command-center.html, /cc2/*.js, json, images): ask the server
  // first, revalidating past the HTTP cache, and keep a copy only as the offline fallback.
  // (navigations keep the original request so redirects still work; the HTML is served
  // no-cache by netlify.toml, so the browser revalidates it anyway)
  const nav = req.mode === 'navigate';
  e.respondWith(
    (nav ? fetch(req) : fetch(req, { cache: 'no-cache' }))
      .then((r) => { if (r && r.status === 200) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); } return r; })
      .catch(() => caches.match(req).then((m) => m || (nav ? caches.match('/index.html') : Response.error())))
  );
});
