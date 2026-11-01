const CACHE_NAME = "offlineclass-cache-v2";
const STATIC_ASSETS = [
  "/",
  "/manifest.json",
  "/static/css/styles.css",
  "/static/js/clock.js",
  "/static/js/encryption.js",
  "/static/js/database.js",
  "/static/js/sync.js",
  "/static/js/app.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls in Service Worker; IndexedDB handles offline API data
  if (url.pathname.startsWith("/api/") || event.request.method !== "GET") {
    return;
  }

  // Network-first: when online the newest code/CSS/HTML is always used (the old cache-first
  // strategy kept serving stale JS after an update); the cache is only the offline fallback.
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/")))
  );
});
