/* ADR 0003 §1b, area 2 — service worker and the PWA offline path.
 *
 * jsdom has no ServiceWorkerContainer, no CacheStorage and no way to take the
 * network away, so none of this can be asserted in the fast suite. Everything
 * here runs against real Chromium over real https, because index.html only
 * registers sw.js when `location.protocol === "https:"`.
 *
 * This tier also owns the runtime half of the release-coupling contract: the
 * source-text test in test/production-readiness.test.mjs asserts that sw.js's
 * cache name string matches the APP_VERSION string; this asserts that the cache
 * the browser actually created is the one APP_VERSION names.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  LS_KEY, appVersion, closeBrowser, fixtureDb, newContext, startServer, waitForApp,
} from "../test-harness/browser.mjs";

let server;
before(async () => { server = await startServer({ cloud: false }); });
after(async () => { await server?.close(); await closeBrowser(); });

/** Boot the app and wait until sw.js is installed, activated and controlling. */
async function bootWithServiceWorker(t) {
  /* No route interception: `context.setOffline(true)` has to be the only thing
     answering the network, or the offline assertion below proves nothing. */
  const app = await newContext(server, {
    storage: { [LS_KEY]: JSON.stringify(fixtureDb()) },
    intercept: false,
  });
  t.after(() => app.close());

  await app.page.goto(server.origin + "/", { waitUntil: "load" });
  await waitForApp(app.page);
  await app.page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  return app;
}

/** sw.js has finished precaching and is controlling this page. */
async function waitUntilControlling(page) {
  await page.waitForFunction(async () =>
    navigator.serviceWorker.controller !== null && !!(await caches.match("./index.html")),
    null, { timeout: 15_000 });
}

test("the app registers sw.js off its own boot code, without help from the test", async t => {
  const app = await bootWithServiceWorker(t);

  const registration = await app.page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    return { scope: r.scope, script: r.active?.scriptURL, state: r.active?.state };
  });

  assert.equal(registration.scope, server.origin + "/");
  assert.equal(registration.script, server.origin + "/sw.js");
  assert.equal(registration.state, "activated");
  assert.deepEqual(app.external, [],
    "local mode must reach nothing off-origin — in particular neither esm.sh import");
});

test("the cache the browser created is the one APP_VERSION names", async t => {
  const app = await bootWithServiceWorker(t);
  await app.page.waitForFunction(async () => (await caches.keys()).length > 0,
    null, { timeout: 15_000 });

  const { keys, version } = await app.page.evaluate(async () => ({
    keys: await caches.keys(), version: __fablepeak.version,
  }));

  assert.deepEqual(keys, [`fablepeak-v${version}`],
    "exactly one cache, named for the running APP_VERSION — a stale extra key " +
    "means activate() stopped pruning and users would be served an old app");
});

test("the install step precaches the app shell", async t => {
  const app = await bootWithServiceWorker(t);
  await waitUntilControlling(app.page);

  const cached = await app.page.evaluate(async () => {
    const cache = await caches.open(`fablepeak-v${__fablepeak.version}`);
    return (await cache.keys()).map(request => new URL(request.url).pathname).sort();
  });

  for (const path of ["/", "/index.html", "/manifest.json", "/icon-192.png", "/privacy.html"]) {
    assert.ok(cached.includes(path), `${path} should be precached, got ${cached.join(", ")}`);
  }
  // Since the ADR 0003 Phase 2b split the shell is not one file: every module
  // has to be in the cache, or an offline reload renders nothing at all.
  for (const path of ["/js/main.js", "/js/shell.js", "/js/planner.js", "/js/state.js"]) {
    assert.ok(cached.includes(path), `${path} should be precached, got ${cached.join(", ")}`);
  }
});

test("with the network switched off the app still loads, out of the cache", async t => {
  const app = await bootWithServiceWorker(t);
  await waitUntilControlling(app.page);

  await app.context.setOffline(true);
  const servedBefore = server.requested.length;
  const response = await app.page.reload({ waitUntil: "load" });

  assert.equal(server.requested.length, servedBefore,
    "nothing may reach the origin server once the context is offline");
  assert.equal(response.status(), 200);
  assert.equal(response.fromServiceWorker(), true,
    "the document must come from sw.js, not from a warm HTTP connection");

  await waitForApp(app.page);
  assert.equal(await app.page.locator("h1").first().textContent(), "Content Planner");
  assert.equal(await app.page.locator(".calgrid .post", { hasText: "Still a draft" }).count(), 1,
    "locally saved work is still there after an offline reload");
});

test("an offline navigation to an uncached page falls back to the app shell", async t => {
  const app = await bootWithServiceWorker(t);
  await waitUntilControlling(app.page);

  await app.context.setOffline(true);
  const response = await app.page.goto(server.origin + "/never-precached", { waitUntil: "load" });

  assert.equal(response.fromServiceWorker(), true);
  await waitForApp(app.page);
  assert.equal(await app.page.locator("h1").first().textContent(), "Content Planner",
    "sw.js answers navigations it cannot serve with ./index.html rather than an error page");
});

test("the service worker refuses to cache an authenticated response", async t => {
  const app = await bootWithServiceWorker(t);
  await waitUntilControlling(app.page);

  const entries = () => app.page.evaluate(async () => (await (await caches.open(
    `fablepeak-v${__fablepeak.version}`)).keys()).length);

  const cachedBefore = await entries();
  await app.page.evaluate(() => fetch("./manifest.json", {
    headers: { authorization: "Bearer pretend-supabase-jwt" },
  }).then(r => r.text()));
  const cachedAfter = await entries();

  assert.equal(cachedAfter, cachedBefore,
    "sw.js must not put authenticated responses into the shared cache");
});
