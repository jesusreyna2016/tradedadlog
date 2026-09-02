// TradeDadLog service worker: makes the hub installable and work offline.
// Network-first for navigations (fresh pages), cache-first for static assets,
// NETWORK-ONLY for live data (/api/*, functions) so the Command Center never
// shows stale plan/scan/news. Never intercepts other origins (fonts, analytics, TV).
const CACHE = 'tdl-v2';
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

  // Page loads: network-first, cache a copy for offline fallback.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return r; })
                .catch(() => caches.match(req).then((m) => m || caches.match('/index.html')))
    );
    return;
  }

  // Static assets (hashed JS/CSS/img, fonts stylesheet): cache-first.
  e.respondWith(
    caches.match(req).then((c) => c || fetch(req).then((r) => {
      if (r && r.status === 200) { const cp = r.clone(); caches.open(CACHE).then((ca) => ca.put(req, cp)); }
      return r;
    }))
  );
});
