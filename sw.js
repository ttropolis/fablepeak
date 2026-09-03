const CACHE = "fablepeak-v1.6.4";
// Every js/ module is precached: since ADR 0003 Phase 2b the app is native ES
// modules, so a missing one is a blank page rather than a degraded one. The
// installed PWA is the offline story (decision 3), which makes this list part
// of it. test/production-readiness.test.mjs fails if js/ and this list drift.
const ASSETS = [
  "./", "./index.html", "./oauth-complete.html", "./privacy.html", "./terms.html",
  "./data-deletion.html", "./manifest.json", "./icon-192.png", "./icon-512.png",
  "./apple-touch-icon.png",
  "./js/main.js", "./js/actions.js", "./js/analytics.js", "./js/connections.js",
  "./js/constants.js", "./js/escape.js", "./js/hashtags.js", "./js/inbox.js",
  "./js/local-store.js",
  "./js/metrics.js", "./js/planner.js", "./js/remote-store.js", "./js/reports.js",
  "./js/settings.js", "./js/shell.js", "./js/smartlinks.js", "./js/state.js",
  "./js/store.js", "./js/team.js", "./js/util.js", "./js/welcome.js",
  "./js/workspace.js", "./js/x-thread.js",
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
