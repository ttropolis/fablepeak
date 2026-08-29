/* Browser acceptance harness for index.html — ADR 0003 Phase 1b.
 *
 * A deliberately narrow second tier. It exists only for the four things the ADR
 * says jsdom cannot honestly cover (decision 2, 2026-08-29):
 *
 *   1. HTML5 drag-and-drop (real DataTransfer / DragEvent)
 *   2. the service worker and the PWA offline path
 *   3. real focus / tab order
 *   4. whether the app still loads over file://  (deprecation canary, decision 3)
 *
 * Anything jsdom can assert belongs in test/behaviour/, not here. This tier is
 * kept out of `npm run check`; it has its own npm script and its own CI job.
 *
 * Offline by construction. index.html is served from a throwaway node:https
 * server over 127.0.0.1 (https, because the app only registers sw.js when
 * `location.protocol === "https:"`), and every context installs a route handler
 * that answers same-origin requests from the server and refuses everything else.
 * The two `await import("https://esm.sh/…")` calls are on the cloud path only:
 * local-mode tests assert they never fire, and cloud-mode tests fulfil them with
 * a local stub module rather than reaching the CDN.
 *
 * Lives outside test/ for the same reason test-harness/app.mjs does: a helper
 * module is not a test file.
 */
import { execFileSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { createServer } from "node:https";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = new URL("../", import.meta.url);
export const ROOT_DIR = fileURLToPath(ROOT);

/* Keep this in step with the pinned playwright-core devDependency and with the
   `npx playwright-core install` step in .github/workflows/ci.yml — playwright-core
   only finds browsers downloaded for its own exact version. */
export const PLAYWRIGHT_VERSION = "1.62.1";

const CONTENT_TYPES = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8", png: "image/png", svg: "image/svg+xml",
  ico: "image/x-icon", webmanifest: "application/manifest+json",
};

/* backend-config.js is what selects local vs cloud mode. The real file points at
   the production Supabase project, so cloud-mode tests get a synthetic one aimed
   at a host that does not exist and is refused by the route handler anyway. */
const TEST_CLOUD_CONFIG = `window.FABLEPEAK_BACKEND = {
  provider: "supabase",
  url: "https://project.supabase.invalid",
  anonKey: "test-anon-key",
};
`;

/* Stands in for https://esm.sh/@supabase/supabase-js. Enough surface for
   RemoteAdapter.init(), .load() and .onRemoteChange() to run their real code
   against an empty workspace; the tests install their own db afterwards. */
const SUPABASE_STUB = `
function query(){
  const q = {
    select(){ return q; }, eq(){ return q; }, in(){ return q; }, order(){ return q; },
    upsert(){ return q; }, delete(){ return q; }, insert(){ return q; },
    then(onOk, onErr){ return Promise.resolve({ data: [], error: null }).then(onOk, onErr); },
  };
  return q;
}
export function createClient(){
  return {
    auth: {
      async getSession(){
        return { data: { session: {
          access_token: "test-jwt",
          user: { id: "user-1", email: "owner@example.com" },
        } } };
      },
      onAuthStateChange(){ return { data: { subscription: { unsubscribe(){} } } }; },
      async signInWithPassword(){ return { data: {}, error: null }; },
      async signOut(){ return { error: null }; },
    },
    from(){ return query(); },
    channel(){ const c = { on(){ return c; }, subscribe(){ return c; } }; return c; },
    storage: { from(){ return {
      async upload(){ return { data: null, error: new Error("no storage in tests") }; },
      getPublicUrl(){ return { data: { publicUrl: "" } }; },
    }; } },
  };
}
export default { createClient };
`;

/* ---------------------------------------------------------------- https cert */

let certificate = null;

/** Self-signed localhost certificate, generated once per process into a temp
 *  directory. Nothing is committed, so no private key ever lands in the repo. */
function localhostCertificate() {
  if (certificate) return certificate;
  const dir = mkdtempSync(join(tmpdir(), "fablepeak-browser-tls-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-nodes", "-sha256", "-days", "2", "-keyout", key, "-out", cert,
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ], { stdio: "pipe" });
  } catch (error) {
    throw new Error(
      "the browser tier needs `openssl` on PATH to mint a throwaway localhost " +
      "certificate (index.html only registers sw.js over https): " + error.message);
  }
  const pem = readFileSync(cert, "utf8");
  /* Chromium refuses to register a service worker whose script came over a
     connection with a certificate error, and Playwright's `ignoreHTTPSErrors`
     does not reach that check — it only suppresses the interstitial. Pinning
     this one certificate's SPKI hash makes Chromium trust it outright, which is
     narrower than --ignore-certificate-errors and is what lets the PWA tier
     exercise the app's real `location.protocol === "https:"` guard. */
  const spki = createHash("sha256")
    .update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
  certificate = { key: readFileSync(key), cert: readFileSync(cert), spki };
  return certificate;
}

/* -------------------------------------------------------------- file server */

/**
 * Serve the repo over https on an ephemeral 127.0.0.1 port.
 *
 * `cloud: false` answers backend-config.js with 404, exactly as a deployment
 * without cloud config does, putting the app in local mode.
 */
export async function startServer({ cloud = false } = {}) {
  const { key, cert } = localhostCertificate();
  const requested = [];

  const server = createServer({ key, cert }, (req, res) => {
    const path = new URL(req.url, "https://127.0.0.1").pathname;
    requested.push(path);
    const rel = path.replace(/^\/+/, "") || "index.html";
    if (rel.includes("..")) { res.writeHead(400).end("bad path"); return; }

    if (rel === "backend-config.js") {
      if (!cloud) { res.writeHead(404).end("not found"); return; }
      res.writeHead(200, { "Content-Type": CONTENT_TYPES.js }).end(TEST_CLOUD_CONFIG);
      return;
    }
    const file = fileURLToPath(new URL(rel, ROOT));
    if (!existsSync(file)) { res.writeHead(404).end("not found"); return; }
    const type = CONTENT_TYPES[rel.split(".").pop()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(readFileSync(file));
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `https://127.0.0.1:${port}`,
    requested,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

/* ------------------------------------------------------------------ browser */

let browserPromise = null;

/** One Chromium per process; every test gets its own context. */
function browser() {
  browserPromise ??= chromium.launch({
    args: [`--ignore-certificate-errors-spki-list=${localhostCertificate().spki}`],
  });
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const instance = await browserPromise;
  browserPromise = null;
  await instance.close();
}

/* The frozen "today" every browser test sees (2026-06-15), matching
   test-harness/app.mjs so fixtures read the same in both tiers. */
const DEFAULT_NOW = [2026, 5, 15, 12, 0, 0]; // Mon 15 June 2026, 12:00 local

/* Runs before any page script. Freezes Date the same way the jsdom harness does
   and pre-seeds localStorage, so a fixture can arrive through the app's real
   load() path instead of being poked into place afterwards. */
function initScript({ parts, storage }) {
  const Real = Date;
  const fixed = new Real(...parts).getTime();
  class FrozenDate extends Real {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  }
  Object.defineProperty(FrozenDate, "name", { value: "Date" });
  globalThis.Date = FrozenDate;
  try {
    /* Seed only what is missing. This runs before *every* navigation, and
       localStorage is the local-mode database: overwriting on reload would
       silently undo whatever the test just did. */
    for (const [key, value] of Object.entries(storage)) {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    }
  } catch { /* file:// origins may refuse storage; that is the canary's business */ }
}

/**
 * A browser context wired for offline acceptance testing.
 *
 * `intercept: true` (default) installs a route handler: same-origin requests go
 * to the local server, https://esm.sh/* is fulfilled with the local Supabase
 * stub, and anything else is aborted and recorded in `external`. Pass
 * `intercept: false` when the test needs genuine network conditions — the
 * service-worker tier does, because routes would answer requests that
 * `setOffline(true)` is supposed to kill.
 */
export async function newContext(server, {
  now = DEFAULT_NOW, storage = {}, intercept = true, stubEsm = true,
} = {}) {
  const context = await (await browser()).newContext({ ignoreHTTPSErrors: true });
  const external = [];
  const consoleErrors = [];
  const pageErrors = [];

  await context.addInitScript(initScript, { parts: now, storage });

  if (intercept) {
    await context.route("**/*", async route => {
      const url = route.request().url();
      if (url.startsWith(server.origin) || url.startsWith("file://")
          || url.startsWith("data:") || url.startsWith("blob:")) {
        return route.continue();
      }
      if (stubEsm && url.startsWith("https://esm.sh/")) {
        external.push(url);
        return route.fulfill({
          status: 200, contentType: "text/javascript; charset=utf-8", body: SUPABASE_STUB,
        });
      }
      external.push(url);
      return route.abort("blockedbyclient");
    });
  } else {
    context.on("request", request => {
      const url = request.url();
      if (!url.startsWith(server.origin) && !url.startsWith("data:") && !url.startsWith("blob:")) {
        external.push(url);
      }
    });
  }

  const page = await context.newPage();
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", error => pageErrors.push(String(error)));

  return { context, page, external, consoleErrors, pageErrors, close: () => context.close() };
}

/** Wait until index.html has finished its first render. */
export async function waitForApp(page) {
  await page.waitForFunction(() => {
    const main = document.getElementById("main");
    const welcome = document.getElementById("welcome");
    return (main && main.innerHTML.length > 0) || (welcome && welcome.hidden === false);
  }, null, { timeout: 15_000 });
}

/** Currently visible toast text ("" when none is showing). */
export const toastText = page => page.evaluate(() => {
  const el = document.getElementById("toast");
  return el.classList.contains("show") ? el.textContent : "";
});

/** The page's live `db` (a top-level `let`, so reachable from evaluate). */
export const readDb = page => page.evaluate(() => JSON.parse(JSON.stringify(db)));

/** Replace `db` wholesale and re-render, for states the fixture cannot seed. */
export const installDb = (page, value) => page.evaluate(next => {
  db = next;
  render();
}, value);

/** A one-brand workspace with a published post and a scheduled one. */
export function fixtureDb() {
  return {
    activeBrand: "b1",
    brands: [{
      id: "b1", name: "Acme", seed: 11,
      /* Two connected networks so the composer renders enabled network
         checkboxes; without them every checkbox is disabled and drops out of
         the tab order, which would make the focus tier assert far too little. */
      connections: { instagram: true, facebook: true },
      smartlink: { title: "Acme", bio: "", avatar: "🚀", color: "#22c1dc", links: [] },
      inbox: [],
      posts: [
        {
          id: "p-live", date: "2026-06-10", time: "09:00", text: "Already out there",
          networks: ["instagram"], status: "published", media_url: "", targets: [],
        },
        {
          id: "p-sched", date: "2026-06-18", time: "09:00", text: "Still a draft",
          networks: ["instagram"], status: "scheduled", media_url: "", targets: [],
        },
      ],
    }],
  };
}

export const LS_KEY = "fablepeak_v1";

/** Locator for a calendar day cell, addressed through its accessible day button. */
export const dayCell = (page, date) =>
  page.locator(`.calgrid .day:has([aria-label="Schedule a post on ${date}"])`);

/** Locator for a post chip, addressed by the text it renders. */
export const chip = (page, text) => page.locator(".calgrid .post", { hasText: text });
