/* Every value the app reassigns at runtime.
 *
 * In a classic script these were top-level `let`s that any function could read
 * and write. Module scope is not shared, so they live here instead and are
 * exported as live bindings: importers read `db`, `view`, `connCache`… exactly
 * as before and always see the current value, but a reassignment has to go
 * through the setter beside it, because only the declaring module may rebind an
 * export. Property mutation (`connCache.loaded = false`, `db.brands.push(…)`)
 * is unchanged and still done in place by the owning code.
 *
 * Collecting them here rather than in each view also keeps the module graph
 * acyclic at its base: this module imports nothing.
 */

/** the whole workspace: { brands, activeBrand } */
export let db = null;
/** which view the shell is rendering */
export let view = "planner";
/** month shown in the planner */
export let calCursor = new Date();
/** id of the inbox thread currently open, or null */
export let selectedMsg = null;
export let inboxFilter = "all";
export let analyticsNet = "all";
/** true while a media upload is in flight — blocks modal close and save */
export let mediaUploadActive = false;
/** the deferred beforeinstallprompt event, when the browser offered one */
export let deferredInstallPrompt = null;
/** real platform metrics for one brand (Analytics + Reports) */
export let metricsCache = {
  brandId: null, rows: [], loaded: false, loading: false, error: null,
};
/** real connected accounts for one brand. `loaded:false` means "not known
    yet", never "nothing connected" — see connectionsKnown(). */
export let connCache = { brandId:null, available:[], accounts:[], loaded:false };
/** public SmartLink slug, publish flag and real click aggregates for one brand */
export let slCache = { brandId:null, slug:"", published:false, totals:{},
                       loaded:false, loading:false, error:null };
/** welcome gate tab: "signin" | "signup" */
export let wMode = "signin";
/** element focused before the modal opened, restored on close */
export let previousModalFocus = null;
/** the composer's values as it opened, so a stray Escape cannot discard a
    half-written post. Null while no composer is open. */
export let composerBaseline = null;

export function setDb(value){ db = value; }
export function setView(value){ view = value; }
export function setCalCursor(value){ calCursor = value; }
export function setSelectedMsg(value){ selectedMsg = value; }
export function setInboxFilter(value){ inboxFilter = value; }
export function setAnalyticsNet(value){ analyticsNet = value; }
export function setMediaUploadActive(value){ mediaUploadActive = value; }
export function setDeferredInstallPrompt(value){ deferredInstallPrompt = value; }
export function setMetricsCache(value){ metricsCache = value; }
export function setConnCache(value){ connCache = value; }
export function setSlCache(value){ slCache = value; }
export function setWMode(value){ wMode = value; }
export function setPreviousModalFocus(value){ previousModalFocus = value; }
export function setComposerBaseline(value){ composerBaseline = value; }

const SETTERS = {
  db: setDb, view: setView, calCursor: setCalCursor, selectedMsg: setSelectedMsg,
  inboxFilter: setInboxFilter, analyticsNet: setAnalyticsNet,
  mediaUploadActive: setMediaUploadActive,
  deferredInstallPrompt: setDeferredInstallPrompt,
  metricsCache: setMetricsCache, connCache: setConnCache, slCache: setSlCache,
  wMode: setWMode, previousModalFocus: setPreviousModalFocus,
  composerBaseline: setComposerBaseline,
};

/** Set one field by name. Used by the test seam (js/main.js), which needs to
 *  put the app into a state no fixture can reach, and by nothing else. */
export function set(name, value){
  const apply = SETTERS[name];
  if(!apply) throw new Error("unknown state field: " + name);
  apply(value);
}
