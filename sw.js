/* Service worker — офлайн-кэш приложения (сеть → кэш) */
const CACHE = 'arenda-tools-v5';
const ASSETS = [
  './', './index.html', './config.js?v=5',
  './app.css?v=5', './app.js?v=5', './theme.css?v=5', './catalog-data.js?v=5',
  './manifest.webmanifest',
  './vendor/qrcode.min.js', './vendor/html5-qrcode.min.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Сеть в приоритете (свежие версии), кэш — резерв для офлайна
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return resp;
    }).catch(() => caches.match(e.request))
  );
});
