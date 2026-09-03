// Pocket Ledger Service Worker

const CACHE = 'pocket-ledger-v79';
const APP_SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/db.js',
  './js/engine.js',
  './js/utils.js',
  './js/app.js',
  './js/firebase.js',
  './js/sync.js',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
];

const CDN = [
  'https://unpkg.com/dexie@3.2.4/dist/dexie.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => {
      return cache.addAll(APP_SHELL)
        .then(() => cache.addAll(CDN).catch(() => {}));
    })
  );
  self.skipWaiting();
});

// Backstop: the page can ask a freshly-installed worker to take over immediately.
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Cache a successful response and hand it back.
function cachePut(request, response) {
  if (response && response.ok) {
    const clone = response.clone();
    caches.open(CACHE).then(cache => cache.put(request, clone));
  }
  return response;
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;

  // Navigations: network-first, fall back to the cached shell when offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('./index.html'))
    );
    return;
  }

  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin) {
    // App code/assets (index.html, app.js, css, …): NETWORK-FIRST so an online
    // device always runs the latest version, with the cache as an offline
    // fallback. This is what stops installed iOS PWAs getting stuck on an old
    // cached build — cache-first meant they kept serving stale JS until the
    // service worker itself finally updated, which iOS does only grudgingly.
    event.respondWith(
      fetch(event.request)
        .then(response => cachePut(event.request, response))
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cross-origin (CDN libraries, version-pinned): cache-first is fine and fast.
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => cachePut(event.request, response)).catch(() => cached);
    })
  );
});
