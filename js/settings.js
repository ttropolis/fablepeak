/* =============== SETTINGS =============== */
import { LS_KEY, OWNER_ONLY_TITLE } from "./constants.js";
import { attr, esc, slColorOf } from "./escape.js";
import { todayStr, uid } from "./util.js";
import {
  db, deferredInstallPrompt, editingHashtagGroup, setDb, setDeferredInstallPrompt,
  setEditingHashtagGroup,
} from "./state.js";
import {
  GROUP_NAME_MAX, describeGroupProblem, groupsOf, parseTags, validHashtagGroup,
} from "./hashtags.js";
import { liveMode, store } from "./store.js";
import { approvalRequired, brand, defaultBrand, isOwner, save, seedDemo } from "./workspace.js";
import { renderTeamCard } from "./team.js";
import { render, toast } from "./shell.js";

export function installedApp(){
  return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone===true;
}
export async function installPhoneApp(){
  if(!deferredInstallPrompt) return toast("Use your browser menu and choose Add to Home Screen");
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  setDeferredInstallPrompt(null);
  render();
}
function mobileInstallCard(){
  const ios=/iPad|iPhone|iPod/.test(navigator.userAgent);
  if(installedApp()) return `<p style="color:#3d9b63;font-size:13px">Installed ✔ Open FablePeak from your Home Screen for the app experience.</p>`;
  if(deferredInstallPrompt) return `<p style="color:var(--muted);font-size:13px;margin-bottom:12px">Install FablePeak for a full-screen app that opens directly to your workspace.</p>
    <button class="btn" data-action="installPhoneApp">📲 Install FablePeak</button>`;
  return `<p style="color:var(--muted);font-size:13px;line-height:1.6">
    ${ios ? `On iPhone or iPad, open FablePeak in <strong>Safari</strong>, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.`
      : `On Android, open the browser menu and choose <strong>Install app</strong> or <strong>Add to Home Screen</strong>.`}
    You can choose media from Photos/Gallery or use the camera inside New post.</p>`;
}
export function renderSettings(m){
  /* Deleting a brand is owner-only (ADR 0006): the brands_delete policy is
     is_owner(id), so an editor's delete would match no row and silently do
     nothing. Disable rather than hide, and say why. */
  const owner=isOwner();
  m.innerHTML=`
  <h1>Settings</h1>
  <div class="sub">Manage brands, cloud sync, and backups.</div>
  <div class="row">
    <div class="card" style="flex:1;min-width:280px">
      <h4 style="margin-bottom:10px">Brands</h4>
      ${db.brands.map(b=>`
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <input type="text" value="${attr(b.name)}" data-change="renameBrand" data-arg="${attr(b.id)}">
          <button class="btn dangerb mini" ${db.brands.length<2||!owner?"disabled":""}
            ${owner?"":`title="${attr(OWNER_ONLY_TITLE)}"`}
            data-action="deleteBrand" data-arg="${attr(b.id)}">✕</button>
        </div>`).join("")}
      ${owner?"":`<div style="color:var(--muted);font-size:12px;margin-top:4px">
        You're an editor in this workspace. Only its owners can delete a brand.</div>`}
      <div style="display:flex;gap:8px;margin-top:10px">
        <input type="text" id="newBrand" placeholder="New brand name">
        <button class="btn mini" data-action="addBrand">Add</button>
      </div>
      ${approvalCard(owner)}
    </div>
    ${hashtagGroupsCard()}
    <div class="card" style="flex:1;min-width:280px">
      <h4 style="margin-bottom:10px">Cloud sync &amp; team accounts</h4>
      <p style="color:var(--muted);font-size:13px;margin-bottom:10px">
        Mode: <strong>${store.name!=="cloud" ? "💻 Local (this browser only)"
          : store.user ? "☁️ Cloud · synced" : "👀 Demo (sample data, this device only)"}</strong>
        ${store.user ? " · signed in as "+esc(store.user.email) : ""}</p>
      ${store.name==="cloud" ? (store.user
        ? `<button class="btn ghost" data-action="cloudSignOut">Sign out</button>
           <h4 style="margin:14px 0 8px">Change password</h4>
           <label class="f" for="cp_cur">Current password</label>
           <div class="pwwrap">
             <input type="password" id="cp_cur" autocomplete="current-password">
             <button type="button" class="pwtoggle" data-action="togglePassword" data-arg="cp_cur" aria-label="Show password">👁</button>
           </div>
           <label class="f" for="cp_new" style="margin-top:10px">New password</label>
           <div class="pwwrap">
             <input type="password" id="cp_new" placeholder="Min 8 characters" autocomplete="new-password"
               data-enter="changeCloudPassword">
             <button type="button" class="pwtoggle" data-action="togglePassword" data-arg="cp_new" aria-label="Show password">👁</button>
           </div>
           <div class="werr" id="cp_err"></div>
           <button class="btn" data-action="changeCloudPassword">Change password</button>`
        : `<p style="color:var(--muted);font-size:13px;margin-bottom:10px">You're exploring with
             sample data. Create a free account to get a real workspace that syncs across
             your devices.</p>
           <button class="btn" data-action="exitDemo">Sign in / Create account</button>`) : `
        <p style="color:var(--muted);font-size:13px">This deployment has no
        <code>backend-config.js</code>, so it intentionally runs without accounts or cloud sync.</p>`}
    </div>
    ${renderTeamCard()}
    <div class="card" style="flex:1;min-width:280px">
      <h4 style="margin-bottom:10px">Your data</h4>
      <p style="color:var(--muted);font-size:13px;margin-bottom:12px">Back up everything to a JSON file, restore it later, or start fresh with demo data.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" data-action="exportData">⬇ Export backup</button>
        <button class="btn ghost" data-action="pickImportFile">⬆ Import backup</button>
        <input type="file" id="impFile" accept=".json" style="display:none" data-change="importData">
        <button class="btn dangerb" data-action="resetData">Reset to demo</button>
      </div>
    </div>
    <div class="card" style="flex:1;min-width:280px">
      <h4 style="margin-bottom:10px">Use FablePeak on your phone</h4>
      ${mobileInstallCard()}
    </div>
  </div>
  <div class="card" style="margin-top:14px">
    <h4 style="margin-bottom:8px">How to manage FablePeak yourself</h4>
    <ol style="margin-left:18px;color:var(--muted);font-size:13px;line-height:1.9">
      <li><strong>Open:</strong> visit <code>fablepeak.com</code>, or install it from your phone browser (<em>Add to Home Screen</em>) — the installed app is what keeps working offline.</li>
      <li><strong>Data:</strong> ${store.user
        ? "synced to your cloud workspace and cached locally for offline access."
        : "saved in this browser. Use <em>Export backup</em> regularly."}</li>
      <li><strong>Move devices:</strong> ${store.user
        ? "sign in with the same account to load brands you can access."
        : "export here and import on the other device."}</li>
      <li><strong>Customize:</strong> plain HTML/CSS/JS — colors in the <code>:root</code> CSS block of <code>index.html</code>, platforms in the <code>NETWORKS</code> array in <code>js/constants.js</code>. Push to GitHub to redeploy.</li>
    </ol>
  </div>
  ${store.user?`<div class="card" style="margin-top:14px;border-color:#e7b6b6">
    <h4 style="margin-bottom:8px;color:var(--danger)">Delete account</h4>
    <p style="color:var(--muted);font-size:13px;margin-bottom:12px">Permanently remove your FablePeak account, your provider credentials, and workspaces owned only by you. Shared workspaces remain available to their other members.</p>
    <button class="btn dangerb" data-action="deleteCloudAccount">Delete my account</button>
  </div>`:""}`;
}
/* ---------- approval opt-in (ADR 0006 decision 9) ---------- */
/* One switch, scoped to the ACTIVE brand — which is what `owner` above is an
   answer about, and the reason this is not a per-row control in the list: the
   role cache holds the caller's role in one brand at a time, so a per-row
   toggle would gate every other brand's switch on the wrong role.

   Owner-only, disabled-with-a-reason rather than hidden, exactly like brand
   deletion above and the SmartLinks publish toggle: an editor should be able to
   see that their workspace requires review and who can change that.

   The guarantee is in Postgres — brands_guard_smartlink_slug refuses a
   non-owner's write to this column (20260830130000_post_approval.sql §4). */
function approvalCard(owner){
  const b=brand();
  const simulated=!liveMode();
  const on=approvalRequired();
  return `<div style="border-top:1px solid var(--line);margin-top:14px;padding-top:12px">
    <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px">
      <input type="checkbox" id="brandApproval" ${on?"checked":""} style="margin-top:2px"
        ${simulated?"":(owner?"":`disabled title="${attr(OWNER_ONLY_TITLE)}"`)}
        data-change="${simulated?"simulatedApprovalToggle":"toggleApproval"}">
      <span>Require approval before scheduling
        <span style="display:block;color:var(--muted);font-size:12px;margin-top:2px">${simulated
          ? `<strong>Simulated — approval needs a cloud workspace.</strong>
             There are no accounts here, so there is nobody to approve anything.`
          : `Editors submit posts in <strong>${esc(b.name)}</strong> for review instead of
             scheduling them. Only an owner can approve, reject or schedule.`}</span></span>
    </label>
    ${!simulated && !owner ? `<div style="color:var(--muted);font-size:12px;margin-top:6px">
      Only this workspace's owners can turn approval on or off.</div>` : ""}
  </div>`;
}
export async function toggleApproval(el){
  const b=brand(), want=!!el.checked;
  try{
    await store.setApprovalRequired(b.id, want);
    b.approval_required=want;              // not persisted through save(): the
    render();                              // column is owner-gated and is never
    toast(want                             // part of an ordinary brand upsert
      ? "Posts in this brand now need an owner's approval before scheduling"
      : "Approval turned off — editors can schedule directly again");
  }catch(e){
    render();                              // put the switch back where the server left it
    toast(String(e.message||e).slice(0,120));
  }
}
export function simulatedApprovalToggle(){
  render();
  toast("Simulated — the approval workflow needs a cloud workspace");
}
/* ---------- hashtag groups (ADR 0005 publishing depth) ---------- */
/* Named, reusable tag sets for the ACTIVE brand — beside the Brands card, and
   scoped the way the approval switch above is scoped, because a group belongs to
   one brand and the composer that inserts it is always open in one.

   Not owner-gated. ADR 0006 reserves is_owner for destructive and account-shaped
   acts; composing is everyday editor work, and the hashtag_groups_all RLS policy
   is is_member(brand_id) to match. So there is no disabled-with-a-reason control
   here — an editor may do all of this, and the database agrees.

   Fully functional in local and demo mode: nothing below touches the network.
   save() persists through whichever adapter is installed, exactly as renaming a
   brand does. */
function groupRow(g){
  return `<div class="hgroup">
    <div class="hgroup-head">
      <strong>${esc(g.name)}</strong>
      <span class="hgroup-count">${g.tags.length} tag${g.tags.length===1?"":"s"}</span>
    </div>
    <div class="hgroup-tags">${esc(g.tags.join(" "))}</div>
    <div class="hgroup-acts">
      <button class="btn ghost mini" data-action="editHashtagGroup" data-arg="${attr(g.id)}"
        >Edit</button>
      <button class="btn dangerb mini" data-action="deleteHashtagGroup" data-arg="${attr(g.id)}"
        aria-label="${attr("Delete the hashtag group "+g.name)}">✕</button>
    </div>
  </div>`;
}
function hashtagGroupsCard(){
  const groups=groupsOf(brand());
  const editing=groups.find(g=>g.id===editingHashtagGroup) || null;
  return `<div class="card" style="flex:1;min-width:280px">
    <h4 style="margin-bottom:10px">Hashtag groups</h4>
    <p style="color:var(--muted);font-size:13px;margin-bottom:12px">Reusable sets of
      hashtags for <strong>${esc(brand().name)}</strong>. Add one to a post from the
      composer instead of retyping it.</p>
    ${groups.length ? groups.map(groupRow).join("")
      : `<p style="color:var(--muted);font-size:13px">No groups yet. Create your first one below.</p>`}
    <div style="border-top:1px solid var(--line);margin-top:14px;padding-top:12px">
      <label class="f" for="hgName">${editing?"Edit group":"New group"}</label>
      <input type="text" id="hgName" maxlength="${attr(GROUP_NAME_MAX)}"
        placeholder="Product launch" value="${attr(editing?editing.name:"")}">
      <label class="f" for="hgTags" style="margin-top:10px">Hashtags</label>
      <textarea id="hgTags" style="min-height:70px"
        placeholder="#launch #newfeature — or just launch, newfeature">${esc(editing?editing.tags.join(" "):"")}</textarea>
      <div style="color:var(--muted);font-size:12px;margin-top:4px">Separate them with
        spaces or commas. A missing <strong>#</strong> is added for you.</div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn mini" data-action="saveHashtagGroup"
          data-arg="${attr(editing?editing.id:"")}">${editing?"Save changes":"Create group"}</button>
        ${editing?`<button class="btn ghost mini" data-action="cancelHashtagGroup">Cancel</button>`:""}
      </div>
    </div>
  </div>`;
}
export function editHashtagGroup(id){ setEditingHashtagGroup(id); render(); }
export function cancelHashtagGroup(){ setEditingHashtagGroup(null); render(); }
export function saveHashtagGroup(id){
  const b=brand();
  const name=document.getElementById("hgName").value.trim();
  const tags=parseTags(document.getElementById("hgTags").value);
  /* One sentence per refusal, from the same vocabulary the CHECK constraint
     enforces — the customer gets English, and the database still gets the last
     word if anything ever reaches it another way. */
  const problem=describeGroupProblem(name, tags);
  if(problem) return toast(problem);
  if(!Array.isArray(b.hashtag_groups)) b.hashtag_groups=[];
  const existing=b.hashtag_groups.find(g=>g.id===id);
  if(existing){ existing.name=name; existing.tags=tags; }
  else b.hashtag_groups.push({ id:uid(), name, tags });
  setEditingHashtagGroup(null);
  save(); render();
  toast(existing?"Hashtag group updated ✔":"Hashtag group created ✔");
}
export function deleteHashtagGroup(id){
  const b=brand();
  const group=groupsOf(b).find(g=>g.id===id);
  if(!group) return;
  if(!confirm(`Delete the hashtag group “${group.name}”?`)) return;
  b.hashtag_groups=groupsOf(b).filter(g=>g.id!==id);
  if(editingHashtagGroup===id) setEditingHashtagGroup(null);
  save(); render(); toast("Hashtag group deleted");
}

export function renameBrand(id,name){ db.brands.find(b=>b.id===id).name=name.trim()||"Brand"; save(); render(); }
export function addBrand(){
  const name=document.getElementById("newBrand").value.trim(); if(!name)return toast("Give it a name");
  const b=defaultBrand(name); db.brands.push(b); db.activeBrand=b.id; save(); render(); toast("Brand created");
}
export function deleteBrand(id){
  if(db.brands.length<2)return;
  if(!confirm("Delete this brand and all its posts, inbox and links?"))return;
  db.brands=db.brands.filter(b=>b.id!==id);
  if(db.activeBrand===id)db.activeBrand=db.brands[0].id;
  save(); render();
}
export function exportData(){
  const a=document.createElement("a");
  a.href="data:application/json;charset=utf-8,"+encodeURIComponent(JSON.stringify(db,null,2));
  a.download="fablepeak-backup-"+todayStr()+".json"; a.click(); toast("Backup downloaded");
}
/* Settings → Import backup is a first-class untrusted input path: whatever it
   accepts is rendered, and on the next persistNow() it reaches Supabase. The
   whole file is therefore validated against the workspace schema *before* `db`
   is touched, so a rejected import changes nothing in memory or in storage
   (ADR 0003 §2a). Returns the accepted workspace, or null. */
/* ADR 0006 decision 9 widened this vocabulary to six. A workspace holding a
   post awaiting approval must survive its own backup: without `pending_approval`
   here, exporting and re-importing such a workspace would reject the whole
   file. It is the same list as the posts_status_check constraint in
   20260830130000_post_approval.sql, and it has to stay that way. */
const POST_STATUSES = ["draft","pending_approval","scheduled","publishing","published","failed"];
const isText = v => typeof v === "string";
const isId = v => typeof v === "string" && v.length > 0 && v.length <= 200;
const isPlainObject = v => !!v && typeof v === "object" && !Array.isArray(v);
/* The seven keys posts_tiktok_options_valid names, and nothing else. The four
   privacy levels are TikTok's own; a level outside them is not a level the
   composer could label or the adapter could send. */
const TIKTOK_PRIVACY = ["PUBLIC_TO_EVERYONE","MUTUAL_FOLLOW_FRIENDS","FOLLOWER_OF_CREATOR","SELF_ONLY"];
const TIKTOK_FLAGS = ["disable_comment","disable_duet","disable_stitch",
                      "disclose_commercial","brand_organic","brand_content"];
export function validBackupTikTokOptions(o){
  return isPlainObject(o)
    && Object.keys(o).every(k => k==="privacy_level" || TIKTOK_FLAGS.includes(k))
    && TIKTOK_PRIVACY.includes(o.privacy_level)
    && TIKTOK_FLAGS.every(k => o[k]===undefined || typeof o[k]==="boolean")
    // The two rules TikTok itself imposes, restated where an untrusted file
    // lands: an undeclared declaration, and private branded content.
    && (!o.disclose_commercial || !!o.brand_organic || !!o.brand_content)
    && !(o.brand_content && o.privacy_level==="SELF_ONLY");
}
/* The Instagram carousel, checked against the same three limits
   posts_media_urls_valid enforces: 2..10 entries, each an https:// string of at
   most 2048 characters. Absent and null both mean "this post has no carousel",
   which is nearly every post. */
const CAROUSEL_MIN = 2, CAROUSEL_MAX = 10;
const isCarouselItem = v => isText(v) && v.length <= 2048 && v.startsWith("https://");
export function validBackupMediaUrls(v){
  return Array.isArray(v) && v.length >= CAROUSEL_MIN && v.length <= CAROUSEL_MAX
    && v.every(isCarouselItem);
}
/* The per-post Instagram options, checked against the same closed shape
   posts_instagram_options_valid enforces: the three keys and nothing else, a
   boolean share_to_feed, an alt text of at most 1000 characters carrying no
   control characters, and never an object with no keys — "no options" is spelled
   null, and a second spelling of it would be a post claiming choices nobody made.
   Alt text is announced by a screen reader and rendered back into this app, so a
   backup carrying a C0 character in one is refused rather than repaired.
   `carousel_alt_texts` is that same rule per entry, in an array of 1..10 — one
   description per carousel item, in the carousel's own order. An entry may be ""
   ("this item has no description", said in position); the array itself may not
   be empty, because that is "no descriptions" and its spelling is an absent key. */
const ALT_TEXT_MAX = 1000;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const isAltText = v => isText(v) && v.length <= ALT_TEXT_MAX && !CONTROL_CHARS.test(v);
export function validBackupInstagramOptions(o){
  return isPlainObject(o) && Object.keys(o).length > 0
    && Object.keys(o).every(k =>
        k==="share_to_feed" || k==="alt_text" || k==="carousel_alt_texts")
    && (o.share_to_feed===undefined || typeof o.share_to_feed==="boolean")
    && (o.alt_text===undefined || isAltText(o.alt_text))
    && (o.carousel_alt_texts===undefined || (Array.isArray(o.carousel_alt_texts)
        && o.carousel_alt_texts.length >= 1 && o.carousel_alt_texts.length <= CAROUSEL_MAX
        && o.carousel_alt_texts.every(isAltText)));
}
export function validBackupPost(p){
  return isPlainObject(p) && isId(p.id) && isText(p.text) && isText(p.date)
    && (p.time===undefined || isText(p.time))
    && (p.media_url===undefined || p.media_url===null || isText(p.media_url))
    // The carousel is an ordered array of public URLs that this app will hand
    // straight to Meta, so a backup carrying one that Instagram could never
    // accept — a single item, an eleventh, an http:// URL — is refused here,
    // before it can reach `db` and be queued for sync.
    && (p.media_urls===undefined || p.media_urls===null || validBackupMediaUrls(p.media_urls))
    && Array.isArray(p.networks) && p.networks.every(isText)
    && POST_STATUSES.includes(p.status)
    // ADR 0005 decision 2: per-network copy. An imported file is as untrusted
    // as any other input, and the database CHECK on `posts.variants` is the
    // last line, not the first — a backup that carries a non-string variant is
    // refused here, before it can reach `db` and be queued for sync.
    && (p.variants===undefined || (isPlainObject(p.variants)
        && Object.values(p.variants).every(isText)))
    // TikTok Direct Post options. Null and absent both mean "this post records
    // no TikTok choices", which is every post that does not target TikTok. An
    // object is checked against the same closed shape the CHECK constraint
    // enforces, so a backup cannot smuggle an audience TikTok never offered.
    && (p.tiktok_options===undefined || p.tiktok_options===null
        || validBackupTikTokOptions(p.tiktok_options))
    // Instagram's Reel placement and image alt text. Null and absent both mean
    // "this post records no Instagram choices", which is every post that
    // predates the column and every post that does not target Instagram.
    && (p.instagram_options===undefined || p.instagram_options===null
        || validBackupInstagramOptions(p.instagram_options))
    // ADR 0006 decision 11: the rejection note is one optional string, and it
    // is rendered — so it is validated on the way in like every other one.
    && (p.approval_note===undefined || p.approval_note===null || isText(p.approval_note))
    && (p.targets===undefined || Array.isArray(p.targets));
}
export function validBackupThread(t){
  return isPlainObject(t) && isId(t.id) && isText(t.net) && isText(t.from)
    && Array.isArray(t.msgs)
    && t.msgs.every(msg => isPlainObject(msg) && isText(msg.who) && isText(msg.text));
}
export function validBackupSmartlink(sl){
  return isPlainObject(sl) && isText(sl.title) && isText(sl.bio) && isText(sl.avatar)
    && Array.isArray(sl.links)
    && sl.links.every(l => isPlainObject(l) && isId(l.id) && isText(l.title)
      && isText(l.url) && (l.clicks===undefined || typeof l.clicks === "number"));
}
/* Hashtag groups ride the backup like the rest of a brand's data, and are
   checked against the same rules `hashtag_groups_tags_valid` enforces — a name
   of 1..60 characters and 1..30 tags, each a `#`-prefixed string of 2..100
   characters with no whitespace and no control characters. Absent means "this
   brand has no groups", which is every brand exported before this feature. */
export function validBackupHashtagGroups(v){
  return Array.isArray(v) && v.every(validHashtagGroup);
}
export function validBackupBrand(b){
  return isPlainObject(b) && isId(b.id) && isText(b.name)
    && (b.hashtag_groups===undefined || validBackupHashtagGroups(b.hashtag_groups))
    && (b.seed===undefined || typeof b.seed === "number")
    // Carried by a cloud export, never *applied* by an import: the flag is
    // owner-gated server-side and is not part of a brand upsert, so restoring a
    // backup can describe it but cannot switch it on for anybody.
    && (b.approval_required===undefined || typeof b.approval_required === "boolean")
    && isPlainObject(b.connections || {})
    && Array.isArray(b.posts) && b.posts.every(validBackupPost)
    && Array.isArray(b.inbox) && b.inbox.every(validBackupThread)
    && validBackupSmartlink(b.smartlink);
}
export function acceptBackup(d){
  if(!isPlainObject(d)) return null;
  if(!Array.isArray(d.brands) || !d.brands.length) return null;
  if(!d.brands.every(validBackupBrand)) return null;
  const ids = d.brands.map(b=>b.id);
  if(new Set(ids).size !== ids.length) return null;
  d.brands.forEach(b=>{
    b.smartlink.color = slColorOf(b.smartlink.color);
    // A file exported before hashtag groups existed carries none. Normalised to
    // [] rather than left absent so every brand in `db` has the same shape.
    if(!Array.isArray(b.hashtag_groups)) b.hashtag_groups = [];
  });
  d.activeBrand = d.brands[0].id;
  return d;
}
export function importData(inp){
  const f=inp.files[0]; if(!f)return;
  const r=new FileReader();
  r.onload=()=>{
    let parsed=null;
    try{ parsed=JSON.parse(r.result); }catch(e){ return toast("Invalid backup file"); }
    const accepted=acceptBackup(parsed);
    if(!accepted) return toast("Invalid backup file");   // db is untouched, nothing persists
    setDb(accepted); save(); render(); toast("Backup restored ✔");
  };
  r.readAsText(f); inp.value="";
}
export function resetData(){
  if(!confirm("Replace ALL current data with fresh demo data?"))return;
  setDb(seedDemo()); save(); render(); toast("Demo data restored");
}
export function cloudSignOut(){
  localStorage.removeItem(LS_KEY);              // cloud cache off this device
  store.signOut().then(()=>location.reload());
}
/* The re-authentication is deliberate. updateUser() alone would let anyone
   holding a hijacked session rotate the password silently and lock the owner
   out, so the current password is checked first — the same stance the delete
   account flow below takes. A failed signIn() is reported as one sentence
   rather than Supabase's own text, which describes the sign-in it just made. */
let changingPassword=false;                     // guards button-click + Enter double submits
export async function changeCloudPassword(){
  const current=document.getElementById("cp_cur").value;
  const newPw=document.getElementById("cp_new").value;
  const err=document.getElementById("cp_err");
  if(!current || !newPw){ err.textContent="Current and new password, please."; return; }
  if(newPw.length<8){ err.textContent="Use at least 8 characters."; return; }
  if(newPw===current){ err.textContent="New password must be different."; return; }
  if(changingPassword) return;
  changingPassword=true;
  try{
    try{
      await store.signIn(store.user.email, current);
    }catch(e){ err.textContent="Current password is incorrect."; return; }
    try{
      await store.updatePassword(newPw);
    }catch(e){ err.textContent="Password change failed: "+String(e.message||e).slice(0,100); return; }
    document.getElementById("cp_cur").value="";
    document.getElementById("cp_new").value="";
    err.textContent="";
    toast("Password changed ✔");
  }finally{ changingPassword=false; }
}
export async function deleteCloudAccount(){
  const answer=prompt('This permanently deletes your account. Type DELETE to continue.');
  if(answer!=="DELETE") return;
  const password=prompt("Enter your FablePeak password to confirm deletion.");
  if(!password) return;
  try{
    toast("Deleting account…");
    await store.deleteAccount(password);
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem("fablepeak_pref_activeBrand");
    location.reload();
  }catch(e){ toast("Account deletion failed: "+String(e.message||e).slice(0,100)); }
}
