/* Behavioural test harness for index.html — ADR 0003 Phase 1a, reworked for
 * the Phase 2b module split.
 *
 * Loads the real, unmodified index.html off disk into jsdom. Same-origin
 * subresources resolve to repo files through a request interceptor, so no test
 * ever touches the network. Tests interact through the DOM and assert what the
 * app rendered; they never read index.html as text and never reach into jsdom
 * directly.
 *
 * Two things changed when the app became `<script type="module">`:
 *
 * 1. **jsdom does not execute module scripts at all** (it never has; its README
 *    points at `getInternalVMContext()` for exactly this). So the harness loads
 *    the graph itself: `vm.SourceTextModule` compiled *into jsdom's own vm
 *    context*, linked by resolving each specifier against the repo. The modules
 *    therefore run in the page's realm, against the page's `document`,
 *    `localStorage` and frozen clock — the same code the browser tier loads the
 *    real way. It needs Node's `--experimental-vm-modules`, which is why
 *    `npm test` passes that flag.
 * 2. **Module scope is not global**, so the old `window.eval()` bridge over the
 *    classic script's lexical `db`/`store`/`view` is gone. js/main.js publishes
 *    `window.__fablepeak` instead — a deliberate, documented seam, installed
 *    only when `__FABLEPEAK_TEST__` was set before any app code ran, which
 *    beforeParse below does and a production page never does.
 *
 * The `bootApp()` return shape is unchanged.
 *
 * Lives outside test/ on purpose: `node --test` treats every *.mjs under test/
 * as a test file, and a helper module is not a test file.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM, VirtualConsole, requestInterceptor } from "jsdom";

const ROOT = new URL("../", import.meta.url);
const ORIGIN = "https://fablepeak.com";
const INDEX = readFileSync(new URL("index.html", ROOT), "utf8");
const CLOUD_CONFIG = readFileSync(new URL("backend-config.js", ROOT), "utf8");
const LOCAL_CONFIG = "/* test harness: no cloud config → local mode */\n";

const CONTENT_TYPES = {
  js: "text/javascript", mjs: "text/javascript", css: "text/css",
  json: "application/json", html: "text/html", png: "image/png",
  svg: "image/svg+xml", webmanifest: "application/manifest+json",
};

/* Resolves every same-origin subresource to a repo file. Anything else is
   answered with a synthetic 503 and recorded, which is how "demo/local mode
   reaches no network" is proven rather than assumed: the interceptor always
   returns a Response, so no request can reach undici's dispatcher.
   (ADR 0003 describes this as a ResourceLoader subclass; jsdom 29 replaced
   ResourceLoader with request interceptors. Same job, stricter guarantee.) */
function repoLoader(cloud, blocked, served) {
  return requestInterceptor(request => {
    let parsed;
    try { parsed = new URL(request.url); } catch { parsed = null; }
    const refuse = () => {
      blocked.push(request.url);
      return new Response("blocked by the test harness", { status: 503 });
    };
    if (!parsed || parsed.origin !== ORIGIN) return refuse();
    const rel = parsed.pathname.replace(/^\/+/, "") || "index.html";
    if (rel.includes("..")) return refuse();
    const type = CONTENT_TYPES[rel.split(".").pop()] || "application/octet-stream";
    if (rel === "backend-config.js") {
      served.push(rel);
      return new Response(cloud ? CLOUD_CONFIG : LOCAL_CONFIG,
        { headers: { "Content-Type": "text/javascript" } });
    }
    let body;
    try { body = readFileSync(new URL(rel, ROOT)); } catch { return refuse(); }
    served.push(rel);
    return new Response(body, { headers: { "Content-Type": type } });
  });
}

/* Deterministic clock. seedDemo() derives every demo post from `new Date()`
   with day offsets of -6…+5, so a fixed mid-month local date keeps the whole
   seeded month inside one calendar page regardless of when CI runs. */
const DEFAULT_NOW = [2026, 5, 15, 12, 0, 0]; // Mon 15 June 2026, 12:00 local

function freezeClock(window, parts) {
  const Real = window.Date;
  const fixed = new Real(...parts).getTime();
  class FrozenDate extends Real {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  }
  Object.defineProperty(FrozenDate, "name", { value: "Date" });
  window.Date = FrozenDate;
}

/* Deterministic Math.random: uid() and the demo brand seed are built from it. */
function seedRandom(window, seed) {
  let s = (seed % 2147483647) || 1;
  window.Math.random = () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function installStubs(window, state) {
  // jsdom implements neither of these; index.html depends on matchMedia at
  // boot (welcome focus guard) and in Settings (installed-PWA detection).
  window.matchMedia = query => ({
    media: query,
    matches: state.media[query] ?? false,
    onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  });
  window.confirm = message => { state.confirms.push(String(message)); return state.confirmAnswer; };
  window.prompt = message => { state.prompts.push(String(message)); return state.promptAnswers.shift() ?? null; };
  window.alert = message => { state.alerts.push(String(message)); };
  window.print = () => { state.prints += 1; };
  window.URL.createObjectURL = () => "blob:https://fablepeak.com/test-object-url";
  window.URL.revokeObjectURL = () => {};
  if (!window.crypto?.randomUUID) {
    Object.defineProperty(window.crypto, "randomUUID", {
      configurable: true,
      value: () => "00000000-0000-4000-8000-00000000000" + (state.uuids++ % 10),
    });
  }
  // Nothing in local/demo mode may reach the network. Cloud tests inject a
  // fake `store` instead of letting the app talk to Supabase.
  window.fetch = async (input) => {
    const url = String(input?.url ?? input);
    state.blocked.push(url);
    throw new Error("network blocked by the test harness: " + url);
  };
  // exportData() builds a data: URL on a detached <a> and clicks it. jsdom
  // would treat that as an unimplemented navigation; capture it instead.
  const anchorClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute("download")) {
      state.downloads.push({ name: this.getAttribute("download"), href: this.href });
      return;
    }
    return anchorClick.call(this);
  };
}

/* The module entry index.html names. Everything else is reached from here by
   following relative specifiers, so a new module needs no harness change. */
const ENTRY = ORIGIN + "/js/main.js";

/**
 * Evaluate the app's ES module graph inside jsdom's own vm context.
 *
 * jsdom ignores `<script type="module">`, so nothing has run this graph by the
 * time we get here. Specifiers are resolved against the importing module's URL
 * and read from the repo — the same files the browser tier is served.
 * `import("https://esm.sh/…")` is on the cloud path only and is refused before
 * a request is ever made, which is why it does not appear in `blockedRequests`:
 * nothing reached the network to block. RemoteAdapter.init() already handles the
 * rejection by toasting "Cloud unavailable", exactly as it does offline.
 */
async function evaluateModules(dom) {
  if (typeof vm.SourceTextModule !== "function") {
    throw new Error(
      "the behavioural harness needs Node's --experimental-vm-modules flag to " +
      "load the app's ES modules into jsdom (jsdom does not run module scripts " +
      "itself). Run the suite through `npm test`, which passes it.");
  }
  const context = dom.getInternalVMContext();
  const cache = new Map();
  const dynamic = specifier => {
    throw new Error("dynamic import blocked by the test harness: " + specifier);
  };
  const moduleFor = url => {
    if (cache.has(url)) return cache.get(url);
    const relative = new URL(url).pathname.replace(/^\/+/, "");
    const source = readFileSync(new URL(relative, ROOT), "utf8");
    const module = new vm.SourceTextModule(source, {
      context, identifier: url, importModuleDynamically: dynamic,
    });
    cache.set(url, module);
    return module;
  };
  const entry = moduleFor(ENTRY);
  await entry.link((specifier, referencing) =>
    moduleFor(new URL(specifier, referencing.identifier).href));
  await entry.evaluate();
}

/**
 * Boot index.html in jsdom.
 *
 * mode:
 *   "local"     — no backend-config.js → LocalAdapter, seeded demo data
 *   "demo"      — cloud config present, demo flag set → signed-out demo workspace
 *   "signedOut" — cloud config present, no demo flag → welcome gate
 *   "cloud"     — boots at the gate, then signs in against a fake store
 */
export async function bootApp(options = {}) {
  const {
    mode = "local",
    now = DEFAULT_NOW,
    seed = 20260829,
    storage = {},
    search = "",
    media = {},
    cloud = null,
  } = options;

  const state = {
    confirms: [], confirmAnswer: true,
    prompts: [], promptAnswers: [],
    alerts: [], prints: 0, downloads: [], blocked: [],
    uuids: 0, media,
  };
  const served = [];
  const loader = repoLoader(mode !== "local", state.blocked, served);
  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", error => consoleErrors.push(error));

  const dom = new JSDOM(INDEX, {
    url: ORIGIN + "/" + search,
    runScripts: "dangerously",
    resources: { interceptors: [loader] },
    pretendToBeVisual: true,
    virtualConsole,
    storageQuota: 10_000_000,
    beforeParse(window) {
      // Asks js/main.js for its test seam. Set before any app code runs, which
      // is the whole contract: a page that did not opt in never gets one.
      window.__FABLEPEAK_TEST__ = true;
      freezeClock(window, now);
      seedRandom(window, seed);
      installStubs(window, state);
      for (const [key, value] of Object.entries(storage)) {
        window.localStorage.setItem(key, value);
      }
      if (mode === "demo") window.localStorage.setItem("fablepeak_demo", "1");
    },
  });

  const { window } = dom;
  const document = window.document;

  const api = {
    dom, window, document, state,
    blockedRequests: state.blocked,
    servedResources: served,
    jsdomErrors: consoleErrors,
    downloads: state.downloads,
    confirms: state.confirms,
    prompts: state.prompts,
    /** answer the next window.confirm() calls with `value` */
    answerConfirm(value) { state.confirmAnswer = value; },

    /** js/main.js's test seam (see its header). */
    get seam() { return window.__fablepeak; },
    get db() { return window.__fablepeak.state.db; },
    get store() { return window.__fablepeak.store; },
    get view() { return window.__fablepeak.state.view; },
    /** live view of js/state.js — api.state.connCache, api.state.slCache, … */
    get state() { return window.__fablepeak.state; },
    /** put the app into a state no fixture can reach, e.g. an unloaded cache */
    setState(name, value) { window.__fablepeak.state.set(name, value); },
    /** clone a plain object into the page realm */
    intoPage(value) { return window.JSON.parse(JSON.stringify(value)); },
    /** call any app function by its export name, e.g. api.call("render") */
    call(name, ...args) { return window.__fablepeak.call(name, ...args); },
    /** evaluate in the page's *global* scope. App internals are no longer
     *  there — use call()/state instead; this is for window-level fixtures. */
    eval(code) { return window.eval(code); },

    $(selector, root = document) { return root.querySelector(selector); },
    $$(selector, root = document) { return [...root.querySelectorAll(selector)]; },
    text(selector, root = document) {
      const el = root.querySelector(selector);
      return el ? el.textContent.replace(/\s+/g, " ").trim() : null;
    },
    /** first element whose trimmed text contains `needle` */
    byText(selector, needle, root = document) {
      return [...root.querySelectorAll(selector)]
        .find(el => el.textContent.replace(/\s+/g, " ").trim().includes(needle)) || null;
    },
    main() { return document.getElementById("main"); },
    modal() { return document.getElementById("modalBody"); },
    modalOpen() { return document.getElementById("overlay").classList.contains("open"); },
    toast() {
      const el = document.getElementById("toast");
      return el.classList.contains("show") ? el.textContent : "";
    },
    clearToast() {
      const el = document.getElementById("toast");
      el.classList.remove("show");
      el.textContent = "";
    },

    async click(target, root = document) {
      const el = typeof target === "string" ? root.querySelector(target) : target;
      if (!el) throw new Error("click: no element for " + target);
      el.click();
      await api.flush();
      return el;
    },
    async fill(target, value, root = document) {
      const el = typeof target === "string" ? root.querySelector(target) : target;
      if (!el) throw new Error("fill: no element for " + target);
      el.value = value;
      el.dispatchEvent(new window.Event("input", { bubbles: true }));
      el.dispatchEvent(new window.Event("change", { bubbles: true }));
      await api.flush();
      return el;
    },
    async check(target, checked = true, root = document) {
      const el = typeof target === "string" ? root.querySelector(target) : target;
      if (!el) throw new Error("check: no element for " + target);
      el.checked = checked;
      el.dispatchEvent(new window.Event("change", { bubbles: true }));
      await api.flush();
      return el;
    },
    async press(target, key, init = {}) {
      const el = typeof target === "string" ? document.querySelector(target) : target;
      if (!el) throw new Error("press: no element for " + key);
      el.dispatchEvent(new window.KeyboardEvent("keydown", {
        key, bubbles: true, cancelable: true, ...init,
      }));
      await api.flush();
      return el;
    },
    /** hand a JSON file to a file input, the way Settings → Import backup does */
    async selectFile(target, { name = "backup.json", type = "application/json", body }) {
      const el = typeof target === "string" ? document.querySelector(target) : target;
      const file = new window.File([body], name, { type });
      api.clearToast();
      Object.defineProperty(el, "files", { configurable: true, value: [file] });
      el.dispatchEvent(new window.Event("change", { bubbles: true }));
      await api.flush();
      await api.waitFor(() => api.toast() !== "");
      return file;
    },

    async flush(ticks = 3) {
      for (let i = 0; i < ticks; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    },
    async waitFor(predicate, { timeout = 3000, label = "condition" } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        let value;
        try { value = predicate(); } catch { value = false; }
        if (value) return value;
        if (Date.now() > deadline) throw new Error("timed out waiting for " + label);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    },
    /** Stops the app's 60s interval and jsdom's animation-frame loop. */
    close() { window.close(); },
  };

  // Classic scripts first: backend-config.js decides local vs cloud mode and is
  // fetched through the interceptor, so it has to have run before the app does.
  // Real browsers order it the same way — module scripts are deferred.
  await api.waitFor(() => document.readyState === "complete",
    { label: "index.html and backend-config.js to finish parsing" });
  await evaluateModules(dom);
  await api.waitFor(() => document.getElementById("verSlot").textContent,
    { label: "js/main.js execution" });

  if (mode === "signedOut" || mode === "cloud") {
    await api.waitFor(() => document.getElementById("welcome").hidden === false
      && document.getElementById("welcome").innerHTML.includes("Explore the demo"),
      { label: "the welcome gate" });
  } else {
    await api.waitFor(() => api.main().innerHTML.length > 0, { label: "the first render" });
  }

  if (mode === "cloud") await signIn(api, cloud || {});
  return api;
}

/* Cloud mode without Supabase: the real welcome form drives the real sign-in
   path, but `store` is patched so every backend call is answered locally. The
   two `await import("https://esm.sh/…")` calls in js/remote-store.js are on the
   cloud path only and already failed harmlessly during boot. */
async function signIn(api, cloud) {
  const {
    user = { id: "user-1", email: "owner@example.com" },
    db = null,
    accounts = [],
    available = [],
    targets = [],
    metrics = [],
  } = cloud;

  const store = api.store;
  const calls = api.storeCalls = [];
  const record = (name, args) => calls.push({ name, args });
  const pageDb = db ? api.intoPage(db) : null;

  store.signIn = async (email, password) => {
    record("signIn", [email, password]);
    store.user = api.intoPage(user);
  };
  store.load = async () => { record("load", []); return pageDb; };
  store.persist = async data => { record("persist", [data]); };
  store.onRemoteChange = () => {};
  store.availablePlatforms = async () => { record("availablePlatforms", []); return api.intoPage(available); };
  store.listAccounts = async brandId => { record("listAccounts", [brandId]); return api.intoPage(cloud.accountsFor?.(brandId) ?? accounts); };
  store.verifyAccounts = async brandId => { record("verifyAccounts", [brandId]); return api.intoPage([]); };
  store.listTargets = async brandId => { record("listTargets", [brandId]); return api.intoPage(targets); };
  store.listMetrics = async brandId => { record("listMetrics", [brandId]); return api.intoPage(metrics); };
  store.disconnectAccount = async id => { record("disconnectAccount", [id]); };
  store.selectAccount = async id => { record("selectAccount", [id]); };
  store.ensureBrandSynced = async brand => { record("ensureBrandSynced", [brand.id]); };
  store.startOAuth = async (platform, brandId) => { record("startOAuth", [platform, brandId]); return true; };
  store.smartlinkPublishing = async brandId => { record("smartlinkPublishing", [brandId]); return api.intoPage(cloud.smartlinkPublishing ?? { slug: "", published: false }); };
  store.smartlinkClickTotals = async brandId => { record("smartlinkClickTotals", [brandId]); return api.intoPage(cloud.clickTotals ?? []); };
  store.setSmartlinkSlug = async (brandId, slug) => { record("setSmartlinkSlug", [brandId, slug]); return api.intoPage(cloud.slugResult?.(slug) ?? { ok: true, slug, changed: true }); };
  store.setSmartlinkPublic = async (brandId, isPublic) => { record("setSmartlinkPublic", [brandId, isPublic]); };
  /* AI assist. `cloud.aiAssist` is either a fixed answer or a function of the
     request, and either shape may be a failure — {error, status,
     retry_after_seconds} — which is thrown the way RemoteAdapter.aiAssist
     throws it, so the composer's typed-error handling is what gets exercised.
     The recorded request is copied into this realm so tests can compare it
     against a plain object literal. */
  store.aiAssist = async (brandId, request) => {
    record("aiAssist", [brandId, JSON.parse(JSON.stringify(request))]);
    const answer = (typeof cloud.aiAssist === "function" ? cloud.aiAssist(request) : cloud.aiAssist)
      ?? { suggestions: ["A first idea", "A second idea", "A third idea"] };
    if (answer.error) {
      const failure = new api.window.Error(String(answer.error));
      failure.status = answer.status ?? 500;
      if (answer.retry_after_seconds) failure.retryAfterSeconds = answer.retry_after_seconds;
      throw failure;
    }
    return api.intoPage({
      suggestions: answer.suggestions ?? [], truncated: !!answer.truncated,
    });
  };
  store.publishNow = async id => { record("publishNow", [id]); return api.intoPage(cloud.publishResults ?? []); };
  store.retryPost = async id => { record("retryPost", [id]); return api.intoPage(cloud.retryResults ?? []); };

  await api.fill("#w_email", user.email);
  await api.fill("#w_pw", "correct-horse-battery");
  await api.click(".wcard button.wsubmit");
  await api.waitFor(() => api.document.getElementById("welcome").hidden,
    { label: "the welcome gate to close" });
  await api.waitFor(() => api.main().innerHTML.length > 0, { label: "the signed-in render" });
  return api;
}

/** Change what the fake backend reports for listAccounts, then let the app
 *  refresh exactly as it does after a connect/disconnect round trip. */
export async function reloadAccounts(api, accounts) {
  api.store.listAccounts = async brandId => {
    api.storeCalls.push({ name: "listAccounts", args: [brandId] });
    return api.intoPage(accounts);
  };
  api.setState("connCache", api.intoPage(
    { brandId: null, available: api.state.connCache.available, accounts: [], loaded: false }));
  await api.call("refreshConnections", api.db.activeBrand);
  await api.flush();
}

/** The frozen "today" every test sees. */
export const TODAY = "2026-06-15";
