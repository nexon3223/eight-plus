// Minimal service worker: network-first (so card/app updates land immediately),
// falling back to cache so the app shell still opens if HA/network is briefly down.
const CACHE = "eight-plus-app-v1";
const SHELL = [
  "/", "/index.html", "/app.js", "/eight-sleep-card.js",
  "/manifest.webmanifest",
  "/assets/es-bed.png", "/assets/es-pillows.png",
  "/icons/icon-192-8plus.png", "/icons/apple-touch-icon-8plus.png",
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname === "/ws") return; // never touch the websocket
  e.respondWith((async () => {
    try {
      const net = await fetch(req);
      if (net && net.ok && url.origin === location.origin) {
        const c = await caches.open(CACHE);
        c.put(req, net.clone());
      }
      return net;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      throw err;
    }
  })());
});
