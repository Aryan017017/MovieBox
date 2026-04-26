const CACHE = "moviebox-v1";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.json", "./icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  // Network-first for API/HTML, cache-first for static assets
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("./index.html")));
    return;
  }
  e.respondWith(caches.match(req).then(c => c || fetch(req).then(res => {
    const clone = res.clone();
    caches.open(CACHE).then(cache => cache.put(req, clone));
    return res;
  }).catch(() => c)));
});
