/* Behavioural test harness for index.html — ADR 0003 Phase 1a.
 *
 * Loads the real, unmodified index.html off disk into jsdom. Same-origin
 * subresources resolve to repo files through a request interceptor, so no test
 * ever touches the network. Tests interact through the DOM and assert what the
 * app rendered; they never read index.html as text and never reach into jsdom
 * directly.
 *
 * index.html declares `db`, `store`, `view` and `connCache` with let/const at
 * the top level of a classic script, so they live in the global *lexical*
 * environment and are not properties of `window`. An indirect `window.eval()`
 * runs in that same scope, which is how `window.__bridge` below reaches them —
 * no product code change is needed to make the app observable.
 *
 * Lives outside test/ on purpose: `node --test` treats every *.mjs under test/
 * as a test file, and a helper module is not a test file.
 */
import { readFileSync } from "node:fs";
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

const TEST_BRIDGE = `window.__bridge = {
  get db(){ return db; },
  set db(value){ db = value; },
  get store(){ return store; },
  get view(){ return view; },
  get connCache(){ return connCache; },
  set connCache(value){ connCache = value; },
  call(name, ...args){ return window[name](...args); },
  parse(json){ return JSON.parse(json); },
};`;

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

    get db() { return window.__bridge.db; },
    get store() { return window.__bridge.store; },
    get view() { return window.__bridge.view; },
    /** clone a plain object into the page realm */
    intoPage(value) { return window.__bridge.parse(JSON.stringify(value)); },
    /** call a global app function, e.g. api.call("render") */
    call(name, ...args) { return window.__bridge.call(name, ...args); },
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

  await api.waitFor(() => window.__appReady === true || document.getElementById("verSlot").textContent,
    { label: "index.html script execution" });
  window.eval(TEST_BRIDGE);

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
   two `await import("https://esm.sh/…")` calls in index.html are on the cloud
   path only and already failed harmlessly during boot. */
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
  api.eval("connCache = { brandId:null, available:connCache.available, accounts:[], loaded:false }");
  await api.call("refreshConnections", api.db.activeBrand);
  await api.flush();
}

/** The frozen "today" every test sees. */
export const TODAY = "2026-06-15";
