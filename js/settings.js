/* =============== SETTINGS =============== */
import { LS_KEY, OWNER_ONLY_TITLE } from "./constants.js";
import { attr, esc, slColorOf } from "./escape.js";
import { todayStr } from "./util.js";
import { db, deferredInstallPrompt, setDb, setDeferredInstallPrompt } from "./state.js";
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
    <div class="card" style="flex:1;min-width:280px">
      <h4 style="margin-bottom:10px">Cloud sync &amp; team accounts</h4>
      <p style="color:var(--muted);font-size:13px;margin-bottom:10px">
        Mode: <strong>${store.name!=="cloud" ? "💻 Local (this browser only)"
          : store.user ? "☁️ Cloud · synced" : "👀 Demo (sample data, this device only)"}</strong>
        ${store.user ? " · signed in as "+esc(store.user.email) : ""}</p>
      ${store.name==="cloud" ? (store.user
        ? `<button class="btn ghost" data-action="cloudSignOut">Sign out</button>`
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
export function validBackupBrand(b){
  return isPlainObject(b) && isId(b.id) && isText(b.name)
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
  d.brands.forEach(b=>{ b.smartlink.color = slColorOf(b.smartlink.color); });
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
