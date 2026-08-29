/* ADR 0003 §1b, area 4 — how the app is loaded, and what file:// now does.
 *
 * These tests used to be the file:// deprecation canary: they documented that
 * double-clicking index.html ran the whole app, and were written to fail the
 * moment Phase 2b introduced `<script type="module">`, so that retiring the
 * README promise had to be a deliberate, reviewed edit rather than something
 * nobody noticed.
 *
 * Phase 2b has landed and decision 3 (2026-08-29) is executed: the app is
 * native ES modules, browsers refuse module scripts on a file:// origin, and
 * offline users are pointed at the installed PWA. So this file now asserts the
 * new reality in both directions — file:// does not boot the app, and the same
 * document served over http(s) does — together with the reason a bare
 * double-click fails loudly rather than half-working.
 *
 * jsdom cannot answer any of this: it is handed a string and told what origin
 * to pretend it came from, so every file:// restriction is invisible to it.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  LS_KEY, ROOT_DIR, closeBrowser, fixtureDb, newContext, startServer, waitForApp,
} from "../test-harness/browser.mjs";

const FILE_URL = pathToFileURL(ROOT_DIR + "index.html").href;
const INDEX_SOURCE = readFileSync(ROOT_DIR + "index.html", "utf8");

let server;
before(async () => { server = await startServer({ cloud: false }); });
after(async () => { await server?.close(); await closeBrowser(); });

/* No esm.sh stub here. The whole question is what a person with no internet
   gets, so the CDN import is blocked outright rather than answered locally. */
async function openFromDisk(t, { storage = {} } = {}) {
  const app = await newContext(server, { storage, stubEsm: false });
  t.after(() => app.close());
  await app.page.goto(FILE_URL, { waitUntil: "load" });
  return app;
}

async function openOverHttps(t, { storage = {} } = {}) {
  const app = await newContext(server, { storage, stubEsm: false });
  t.after(() => app.close());
  await app.page.goto(server.origin + "/", { waitUntil: "load" });
  return app;
}

test("index.html carries a module script and no inline application script", async () => {
  assert.match(INDEX_SOURCE, /<script type="module" src="\.\/js\/main\.js"><\/script>/,
    "the app is loaded as one ES module entry — this is what ends file:// support");
  assert.doesNotMatch(INDEX_SOURCE, /<script>[\s\S]*?<\/script>/,
    "no inline application script may come back");
  assert.match(INDEX_SOURCE, /<script src="backend-config\.js">/,
    "the cloud config stays a classic script, which a file:// document may still load");
});

test("opening index.html off disk no longer boots the app", async t => {
  const app = await openFromDisk(t);

  const state = await app.page.evaluate(() => ({
    protocol: location.protocol,
    // js/main.js sets this; if the module never ran, the app never started.
    booted: typeof window.__fablepeak !== "undefined",
    configLoaded: !!window.FABLEPEAK_BACKEND,
    mainEmpty: document.getElementById("main").innerHTML.length === 0,
    gateHidden: document.getElementById("welcome").hidden,
    version: document.getElementById("verSlot").textContent,
  }));

  assert.equal(state.protocol, "file:");
  assert.equal(state.booted, false,
    "a module script is refused on a file:// origin, so no app code runs at all");
  assert.equal(state.configLoaded, true,
    "the classic backend-config.js still loads — which is why the failure is the module, not the page");
  assert.equal(state.mainEmpty, true, "nothing is rendered");
  assert.equal(state.gateHidden, true, "not even the signed-out welcome gate");
  assert.equal(state.version, "", "the sidebar version slot is never filled in");
});

test("the failure is loud: the browser reports the refused module", async t => {
  const app = await openFromDisk(t);

  const complaints = [...app.consoleErrors, ...app.pageErrors].join("\n");
  assert.match(complaints, /main\.js/,
    "the console names js/main.js, so the cause is discoverable rather than a silent blank page");
  assert.match(complaints, /CORS|cross-origin|Failed to load|blocked/i,
    "and says it was blocked, not that the file is missing");
});

test("locally saved work is untouched — it simply is not read", async t => {
  const app = await openFromDisk(t, {
    storage: { [LS_KEY]: JSON.stringify(fixtureDb()), fablepeak_demo: "1" },
  });

  assert.equal(await app.page.locator(".calgrid .post").count(), 0,
    "no render happens, so nothing from localStorage reaches the screen");
  assert.equal(await app.page.evaluate(() => localStorage.getItem("fablepeak_demo")), "1",
    "and nothing is destroyed either — the same data loads over http");
});

test("file:// gets no service worker, so it never was the offline story", async t => {
  const app = await openFromDisk(t, { storage: { fablepeak_demo: "1" } });

  const probe = await app.page.evaluate(async () => {
    try { return { registrations: (await navigator.serviceWorker.getRegistrations()).length }; }
    catch (error) { return { error: error.name }; }
  });

  assert.deepEqual(probe, { error: "InvalidStateError" },
    "a file:// document has an opaque origin, so Chromium refuses service " +
    "workers outright — the installed PWA, not file://, is the offline path " +
    "decision 3 points users at");
});

/* The replacement path README documents: serve the directory over http(s).
   The server in this harness is exactly that — a static file server, no build
   step, no bundler — so these two tests are the before/after pair. */
test("the same document served over https boots the app in full", async t => {
  const app = await openOverHttps(t, { storage: { [LS_KEY]: JSON.stringify(fixtureDb()) } });
  await waitForApp(app.page);

  assert.equal(await app.page.locator("h1").first().textContent(), "Content Planner");
  assert.equal(await app.page.locator(".calgrid .post", { hasText: "Still a draft" }).count(), 1,
    "locally saved work renders once the modules can load");
  const { APP_VERSION } = await import("../js/constants.js");
  assert.equal(await app.page.evaluate(() => __fablepeak.version), APP_VERSION);
  assert.deepEqual(app.pageErrors, [], "no uncaught error on a served boot");
  assert.deepEqual(app.external, [],
    "and a local-mode boot still reaches nothing off-origin");
});

test("every module the entry imports is fetched from the same static server", async t => {
  const app = await openOverHttps(t);
  await waitForApp(app.page);

  const fetched = [...new Set(server.requested.filter(path => path.startsWith("/js/")))].sort();
  const onDisk = readdirSync(ROOT_DIR + "js")
    .filter(name => name.endsWith(".js")).map(name => `/js/${name}`).sort();

  assert.deepEqual(fetched, onDisk,
    "Chromium walks the graph from js/main.js and fetches every module itself — " +
    "no bundle, no build step, just static files");
});
