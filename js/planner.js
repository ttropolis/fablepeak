/* =============== PLANNER =============== */
/* The month calendar, the composer modal, and everything that happens to a
   post: drag-reschedule, validate, save, publish, retry, duplicate, delete. */
import { NETWORKS, SCHEDULE_TZ } from "./constants.js";
import { attr, esc, safeUrl } from "./escape.js";
import { fileSizeLabel, fmtDate, mediaContentType, todayStr, uid } from "./util.js";
import {
  AI_ASSIST_IDLE, aiAssist, calCursor, mediaUploadActive, setAiAssist,
  setComposerBaseline, setMediaUploadActive,
} from "./state.js";
import { liveMode, store } from "./store.js";
import {
  brand, connectedNets, connectionsKnown, netOf, persistNow, save,
} from "./workspace.js";
import { closeModal, composerSnapshot, openModal, render, toast } from "./shell.js";

export function renderPlanner(m){
  const y=calCursor.getFullYear(), mo=calCursor.getMonth();
  const monthName = calCursor.toLocaleString("en",{month:"long",year:"numeric"});
  const first = new Date(y,mo,1);
  let start = new Date(first); start.setDate(1-((first.getDay()+6)%7)); // Monday start
  const cells=[];
  for(let i=0;i<42;i++){ const d=new Date(start); d.setDate(start.getDate()+i); cells.push(d); }
  const b=brand();
  const postsBy={}; b.posts.forEach(p=>{ (postsBy[p.date]=postsBy[p.date]||[]).push(p); });
  const monthKey=`${y}-${String(mo+1).padStart(2,"0")}`;
  const monthPosts=b.posts.filter(p=>p.date?.startsWith(monthKey+"-"))
    .sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
  const newPostDate=todayStr().startsWith(monthKey+"-") ? todayStr() : `${monthKey}-01`;

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
    <div class="calgrid">
      ${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d=>`<div class="dow">${d}</div>`).join("")}
      ${cells.map(d=>{
        const ds=fmtDate(d);
        const cls=["day", d.getMonth()!==mo?"other":"", ds===todayStr()?"today":""].join(" ");
        const chips=(postsBy[ds]||[]).sort((a,b)=>(a.time||"").localeCompare(b.time||"")).map(p=>{
          const visibleStatus=postVisibleStatus(p);
          return `<button type="button" class="post ${attr(visibleStatus)}" draggable="${!(liveMode()&&["publishing","published"].includes(p.status))}" title="${attr(p.text)}"
                aria-label="${attr(`${p.time||"Any time"}, ${visibleStatus}: ${p.text}`)}"
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
            <span>${esc(p.time||"Any time")} · ${esc(nets)} · ${esc(visibleStatus)}</span></span>
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
  const statusOptions = liveMode()
    ? locked ? [p.status] : ["draft","scheduled"]
    : ["draft","scheduled","published"];
  const nets = p? p.networks : connectedNets().slice(0,1).map(n=>n.id);
  openModal(`
    <h3>${p? "Edit post":"New post"}</h3>
    <div class="sub">${locked
      ? p.status==="publishing" ? "Publishing is in progress…" : "Published posts are read-only. Duplicate this post to reuse it."
      : p? "Update, duplicate or delete this post.":"Compose once, publish everywhere."}</div>
    ${p?deliveryPanel(p):""}
    <label class="f">Content</label>
    <textarea id="pm_text" placeholder="What do you want to say?" ${locked?"disabled":""}
      data-input="syncAiAssist">${esc(p?.text||"")}</textarea>
    ${aiAssistPanel(locked)}
    <label class="f">Image / video <span style="text-transform:none;font-weight:400">— required by Instagram, Pinterest, TikTok and YouTube</span></label>
    <input type="url" id="pm_media" placeholder="https://… (optional for X, Facebook, LinkedIn)" value="${attr(p?.media_url||"")}" ${locked?"disabled":""} data-change="showMediaPreview">
    <div class="media-preview" id="pm_media_preview"></div>
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
          ${statusOptions.map(s=>`<option ${p?.status===s?"selected":""}>${s}</option>`).join("")}
        </select></div>
    </div>
    <div class="modalfoot">
      <div>${p?`${p.status!=="publishing"?`<button class="btn dangerb mini" data-action="deletePost" data-arg="${attr(p.id)}">Delete</button>`:""}
               ${p.status!=="publishing"?`<button class="btn ghost mini" data-action="dupPost" data-arg="${attr(p.id)}">Duplicate</button>`:""}
               ${liveMode() && !["publishing","published"].includes(p.status)
                 ? `<button class="btn mini" data-action="publishNow" data-arg="${attr(p.id)}">🚀 Publish now</button>` : ""}`:""}</div>
      <div class="right">
        <button class="btn ghost" data-action="dismissModal">${locked?"Close":"Cancel"}</button>
        ${locked?"":`<button class="btn" data-action="savePost" data-arg="${attr(p?.id||"")}">${p?"Save":"Schedule"}</button>`}
      </div>
    </div>`);
  if(p?.media_url) showMediaPreview(p.media_url);
  syncAiAssist();                              // the panel was built before #pm_text existed
  setComposerBaseline(composerSnapshot());     // arms the unsaved-changes guard
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

function aiText(){ return document.getElementById("pm_text")?.value.trim() || ""; }
function aiCheckedNets(){
  return [...document.querySelectorAll("#pm_nets input:checked")].map(i=>i.value);
}
/** The one network to write for, when the composer names exactly one we support. */
function aiNetwork(){
  const nets=aiCheckedNets();
  return nets.length===1 && AI_NETWORKS.includes(nets[0]) ? nets[0] : null;
}
/** Why this button cannot run yet — shown as its title — or "" when it can. */
export function aiAssistBlocked(action){
  const text=aiText();
  if(!text) return action==="caption"
    ? "Type the topic you want captions about in Content first"
    : "Write some content first";
  if(text.length>AI_MAX_INPUT)
    return `AI assist reads up to ${AI_MAX_INPUT} characters — this is ${text.length}`;
  if(action==="rewrite" && !aiNetwork())
    return aiCheckedNets().length===1
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
  const network=aiNetwork();
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
  const box=document.getElementById("pm_text");
  const suggestion=(aiAssist.items||[])[Number(index)];
  if(!box || box.disabled || suggestion===undefined) return;
  box.value = aiAssist.action==="hashtags"
    ? appendHashtag(box.value, suggestion) : suggestion;
  syncAiAssist();
  toast(aiAssist.action==="hashtags" ? "Hashtag added" : "Content replaced");
}
function appendHashtag(text, tag){
  const clean=String(tag).trim(), body=String(text).replace(/\s+$/,"");
  if(!clean || body.split(/\s+/).includes(clean)) return text;
  return body ? `${body} ${clean}` : clean;
}
export function clearAiAssist(){ setAiAssist(AI_ASSIST_IDLE); paintAiAssist(); }
export function readPostForm(){
  const text=document.getElementById("pm_text").value.trim();
  const nets=[...document.querySelectorAll("#pm_nets input:checked")].map(i=>i.value);
  const date=document.getElementById("pm_date").value, time=document.getElementById("pm_time").value;
  const status=document.getElementById("pm_status").value;
  const media_url=document.getElementById("pm_media").value.trim();
  return {text,nets,date,time,status,media_url};
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
export function validatePostForm({text,nets,date,time,media_url}){
  if(!text) return toast("Write some content first");
  if(!nets.length) return toast("Pick at least one network");
  if(!date || !time) return toast("Choose a date and time");
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
  return true;
}
export function savePost(id){
  if(mediaUploadActive) return toast("Wait for the media upload to finish");
  const values=readPostForm();
  if(!validatePostForm(values)) return;
  const {nets,...postValues}=values;
  const b=brand();
  if(id){
    const p=b.posts.find(x=>x.id===id);
    if(liveMode() && ["publishing","published"].includes(p.status))
      return toast("Published posts are read-only — duplicate this post instead");
    Object.assign(p,{...postValues,networks:nets});
  } else {
    b.posts.push({id:uid(),...postValues,networks:nets});
  }
  save(); closeModal(); render();
  toast(id?"Post updated":values.status==="draft"?"Draft saved":"Post scheduled ✔");
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
export function dupPost(id){ const b=brand(); const p=b.posts.find(x=>x.id===id);
  b.posts.push({...p,id:uid(),status:"draft"}); save(); closeModal(); render(); toast("Duplicated as draft"); }
