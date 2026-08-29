/* FablePeak entry point (ADR 0003 Phase 2b).
 *
 * index.html loads exactly this file, as `<script type="module">`. Everything
 * else is a module it imports; there is no bundler and no build step, because
 * GitHub Pages serves .js with the right MIME type and HTTP/2 makes twenty
 * small files a non-issue. Module scripts are deferred, so the DOM is parsed
 * and backend-config.js (a classic script) has already run by the time this
 * body executes.
 */
import * as actions from "./actions.js";
import * as analytics from "./analytics.js";
import * as connections from "./connections.js";
import * as constants from "./constants.js";
import * as escapers from "./escape.js";
import * as inbox from "./inbox.js";
import * as localStore from "./local-store.js";
import * as metrics from "./metrics.js";
import * as planner from "./planner.js";
import * as remoteStore from "./remote-store.js";
import * as reports from "./reports.js";
import * as settings from "./settings.js";
import * as shell from "./shell.js";
import * as smartlinks from "./smartlinks.js";
import * as state from "./state.js";
import * as storeModule from "./store.js";
import * as util from "./util.js";
import * as welcome from "./welcome.js";
import * as workspace from "./workspace.js";

import { APP_VERSION } from "./constants.js";
import { db, mediaUploadActive, setDeferredInstallPrompt, view } from "./state.js";
import { store } from "./store.js";
import { installDelegatedHandlers } from "./actions.js";
import { handleLaunchAction, render, toast } from "./shell.js";
import { load, persistNow, tickPublish } from "./workspace.js";

/* =============== test seam =============== */
/* Module scope is not global, so the harnesses can no longer reach app
 * internals by evaluating a bare identifier the way they did while everything
 * lived in one classic script. This is the deliberate, documented replacement:
 * one namespace, published only when the page asked for it *before* any app
 * code ran, which a production page never does.
 *
 *   __fablepeak.version        APP_VERSION
 *   __fablepeak.store          the live storage adapter (tests patch methods)
 *   __fablepeak.state          js/state.js's namespace — live getters for db,
 *                              view, connCache…, plus state.set(name, value)
 *   __fablepeak.fn             every module's exports, flattened
 *   __fablepeak.call(n, ...a)  fn[n](...a)
 *
 * See test-harness/app.mjs and test-harness/browser.mjs.
 */
function testSeam(){
  const modules = {
    actions, analytics, connections, constants, escapers, inbox, localStore, metrics,
    planner, remoteStore, reports, settings, shell, smartlinks, storeModule, util,
    welcome, workspace,
  };
  const fn = {};
  for(const [moduleName, namespace] of Object.entries(modules)){
    for(const [name, value] of Object.entries(namespace)){
      // A duplicate export name would make call() ambiguous and silently pick
      // one module's version. Fail loudly instead — only tests ever see this.
      if(name in fn) throw new Error(`test seam: "${name}" is exported by two modules (${moduleName})`);
      fn[name] = value;
    }
  }
  return {
    version: APP_VERSION,
    get store(){ return store; },
    state,
    fn,
    call(name, ...args){
      if(typeof fn[name] !== "function") throw new Error("test seam: no such function " + name);
      return fn[name](...args);
    },
  };
}
if(globalThis.__FABLEPEAK_TEST__) window.__fablepeak = testSeam();

/* =============== boot =============== */
installDelegatedHandlers();
load().then(()=>{ render(); handleLaunchAction(); });
document.getElementById("verSlot").textContent = "v"+APP_VERSION;

window.addEventListener("beforeinstallprompt",event=>{
  event.preventDefault();
  setDeferredInstallPrompt(event);
  if(view==="settings" && db?.brands?.length) render();
});
window.addEventListener("appinstalled",()=>{
  setDeferredInstallPrompt(null);
  if(view==="settings" && db?.brands?.length) render();
  toast("FablePeak installed ✔");
});
window.addEventListener("beforeunload",event=>{
  if(!mediaUploadActive) return;
  event.preventDefault();
  event.returnValue="";
});

// Offline edits are cached immediately. Push the complete diff as soon as the
// browser reconnects, even if the user does not make another edit afterward.
window.addEventListener("online", async () => {
  if(store.name!=="cloud" || !store.user || !db?.brands?.length) return;
  try{ await persistNow(); toast("Back online — changes synced ✔"); }
  catch(e){ toast("Back online, but sync still failed: "+String(e.message||e).slice(0,80)); }
});

/* flip scheduled→published on time, once a minute, without disturbing typing */
setInterval(()=>{
  if(document.hidden) return;
  const before = JSON.stringify(db);
  tickPublish();
  if(JSON.stringify(db)!==before && !document.querySelector(".overlay.open") &&
     document.activeElement.tagName!=="INPUT" && document.activeElement.tagName!=="TEXTAREA") render();
}, 60000);

/* PWA: offline cache + home-screen install (needs https) */
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(()=>{});
}
