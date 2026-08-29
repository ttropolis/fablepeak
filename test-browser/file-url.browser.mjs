/* ADR 0003 §1b, area 4 — the file:// deprecation canary.
 *
 * DEPRECATION CANARY. These tests document what index.html does TODAY when it
 * is opened straight off disk, which is what README promises with "double-click
 * index.html — same app, no internet needed".
 *
 * ADR 0003 decision 3 (2026-08-29) retires that promise: Phase 2b moves the app
 * to `<script type="module">`, which browsers refuse to load from a file://
 * origin, and offline users are pointed at the installed PWA instead. So this
 * file is expected to fail when Phase 2b lands — and that is the point. The
 * retirement then has to be a deliberate, reviewed edit to these assertions
 * rather than something nobody noticed.
 *
 * Do not "fix" a failure here by loosening an assertion. Either the change was
 * meant to end file:// support (rewrite this file to assert the new behaviour,
 * in the same commit that updates README), or file:// broke by accident.
 *
 * jsdom cannot answer this at all: it is handed a string and told what origin
 * to pretend it came from, so every file:// restriction is invisible to it.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { readFileSync } from "node:fs";
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

test("CANARY: index.html still has no module script, which is why file:// works at all", async () => {
  assert.equal(/<script[^>]+type=["']module["']/.test(INDEX_SOURCE), false,
    "ADR 0003 Phase 2b introduces <script type=\"module\">. The moment it does, " +
    "file:// stops working and every assertion in this file must be rewritten " +
    "together with the README promise.");
  assert.match(INDEX_SOURCE, /<script src="backend-config\.js">/,
    "the cloud config is a classic script, which file:// documents may still load");
});

test("CANARY: the app's script executes over file:// today", async t => {
  const app = await openFromDisk(t);

  const state = await app.page.evaluate(() => ({
    protocol: location.protocol,
    version: typeof APP_VERSION === "string" ? APP_VERSION : null,
    configLoaded: !!window.FABLEPEAK_BACKEND,
  }));

  assert.equal(state.protocol, "file:");
  assert.equal(state.version, "1.4.0",
    "the inline classic script runs, so the app is alive over file://");
  assert.equal(state.configLoaded, true,
    "backend-config.js loads from a sibling file, so a bare double-click lands in cloud mode");
  assert.deepEqual(app.pageErrors, [], "no uncaught error on a file:// boot");
});

test("CANARY: a bare double-click with no internet stops at the welcome gate, not the planner", async t => {
  const app = await openFromDisk(t);
  await app.page.waitForFunction(() =>
    document.getElementById("welcome")?.hidden === false, null, { timeout: 15_000 });

  const state = await app.page.evaluate(() => ({
    storeName: store.name,
    mainEmpty: document.getElementById("main").innerHTML.length === 0,
    toast: document.getElementById("toast").textContent,
  }));

  assert.equal(state.storeName, "cloud");
  assert.equal(state.mainEmpty, true);
  assert.equal(state.toast, "Cloud unavailable — reconnect to sign in, or explore the demo");
  assert.deepEqual(app.external, ["https://esm.sh/@supabase/supabase-js@2.112.0"],
    "the only thing it reaches for is the Supabase SDK, which is unreachable offline");

  /* Recorded so the replacement local-HTTP path in README (decision 3) is
     written against what actually happens rather than against the promise:
     as shipped, the README's "same app, no internet needed" is already only
     reachable through the demo button below. */
});

test("CANARY: the demo path does give a working planner over file://", async t => {
  const app = await openFromDisk(t);
  await app.page.waitForFunction(() =>
    document.getElementById("welcome")?.hidden === false, null, { timeout: 15_000 });

  await app.page.getByRole("button", { name: /Explore the demo first/ }).click();
  await waitForApp(app.page);

  assert.equal(await app.page.locator("h1").first().textContent(), "Content Planner");
  assert.ok(await app.page.locator(".calgrid .post").count() > 0,
    "seeded demo content renders from a file:// origin");
  assert.equal(await app.page.evaluate(() => localStorage.getItem("fablepeak_demo")), "1",
    "localStorage is usable on a file:// origin in Chromium, so demo state persists");
});

test("CANARY: locally saved work survives a file:// reload", async t => {
  const app = await openFromDisk(t, {
    storage: { [LS_KEY]: JSON.stringify(fixtureDb()), fablepeak_demo: "1" },
  });
  await waitForApp(app.page);

  assert.equal(await app.page.locator(".calgrid .post", { hasText: "Still a draft" }).count(), 1);
  await app.page.reload({ waitUntil: "load" });
  await waitForApp(app.page);
  assert.equal(await app.page.locator(".calgrid .post", { hasText: "Still a draft" }).count(), 1);
});

test("CANARY: file:// gets no service worker, so it is not the offline story", async t => {
  const app = await openFromDisk(t, { storage: { fablepeak_demo: "1" } });
  await waitForApp(app.page);

  const probe = await app.page.evaluate(async () => {
    try { return { registrations: (await navigator.serviceWorker.getRegistrations()).length }; }
    catch (error) { return { error: error.name }; }
  });

  assert.deepEqual(probe, { error: "InvalidStateError" },
    "a file:// document has an opaque origin, so Chromium refuses service " +
    "workers outright — the installed PWA, not file://, is the offline path " +
    "decision 3 points users at");
  assert.deepEqual(app.pageErrors, [],
    "index.html's `location.protocol === \"https:\"` guard means it never even " +
    "calls register(), so nothing throws on a file:// boot");
});
