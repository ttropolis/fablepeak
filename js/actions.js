/* =============== delegated event handling (ADR 0003 §2a) ===============
   No markup carries an inline on* attribute. A rendered element names an entry
   in ACTIONS — data-action for click, data-change for change, data-input for
   input, data-enter for Enter, data-drag / data-drop for HTML5 drag — and
   carries its arguments in
   data-arg / data-arg2, escaped with attr(). Record ids therefore never enter
   JavaScript-in-attribute position at all, which retires that risk by
   construction rather than by review discipline.

   Since Phase 2b this is also what keeps the markup working at all: an inline
   onclick resolves against global scope, and module scope is not global.

   The listeners are installed once, at boot, on `document`: it is the one
   ancestor that survives render()'s full innerHTML rebuild of #main, #nav,
   #welcome and #modalBody. The functions themselves are unchanged; every entry
   below is a thin adapter that reads its arguments off the element. */
import { setAnalyticsNet, setCalCursor, setInboxFilter, setSelectedMsg } from "./state.js";
import {
  createFirstBrand, dismissModal, go, handleModalKeydown, render, switchBrand,
} from "./shell.js";
import {
  completePasswordReset, enterDemo, exitDemo, requestPasswordReset, wSubmit, wTab,
} from "./welcome.js";
import {
  calMove, clearAiAssist, deletePost, dragPost, dropPost, dupPost, focusVariant,
  openPostModal, publishNow, renderVariantSections, retryPost, runAiAssist,
  savePost, showMediaPreview, syncAiAssist, syncComposer, syncVariant,
  togglePerNetwork, uploadPostMedia, useAiSuggestion,
} from "./planner.js";
import { fakeIncoming, openMsg, sendReply, toggleResolved } from "./inbox.js";
import {
  slAdd, slClaim, slClick, slCopyUrl, slDel, slLink, slMove, slPublish, slSet,
  slSlugCheck,
} from "./smartlinks.js";
import {
  connectNet, connectReal, disconnectNet, disconnectReal, selectReal,
} from "./connections.js";
import {
  addBrand, cloudSignOut, deleteBrand, deleteCloudAccount, exportData, importData,
  installPhoneApp, renameBrand, resetData,
} from "./settings.js";
import {
  acceptInvite, declineInvite, inviteMember, leaveBrand, revokeInvite,
  simulatedTeamAction,
} from "./team.js";

export const ACTIONS = {
  /* shell + navigation */
  go:                    el => go(el.dataset.arg),
  switchBrand:           el => switchBrand(el.value),
  dismissModal:          () => dismissModal(),
  /* welcome gate */
  wTab:                  el => wTab(el.dataset.arg),
  wSubmit:               () => wSubmit(),
  requestPasswordReset:  () => requestPasswordReset(),
  completePasswordReset: () => completePasswordReset(),
  enterDemo:             () => enterDemo(),
  exitDemo:              () => exitDemo(),
  createFirstBrand:      () => createFirstBrand(),
  /* planner */
  calPrev:               () => calMove(-1),
  calToday:              () => { setCalCursor(new Date()); render(); },
  calNext:               () => calMove(1),
  newPost:               el => openPostModal(null, el.dataset.arg),
  openPost:              el => openPostModal(el.dataset.arg),
  dragPost:              (el,ev) => dragPost(ev, el.dataset.arg),
  dropPost:              (el,ev) => dropPost(ev, el.dataset.arg),
  /* composer */
  savePost:              el => savePost(el.dataset.arg),
  deletePost:            el => deletePost(el.dataset.arg),
  dupPost:               el => dupPost(el.dataset.arg),
  publishNow:            el => publishNow(el.dataset.arg),
  retryPost:             el => retryPost(el.dataset.arg),
  showMediaPreview:      el => showMediaPreview(el.value),
  uploadPostMedia:       el => uploadPostMedia(el),
  toggleNet:             el => {
    el.parentElement.classList.toggle("on", el.checked);
    renderVariantSections();                   // one section per selected network
    syncAiAssist();
  },
  /* composer → per-network copy (ADR 0005 decisions 11-13) */
  togglePerNetwork:      () => togglePerNetwork(),
  syncVariant:           el => syncVariant(el),
  syncComposer:          () => syncComposer(),
  focusVariant:          el => focusVariant(el.dataset.arg),
  /* composer → AI assist. "Rewrite for network" also depends on the picker
     above, which is why toggleNet re-syncs the row too. */
  runAiAssist:           el => runAiAssist(el.dataset.arg),
  useAiSuggestion:       el => useAiSuggestion(el.dataset.arg),
  clearAiAssist:         () => clearAiAssist(),
  syncAiAssist:          () => syncAiAssist(),
  /* analytics */
  analyticsNet:          el => { setAnalyticsNet(el.dataset.arg); render(); },
  /* inbox */
  inboxFilter:           el => { setInboxFilter(el.dataset.arg); setSelectedMsg(null); render(); },
  openMsg:               el => openMsg(el.dataset.arg),
  sendReply:             el => sendReply(el.dataset.arg),
  toggleResolved:        el => toggleResolved(el.dataset.arg),
  fakeIncoming:          () => fakeIncoming(),
  /* smartlinks */
  slSet:                 el => slSet(el.dataset.arg, el.value),
  slLink:                el => slLink(el.dataset.arg, el.dataset.arg2, el.value),
  slAdd:                 () => slAdd(),
  slDel:                 el => slDel(el.dataset.arg),
  slMove:                el => slMove(el.dataset.arg, Number(el.dataset.arg2)),
  slClick:               el => slClick(el.dataset.arg),
  slSlugCheck:           el => slSlugCheck(el),
  slClaim:               () => slClaim(),
  slPublish:             el => slPublish(el),
  slCopyUrl:             () => slCopyUrl(),
  /* reports */
  printReport:           () => window.print(),
  /* connections */
  connectNet:            el => connectNet(el.dataset.arg),
  disconnectNet:         el => disconnectNet(el.dataset.arg),
  connectReal:           el => connectReal(el.dataset.arg),
  disconnectReal:        el => disconnectReal(el.dataset.arg),
  selectReal:            el => selectReal(el.dataset.arg),
  /* settings */
  renameBrand:           el => renameBrand(el.dataset.arg, el.value),
  addBrand:              () => addBrand(),
  deleteBrand:           el => deleteBrand(el.dataset.arg),
  exportData:            () => exportData(),
  pickImportFile:        () => document.getElementById("impFile").click(),
  importData:            el => importData(el),
  resetData:             () => resetData(),
  cloudSignOut:          () => cloudSignOut(),
  deleteCloudAccount:    () => deleteCloudAccount(),
  installPhoneApp:       () => installPhoneApp(),
  /* team (ADR 0006 delivery item 2). Emails are user-controlled strings, so
     every id below travels in data-arg through attr() and never in an inline
     handler — the same rule the rest of this table follows. */
  inviteMember:          () => inviteMember(),
  revokeInvite:          el => revokeInvite(el.dataset.arg),
  acceptInvite:          el => acceptInvite(el.dataset.arg),
  declineInvite:         el => declineInvite(el.dataset.arg),
  /* No data-arg: leaving is always about the *active* brand and the caller's
     own membership, so there is no id for the markup to carry or to get wrong. */
  leaveBrand:            () => leaveBrand(),
  simulatedTeamAction:   () => simulatedTeamAction(),
};
function actionTarget(ev, name){ return ev.target?.closest?.(`[data-${name}]`) || null; }
function runAction(ev, name){
  const el = actionTarget(ev, name);
  if(!el) return;
  const run = ACTIONS[el.dataset[name]];
  if(run) run(el, ev);
}
export function installDelegatedHandlers(){
  document.addEventListener("click",  ev => runAction(ev, "action"));
  document.addEventListener("change", ev => runAction(ev, "change"));
  /* data-input is for controls whose *neighbours* must react while typing —
     `change` on a textarea only fires on blur, which is too late to enable the
     AI assist buttons beside it. */
  document.addEventListener("input",  ev => runAction(ev, "input"));
  /* data-focus is for controls that have to record *where the caret is*: AI
     "Rewrite for network" targets the per-network section the customer is
     working in (ADR 0005 decision 13). Registered on the capture phase because
     `focus` does not bubble, which is also why it is not folded into the
     listeners above. */
  document.addEventListener("focus", ev => runAction(ev, "focus"), true);
  document.addEventListener("keydown", ev => {
    if(ev.key !== "Enter") return;                 // Escape and Tab stay with handleModalKeydown
    runAction(ev, "enter");
  });
  document.addEventListener("dragstart", ev => runAction(ev, "drag"));
  document.addEventListener("dragover", ev => {
    const cell = actionTarget(ev, "drop");
    if(!cell) return;
    ev.preventDefault(); cell.classList.add("dragover");
  });
  document.addEventListener("dragleave", ev => {
    actionTarget(ev, "drop")?.classList.remove("dragover");
  });
  document.addEventListener("drop", ev => {
    const cell = actionTarget(ev, "drop");
    if(!cell) return;
    cell.classList.remove("dragover");
    runAction(ev, "drop");
  });
  /* Escape / Tab inside the dialog. Installed here rather than at module load
     so every document listener the app owns is registered in one place. */
  document.getElementById("overlay").addEventListener("keydown", handleModalKeydown);
  /* Backdrop dismiss: only a click on the overlay itself, never one that
     bubbled out of the dialog inside it. */
  document.getElementById("overlay").addEventListener("click", ev => {
    if(ev.target === ev.currentTarget) dismissModal();
  });
}
