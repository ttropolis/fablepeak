/* =============== PLANNER =============== */
/* The month calendar, the composer modal, and everything that happens to a
   post: drag-reschedule, validate, save, publish, retry, duplicate, delete. */
import { NETWORKS, SCHEDULE_TZ } from "./constants.js";
import { attr, esc, safeUrl } from "./escape.js";
import { fileSizeLabel, fmtDate, mediaContentType, todayStr, uid } from "./util.js";
import {
  AI_ASSIST_IDLE, COMPOSER_INSTAGRAM_IDLE, COMPOSER_TIKTOK_IDLE, aiAssist,
  approvalFilter, calCursor, composerCarousel, composerInstagram, composerTikTok,
  composerVariantFocus, composerVariants, mediaUploadActive, setAiAssist,
  setApprovalFilter, setComposerBaseline, setComposerCarousel,
  setComposerInstagram, setComposerTikTok, setComposerVariantFocus,
  setComposerVariants, setMediaUploadActive,
} from "./state.js";
import { appendTags, groupsOf } from "./hashtags.js";
import { liveMode, store } from "./store.js";
import {
  approvalRequired, brand, connectedNets, connectionsKnown, isOwner, netOf,
  persistNow, save,
} from "./workspace.js";
import { closeModal, composerSnapshot, openModal, render, toast } from "./shell.js";

/* =============== approval (ADR 0006 decisions 9, 11 and 13) ===============

   No new view: a post awaiting review is a post, and it belongs on the calendar
   beside the ones that are not. What the planner adds while a brand has
   `approval_required` on is a chip colour, a legend entry, a filter, a count for
   the owner who has to act on it, and — in the composer — the decision itself.

   Everything below is an affordance. The rule lives in the
   posts_guard_status_transition trigger (20260830130000_post_approval.sql),
   which reads the same flag and the same role from Postgres and refuses an
   editor's `→ scheduled` whatever this file renders. */

/* `pending_approval` is a database value; "pending approval" is English. Every
   other status reads identically either way, so this map changes nothing for
   the five statuses that predate it — including the chip aria-labels and the
   composer's <option> text, which two suites pin. */
export const POST_STATUS_LABEL = { pending_approval: "pending approval" };
export function statusLabel(status){ return POST_STATUS_LABEL[status] || status; }
/** Posts in the active brand waiting on a decision — the owner's badge count. */
export function pendingApprovalCount(){
  return (brand()?.posts || []).filter(p => p.status === "pending_approval").length;
}
/** Show the pending vocabulary at all? While the flag is on, always — an empty
    queue is information. While it is off, only if a post is still parked in
    `pending_approval` from before it was turned off, because hiding the legend
    entry for a chip that is on screen would be the one dishonest option. */
function approvalVisible(){
  return approvalRequired() || pendingApprovalCount() > 0;
}
export function setApprovalScope(scope){
  setApprovalFilter(scope === "pending" ? "pending" : "all");
  render();
}
/* The filter is offered to everyone the vocabulary is visible to: an editor
   wanting to see what they have submitted asks the same question an owner does.
   The count is the reason it exists, so it is rendered into the control. */
function approvalFilterBar(){
  if(!approvalVisible()) return "";
  const pending=pendingApprovalCount();
  return `<div class="tabbar" id="pm_approval_filter" style="margin-top:12px;margin-bottom:0">
    ${[["all","All posts"],["pending",`Needs approval${pending?` (${pending})`:""}`]]
      .map(([id,label])=>`<button class="${approvalFilter===id?"active":""}"
        data-action="approvalScope" data-arg="${attr(id)}">${esc(label)}</button>`).join("")}
  </div>`;
}

export function renderPlanner(m){
  const y=calCursor.getFullYear(), mo=calCursor.getMonth();
  const monthName = calCursor.toLocaleString("en",{month:"long",year:"numeric"});
  const first = new Date(y,mo,1);
  let start = new Date(first); start.setDate(1-((first.getDay()+6)%7)); // Monday start
  const cells=[];
  for(let i=0;i<42;i++){ const d=new Date(start); d.setDate(start.getDate()+i); cells.push(d); }
  const b=brand();
  /* The filter narrows what the month *shows*; it never touches what the month
     contains, so switching back to All is the whole undo. */
  const inScope = p => !(approvalVisible() && approvalFilter==="pending")
    || p.status==="pending_approval";
  const shown=b.posts.filter(inScope);
  const postsBy={}; shown.forEach(p=>{ (postsBy[p.date]=postsBy[p.date]||[]).push(p); });
  const monthKey=`${y}-${String(mo+1).padStart(2,"0")}`;
  const monthPosts=shown.filter(p=>p.date?.startsWith(monthKey+"-"))
    .sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
  const newPostDate=todayStr().startsWith(monthKey+"-") ? todayStr() : `${monthKey}-01`;
  const filterBar=approvalFilterBar();

  m.innerHTML = `
  <h1>Content Planner</h1>
  <div class="sub">Click a day to schedule. Drag posts between days. ${connectionsKnown() && !connectedNets().length ? "⚠️ No profiles connected yet — go to Connections." : ""}</div>
  <div class="card">
    <div class="calhead">
      <h2>${monthName}</h2>
      <div style="display:flex;gap:8px">
        <button class="btn ghost mini" data-action="calPrev">← Prev</button>
        <button class="btn ghost mini" data-action="calToday">Today</button>
        <button class="btn ghost mini" data-action="calNext">Next →</button>
        <button class="btn mini" data-action="newPost" data-arg="${attr(newPostDate)}">+ New post</button>
      </div>
    </div>
    ${filterBar}
    ${filterBar && approvalFilter==="pending" && !monthPosts.length
      ? `<div style="color:var(--muted);font-size:13px;margin:10px 0">Nothing is waiting for approval in ${esc(monthName)}.</div>` : ""}
    <div class="calgrid">
      ${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d=>`<div class="dow">${d}</div>`).join("")}
      ${cells.map(d=>{
        const ds=fmtDate(d);
        const cls=["day", d.getMonth()!==mo?"other":"", ds===todayStr()?"today":""].join(" ");
        const chips=(postsBy[ds]||[]).sort((a,b)=>(a.time||"").localeCompare(b.time||"")).map(p=>{
          const visibleStatus=postVisibleStatus(p);
          return `<button type="button" class="post ${attr(visibleStatus)}" draggable="${!(liveMode()&&["publishing","published"].includes(p.status))}" title="${attr(p.text)}"
                aria-label="${attr(`${p.time||"Any time"}, ${statusLabel(visibleStatus)}: ${p.text}`)}"
                data-action="openPost" data-drag="dragPost" data-arg="${attr(p.id)}">
             <span class="nets">${p.networks.map(n=>netOf(n)?.short||n).join("·")}</span>${esc(p.text)}</button>`;
        }).join("");
        return `<div class="${attr(cls)}" data-drop="dropPost" data-arg="${attr(ds)}">
                  <button type="button" class="dnum" aria-label="Schedule a post on ${attr(ds)}"
                    data-action="newPost" data-arg="${attr(ds)}">${d.getDate()}</button>${chips}</div>`;
      }).join("")}
    </div>
    <div class="legend">
      <span><i style="background:var(--chip-draft)"></i>Draft</span>
      ${approvalVisible()?`<span><i style="background:var(--chip-pending)"></i>Needs approval</span>`:""}
      <span><i style="background:var(--chip-sched)"></i>Scheduled</span>
      ${liveMode()?`<span><i style="background:#2f91b5"></i>Publishing</span>`:""}
      <span><i style="background:var(--chip-pub)"></i>Published</span>
      ${liveMode()?`<span><i style="background:var(--chip-fail)"></i>Needs attention</span>`:""}
    </div>
    <div class="mobile-agenda">
      ${monthPosts.length ? monthPosts.map(p=>{
        const date=new Date(`${p.date}T12:00:00`);
        const dateLabel=date.toLocaleDateString("en",{weekday:"short",day:"numeric"});
        const nets=p.networks.map(n=>netOf(n)?.short||n).join(" · ");
        const visibleStatus=postVisibleStatus(p);
        return `<button type="button" class="agenda-post" data-action="openPost" data-arg="${attr(p.id)}">
          <span class="agenda-date">${dateLabel}</span>
          <span class="agenda-copy"><strong>${esc(p.text)}</strong>
            <span>${esc(p.time||"Any time")} · ${esc(nets)} · ${esc(statusLabel(visibleStatus))}</span></span>
        </button>`;
      }).join("") : `<div class="empty">No posts in ${monthName}. Tap <strong>New post</strong> to add one.</div>`}
    </div>
  </div>`;
}
export function calMove(n){ calCursor.setMonth(calCursor.getMonth()+n); render(); }
export function dragPost(ev,id){ ev.dataTransfer.setData("text/plain",id); }
export function dropPost(ev,ds){
  ev.preventDefault();                           // the delegated drop listener clears .dragover
  const id=ev.dataTransfer.getData("text/plain");
  const p=brand().posts.find(p=>p.id===id);
  if(!p) return;
  if(liveMode() && ["publishing","published"].includes(p.status))
    return toast("Published posts can't be rescheduled — duplicate it as a draft instead");
  p.date=ds; if(p.status==="published") p.status="scheduled";
  save(); render(); toast("Post moved to "+ds);
}
export function deliveryPanel(p){
  const targets=p?.targets||[];
  if(!targets.length) return "";
  const canRetry=targets.some(t=>["retryable","permanent"].includes(t.failure_kind));
  return `<section class="delivery-panel" aria-label="Delivery results">
    <h4>Delivery results</h4>
    ${targets.map(t=>{
      const name=netOf(t.platform)?.name||t.platform;
      const detail=t.status==="published"
        ? safeUrl(t.remote_url) ? `<a href="${attr(safeUrl(t.remote_url))}" target="_blank" rel="noopener">Published — view post</a>` : "Published"
        : t.failure_kind==="retryable"
          ? `Automatic retry scheduled${t.next_retry_at?` for ${new Date(t.next_retry_at).toLocaleString()}`:""}`
          : t.failure_kind==="unknown"
            ? `Verify on ${esc(name)} before doing anything else — delivery may have succeeded.`
            : t.error||t.status;
      return `<div class="delivery-row ${attr(t.status)}">
        <strong>${esc(name)}</strong><span>${detail}</span>
        ${t.error&&t.status!=="published"?`<small>${esc(t.error)}</small>`:""}
      </div>`;
    }).join("")}
    ${canRetry?`<button class="btn ghost mini" data-action="retryPost" data-arg="${attr(p.id)}">Retry failed targets now</button>`:""}
  </section>`;
}
export function postVisibleStatus(p){
  const needsAttention=(p?.targets||[]).some(target=>
    target.status!=="published" && ["permanent","unknown"].includes(target.failure_kind));
  return needsAttention?"failed":p.status;
}
export function postStatusFromResults(results){
  if(results.some(result=>result.failure_kind==="retryable")) return "scheduled";
  return results.length && results.every(result=>result.status==="published")
    ? "published" : "failed";
}
export function openPostModal(id, dateStr){
  const b=brand();
  const p = id? b.posts.find(x=>x.id===id) : null;
  const locked = liveMode() && ["publishing","published"].includes(p?.status);
  /* ADR 0006 decision 13. While the brand requires approval the select is the
     submit control: an editor's ladder stops at "pending approval", and only an
     owner is offered "scheduled". The trigger enforces exactly this, so an
     editor who reaches past the select is refused by Postgres rather than by a
     missing <option>. */
  const approval = approvalRequired();
  const owner = isOwner();
  const statusOptions = liveMode()
    ? locked ? [p.status]
      : approval ? (owner ? ["draft","pending_approval","scheduled"] : ["draft","pending_approval"])
      : ["draft","scheduled"]
    : ["draft","scheduled","published"];
  /* A post parked in `pending_approval` when the flag was switched off would
     otherwise open with the select showing "draft" and be silently moved by the
     next Save. Its own status is always an option it can stay on. */
  if(p && !locked && p.status==="pending_approval" && !statusOptions.includes("pending_approval"))
    statusOptions.splice(1, 0, "pending_approval");
  const nets = p? p.networks : connectedNets().slice(0,1).map(n=>n.id);
  openModal(`
    <h3>${p? "Edit post":"New post"}</h3>
    <div class="sub">${locked
      ? p.status==="publishing" ? "Publishing is in progress…" : "Published posts are read-only. Duplicate this post to reuse it."
      : p? "Update, duplicate or delete this post.":"Compose once, publish everywhere."}</div>
    ${p?deliveryPanel(p):""}
    ${approvalPanel(p, locked)}
    <label class="f">Content</label>
    <textarea id="pm_text" placeholder="What do you want to say?" ${locked?"disabled":""}
      data-input="syncComposer" data-focus="focusVariant">${esc(p?.text||"")}</textarea>
    <div class="charcount" id="pm_count" aria-live="polite"></div>
    ${aiAssistPanel(locked)}
    ${hashtagGroupsPanel(locked)}
    ${perNetworkPanel(p, locked)}
    ${tiktokPanelHost(locked)}
    <label class="f">Image / video <span style="text-transform:none;font-weight:400">— required by Instagram, Pinterest, TikTok and YouTube</span></label>
    <input type="url" id="pm_media" placeholder="https://… (optional for X, Facebook, LinkedIn)" value="${attr(p?.media_url||"")}" ${locked?"disabled":""} data-change="showMediaPreview">
    <div class="media-preview" id="pm_media_preview"></div>
    ${carouselHost(locked)}
    ${instagramPanelHost(locked)}
    ${liveMode() && !locked ? `<div class="upload-actions">
      <label class="filebtn ghost">📱 Choose photo or video
        <input type="file" id="pm_upload" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.heic,.heif,video/mp4,video/quicktime,video/webm,.m4v"
          data-change="uploadPostMedia">
      </label>
      <label class="filebtn ghost mobile-only">📷 Take photo
        <input type="file" accept="image/*" capture="environment" data-change="uploadPostMedia">
      </label>
      <label class="filebtn ghost mobile-only">🎥 Record video
        <input type="file" accept="video/*" capture="environment" data-change="uploadPostMedia">
      </label>
      <span id="pm_upload_status" class="upload-status">Phone gallery and camera supported · 50 MB maximum.</span>
    </div>` : ""}
    <label class="f">Networks</label>
    <div class="netpick" id="pm_nets">
      ${NETWORKS.map(n=>{
        const live = connectedNets().some(c => c.id === n.id);
        const conn = liveMode() ? live : !!b.connections[n.id];
        const on=nets.includes(n.id);
        return `<label class="${on?'on':''}" style="${conn?'':'opacity:.4'}" title="${conn?'':'Not connected'}">
          <input type="checkbox" value="${attr(n.id)}" ${on?'checked':''} ${conn&&!locked?'':'disabled'}
            data-change="toggleNet">
          <span style="color:${n.color};font-weight:700">${n.short}</span> ${n.name}
          ${conn?"":`<small class="netreason">Not connected</small>`}</label>`;
      }).join("")}
    </div>
    <div class="fieldrow">
      <div style="flex:1;min-width:120px"><label class="f">Date</label><input type="date" id="pm_date" value="${attr(p?.date||dateStr||todayStr())}" ${locked?"disabled":""}></div>
      <div style="flex:1;min-width:110px"><label class="f">Time${liveMode()?` <span style="text-transform:none;font-weight:400">(${esc(SCHEDULE_TZ)})</span>`:""}</label><input type="time" id="pm_time" value="${attr(p?.time||"10:00")}" ${locked?"disabled":""}></div>
      <div style="flex:1;min-width:110px"><label class="f">Status</label>
        <select class="inp" id="pm_status" ${locked?"disabled":""}>
          ${statusOptions.map(s=>`<option value="${attr(s)}" ${p?.status===s?"selected":""}>${esc(statusLabel(s))}</option>`).join("")}
        </select></div>
    </div>
    ${tiktokConsentHost(locked)}
    <div class="modalfoot">
      <div>${p?`${p.status!=="publishing"?`<button class="btn dangerb mini" data-action="deletePost" data-arg="${attr(p.id)}">Delete</button>`:""}
               ${p.status!=="publishing"?`<button class="btn ghost mini" data-action="dupPost" data-arg="${attr(p.id)}">Duplicate</button>`:""}
               ${liveMode() && !["publishing","published","pending_approval"].includes(p.status) && !(approval && !owner)
                 ? `<button class="btn mini" data-action="publishNow" data-arg="${attr(p.id)}">🚀 Publish now</button>` : ""}`:""}</div>
      <div class="right">
        <button class="btn ghost" data-action="dismissModal">${locked?"Close":"Cancel"}</button>
        ${locked?"":`<button class="btn" data-action="savePost" data-arg="${attr(p?.id||"")}">${p?"Save":"Schedule"}</button>`}
      </div>
    </div>`);
  // openModal() cleared these; the composer's own copy is installed after it.
  setComposerVariants({...(p?.variants||{})});
  setComposerVariantFocus(null);
  /* A post that already recorded TikTok choices reopens showing them. The
     no-preselected-default rule is about a *new* composer having no audience
     chosen for it, not about hiding a choice the customer already made. */
  setComposerTikTok({...COMPOSER_TIKTOK_IDLE,
    options:{...COMPOSER_TIKTOK_IDLE.options, ...readStoredTikTokOptions(p)}});
  /* A post that already carries a carousel reopens showing it. Only the extras
     live in composer state — item one is `media_url`, which #pm_media already
     holds, and keeping one copy of it is what stops the two drifting apart. */
  setComposerCarousel(storedCarouselExtras(p));
  /* A post that already recorded Instagram choices reopens showing them. Unlike
     TikTok's audience there is a legitimate default here — "Instagram default",
     which is what an absent share_to_feed has always meant — so a post with no
     stored options opens on it rather than on nothing. */
  setComposerInstagram({...COMPOSER_INSTAGRAM_IDLE, ...readStoredInstagramOptions(p)});
  if(p?.media_url) showMediaPreview(p.media_url);
  renderVariantSections();                     // #pm_variants was built empty
  renderCarousel();                            // …and so was #pm_carousel
  renderInstagramPanel();                      // …and so was #pm_instagram
  renderTikTokPanel();                         // …and so was #pm_tiktok
  syncComposer();                              // the panels were built before #pm_text existed
  setComposerBaseline(composerSnapshot());     // arms the unsaved-changes guard
}

/* The composer's half of the approval workflow.
 *
 *  Three states, one panel, and nothing at all in the common case:
 *
 *    owner + pending    the decision itself — a note box and Approve / Request
 *                       changes. The note is required for a rejection because
 *                       it is the only thing the author gets back (decision 11),
 *                       and the trigger refuses a noteless rejection too.
 *    editor + pending   "waiting on an owner", so the post does not look stuck.
 *    a note, any state  the last decision's words, shown to whoever opens the
 *                       post next. Rendered through esc() like every other
 *                       string somebody else typed.
 *
 *  Nothing renders for a locked (publishing/published) post: a delivered post
 *  has no decision left to make. */
function approvalPanel(p, locked){
  if(!liveMode() || !p || locked) return "";
  const note=String(p.approval_note||"").trim();
  const pending=p.status==="pending_approval";
  const decide=pending && approvalRequired() && isOwner();
  if(!pending && !note) return "";
  return `<section class="approval-panel" aria-label="Approval">
    <h4>${decide?"Your decision":pending?"Waiting for approval":"Changes requested"}</h4>
    ${note?`<div class="approval-note">${esc(note)}</div>`:""}
    ${decide ? `
      <label class="f" for="pm_approval_note">Note to the author — required to send it back</label>
      <textarea id="pm_approval_note" placeholder="What needs to change before this can go out?"
        >${esc(p.approval_note||"")}</textarea>
      <div class="approval-acts">
        <button class="btn mini" data-action="approvePost" data-arg="${attr(p.id)}">✔ Approve &amp; schedule</button>
        <button class="btn ghost mini" data-action="rejectPost" data-arg="${attr(p.id)}">↩ Request changes</button>
      </div>`
    : pending ? `<div style="color:var(--muted);font-size:13px">
        Submitted for approval. An owner of this workspace can schedule it, and
        you can pull it back to a draft while you wait.</div>`
    : `<div style="color:var(--muted);font-size:13px">
        Edit the post and set its status back to <strong>pending approval</strong> when it is ready.</div>`}
  </section>`;
}
/* Approve and Request changes are the composer's own writes, so they carry the
   composer's edits with them exactly the way Publish now does: an owner who
   fixed a typo and pressed Approve must not lose the typo fix. The status is
   set afterwards, over whatever the select said.

   Both mirror server-side rules rather than replacing them — the trigger clears
   the note on approval and refuses a rejection without one — so the worst a
   drifted copy of this file can do is show a message a moment early. */
export function approvePost(id){
  const p=brand().posts.find(x=>x.id===id);
  if(!p) return;
  const values=readPostForm();
  if(!validatePostForm(values)) return;
  const {nets,...postValues}=values;
  Object.assign(p,{...postValues,networks:nets,status:"scheduled",approval_note:""});
  save(); closeModal(); render();
  toast("Approved — this post is scheduled ✔");
}
export function rejectPost(id){
  const p=brand().posts.find(x=>x.id===id);
  if(!p) return;
  const note=String(document.getElementById("pm_approval_note")?.value||"").trim();
  if(!note) return toast("Say what needs changing — the note is all the author gets back");
  const values=readPostForm();
  if(!validatePostForm(values)) return;
  const {nets,...postValues}=values;
  Object.assign(p,{...postValues,networks:nets,status:"draft",approval_note:note});
  save(); closeModal(); render();
  toast("Sent back to the author as a draft");
}

/* =============== per-network copy (ADR 0005 decisions 2, 11 and 12) ===============

   One post, one media URL, one schedule — and, optionally, a different string of
   copy per network. The map lives on the post as `variants`; an entry overrides
   `text` for that network and anything blank inherits it.

   Two rules shape everything below.

   The resolver is the contract. `effectiveText()` here and `effectiveText()` in
   supabase/functions/_shared/platforms.ts must agree character for character,
   because one of them draws the counter that tells the customer their post fits
   and the other decides what the provider is actually sent.

   The panel is off by default and renders *nothing* when it is off — not hidden
   markup. A composer with no variants therefore has exactly the DOM it had
   before this feature existed, which is what keeps the modal's focus trap and
   the browser tier's tab-order walk describing the same dialog they always did. */

/* Advisory in the composer, except where HARD_TEXT_CAPS repeats the number:
   those are provider limits that refuse the post rather than trim it. */
export const NETWORK_TEXT_CAPS = {
  x: 280, instagram: 2200, pinterest: 500, linkedin: 3000,
  tiktok: 2200, youtube: 5000, gbp: 1500, facebook: 63206,
};
/* ADR 0005 decision 12: X's 280 is refused at save time. The adapter refuses it
   again at publish time; neither one truncates the customer's words any more. */
export const HARD_TEXT_CAPS = { x: 280 };

/** The text one network actually receives.
 *
 *  Mirrors effectiveText() in supabase/functions/_shared/platforms.ts, and the
 *  amendment to ADR 0005 decision 3 is the whole reason it is a function rather
 *  than `post.variants?.[net] ?? post.text`: `??` catches only null and
 *  undefined, so a variant of "" or "   " would mean "publish nothing here".
 *  **Missing, empty and whitespace-only variants all inherit the base text.**
 *  A variant that is not blank is used verbatim, outer whitespace included. */
export function effectiveText(post, network){
  const variants=post?.variants;
  const variant = variants && typeof variants==="object" && !Array.isArray(variants)
    ? variants[network] : undefined;
  return (typeof variant==="string" && variant.trim()!=="") ? variant : (post?.text ?? "");
}
/** Does this post carry per-network copy worth reopening the panel for? Only a
    known network's non-blank entry counts — an imported map's junk key is not
    copy anyone can edit here, and normalizedVariants() drops it on the next
    save. */
function hasVariants(p){
  return NETWORKS.some(n => typeof p?.variants?.[n.id]==="string"
    && p.variants[n.id].trim()!=="");
}
function checkedNets(){
  return [...document.querySelectorAll("#pm_nets input:checked")].map(i=>i.value);
}
/** The variant textarea for one network, when its section is on screen. */
function variantBox(network){
  return [...document.querySelectorAll("#pm_variants textarea[data-net]")]
    .find(box => box.dataset.net===network) || null;
}
/** What is typed right now, over what this composer opened with or retained. */
function currentVariants(){
  const typed={};
  for(const box of document.querySelectorAll("#pm_variants textarea[data-net]"))
    typed[box.dataset.net]=box.value;
  return {...composerVariants, ...typed};
}
/** The map as it is stored: blanks dropped (they mean inherit), keys in one
    fixed order so the dirty-state baseline compares by value, not by history. */
function normalizedVariants(map){
  const out={};
  for(const n of NETWORKS){
    const value=map[n.id];
    if(typeof value==="string" && value.trim()!=="") out[n.id]=value;
  }
  return out;
}
/* The disclosure itself. Off unless the post already has copy to show, so a
   post without variants opens exactly as it did before (decision 11). */
function perNetworkPanel(p, locked){
  if(locked) return "";
  return `<label class="percheck"><input type="checkbox" id="pm_percustom"
      ${hasVariants(p)?"checked":""} data-change="togglePerNetwork"> Customize per network</label>
    <div class="variants" id="pm_variants"></div>`;
}
/* One native <details> per *selected* network — no tabs. Tabs would hide the
   base text, which is the one thing the customer needs in front of them to know
   what a network inherits, and they would add a roving-tabindex ARIA pattern to
   a dialog whose keyboard contract two suites already pin. */
function variantSection(id){
  const net=netOf(id);
  if(!net) return "";
  const value=composerVariants[id]||"";
  return `<details class="variant"${value.trim()?" open":""}>
    <summary tabindex="0" data-focus="focusVariant" data-arg="${attr(id)}">
      <span style="color:${net.color};font-weight:700">${esc(net.short)}</span> ${esc(net.name)}
      <span class="variant-state">${value.trim()?"custom":"inherits"}</span>
    </summary>
    <textarea id="pm_var_${attr(id)}" data-net="${attr(id)}" data-input="syncVariant" data-focus="focusVariant"
      data-arg="${attr(id)}" aria-label="${attr(net.name+" version of this post")}"
      >${esc(value)}</textarea>
    ${NETWORK_TEXT_CAPS[id]?`<div class="charcount" data-count="${attr(id)}"></div>`:""}
  </details>`;
}
/** Rebuild the sections for the currently selected networks, keeping whatever
    is already typed — including copy for a network that has just been
    deselected, which is retained but never published. */
export function renderVariantSections(){
  const host=document.getElementById("pm_variants");
  if(!host) return;
  setComposerVariants(currentVariants());
  const on=document.getElementById("pm_percustom")?.checked;
  const nets=checkedNets();
  host.innerHTML = !on ? ""
    : nets.length ? nets.map(variantSection).join("")
    : `<p class="variant-empty">Pick a network below to write a version just for it.</p>`;
  // The base counter names the strictest network still inheriting, so it has to
  // be redrawn even on the path that renders nothing.
  syncComposerCounts();
}
export function togglePerNetwork(){ renderVariantSections(); }
/** One variant textarea changed: remember it, aim the AI at it, redraw counts. */
export function syncVariant(el){
  composerVariants[el.dataset.net]=el.value;
  setComposerVariantFocus(el.dataset.net);
  syncComposer();
}
/** Any caret landing inside a per-network section aims the AI at that network,
    and a caret back in the post's own content aims it at the base text again
    (ADR 0005 decision 13). Deliberately *not* cleared by focus moving anywhere
    else: pressing the Rewrite button moves focus to the button, and clearing
    the target there would destroy the very thing the press is about. */
export function focusVariant(network){
  setComposerVariantFocus(network || null);
  syncAiAssist();
}
/* The counters. The base one answers "does what I typed fit the strictest
   network still inheriting it?", which is the question decision 12 makes
   load-bearing for X; each section's own answers it for that network's copy. */
export function syncComposerCounts(){
  const base=document.getElementById("pm_text")?.value ?? "";
  const values=currentVariants();
  for(const box of document.querySelectorAll("#pm_variants textarea[data-net]")){
    const id=box.dataset.net, section=box.closest("details");
    box.placeholder = base || "Leave this empty to use the main content";
    const state=section?.querySelector(".variant-state");
    if(state) state.textContent = box.value.trim() ? "custom" : "inherits";
    paintCount(section?.querySelector("[data-count]"), box.value.length, NETWORK_TEXT_CAPS[id]);
  }
  const meter=document.getElementById("pm_count");
  if(!meter) return;
  const inheriting=checkedNets()
    .filter(id => NETWORK_TEXT_CAPS[id] && !(values[id]||"").trim())
    .sort((a,b) => NETWORK_TEXT_CAPS[a]-NETWORK_TEXT_CAPS[b]);
  const tightest=inheriting[0];
  paintCount(meter, base.length, NETWORK_TEXT_CAPS[tightest],
    tightest ? " · " + netOf(tightest).name : "");
}
/* Amber approaching the cap, red past it. Red past a cap the composer does not
   refuse (Instagram's 2200, say) is still the truth: the provider will reject
   it. What "advisory" buys those networks is that saving is allowed anyway. */
function paintCount(el, length, cap, suffix=""){
  if(!el) return;
  if(!cap){ el.textContent=""; el.className="charcount"; return; }
  el.textContent = `${length} / ${cap}${suffix}`;
  el.className = "charcount" + (length>cap ? " over" : length>=cap*0.9 ? " near" : "");
}
/** Everything beside the content boxes that has to react while typing. */
export function syncComposer(){
  syncComposerCounts();
  syncAiAssist();
}

/* =============== Instagram carousels (ADR 0005 publishing depth) ===============

   ADR 0005 decision 14 cut carousels from v1 because they need a media *array*
   and an N-container upload flow. This is that array, and it is deliberately the
   smallest one that works: `media_url` stays the single cover every network
   publishes, and the carousel is `[media_url, ...extras]` — so a customer who
   never opens this affordance has exactly the composer, the post shape and the
   publish path they had before.

   It follows the per-network disclosure and the TikTok panel exactly: one host
   div rendered empty into the composer, filled by a function the network picker
   re-runs, and nothing at all in the DOM when Instagram is not a selected
   network. Only the extras live in composer state; item one is #pm_media, and
   keeping one copy of it is what stops the two from drifting apart.

   The one sentence the panel owes the customer is the one about the other
   networks: Facebook, LinkedIn and the rest have no carousel to publish, so they
   post the first item and nothing else. Saying it beside the control is cheaper
   than a support ticket about a Facebook post that lost four images. */

/* Instagram's own bounds, restated here because this is where the customer is
   choosing. posts_media_urls_valid states them where the data lands, and
   instagramCarouselItems() in _shared/platforms.ts states them where the
   provider is called. */
export const CAROUSEL_MAX_ITEMS = 10;
const CAROUSEL_MAX_EXTRAS = CAROUSEL_MAX_ITEMS - 1;

/** The extras a stored post reopens with: everything after item one. A post
    with no carousel, or one somehow holding a single item, has no extras. */
function storedCarouselExtras(p){
  const stored=p?.media_urls;
  return Array.isArray(stored) && stored.length > 1
    ? stored.slice(1).map(url => typeof url==="string" ? url : "") : [];
}
function instagramSelected(){ return checkedNets().includes("instagram"); }
/* Rendered empty, filled by renderCarousel() — the variants and TikTok pattern.
   Absent for a locked post: a delivered carousel has no items left to add. */
function carouselHost(locked){
  return locked ? "" : `<div class="carousel" id="pm_carousel"></div>`;
}
/** What is typed right now, over what this composer opened with or retained. */
function currentCarousel(){
  const typed=[...document.querySelectorAll("#pm_carousel input[data-carousel]")];
  if(!typed.length) return [...composerCarousel];
  const out=[...composerCarousel];
  for(const box of typed) out[Number(box.dataset.carousel)]=box.value;
  return out;
}
/** The panel, rebuilt for the currently selected networks — keeping whatever is
    already typed, including items for a composer that has just deselected
    Instagram, which are retained but never published. */
export function renderCarousel(){
  if(!document.getElementById("pm_carousel")) return;
  setComposerCarousel(currentCarousel());
  paintCarousel();
}
/* Draws the state as it stands. Split from renderCarousel() deliberately: the
   add and remove paths have *already* decided what the list is, and re-reading
   the outgoing DOM there would merge the row being removed straight back in. */
function paintCarousel(){
  const host=document.getElementById("pm_carousel");
  if(!host) return;
  if(!instagramSelected()){ host.innerHTML=""; return; }
  const extras=composerCarousel;
  const total=extras.length + 1;
  const rows=extras.map((url, index) => `<li class="carousel-item">
      <span class="carousel-index">${index + 2}</span>
      <input type="url" id="pm_carousel_${index}" data-carousel="${index}"
        data-input="syncCarouselItem" data-change="syncCarouselItem" data-arg="${index}"
        placeholder="https://…" value="${attr(url)}"
        aria-label="${attr(`Carousel item ${index + 2} image or video URL`)}">
      <div class="media-preview carousel-thumb"></div>
      <button class="btn ghost mini" data-action="removeCarouselItem" data-arg="${index}"
        aria-label="${attr(`Remove carousel item ${index + 2}`)}">Remove</button>
    </li>`).join("");
  host.innerHTML=`<section class="carousel-panel" aria-label="Instagram carousel">
    <h4>Instagram carousel</h4>
    <p class="carousel-note">Add up to ${CAROUSEL_MAX_ITEMS} images or videos and Instagram
      posts them as one swipeable carousel. <strong>Other networks post the first item
      only.</strong></p>
    ${extras.length ? `<ol class="carousel-list">
      <li class="carousel-item cover"><span class="carousel-index">1</span>
        <span class="carousel-cover-note">The image or video above</span></li>
      ${rows}</ol>` : ""}
    ${extras.length < CAROUSEL_MAX_EXTRAS
      ? `<button class="btn ghost mini" data-action="addCarouselItem">➕ Add another image/video —
          Instagram carousel</button>`
      : `<p class="carousel-note">That is all ${CAROUSEL_MAX_ITEMS} items Instagram allows.</p>`}
    ${extras.length ? `<p class="carousel-count">${total} of ${CAROUSEL_MAX_ITEMS} items</p>` : ""}
  </section>`;
  for(const box of host.querySelectorAll("input[data-carousel]")) paintCarouselThumb(box);
}
/** One row's thumbnail. Built with createElement and a safeUrl()'d src — never
    innerHTML — so a hostile URL is at worst a broken image, and a javascript:
    URL is not even that. Painted in place so typing never loses the caret. */
function paintCarouselThumb(box){
  const thumb=box.closest(".carousel-item")?.querySelector(".carousel-thumb");
  if(!thumb) return;
  thumb.replaceChildren(); thumb.classList.remove("on");
  const src=safeUrl(box.value.trim());
  if(!src) return;
  const video=VIDEO_URL.test(src);
  const media=document.createElement(video?"video":"img");
  media.src=src; media.alt=video?"Carousel video preview":"Carousel image preview";
  if(video){ media.controls=true; media.playsInline=true; media.preload="metadata"; }
  thumb.append(media); thumb.classList.add("on");
}
/** One item URL changed: remember it and repaint just that thumbnail. The panel
    is deliberately NOT rebuilt — that would drop the caret mid-URL. */
export function syncCarouselItem(el){
  const extras=[...composerCarousel];
  extras[Number(el.dataset.carousel)]=el.value;
  setComposerCarousel(extras);
  paintCarouselThumb(el);
}
export function addCarouselItem(){
  const extras=currentCarousel();
  if(extras.length >= CAROUSEL_MAX_EXTRAS)
    return toast(`Instagram carousels hold up to ${CAROUSEL_MAX_ITEMS} items`);
  setComposerCarousel([...extras, ""]);
  paintCarousel();
  renderInstagramPanel();                        // alt text is for a single image
  document.getElementById(`pm_carousel_${extras.length}`)?.focus?.();
}
export function removeCarouselItem(index){
  const extras=currentCarousel();
  const at=Number(index);
  if(!Number.isInteger(at) || at < 0 || at >= extras.length) return;
  extras.splice(at, 1);
  setComposerCarousel(extras);
  paintCarousel();
  renderInstagramPanel();                        // …and removing the last extra restores it
}
/** The array this composer would save, or null when there is no carousel.
 *  Deliberately not "whatever the panel happens to hold": a post that does not
 *  publish to Instagram has no carousel, and a post with no extras is an
 *  ordinary single-media post — storing `[media_url]` would be the same post
 *  said twice, which posts_media_urls_valid refuses outright. */
function carouselForSave(nets, mediaUrl){
  if(!nets.includes("instagram") || !mediaUrl) return null;
  const extras=currentCarousel().map(url => String(url||"").trim()).filter(Boolean);
  return extras.length ? [mediaUrl, ...extras] : null;
}
/** Why this post's carousel cannot be saved, as a sentence — or "" when it can.
 *  The composer caps the list at ten and only offers https URLs, so both of
 *  these are about a post that reached here another way: an imported backup, a
 *  duplicated post, a cached workspace. */
export function carouselBlocked(mediaUrls){
  if(!Array.isArray(mediaUrls) || !mediaUrls.length) return "";
  if(mediaUrls.length > CAROUSEL_MAX_ITEMS)
    return `Instagram carousels hold up to ${CAROUSEL_MAX_ITEMS} items — this one has ${mediaUrls.length}. Remove some.`;
  const bad=mediaUrls.findIndex(url => {
    try{ return new URL(url).protocol!=="https:"; }catch(e){ return true; }
  });
  return bad < 0 ? ""
    : `Carousel item ${bad + 1} needs a valid https:// URL`;
}

/* =============== per-post Instagram options (ADR 0005 publishing depth) =====

   Two choices Instagram gives the customer that FablePeak has so far made for
   them by omission, and neither costs a Meta permission:
   `instagram_business_content_publish` already covers both parameters.

   Where does this video appear? FablePeak forces every Instagram video to
   `media_type=REELS`, so today a Reel lands wherever Instagram's own default puts
   it. That default is the one option preselected here, and it is preselected
   precisely *because* it is today's behaviour — picking "Reel + Home feed" or
   "Reel only" for somebody would change what their existing posts do.

   What does a screen reader say about this image? Instagram writes alt text
   automatically when none is supplied. A customer describing their own picture
   will do it better, and accessibility is one of ADR 0001's release gates.

   The panel follows the carousel and the TikTok form exactly: one host div
   rendered empty into the composer, filled by a function the network picker and
   the media field re-run, and nothing at all in the DOM when Instagram is not a
   selected network. Nothing here contacts any network in any mode — the choices
   are client state until publish time — so a local or demo workspace composes
   them for real and says only that the posting itself is simulated.

   v1 scope, stated where it is felt: alt text is for a *single* image. Instagram
   takes `alt_text` per container, so a carousel would need one description per
   item; the panel says so instead of silently describing only the cover. */

/* Instagram's own alt-text ceiling, restated here because this is where the
   customer is typing. posts_instagram_options_valid states it where the data
   lands, and INSTAGRAM_ALT_TEXT_MAX in _shared/platforms.ts where Meta is called. */
export const INSTAGRAM_ALT_MAX = 1000;
/* Three answers to one question, and the third is the absence of an answer.
   "" is stored as null and sends no parameter at all, which is what every
   Instagram video published before this feature did. */
export const INSTAGRAM_SHARE_CHOICES = [
  ["", "Instagram default",
    "Whatever Instagram already does for this account. No preference is sent."],
  ["true", "Reel + Home feed", "The Reel also appears on your profile grid."],
  ["false", "Reel only", "The Reel stays on the Reels tab, off your profile grid."],
];
/** The stored options of the post being edited, keys we know only. */
function readStoredInstagramOptions(p){
  const stored=p?.instagram_options;
  if(!stored || typeof stored!=="object" || Array.isArray(stored)) return {};
  const out={};
  if(typeof stored.share_to_feed==="boolean") out.share_to_feed=stored.share_to_feed;
  if(typeof stored.alt_text==="string") out.alt_text=stored.alt_text;
  return out;
}
/* Rendered empty, filled by renderInstagramPanel() — the carousel pattern.
   Absent for a locked post: a delivered Reel has no placement left to choose.
   It sits below the media field rather than up with the per-network copy because
   both choices are *about the media*: which one is offered depends on whether
   that field holds a video or an image. */
function instagramPanelHost(locked){
  return locked ? "" : `<div class="instagram" id="pm_instagram"></div>`;
}
/** What the media field holds right now, as far as this panel cares:
    "video", "carousel" (an image with extras, which alt text does not cover in
    v1), "image", or "" when there is nothing to describe yet. */
function instagramMediaKind(){
  const url=document.getElementById("pm_media")?.value.trim() || "";
  if(!url) return "";
  if(VIDEO_URL.test(url)) return "video";
  return currentCarousel().some(item => String(item||"").trim()) ? "carousel" : "image";
}
/** The panel, rebuilt for the currently selected networks and media. */
export function renderInstagramPanel(){
  const host=document.getElementById("pm_instagram");
  if(!host) return;
  if(!instagramSelected()){ host.innerHTML=""; return; }
  const kind=instagramMediaKind();
  if(!kind){ host.innerHTML=""; return; }
  // A rebuild would drop the caret out of whichever control was in use.
  const focused=document.activeElement?.id || "";
  host.innerHTML=instagramPanelInner(kind);
  if(focused) document.getElementById(focused)?.focus?.();
  paintInstagramAltCount();
}
function instagramPanelInner(kind){
  const shell=body => `<section class="instagram-panel" aria-label="Instagram options">
    <h4>Instagram</h4>
    ${liveMode() ? "" : `<p class="instagram-note"><strong>Simulated — posting to Instagram
      needs a cloud workspace and a connected Instagram account.</strong> These controls
      behave exactly as the real ones do; nothing here contacts Instagram.</p>`}
    ${body}</section>`;
  if(kind==="video"){
    const chosen = composerInstagram.share_to_feed===null ? "" : String(composerInstagram.share_to_feed);
    return shell(`<fieldset class="instagram-where">
      <legend class="f">Where does this video appear?</legend>
      ${INSTAGRAM_SHARE_CHOICES.map(([value,label,why],index) =>
        `<label class="instagram-choice">
          <input type="radio" name="pm_ig_share" id="pm_ig_share_${index}"
            value="${attr(value)}" ${chosen===value?"checked":""}
            data-change="instagramOption" data-arg="share_to_feed">
          ${esc(label)}<small class="netreason">${esc(why)}</small></label>`).join("")}
    </fieldset>`);
  }
  if(kind==="carousel"){
    return shell(`<p class="instagram-note">Alt text describes one image. A carousel needs a
      description per item, so FablePeak does not send alt text for carousels yet — Instagram
      writes its own.</p>`);
  }
  return shell(`<label class="f" for="pm_ig_alt">Alt text <span
      style="text-transform:none;font-weight:400">— optional</span></label>
    <input type="text" id="pm_ig_alt" data-input="syncInstagramAlt" data-change="syncInstagramAlt"
      placeholder="Describe this image for people using a screen reader"
      aria-describedby="pm_ig_alt_count" value="${attr(composerInstagram.alt_text)}">
    <div class="charcount" id="pm_ig_alt_count" aria-live="polite"></div>
    <p class="instagram-note">Leave it empty and Instagram writes its own description.</p>`);
}
function paintInstagramAltCount(){
  paintCount(document.getElementById("pm_ig_alt_count"),
    composerInstagram.alt_text.length, INSTAGRAM_ALT_MAX);
}
/** The Reel placement changed. "" is the absence of a preference and is stored
    as null, never as false — false is "keep this Reel off the profile grid",
    which is a different instruction. */
export function setInstagramOption(el){
  if(el.dataset.arg!=="share_to_feed") return;
  const value=el.value;
  setComposerInstagram({...composerInstagram,
    share_to_feed: value==="" ? null : value==="true"});
  syncComposer();
}
/** Alt text changed: remember it and repaint its counter. The panel is
    deliberately NOT rebuilt — that would drop the caret mid-sentence. */
export function syncInstagramAlt(el){
  setComposerInstagram({...composerInstagram, alt_text:el.value});
  paintInstagramAltCount();
  syncComposer();
}
/** The options this composer would save, or null when there are none.
 *  Deliberately not "whatever the panel happens to hold": a post that does not
 *  publish to Instagram has no Instagram choices, a placement belongs only to a
 *  video, and alt text belongs only to a single image — so each key is written
 *  only when the question it answers was actually on screen. An object with no
 *  keys is null, because posts_instagram_options_valid refuses `{}` outright:
 *  "no options" already has a spelling and it is NULL. */
function instagramOptionsForSave(nets, mediaUrl, mediaUrls){
  if(!nets.includes("instagram") || !mediaUrl) return null;
  const out={};
  const video=VIDEO_URL.test(mediaUrl);
  if(video && composerInstagram.share_to_feed!==null)
    out.share_to_feed=composerInstagram.share_to_feed;
  const alt=String(composerInstagram.alt_text||"").trim();
  if(!video && !mediaUrls && alt) out.alt_text=alt;
  return Object.keys(out).length ? out : null;
}
/** Why this post's Instagram options cannot be saved, as a sentence — or "" when
 *  they can. Alt text is refused rather than truncated, for the reason ADR 0005
 *  decision 12 refused a truncated X post: silently losing the end of a
 *  description is worse than saying it is too long. */
export function instagramBlocked(options){
  if(!options || typeof options.alt_text!=="string") return "";
  if(options.alt_text.length > INSTAGRAM_ALT_MAX)
    return `Instagram allows ${INSTAGRAM_ALT_MAX} characters of alt text — this is ${options.alt_text.length}. Shorten it.`;
  return "";
}

/* =============== TikTok Direct Post options ===============

   TikTok's Content Posting API guidelines do not describe an API surface here;
   they describe a *form*. A Direct Post integration must show the creator who
   they are posting as, offer only the audiences their own account offers with
   none of them preselected, disable the interaction toggles their account
   disables, collect a commercial-content declaration, show a consent line next
   to the button that posts, and refuse a video longer than their account
   allows. All of that is what this section is.

   It follows the per-network disclosure above exactly: one host div rendered
   into the composer, filled by a function the network picker re-runs, and
   nothing at all in the DOM when TikTok is not a selected network — so a
   composer that never mentions TikTok has the markup it always had.

   Two rules matter more than the rest.

   Nothing is preselected. `options.privacy_level` starts as "" and the select
   opens on a prompt, because a preselected audience is a choice the customer
   did not make. validatePostForm() refuses the save rather than picking one,
   and the posts_tiktok_options_valid CHECK constraint refuses the row.

   The form is a function of the account, not of us. `creator_info` decides
   which audiences appear and which toggles are available, so the panel renders
   a loading line, then either the real form or the reason there isn't one. */

export const TIKTOK_PRIVACY_LABELS = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only you",
};
export const TIKTOK_BRANDED_POLICY_URL =
  "https://www.tiktok.com/legal/page/global/bc-policy/en";
export const TIKTOK_MUSIC_USAGE_URL =
  "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en";
/* A local or demo workspace has no TikTok connection and must reach no
   network, so the panel is rendered from this fixed stand-in and says so — the
   same shape settings.js gives the approval switch when there is no cloud
   workspace to enforce it. Every audience is offered because a simulated
   account has no real restrictions to honour. */
const SIMULATED_TIKTOK_CREATOR = Object.freeze({
  nickname: "your TikTok account",
  avatar_url: "",
  privacy_level_options: Object.freeze([
    "PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY",
  ]),
  comment_disabled: false, duet_disabled: false, stitch_disabled: false,
  max_video_post_duration_sec: 600,
});
const VIDEO_URL = /\.(mp4|mov|m4v|webm)(?:[?#]|$)/i;

/** The stored options of the post being edited, keys we know only. */
function readStoredTikTokOptions(p){
  const stored=p?.tiktok_options;
  if(!stored || typeof stored!=="object" || Array.isArray(stored)) return {};
  const out={};
  for(const key of Object.keys(COMPOSER_TIKTOK_IDLE.options)){
    if(stored[key]!==undefined) out[key]=stored[key];
  }
  return out;
}
function tiktokSelected(){ return checkedNets().includes("tiktok"); }
/* Rendered empty, filled by renderTikTokPanel() — the variants pattern. Both
   hosts are absent for a locked post: a delivered video has no options left to
   choose, and TikTok's consent line belongs beside a button that posts. */
function tiktokPanelHost(locked){
  return locked ? "" : `<div class="tiktok" id="pm_tiktok"></div>`;
}
function tiktokConsentHost(locked){
  return locked ? "" : `<div class="tiktok-consent" id="pm_tt_consent"></div>`;
}
/** Fetch the creator's account settings once per composer, lazily — only when
    TikTok is actually one of the selected networks. */
function ensureTikTokCreator(){
  if(composerTikTok.loaded || composerTikTok.loading) return;
  if(!liveMode()){
    setComposerTikTok({...composerTikTok, loaded:true, simulated:true,
      creator:SIMULATED_TIKTOK_CREATOR});
    return;
  }
  setComposerTikTok({...composerTikTok, loading:true, error:""});
  store.tiktokCreatorInfo(brand().id).then(out => {
    const creator=out?.ok ? out.creator : null;
    setComposerTikTok({...composerTikTok, loading:false, loaded:true, creator,
      error:creator ? "" : String(out?.error||"TikTok did not return your account settings."),
      // An interaction the account disables is off and stays off, in the state
      // as well as in the markup: the request body must say what the form says.
      options:{...composerTikTok.options,
        disable_comment:composerTikTok.options.disable_comment || !!creator?.comment_disabled,
        disable_duet:composerTikTok.options.disable_duet || !!creator?.duet_disabled,
        disable_stitch:composerTikTok.options.disable_stitch || !!creator?.stitch_disabled}});
  }).catch(e => {
    setComposerTikTok({...composerTikTok, loading:false, loaded:true, creator:null,
      error:String(e?.message||e).slice(0,160)});
  }).then(() => {
    // The composer may have been closed while TikTok answered; renderTikTokPanel
    // is a no-op without its host, so no answer repopulates another post's form.
    renderTikTokPanel();
  });
}
/** How long the selected video is, when the browser can tell us.
 *
 *  We only ever hold a URL, so the honest options are "ask the browser to read
 *  the metadata" or "guess". A URL that cannot be probed — CORS, a redirect, a
 *  host that refuses a range request — resolves to null and the panel says the
 *  duration is unverified, because the provider's answer at publish time is the
 *  truth and refusing a post over a length we could not measure would be a
 *  guess dressed up as a rule. */
export function probeVideoDuration(url){
  return new Promise(resolve => {
    let settled=false;
    const video=document.createElement("video");
    const finish=value => {
      if(settled) return;
      settled=true; clearTimeout(timer); video.removeAttribute("src");
      resolve(Number.isFinite(value) && value>0 ? value : null);
    };
    const timer=setTimeout(() => finish(null), 8000);
    video.preload="metadata";
    video.addEventListener("loadedmetadata", () => finish(video.duration));
    video.addEventListener("error", () => finish(null));
    try{ video.src=url; }catch(e){ finish(null); }
  });
}
function ensureTikTokDuration(){
  const url=document.getElementById("pm_media")?.value.trim() || "";
  if(composerTikTok.durationUrl===url) return;
  setComposerTikTok({...composerTikTok, durationUrl:url, duration:null});
  if(!url || !VIDEO_URL.test(url)) return;
  probeVideoDuration(url).then(duration => {
    if(composerTikTok.durationUrl!==url) return;   // the customer moved on
    setComposerTikTok({...composerTikTok, duration});
    renderTikTokPanel();
  });
}
/** The panel, rebuilt for the currently selected networks and creator info. */
export function renderTikTokPanel(){
  const host=document.getElementById("pm_tiktok");
  const consent=document.getElementById("pm_tt_consent");
  if(!host) return;
  if(!tiktokSelected()){
    host.innerHTML=""; if(consent) consent.innerHTML="";
    return;
  }
  ensureTikTokCreator();
  ensureTikTokDuration();
  // A change handler rebuilds this panel, which would drop the caret; put it
  // back on the control the customer was using.
  const focused=document.activeElement?.id || "";
  host.innerHTML=tiktokPanelInner();
  if(consent) consent.innerHTML=tiktokConsentInner();
  if(focused) document.getElementById(focused)?.focus?.();
}
function tiktokPanelInner(){
  const {loading, error, creator, simulated, duration, options}=composerTikTok;
  const head=`<h4>TikTok</h4>`;
  const shell=body => `<section class="tiktok-panel" aria-label="TikTok posting options">
    ${head}${body}</section>`;
  if(loading) return shell(`<p class="tiktok-note">Reading your TikTok account settings…</p>`);
  if(!creator) return shell(`<p class="tiktok-note">${esc(error ||
    "TikTok did not return your account settings, so this post cannot be composed for TikTok yet.")}</p>`);

  const maximum=creator.max_video_post_duration_sec;
  const tooLong=maximum && duration && duration>maximum;
  const privacy=`<label class="f" for="pm_tt_privacy">Who can see this video</label>
    <select class="inp" id="pm_tt_privacy" data-change="tiktokOption" data-arg="privacy_level">
      <option value=""${options.privacy_level?"":" selected"}>Choose who can see this video…</option>
      ${creator.privacy_level_options.map(level => {
        // TikTok does not allow branded content to be private, so the option is
        // withdrawn rather than left to fail at publish time.
        const barred=level==="SELF_ONLY" && options.brand_content;
        return `<option value="${attr(level)}"${options.privacy_level===level?" selected":""}
          ${barred?"disabled":""}>${esc(TIKTOK_PRIVACY_LABELS[level]||level)}</option>`;
      }).join("")}
    </select>`;
  const toggle=(id, arg, label, off, why) =>
    `<label class="tiktok-toggle${off?" off":""}" ${off?`title="${attr(why)}"`:""}>
      <input type="checkbox" id="${attr(id)}" data-change="tiktokOption" data-arg="${attr(arg)}"
        ${off?"disabled":""} ${!off && !options[arg==="allow_comment"?"disable_comment"
          :arg==="allow_duet"?"disable_duet":"disable_stitch"]?"checked":""}>
      ${esc(label)}${off?`<small class="netreason">${esc(why)}</small>`:""}</label>`;
  const interactions=`<div class="tiktok-toggles">
    ${toggle("pm_tt_comment","allow_comment","Allow comments",
      creator.comment_disabled,"This account has comments turned off")}
    ${toggle("pm_tt_duet","allow_duet","Allow duet",
      creator.duet_disabled,"This account has duets turned off")}
    ${toggle("pm_tt_stitch","allow_stitch","Allow stitch",
      creator.stitch_disabled,"This account has stitches turned off")}
  </div>`;
  const disclosure=`<label class="percheck"><input type="checkbox" id="pm_tt_disclose"
      ${options.disclose_commercial?"checked":""} data-change="tiktokOption"
      data-arg="disclose_commercial"> Disclose video content</label>
    ${options.disclose_commercial ? `<div class="tiktok-brands" id="pm_tt_brands">
      <p class="tiktok-note">Tell viewers what this video promotes. Pick at least one.</p>
      <label class="tiktok-toggle"><input type="checkbox" id="pm_tt_brand_organic"
        ${options.brand_organic?"checked":""} data-change="tiktokOption"
        data-arg="brand_organic"> Your brand
        <small class="netreason">You are promoting yourself or your own business.</small></label>
      <label class="tiktok-toggle"><input type="checkbox" id="pm_tt_brand_content"
        ${options.brand_content?"checked":""} data-change="tiktokOption"
        data-arg="brand_content"> Branded content
        <small class="netreason">A paid partnership with another brand. TikTok does not
          allow branded content to be private.</small></label>
    </div>` : ""}`;
  const durationNote=!maximum ? ""
    : tooLong
      ? `<p class="tiktok-note over">This video is ${Math.round(duration)} seconds.
          ${esc(creator.nickname)} can post up to ${maximum} seconds.</p>`
      : duration
        ? `<p class="tiktok-note">${Math.round(duration)} of ${maximum} seconds allowed.</p>`
        : `<p class="tiktok-note">Videos up to ${maximum} seconds. This one's length could not be
            checked here, so TikTok's own answer at publish time is the final word.</p>`;

  return shell(`
    ${simulated ? `<p class="tiktok-note"><strong>Simulated — posting to TikTok needs a cloud
      workspace and a connected TikTok account.</strong> These controls behave exactly as the
      real ones do; nothing here contacts TikTok.</p>` : ""}
    <p class="tiktok-creator">Posting to <strong>${esc(creator.nickname)}</strong></p>
    ${privacy}
    ${interactions}
    ${disclosure}
    ${durationNote}`);
}
/** The consent line, beside the button that posts. Its wording is TikTok's and
    changes with the declaration: branded content adds the Branded Content
    Policy to the Music Usage Confirmation every post carries. */
function tiktokConsentInner(){
  if(!composerTikTok.creator) return "";
  const music=`<a href="${TIKTOK_MUSIC_USAGE_URL}" target="_blank" rel="noopener">Music Usage Confirmation</a>`;
  return composerTikTok.options.brand_content
    ? `<p>By posting, you agree to TikTok's
       <a href="${TIKTOK_BRANDED_POLICY_URL}" target="_blank" rel="noopener">Branded Content Policy</a>
       and ${music}.</p>`
    : `<p>By posting, you agree to TikTok's ${music}.</p>`;
}
/** One control changed. Everything the guidelines make conditional is applied
    here rather than left to the markup, so the state the post is saved from and
    the form on screen can never disagree. */
export function setTikTokOption(el){
  const key=el.dataset.arg;
  const options={...composerTikTok.options};
  let message="";
  if(key==="privacy_level") options.privacy_level=el.value;
  else if(key==="allow_comment") options.disable_comment=!el.checked;
  else if(key==="allow_duet") options.disable_duet=!el.checked;
  else if(key==="allow_stitch") options.disable_stitch=!el.checked;
  else if(key==="disclose_commercial"){
    options.disclose_commercial=el.checked;
    // Turning the declaration off retracts both claims with it: leaving
    // "branded content" set on an undisclosed post would send TikTok a
    // partnership flag the customer just said was not there.
    if(!el.checked){ options.brand_organic=false; options.brand_content=false; }
  }
  else if(key==="brand_organic") options.brand_organic=el.checked;
  else if(key==="brand_content"){
    options.brand_content=el.checked;
    if(el.checked && options.privacy_level==="SELF_ONLY"){
      options.privacy_level="";
      message="TikTok doesn't allow branded content to be private — choose who can see it.";
    }
  }
  else return;
  setComposerTikTok({...composerTikTok, options});
  renderTikTokPanel();
  syncComposer();
  if(message) toast(message);
}
/** The options this composer would save, or null when TikTok is not a target.
 *  Deliberately not "whatever the panel happens to hold": a post that does not
 *  publish to TikTok has no TikTok choices, and writing them would be a claim
 *  about an audience nobody picked for it. */
function tiktokOptionsForSave(nets){
  if(!nets.includes("tiktok")) return null;
  return {...composerTikTok.options};
}
/** Why this post cannot go to TikTok yet, as a sentence — or "" when it can. */
export function tiktokBlocked(nets, options){
  if(!nets.includes("tiktok")) return "";
  if(!options || !TIKTOK_PRIVACY_LABELS[options.privacy_level])
    return "Choose who can see this video on TikTok";
  if(options.disclose_commercial && !options.brand_organic && !options.brand_content)
    return "Say what this video promotes — your brand, branded content, or both";
  if(options.brand_content && options.privacy_level==="SELF_ONLY")
    return "TikTok doesn't allow branded content to be private — choose a different audience";
  const maximum=composerTikTok.creator?.max_video_post_duration_sec;
  const duration=composerTikTok.duration;
  if(maximum && duration && duration>maximum)
    return `TikTok allows ${maximum} seconds — this video is ${Math.round(duration)}. Trim it.`;
  return "";
}

/* =============== AI assist (cloud + signed in only) =============== */
/* The composer's writing help, backed by supabase/functions/ai-assist. Two
   rules shape everything below.

   The model's answer is *data*: every suggestion reaches the DOM through esc(),
   exactly like a customer's own post text, because it is a string the server
   was talked into producing and nothing more.

   A failure is reported with the Edge Function's own message. That function
   deliberately never forwards the provider's response body, so the browser has
   a clean sentence to show for every status, and the only thing it adds is how
   long a rate limit has left to run. */
const AI_ACTIONS = [
  ["caption",  "Suggest captions"],
  ["hashtags", "Hashtags"],
  ["rewrite",  "Rewrite for network"],
];
const AI_RESULT_LABEL = {
  caption:  "Tap a caption to use it",
  hashtags: "Tap a hashtag to add it",
  rewrite:  "Tap a rewrite to use it",
};
/* Mirrors NETWORK_CONVENTIONS in the Edge Function. Asking it to rewrite for a
   network it has no house style for is a 400, so the button says so instead. */
const AI_NETWORKS = ["x","linkedin","instagram","facebook","pinterest","youtube","tiktok"];
const AI_MAX_INPUT = 4000;                     // MAX_INPUT_CHARS, server-side

/** The box the assist reads from and writes into: the per-network section the
    caret is in, when there is one, or the post's own content (decision 13). */
function aiBox(){
  return (composerVariantFocus && variantBox(composerVariantFocus))
    || document.getElementById("pm_text");
}
function aiText(){
  // A blank variant inherits, so the base text is what the model works from.
  return aiBox()?.value.trim()
    || document.getElementById("pm_text")?.value.trim() || "";
}
function aiCheckedNets(){
  return [...document.querySelectorAll("#pm_nets input:checked")].map(i=>i.value);
}
/** The one network to write for, when the composer names exactly one we support. */
function aiNetwork(){
  const nets=aiCheckedNets();
  return nets.length===1 && AI_NETWORKS.includes(nets[0]) ? nets[0] : null;
}
/** The per-network section the caret is in, when that section is on screen. */
function focusedVariantNetwork(){
  return (composerVariantFocus && variantBox(composerVariantFocus))
    ? composerVariantFocus : null;
}
/** Which network the assist writes for (ADR 0005 decision 13).
 *
 *  The focused per-network section wins, however many networks are selected —
 *  that is the retarget, and it is what retires "Select exactly one network"
 *  as rewrite's most-hit blocker. A focused section whose network the Edge
 *  Function has no house style for resolves to nothing rather than quietly
 *  falling back: the customer is plainly working on *that* network.
 *
 *  With no section focused the subject is the base text, and base text has no
 *  network of its own — so the original rule still governs it: exactly one
 *  selected network, and one the assist knows a house style for. */
function aiTargetNetwork(){
  const focused=focusedVariantNetwork();
  if(focused) return AI_NETWORKS.includes(focused) ? focused : null;
  return aiNetwork();
}
/** Why this button cannot run yet — shown as its title — or "" when it can. */
export function aiAssistBlocked(action){
  const text=aiText();
  if(!text) return action==="caption"
    ? "Type the topic you want captions about in Content first"
    : "Write some content first";
  if(text.length>AI_MAX_INPUT)
    return `AI assist reads up to ${AI_MAX_INPUT} characters — this is ${text.length}`;
  if(action==="rewrite" && !aiTargetNetwork())
    return focusedVariantNetwork() || aiCheckedNets().length===1
      ? "AI assist has no house style for that network yet"
      : "Select exactly one network to rewrite for";
  return "";
}
function aiAssistInner(){
  const buttons=AI_ACTIONS.map(([action,label])=>{
    const blocked=aiAssistBlocked(action);
    return `<button type="button" class="btn ghost mini" data-action="runAiAssist"
      data-arg="${attr(action)}"${aiAssist.busy||blocked?" disabled":""}${blocked?` title="${attr(blocked)}"`:""}
      >${aiAssist.busy===action?"Thinking…":esc(label)}</button>`;
  }).join("");
  const items=aiAssist.items||[];
  return `<div class="ai-row"><span class="ai-label">✨ AI assist</span>${buttons}</div>
    ${items.length?`<div class="ai-out">
      <div class="ai-outhead"><span>${esc(AI_RESULT_LABEL[aiAssist.action]||"Suggestions")}</span>
        <button type="button" class="btn ghost mini" data-action="clearAiAssist"
          aria-label="Dismiss AI suggestions">✕</button></div>
      ${items.map((s,i)=>`<button type="button" class="ai-sugg" data-action="useAiSuggestion"
        data-arg="${attr(i)}">${esc(s)}</button>`).join("")}
      <div class="ai-note">${aiAssist.truncated?"The last suggestion may be cut short. ":""}Written by AI — read it before you post.</div>
    </div>`:""}`;
}
/** The row itself. Cloud + signed in only: local and demo mode show nothing at
    all rather than a teaser for something they cannot do. */
export function aiAssistPanel(locked){
  if(!liveMode() || locked) return "";
  return `<section class="ai-assist" id="pm_ai" aria-label="AI assist">${aiAssistInner()}</section>`;
}
export function paintAiAssist(){
  const panel=document.getElementById("pm_ai");
  if(panel) panel.innerHTML=aiAssistInner();
}
/* Which buttons can run depends on the textarea and the network picker, and
   neither of those re-renders the composer as it changes — so every edit
   re-asks aiAssistBlocked() instead of rebuilding the panel under the cursor. */
export function syncAiAssist(){
  for(const button of document.querySelectorAll("#pm_ai button[data-action='runAiAssist']")){
    const blocked=aiAssistBlocked(button.dataset.arg);
    button.disabled=!!(aiAssist.busy||blocked);
    if(blocked) button.title=blocked; else button.removeAttribute("title");
  }
}
export async function runAiAssist(action){
  if(aiAssist.busy) return;                    // one request at a time
  const blocked=aiAssistBlocked(action);
  if(blocked) return toast(blocked);
  const request = action==="caption" ? {action, topic:aiText()} : {action, text:aiText()};
  const network=aiTargetNetwork();
  if(network) request.network=network;
  setAiAssist({...aiAssist, busy:action});
  paintAiAssist();
  try{
    const out=await store.aiAssist(brand().id, request);
    // Modal open/close resets state to idle; a response for a composer that
    // no longer exists must not repopulate the fresh one.
    if(aiAssist.busy!==action) return;
    const items=(out?.suggestions||[]).map(s=>String(s).trim()).filter(Boolean);
    setAiAssist({busy:null, action, items, truncated:!!out?.truncated});
    if(!items.length) toast("AI assist returned nothing usable. Try again.");
  }catch(e){
    if(aiAssist.busy!==action) return;
    setAiAssist({...aiAssist, busy:null});
    toast(aiAssistMessage(e));
  }
  paintAiAssist();
}
/** The Edge Function's message, plus the wait when we were rate limited. */
export function aiAssistMessage(error){
  const message=String(error?.message||"").trim() || "AI assist failed — try again shortly.";
  const seconds=Number(error?.retryAfterSeconds);
  if(Number(error?.status)!==429 || !Number.isFinite(seconds) || seconds<=0) return message;
  const minutes=Math.max(1,Math.round(seconds/60));
  return `${message.replace(/\s*Try again later\.?$/,"")} `
    + `Try again in about ${minutes} minute${minutes===1?"":"s"}.`;
}
/* A suggestion is an ordinary edit: the unsaved-changes baseline is left
   exactly as openPostModal armed it, so a composer whose text came from the
   model still asks before it is discarded. */
export function useAiSuggestion(index){
  const box=aiBox();
  const suggestion=(aiAssist.items||[])[Number(index)];
  if(!box || box.disabled || suggestion===undefined) return;
  const network=box.dataset.net || "";
  // Appending to a blank variant would replace what it inherits with one
  // hashtag. Append to the text it actually stands for instead.
  const existing = network && !box.value.trim()
    ? (document.getElementById("pm_text")?.value || "") : box.value;
  box.value = aiAssist.action==="hashtags"
    ? appendHashtag(existing, suggestion) : suggestion;
  if(network) composerVariants[network]=box.value;
  syncComposer();
  toast(aiAssist.action==="hashtags" ? "Hashtag added"
    : network ? `${netOf(network).name} version replaced` : "Content replaced");
}
function appendHashtag(text, tag){
  const clean=String(tag).trim(), body=String(text).replace(/\s+$/,"");
  if(!clean || body.split(/\s+/).includes(clean)) return text;
  return body ? `${body} ${clean}` : clean;
}
export function clearAiAssist(){ setAiAssist(AI_ASSIST_IDLE); paintAiAssist(); }

/* =============== hashtag groups (ADR 0005 publishing depth) ===============

   The saved counterpart to the AI "Hashtags" button it sits beside: that one
   asks a model for tags about this post, this one drops in a set the customer
   already decided on. Unlike the AI row it is *not* gated on live mode — a group
   is local data and needs no backend at all — so a demo or a local deployment
   gets the whole feature.

   A native <details>, exactly like the per-network sections: the modal's focus
   trap already understands a collapsed one, and it renders nothing at all when
   the brand has no groups, so a composer that has never met this feature has the
   DOM it always had. The list is static for the life of the composer, because
   groups are created in Settings and nothing in the modal can change them.

   Insertion always targets #pm_text, never a per-network variant. A hashtag
   block is something the post carries everywhere; a customer who wants it on one
   network only can move it into that section themselves, and the alternative —
   silently writing into whichever box the caret last touched — is a surprise. */

/** The first few tags of a group, as a hint beside its name. */
function tagPreview(tags){
  const shown=tags.slice(0, 3).join(" ");
  return tags.length > 3 ? `${shown} +${tags.length - 3} more` : shown;
}
function hashtagGroupsPanel(locked){
  if(locked) return "";
  const groups=groupsOf(brand());
  if(!groups.length) return "";
  return `<details class="hgroups" id="pm_hgroups">
    <summary tabindex="0"># Hashtag groups</summary>
    <div class="hgroup-list">
      ${groups.map(g=>`<button type="button" class="hgroup-pick"
        data-action="insertHashtagGroup" data-arg="${attr(g.id)}">
        <span class="hgroup-name">${esc(g.name)}</span>
        <span class="hgroup-preview">${esc(tagPreview(g.tags))}</span>
      </button>`).join("")}
    </div>
    <div class="hgroup-note">Manage these in Settings → Hashtag groups.</div>
  </details>`;
}
/* An ordinary edit, like a suggestion from the AI row: the unsaved-changes
   baseline is left as openPostModal armed it, so a post whose tags came from a
   group still asks before it is discarded. */
export function insertHashtagGroup(id){
  const group=groupsOf(brand()).find(g=>g.id===id);
  const box=document.getElementById("pm_text");
  if(!group || !box || box.disabled) return;
  const { text, added }=appendTags(box.value, group.tags);
  if(!added.length)
    return toast(`Every hashtag in “${group.name}” is already in this post`);
  box.value=text;
  syncComposer();                              // counters, and the AI row's gates
  toast(added.length===group.tags.length
    ? `Added ${added.length} hashtag${added.length===1?"":"s"} from “${group.name}”`
    : `Added ${added.length} of ${group.tags.length} — the rest were already there`);
}
export function readPostForm(){
  const text=document.getElementById("pm_text").value.trim();
  const nets=[...document.querySelectorAll("#pm_nets input:checked")].map(i=>i.value);
  const date=document.getElementById("pm_date").value, time=document.getElementById("pm_time").value;
  const status=document.getElementById("pm_status").value;
  const media_url=document.getElementById("pm_media").value.trim();
  // Variants are part of the form, so composerSnapshot() sees an edit to one
  // and the Escape guard asks before discarding it (ADR 0005 dirty-state note).
  const variants=normalizedVariants(currentVariants());
  /* The approval note is part of the form only when the panel offered one — an
     absent key leaves the post's own note alone, where a key holding "" would
     erase somebody else's feedback on every unrelated save. */
  const noteBox=document.getElementById("pm_approval_note");
  /* TikTok's choices are part of the form too, so an edit to one is an unsaved
     change the Escape guard defends — and, unlike the approval note, the key is
     always present: null is the meaningful value for a post that does not
     target TikTok, and writing it is how deselecting TikTok clears them. */
  const tiktok_options=tiktokOptionsForSave(nets);
  /* The Instagram carousel, on the same terms as TikTok's choices: always
     present, because null is the meaningful value for a post with no carousel,
     and writing it is how deselecting Instagram — or removing the last extra —
     clears one. */
  const media_urls=carouselForSave(nets, media_url);
  /* The per-post Instagram choices, on the same terms again: always present,
     because null is the meaningful value for a post that records none, and
     writing it is how deselecting Instagram — or swapping a video for an image —
     clears the choices that no longer apply. */
  const instagram_options=instagramOptionsForSave(nets, media_url, media_urls);
  return {text,nets,date,time,status,media_url,media_urls,variants,tiktok_options,
    instagram_options,
    ...(noteBox ? {approval_note:noteBox.value.trim()} : {})};
}
export function showMediaPreview(url,contentType=""){
  const box=document.getElementById("pm_media_preview");
  if(!box) return;
  box.replaceChildren(); box.classList.remove("on");
  if(!url) return;
  const video=contentType.startsWith("video/") || /\.(mp4|mov|m4v|webm)(?:[?#]|$)/i.test(url);
  const media=document.createElement(video?"video":"img");
  media.src=url; media.alt=video?"Selected video preview":"Selected image preview";
  if(video){ media.controls=true; media.playsInline=true; media.preload="metadata"; }
  box.append(media); box.classList.add("on");
}
export async function compatiblePhoneMedia(file,status){
  const ext=(file.name||"").split(".").pop().toLowerCase();
  if(!["heic","heif"].includes(ext) && !/image\/hei[cf]/i.test(file.type||"")) return file;
  status.textContent="Preparing iPhone photo…";
  const localUrl=URL.createObjectURL(file);
  try{
    const image=new Image(); image.src=localUrl;
    await image.decode();
    const scale=Math.min(1,4096/Math.max(image.naturalWidth,image.naturalHeight));
    const canvas=document.createElement("canvas");
    canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));
    canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
    const context=canvas.getContext("2d");
    if(!context) throw new Error("This browser cannot prepare HEIC photos.");
    context.drawImage(image,0,0,canvas.width,canvas.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",.9));
    if(!blob) throw new Error("This HEIC photo could not be converted.");
    return new File([blob],(file.name||"photo").replace(/\.hei[cf]$/i,"")+".jpg",{
      type:"image/jpeg",lastModified:file.lastModified,
    });
  }finally{ URL.revokeObjectURL(localUrl); }
}
export async function uploadPostMedia(input){
  let file=input.files?.[0]; const status=document.getElementById("pm_upload_status");
  if(!file) return;
  if(mediaUploadActive){ status.textContent="Another upload is already in progress."; input.value=""; return; }
  const previewUrl=URL.createObjectURL(file); showMediaPreview(previewUrl,file.type);
  try{
    file=await compatiblePhoneMedia(file,status);
    const contentType=mediaContentType(file);
    if(!contentType) throw new Error("Choose JPEG, PNG, WebP, GIF, MP4, MOV or WebM media.");
    if(file.size>50*1024*1024) throw new Error("This file is over 50 MB. Trim the video or record at a lower quality, then try again.");
    setMediaUploadActive(true);
    document.querySelectorAll('.upload-actions input[type="file"]').forEach(el=>el.disabled=true);
    status.textContent=`Uploading ${file.name} (${fileSizeLabel(file.size)}) · 0%`;
    const url=await store.uploadMedia(file,brand().id,percent=>{
      if(status.isConnected) status.textContent=`Uploading ${file.name} (${fileSizeLabel(file.size)}) · ${percent}%`;
    });
    document.getElementById("pm_media").value=url;
    showMediaPreview(url,contentType);
    status.textContent="Upload complete ✔";
  }catch(e){ status.textContent="Upload failed: "+String(e.message||e).slice(0,120); }
  finally{
    setMediaUploadActive(false);
    URL.revokeObjectURL(previewUrl);
    document.querySelectorAll('.upload-actions input[type="file"]').forEach(el=>el.disabled=false);
    input.value="";
  }
}
export function validatePostForm({text,nets,date,time,media_url,media_urls=null,
                                  variants={},tiktok_options=null,
                                  instagram_options=null}){
  if(!text) return toast("Write some content first");
  if(!nets.length) return toast("Pick at least one network");
  if(!date || !time) return toast("Choose a date and time");
  /* ADR 0005 decision 12. Every selected network is checked against the text it
     will actually receive, so a blank variant is validated as the base text it
     inherits rather than as "publish nothing". Only a hard cap refuses the
     save: X's 280 used to be a silent `text.slice(0, 280)` in the adapter, and
     losing the end of a customer's sentence without telling them is worse than
     refusing to save it. */
  for(const id of nets){
    const cap=HARD_TEXT_CAPS[id];
    if(!cap) continue;
    const length=effectiveText({text,variants}, id).length;
    if(length<=cap) continue;
    const name=netOf(id).name;
    return toast((variants[id]||"").trim()
      ? `${name} allows ${cap} characters — that version is ${length}. Shorten it.`
      : `${name} allows ${cap} characters — this post is ${length}. Shorten it, or give ${name} its own shorter version.`);
  }
  if(media_url){
    try{ const u=new URL(media_url); if(u.protocol!=="https:") throw 0; }
    catch(e){ return toast("Media must use a valid https:// URL"); }
  }
  // platforms that physically cannot post without media
  const needsMedia = nets.filter(n => ["instagram","pinterest","tiktok","youtube"].includes(n));
  if(needsMedia.length && !media_url)
    return toast(needsMedia.map(n=>netOf(n).name).join(" and ") + " need an image/video URL");
  const linkedInVideo = media_url && nets.includes("linkedin") &&
    /\.(mp4|mov|m4v|webm)(?:[?#]|$)/i.test(media_url);
  if(linkedInVideo)
    return toast("LinkedIn currently supports image attachments only — remove the video or LinkedIn");
  const pinterestVideo = media_url && nets.includes("pinterest") &&
    /\.(mp4|mov|m4v|webm)(?:[?#]|$)/i.test(media_url);
  if(pinterestVideo)
    return toast("Pinterest video Pins are not supported yet — choose an image or remove Pinterest");
  if(nets.includes("youtube") && /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(new URL(media_url).hostname))
    return toast("YouTube needs a direct video file URL, not a YouTube watch link");
  /* TikTok's guidelines, refused here rather than defaulted: an audience nobody
     chose, an undeclared declaration, private branded content, or a video the
     creator's account is not allowed to post. The adapter refuses the first
     three again at publish time and the CHECK constraint refuses the row, so
     this is the sentence the customer gets rather than the only line of
     defence. */
  const tiktokProblem=tiktokBlocked(nets, tiktok_options);
  if(tiktokProblem) return toast(tiktokProblem);
  /* The carousel's own two rules, refused here rather than trimmed: an item
     Instagram could not fetch, and an eleventh item. posts_media_urls_valid
     refuses the row and instagramCarouselItems() refuses the publish, so this is
     the sentence the customer gets rather than the only line of defence. */
  const carouselProblem=carouselBlocked(media_urls);
  if(carouselProblem) return toast(carouselProblem);
  /* Alt text's one rule, refused here rather than truncated.
     posts_instagram_options_valid refuses the row and readInstagramOptions()
     drops an over-length description at publish time, so this is the sentence the
     customer gets rather than the only line of defence. */
  const instagramProblem=instagramBlocked(instagram_options);
  if(instagramProblem) return toast(instagramProblem);
  return true;
}
export function savePost(id){
  if(mediaUploadActive) return toast("Wait for the media upload to finish");
  const values=readPostForm();
  if(!validatePostForm(values)) return;
  const {nets,...postValues}=values;
  const b=brand();
  const previous=id ? b.posts.find(x=>x.id===id)?.status : null;
  /* ADR 0006 decision 11: an owner sending a post back to its author owes them
     a note, and the trigger raises 23514 without one. Refuse here so the
     refusal arrives as a sentence in the composer that still holds the words,
     rather than as a failed sync two seconds later. */
  if(approvalRequired() && isOwner() && previous==="pending_approval"
     && postValues.status==="draft" && !String(postValues.approval_note||"").trim())
    return toast("Add a note saying what needs changing before sending it back");
  if(id){
    const p=b.posts.find(x=>x.id===id);
    if(liveMode() && ["publishing","published"].includes(p.status))
      return toast("Published posts are read-only — duplicate this post instead");
    Object.assign(p,{...postValues,networks:nets});
    // A fresh submission carries no decision — the same line the trigger runs.
    if(p.status==="pending_approval" && previous!=="pending_approval") p.approval_note="";
  } else {
    b.posts.push({id:uid(),...postValues,networks:nets});
  }
  save(); closeModal(); render();
  toast(values.status==="pending_approval" && previous!=="pending_approval" ? "Submitted for approval ✔"
    :id?"Post updated"
    :values.status==="draft"?"Draft saved":"Post scheduled ✔");
}
export async function publishNow(id){
  if(mediaUploadActive) return toast("Wait for the media upload to finish");
  const p = brand().posts.find(x=>x.id===id);
  const values=readPostForm();
  if(!validatePostForm(values)) return;
  if(!confirm(`Publish to ${values.nets.map(n=>netOf(n).name).join(", ")} right now? This posts to the real accounts.`)) return;
  toast("Publishing…");
  try{
    const {nets,...postValues}=values;
    Object.assign(p,{...postValues,networks:nets});
    await persistNow();
    const results = await store.publishNow(id);
    const ok = results.filter(r=>r.status==="published");
    const bad = results.filter(r=>r.status!=="published");
    const failures = bad.map(r=>
      `${netOf(r.platform).name}: ${r.error||r.status}`
    ).join(" | ");
    p.status = postStatusFromResults(results);
    await refreshPostTargets();
    save(); closeModal(); render();
    toast(ok.length
      ? `Published to ${ok.map(r=>netOf(r.platform).name).join(", ")}${failures?` · Failed — ${failures}`:""}`.slice(0,240)
      : `Failed: ${failures}`.slice(0,240));
    if(bad.length) console.warn("FablePeak publish issues:", bad);
  }catch(e){ toast(e.message); }
}
export async function refreshPostTargets(){
  if(!liveMode()) return [];
  const b=brand(), rows=await store.listTargets(b.id);
  b.posts.forEach(post=>{ post.targets=rows.filter(target=>target.post_id===post.id); });
  return rows;
}
export async function retryPost(id){
  if(!confirm("Retry only failed deliveries that are safe to send again? Published and ambiguous targets will not be repeated.")) return;
  toast("Retrying failed deliveries…");
  try{
    const results=await store.retryPost(id);
    const p=brand().posts.find(post=>post.id===id);
    if(p){
      p.status=postStatusFromResults(results);
    }
    await refreshPostTargets();
    save(); closeModal(); render();
    toast("Delivery retry completed — review the per-network results");
  }catch(e){ toast(e.message); }
}
export function deletePost(id){
  const b=brand(), p=b.posts.find(p=>p.id===id);
  if(!p) return;
  if(p.status==="publishing") return toast("Wait for publishing to finish before removing this post");
  const warning = liveMode() && p.status==="published"
    ? "Remove this post from FablePeak? The published post will remain on YouTube or the other social platform."
    : "Delete this post?";
  if(!confirm(warning)) return;
  b.posts=b.posts.filter(p=>p.id!==id); save(); closeModal(); render(); toast("Post removed");
}
/* A duplicate is a new post, so it starts with no decision on it: carrying the
   original's rejection note across would show the copy's author feedback about
   words nobody has written yet (ADR 0006 decision 11). */
export function dupPost(id){ const b=brand(); const p=b.posts.find(x=>x.id===id);
  b.posts.push({...p,id:uid(),status:"draft",approval_note:""});
  save(); closeModal(); render(); toast("Duplicated as draft"); }
