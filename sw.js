const CACHE = "mallowbeat-mobile-final-v2-hotfix1";
const ASSETS = ["./", "./index.html", "./style.css", "./app.js", "./analysis-core.js", "./manifest.webmanifest", "./icon-180.png", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Network-first keeps GitHub Pages updates fresh; the cache remains the
  // complete offline fallback once Mallowbeat has been installed.
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const hit = await caches.match(event.request);
        if (hit) return hit;
        if (event.request.mode === "navigate") return caches.match("./index.html");
        throw new Error("Offline asset not cached");
      })
  );
});
