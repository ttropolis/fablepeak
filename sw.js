const CACHE = "fablepeak-v1.3.0";
const ASSETS = [
  "./", "./index.html", "./oauth-complete.html", "./privacy.html", "./terms.html",
  "./data-deletion.html", "./manifest.json", "./icon-192.png", "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first so updates land, with exact cache fallbacks for app assets.
// Only cache our own static files and esm.sh modules. In particular, never put
// authenticated Supabase API responses into the shared service-worker cache.
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  if (e.request.headers.has("authorization")) return;
  const url = new URL(e.request.url);
  const sameOrigin = url.origin === self.location.origin;
  const trustedModule = url.origin === "https://esm.sh" && e.request.destination === "script";
  if (!sameOrigin && !trustedModule) return;

  e.respondWith(
    fetch(e.request)
      .then(async res => {
        if (res.ok) {
          try { await (await caches.open(CACHE)).put(e.request, res.clone()); }
          catch { /* caching is best-effort; never replace a good network response */ }
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(e.request);
        if (hit) return hit;
        if (e.request.mode === "navigate") {
          return (await caches.match("./index.html")) || Response.error();
        }
        return new Response("Offline", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      })
  );
});
