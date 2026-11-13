// Service worker: caches the app shell so it installs and opens offline.
// API calls (cross-origin POSTs to Apps Script) always go to the network.
const VERSION = 'v3';
const CACHE = 'photo-compare-' + VERSION;
const SHELL = [
  './', 'index.html', 'config.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', 'offline.js'
];
// Offline OCR engine (added by fetch-vendor.mjs). Cached individually: a missing file must not fail install.
const VENDOR = [
  'vendor/tesseract.min.js', 'vendor/worker.min.js',
  'vendor/tesseract-core-lstm.wasm.js', 'vendor/tesseract-core-simd-lstm.wasm.js',
  'vendor/lang/eng.traineddata.gz'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c =>
    c.addAll(SHELL).then(() => Promise.all(VENDOR.map(u => c.add(u).catch(() => null))))
  ));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('photo-compare-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // config.js: network first so edits apply, fall back to cache offline
  if (url.pathname.endsWith('/config.js')) {
    e.respondWith(fetch(req).then(r => { caches.open(CACHE).then(c => c.put(req, r.clone())); return r; })
      .catch(() => caches.match(req)));
    return;
  }

  // Pages: network first, cached shell as fallback
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { caches.open(CACHE).then(c => c.put('index.html', r.clone())); return r; })
      .catch(() => caches.match('index.html')));
    return;
  }

  // Static assets: stale-while-revalidate
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => { if (r.ok) caches.open(CACHE).then(c => c.put(req, r.clone())); return r; }).catch(() => hit);
    return hit || net;
  }));
});
