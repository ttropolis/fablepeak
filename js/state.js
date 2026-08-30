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
/** the signed-in user's own role in one brand — "owner" | "editor" | null.
    `loaded:false` means "not known yet", never "not an owner": see isOwner(). */
export let roleCache = { brandId:null, role:null, loaded:false, loading:false };
/** the active brand's roster and its pending invitations (Settings → Team).
    Owner-only data: `invites` is always [] for an editor, because the
    invites_select policy is is_owner (ADR 0006 delivery item 2). */
export let teamCache = { brandId:null, members:[], invites:[],
                         loaded:false, loading:false, error:null };
/** invitations addressed to THIS signed-in user, from list_my_invites().
    Not per brand: the whole point is that the invitee is not in the brand yet
    and the read never returns a brand_id. */
export let inviteCache = { items:[], loaded:false, loading:false };
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
/** AI assist in the open composer: which action is in flight (`busy`), which
    one produced the suggestions on screen, and the suggestions themselves.
    Reset whenever a modal opens or closes, so no answer outlives its composer. */
export const AI_ASSIST_IDLE = Object.freeze({
  busy: null, action: null, items: Object.freeze([]), truncated: false,
});
export let aiAssist = AI_ASSIST_IDLE;
/** The open composer's per-network copy (ADR 0005 decision 2), keyed by network
    id. Holds what is typed *and* what was retained: a variant for a network the
    customer has since deselected stays here so re-selecting restores the draft,
    and is never published. Reset whenever a modal opens or closes, so no
    composer inherits another one's copy. */
export let composerVariants = {};
/** Which per-network section the composer last put the caret in — the target
    for AI "Rewrite for network" (ADR 0005 decision 13). Null until the customer
    touches one, which is what makes the base text the default subject. */
export let composerVariantFocus = null;

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
export function setRoleCache(value){ roleCache = value; }
export function setTeamCache(value){ teamCache = value; }
export function setInviteCache(value){ inviteCache = value; }
export function setSlCache(value){ slCache = value; }
export function setWMode(value){ wMode = value; }
export function setPreviousModalFocus(value){ previousModalFocus = value; }
export function setComposerBaseline(value){ composerBaseline = value; }
export function setAiAssist(value){ aiAssist = value; }
export function setComposerVariants(value){ composerVariants = value; }
export function setComposerVariantFocus(value){ composerVariantFocus = value; }

const SETTERS = {
  db: setDb, view: setView, calCursor: setCalCursor, selectedMsg: setSelectedMsg,
  inboxFilter: setInboxFilter, analyticsNet: setAnalyticsNet,
  mediaUploadActive: setMediaUploadActive,
  deferredInstallPrompt: setDeferredInstallPrompt,
  metricsCache: setMetricsCache, connCache: setConnCache, slCache: setSlCache,
  roleCache: setRoleCache, teamCache: setTeamCache, inviteCache: setInviteCache,
  wMode: setWMode, previousModalFocus: setPreviousModalFocus,
  composerBaseline: setComposerBaseline, aiAssist: setAiAssist,
  composerVariants: setComposerVariants,
  composerVariantFocus: setComposerVariantFocus,
};

/** Set one field by name. Used by the test seam (js/main.js), which needs to
 *  put the app into a state no fixture can reach, and by nothing else. */
export function set(name, value){
  const apply = SETTERS[name];
  if(!apply) throw new Error("unknown state field: " + name);
  apply(value);
}
