/* The application shell: toasts, the modal contract, the sidebar, the render
   dispatcher, and first-brand onboarding. Everything here is view-agnostic. */
import { VIEWS } from "./constants.js";
import { attr, esc } from "./escape.js";
import { todayStr, uid } from "./util.js";
import {
  AI_ASSIST_IDLE, COMPOSER_TIKTOK_IDLE, composerBaseline, db, mediaUploadActive,
  previousModalFocus, setAiAssist, setAnalyticsNet, setComposerBaseline,
  setComposerTikTok, setComposerVariantFocus, setComposerVariants,
  setPreviousModalFocus, setSelectedMsg, setView, view,
} from "./state.js";
import { demoMode, store } from "./store.js";
import {
  approvalRequired, defaultBrand, ensureRoleLoaded, isOwner, save, tickPublish,
} from "./workspace.js";
import {
  openPostModal, pendingApprovalCount, readPostForm, renderPlanner,
} from "./planner.js";
import { renderAnalytics } from "./analytics.js";
import { renderInbox } from "./inbox.js";
import { renderSmartlinks } from "./smartlinks.js";
import { renderReports } from "./reports.js";
import { renderConnections } from "./connections.js";
import { renderSettings } from "./settings.js";
import { ensureInvitesLoaded, invitationsBanner } from "./team.js";

/* =============== ui plumbing =============== */
export function toast(msg){
  const t=document.getElementById("toast"); t.textContent=msg; t.classList.add("show");
  clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove("show"),2200);
}
export function openModal(html){
  setPreviousModalFocus(document.activeElement);
  setComposerBaseline(null);                   // openPostModal re-arms this
  setAiAssist(AI_ASSIST_IDLE);                 // no answer outlives its composer
  setComposerVariants({});                     // …and no per-network copy either
  setComposerVariantFocus(null);
  setComposerTikTok(COMPOSER_TIKTOK_IDLE);     // …and no other creator's account
  const modal=document.getElementById("modalBody");
  modal.innerHTML=html;
  modal.setAttribute("aria-label",modal.querySelector("h3")?.textContent||"Dialog");
  document.getElementById("overlay").classList.add("open");
  requestAnimationFrame(()=>{
    (modal.querySelector("input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled]),a[href]")||modal).focus();
  });
}
export function closeModal(){
  if(mediaUploadActive) return toast("Keep this screen open while your media uploads");
  document.getElementById("overlay").classList.remove("open");
  setComposerBaseline(null);
  setAiAssist(AI_ASSIST_IDLE);
  setComposerVariants({});
  setComposerVariantFocus(null);
  setComposerTikTok(COMPOSER_TIKTOK_IDLE);
  previousModalFocus?.focus?.(); setPreviousModalFocus(null);
}
/* The composer's values as it opened, so a stray Escape or backdrop click
   cannot silently throw away a half-written post. Null while no composer is open. */
export function composerSnapshot(){
  return document.getElementById("pm_text") ? JSON.stringify(readPostForm()) : null;
}
/* Every user-initiated dismiss: Escape, the backdrop and Cancel. Saving,
   deleting, duplicating and publishing call closeModal() — those are not discards. */
export function dismissModal(){
  if(mediaUploadActive) return closeModal();   // keeps the upload-in-progress guard
  if(composerBaseline!==null && composerSnapshot()!==composerBaseline
     && !confirm("Discard this post?")) return;
  closeModal();
}
export function handleModalKeydown(event){
  const overlay=document.getElementById("overlay");
  if(!overlay.classList.contains("open")) return;
  if(event.key==="Escape"){ event.preventDefault(); dismissModal(); return; }
  if(event.key!=="Tab") return;
  const modal=document.getElementById("modalBody");
  const focusable=[...modal.querySelectorAll("a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex='-1'])")]
    /* ADR 0005 decision 11 put native <details> in the composer. A collapsed
       one still contains its textarea in the DOM, but the browser will not tab
       into it — so counting it here would leave the trap's "last control"
       pointing at something focus can never reach. The <summary> itself stays:
       it is the control that opens the section. */
    .filter(el=>!el.hidden && el.getAttribute("aria-hidden")!=="true"
      && (el.tagName==="SUMMARY" || !el.closest("details:not([open])")));
  if(!focusable.length){ event.preventDefault(); modal.focus(); return; }
  const first=focusable[0],last=focusable[focusable.length-1];
  if(event.shiftKey&&document.activeElement===first){ event.preventDefault(); last.focus(); }
  else if(!event.shiftKey&&document.activeElement===last){ event.preventDefault(); first.focus(); }
}

/* ADR 0006 decision 13: approval surfaces in the existing planner, and the one
   thing that has to reach an owner who is *not* looking at the planner is that
   somebody is waiting on them. Owners only — an editor cannot act on the count,
   and an unanswered role lookup counts as an owner exactly as isOwner() says,
   because a badge is an affordance and a briefly-shown one is harmless.
   Guarded on db.brands because renderNav() runs before the onboarding branch. */
function navBadge(viewId){
  if(viewId!=="planner" || !db?.brands?.length) return "";
  if(!approvalRequired() || !isOwner()) return "";
  const pending=pendingApprovalCount();
  return pending
    ? `<span class="navbadge" aria-label="${attr(pending+" waiting for approval")}">${pending}</span>`
    : "";
}
export function renderNav(){
  document.getElementById("demoBadge").innerHTML =
    (store.name==="cloud" && !store.user && demoMode()) ? `<span class="demobadge">DEMO</span>` : "";
  document.getElementById("nav").innerHTML = VIEWS.map(v=>
    `<button class="${v.id===view?'active':''}" data-action="go" data-arg="${attr(v.id)}">
       <span class="ic">${v.ic}</span>${v.name}${navBadge(v.id)}</button>`).join("");
  const sel=document.getElementById("brandSel");
  sel.innerHTML = db.brands.map(b=>`<option value="${attr(b.id)}" ${b.id===db.activeBrand?'selected':''}>${esc(b.name)}</option>`).join("");
}
export function go(v){ setView(v); setSelectedMsg(null); render(); }
export function switchBrand(id){
  db.activeBrand=id;
  setAnalyticsNet("all");
  save();
  render();
}
export function render(){
  if(!document.getElementById("welcome").hidden) return;   // auth gate is up
  tickPublish(); renderNav();
  const m=document.getElementById("main");
  if(!db.brands.length){ renderOnboarding(m); showInvitations(m); return; }  // fresh account
  // Three views gate controls on the caller's role. Asking here rather than in
  // each of them means the answer is already settled by the time one is opened,
  // and one cache invalidation covers switching brands. Idempotent per brand.
  ensureRoleLoaded(db.activeBrand || db.brands[0].id);
  ({planner:renderPlanner, analytics:renderAnalytics, inbox:renderInbox,
    smartlinks:renderSmartlinks, reports:renderReports,
    connections:renderConnections, settings:renderSettings}[view])(m);
  showInvitations(m);
}
/* A pending invitation belongs above whatever the user is looking at, not
   buried in one view — including the onboarding screen, since an account
   created only to accept an invite has no brand of its own yet. Prepended after
   the view has written #main, so no renderer has to know about it and none of
   them can forget it. Idempotent per session; empty markup when there is
   nothing to answer, and always empty in local/demo mode (ADR 0006 §5). */
function showInvitations(m){
  ensureInvitesLoaded();
  const banner=invitationsBanner();
  if(banner) m.insertAdjacentHTML("afterbegin", banner);
}

/* =============== first-brand onboarding (signed in, empty account) =============== */
export function renderOnboarding(m){
  m.innerHTML = `
  <div class="obwrap">
    <div class="card">
      <div class="obi">🏔</div>
      <h2>Welcome to FablePeak${store.user? ", "+esc(store.user.email.split("@")[0]) : ""}!</h2>
      <p>A <strong>brand</strong> is a workspace for one business or client — its posts,
         inbox, links and analytics live inside it. Name your first one to get started.</p>
      <div class="obrow">
        <input type="text" id="ob_name" placeholder="e.g. My Studio" maxlength="40"
          data-enter="createFirstBrand">
        <button class="btn" data-action="createFirstBrand">Create brand</button>
      </div>
    </div>
  </div>`;
  document.getElementById("ob_name").focus();
}
export function createFirstBrand(){
  const name=document.getElementById("ob_name").value.trim();
  if(!name) return toast("Give your brand a name");
  const b=defaultBrand(name);
  b.smartlink.links=[{id:uid(),title:"Our website",url:"https://",clicks:0}];
  db.brands.push(b); db.activeBrand=b.id; save(); render();
  toast("Brand created — connect your profiles next 🔌");
  go("connections");
}

/* =============== launch shortcuts =============== */
/* The installed PWA's manifest shortcuts arrive as ?action=… on a cold start. */
export function handleLaunchAction(){
  const action=new URLSearchParams(location.search).get("action");
  if(!action || !db?.brands?.length || !document.getElementById("welcome").hidden) return;
  if(action==="planner" || action==="connections"){
    setView(action); render();
  }else if(action==="new-post"){
    setView("planner"); render(); openPostModal(null,todayStr());
  }else return;
  history.replaceState(null,"",location.pathname+location.hash);
}
