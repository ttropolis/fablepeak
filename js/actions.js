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
  completePasswordReset, enterDemo, exitDemo, requestPasswordReset, togglePassword,
  wSubmit, wTab,
} from "./welcome.js";
import {
  addCarouselItem, approvePost, calMove, clearAiAssist, deletePost, dragPost,
  dropPost, dupPost, focusVariant, insertHashtagGroup, openPostModal, publishNow,
  rejectPost, removeCarouselItem, renderCarousel, renderInstagramPanel,
  renderTikTokPanel, renderVariantSections, retryPost, runAiAssist, savePost,
  setApprovalScope, setInstagramOption, setTikTokOption, showMediaPreview,
  syncAiAssist, syncCarouselAlt, syncCarouselItem, syncComposer, syncInstagramAlt,
  syncVariant,
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
  addBrand, cancelHashtagGroup, cloudSignOut, deleteBrand, deleteCloudAccount,
  deleteHashtagGroup, editHashtagGroup, exportData, importData, installPhoneApp,
  renameBrand, resetData, saveHashtagGroup, simulatedApprovalToggle, toggleApproval,
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
  togglePassword:        el => togglePassword(el.dataset.arg),
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
  /* approval (ADR 0006 decision 13) — the planner's scope, and the two
     decisions an owner makes from inside the composer. */
  approvalScope:         el => setApprovalScope(el.dataset.arg),
  approvePost:           el => approvePost(el.dataset.arg),
  rejectPost:            el => rejectPost(el.dataset.arg),
  /* composer */
  savePost:              el => savePost(el.dataset.arg),
  deletePost:            el => deletePost(el.dataset.arg),
  dupPost:               el => dupPost(el.dataset.arg),
  publishNow:            el => publishNow(el.dataset.arg),
  retryPost:             el => retryPost(el.dataset.arg),
  /* The media field decides which Instagram options exist at all — a video is
     offered a placement, a single image is offered alt text — so the panel is
     rebuilt with the preview, exactly as TikTok's duration check is. */
  showMediaPreview:      el => {
    showMediaPreview(el.value); renderInstagramPanel(); renderTikTokPanel();
  },
  uploadPostMedia:       el => uploadPostMedia(el),
  toggleNet:             el => {
    el.parentElement.classList.toggle("on", el.checked);
    renderVariantSections();                   // one section per selected network
    renderCarousel();                          // …the carousel, or none
    renderInstagramPanel();                    // …Instagram's own options, or none
    renderTikTokPanel();                       // …and TikTok's own form, or none
    syncAiAssist();
  },
  /* composer -> Instagram carousel. The list is rebuilt on add and remove and
     deliberately NOT on typing: rebuilding mid-URL would drop the caret, so
     syncCarouselItem records the value and repaints only that row's thumbnail. */
  addCarouselItem:       () => addCarouselItem(),
  removeCarouselItem:    el => removeCarouselItem(el.dataset.arg),
  syncCarouselItem:      el => { syncCarouselItem(el); renderInstagramPanel(); },
  /* …and one description per item, which repaints only its own counter for the
     same reason: rebuilding the list under the caret would drop it mid-word. */
  syncCarouselAlt:       el => syncCarouselAlt(el),
  /* composer → per-post Instagram options. The Reel placement rebuilds nothing
     and alt text repaints only its own counter: rebuilding the panel under the
     caret would drop it mid-description. */
  instagramOption:       el => setInstagramOption(el),
  syncInstagramAlt:      el => syncInstagramAlt(el),
  /* composer → TikTok Direct Post options. One entry for every control in the
     panel; which one is being changed travels in data-arg, so the conditional
     rules the guidelines impose live in one function instead of six. */
  tiktokOption:          el => setTikTokOption(el),
  /* composer → per-network copy (ADR 0005 decisions 11-13) */
  togglePerNetwork:      () => togglePerNetwork(),
  syncVariant:           el => syncVariant(el),
  syncComposer:          () => syncComposer(),
  focusVariant:          el => focusVariant(el.dataset.arg),
  /* composer → hashtag groups. One saved set appended to the post's own
     content; the id travels in data-arg like every other record id here. */
  insertHashtagGroup:    el => insertHashtagGroup(el.dataset.arg),
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
  toggleApproval:        el => toggleApproval(el),
  simulatedApprovalToggle: () => simulatedApprovalToggle(),
  addBrand:              () => addBrand(),
  deleteBrand:           el => deleteBrand(el.dataset.arg),
  /* settings → hashtag groups. Member-level work, so there is no owner gate
     here — the hashtag_groups_all RLS policy is is_member(brand_id) to match. */
  saveHashtagGroup:      el => saveHashtagGroup(el.dataset.arg),
  editHashtagGroup:      el => editHashtagGroup(el.dataset.arg),
  cancelHashtagGroup:    () => cancelHashtagGroup(),
  deleteHashtagGroup:    el => deleteHashtagGroup(el.dataset.arg),
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
