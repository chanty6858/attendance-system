const CACHE = 'attendance-v8';
const SHELL = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/styles.css',
  '/app.js',
  '/idb.js',
  '/crypto-util.js',
  '/dashboard.js',
  '/vendor/jsQR.js',
  '/vendor/qrcode-generator.js',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // Photos: cache-first so they stay viewable offline.
  if (url.pathname.startsWith('/api/photo/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
            return res;
          }),
      ),
    );
    return;
  }

  // API calls: always live.
  if (url.pathname.startsWith('/api/')) return;

  // App shell: network-first (so updates land immediately when online),
  // falling back to the cache when offline.
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(request).then((cached) => cached || caches.match(request.mode === 'navigate' ? '/index.html' : request)),
      ),
  );
});
