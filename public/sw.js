// TradeDadLog service worker: makes the hub installable and work offline.
// Network-first for navigations (fresh pages), cache-first for static assets.
// Never intercepts other origins (fonts, Cloudflare analytics, TradingView).
const CACHE = 'tdl-v1';
const SHELL = ['/', '/index.html', '/indicators.html', '/manifest.webmanifest'];

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

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return r; })
                .catch(() => caches.match(req).then((m) => m || caches.match('/index.html')))
    );
    return;
  }
  e.respondWith(
    caches.match(req).then((c) => c || fetch(req).then((r) => {
      if (r && r.status === 200) { const cp = r.clone(); caches.open(CACHE).then((ca) => ca.put(req, cp)); }
      return r;
    }))
  );
});
