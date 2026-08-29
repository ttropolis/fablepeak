/* =============== SMARTLINKS =============== */
/* ADR 0004 (as amended 2026-08-29). Cloud mode talks to the real backend: the
   slug is claimed through set_smartlink_slug, publishing flips
   brands.smartlink_public, and per-link counts come from smartlink_click_totals
   — never from the jsonb `clicks` field, which stays a local/demo simulation
   (decision 11). The canonical public URL lives on its own origin (decision 2). */
import { attr, esc, slColorOf } from "./escape.js";
import { uid } from "./util.js";
import { setSlCache, slCache, view } from "./state.js";
import { liveMode, store } from "./store.js";
import { brand, save } from "./workspace.js";
import { render, toast } from "./shell.js";

export const SL_PUBLIC_BASE = "https://links.fablepeak.com/";
/* Mirrors public.smartlink_slug_is_valid() so the editor can answer instantly.
   The backend stays authoritative — this only avoids a round trip to be told no. */
const SL_RESERVED = ["l","api","app","www","admin","static","assets","oauth","privacy",
  "terms","functions","data-deletion","login","signup","support","help","legal",
  "security","status","well-known","mail","root","fablepeak"];
/* Typed results from set_smartlink_slug, mapped to what an operator should read. */
const SL_SLUG_ERRORS = {
  slug_taken: "That link name is already taken — try another.",
  invalid_slug: "Use 3–30 lowercase letters, numbers and single hyphens.",
  unknown_brand: "This brand isn't in the cloud yet. Try again in a moment.",
};

export function slugProblem(value){
  const s=String(value??"").trim().toLowerCase();
  if(!s) return "Choose a link name first.";
  if(s.length<3 || s.length>30) return "Use between 3 and 30 characters.";
  if(!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(s))
    return "Use lowercase letters, numbers and hyphens — not starting or ending with a hyphen.";
  if(s.includes("--")) return "Two hyphens in a row are not allowed.";
  if(SL_RESERVED.includes(s)) return "That link name is reserved.";
  return "";
}
export function slPublicUrl(){
  return slCache.slug ? SL_PUBLIC_BASE + "?b=" + encodeURIComponent(slCache.slug) : "";
}
function slReady(){ return slCache.loaded && slCache.brandId===brand().id; }
/* Real aggregates, member-authorized, fetched once per brand (see
   ensureMetricsLoaded for the same shape). */
export function ensureSmartlinkLoaded(brandId){
  if(!liveMode()) return;
  if(slCache.brandId===brandId && (slCache.loaded || slCache.loading)) return;
  setSlCache({ brandId, slug:"", published:false, totals:{}, loaded:false, loading:true, error:null });
  Promise.all([store.smartlinkPublishing(brandId), store.smartlinkClickTotals(brandId)])
    .then(([publishing, rows]) => {
      if(slCache.brandId !== brandId) return;
      const totals={};
      for(const r of rows||[])
        totals[r.link_id] = { total: Number(r.total) || 0, last7: Number(r.last_7d) || 0 };
      setSlCache({ brandId, slug: publishing?.slug || "", published: !!publishing?.published,
                   totals, loaded:true, loading:false, error:null });
      if(view==="smartlinks") render();
    })
    .catch(e => {
      if(slCache.brandId !== brandId) return;
      setSlCache({ brandId, slug:"", published:false, totals:{}, loaded:true, loading:false,
                   error:String(e.message || e) });
      if(view==="smartlinks") render();
    });
}
function slClicksCell(l){
  // local/demo: the jsonb counter, simulated and labelled as such in the card above
  if(!liveMode()) return `<span class="clicks">${l.clicks} clicks</span>`;
  if(!slReady()) return `<span class="clicks">… clicks</span>`;
  const t=slCache.totals[l.id] || { total:0, last7:0 };
  return `<span class="clicks" title="${attr(t.last7 + " in the last 7 days")}">${t.total} clicks · approx.</span>`;
}
function slPublishCard(){
  if(!liveMode()){
    return `<div class="card" style="border-left:4px solid var(--chip-draft);margin-bottom:14px">
      <strong>This page is a simulation — nothing here is public.</strong>
      <div style="color:var(--muted);font-size:13px;margin-top:6px">
        ${store.name==="cloud"
          ? "Sign in to claim a public link name and publish this page."
          : "A public page needs the cloud backend. Local mode can only simulate one."}
        The click counts below are simulated demo data, not real visits.</div>
    </div>`;
  }
  if(!slReady()){
    return `<div class="card" style="margin-bottom:14px">
      <strong>Public page</strong>
      <div style="color:var(--muted);font-size:13px;margin-top:6px">Checking your public page…</div>
    </div>`;
  }
  const url=slPublicUrl();
  return `<div class="card" style="margin-bottom:14px">
    <strong>Public page</strong>
    ${slCache.error
      ? `<div style="color:var(--danger);font-size:12px;margin-top:6px">Could not load your public page settings (${esc(slCache.error)}).</div>`
      : ""}
    <div style="color:var(--muted);font-size:13px;margin:6px 0 10px">
      Publishing is off until you switch it on, and switching it off takes effect immediately.</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <span style="color:var(--muted);font-size:12px">${esc(SL_PUBLIC_BASE)}?b=</span>
      <input type="text" id="sl_slug" value="${attr(slCache.slug)}" placeholder="your-brand"
        maxlength="30" style="flex:1;min-width:150px" data-change="slSlugCheck" data-enter="slClaim">
      <button class="btn mini" data-action="slClaim">${slCache.slug?"Change":"Claim"}</button>
    </div>
    <div id="sl_slug_hint" style="color:var(--muted);font-size:11.5px;margin-top:6px"></div>
    ${slCache.slug
      ? `<label style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px">
           <input type="checkbox" id="sl_public" ${slCache.published?"checked":""} data-change="slPublish">
           Publish this page</label>`
      : `<div style="color:var(--muted);font-size:12px;margin-top:10px">Claim a link name before you can publish.</div>`}
    ${slCache.published && url
      ? `<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
           <code class="slurl" style="font-size:12px;word-break:break-all;user-select:all">${esc(url)}</code>
           <button class="btn ghost mini" data-action="slCopyUrl">Copy link</button>
         </div>`
      : ""}
    <div style="color:var(--muted);font-size:11.5px;margin-top:10px">
      Click counts are approximate — they are collected without cookies, IP addresses
      or device identifiers, so repeat visits cannot be de-duplicated.</div>
  </div>`;
}
export function renderSmartlinks(m){
  const sl=brand().smartlink;
  const color=slColorOf(sl.color);
  ensureSmartlinkLoaded(brand().id);
  m.innerHTML=`
  <h1>SmartLinks</h1>
  <div class="sub">Your link-in-bio page. Edit on the left, live preview on the right.</div>
  ${slPublishCard()}
  <div class="slwrap">
    <div class="card sledit">
      <label class="f">Page title</label><input type="text" value="${attr(sl.title)}" data-change="slSet" data-arg="title">
      <label class="f">Bio</label><input type="text" value="${attr(sl.bio)}" data-change="slSet" data-arg="bio">
      <div style="display:flex;gap:10px">
        <div style="flex:1"><label class="f">Avatar (emoji)</label><input type="text" value="${attr(sl.avatar)}" maxlength="4" data-change="slSet" data-arg="avatar"></div>
        <div style="flex:1"><label class="f">Button color</label><input type="color" value="${attr(color)}" style="width:100%;height:36px;border:1px solid var(--line);border-radius:8px" data-change="slSet" data-arg="color"></div>
      </div>
      <label class="f">Links</label>
      ${sl.links.map((l,i)=>`
        <div class="slrow">
          <input type="text" value="${attr(l.title)}" placeholder="Label" data-change="slLink" data-arg="${attr(l.id)}" data-arg2="title">
          <input type="url" value="${attr(l.url)}" placeholder="https://…" data-change="slLink" data-arg="${attr(l.id)}" data-arg2="url">
          ${slClicksCell(l)}
          <button class="btn ghost mini" ${i===0?"disabled":""} data-action="slMove" data-arg="${attr(l.id)}" data-arg2="-1">↑</button>
          <button class="btn ghost mini" ${i===sl.links.length-1?"disabled":""} data-action="slMove" data-arg="${attr(l.id)}" data-arg2="1">↓</button>
          <button class="btn dangerb mini" data-action="slDel" data-arg="${attr(l.id)}">✕</button>
        </div>`).join("")}
      <button class="btn ghost mini" style="margin-top:6px" data-action="slAdd">+ Add link</button>
    </div>
    <div class="phone">
      <div class="av">${esc(sl.avatar)}</div>
      <h5>${esc(sl.title)}</h5>
      <div class="bio">${esc(sl.bio)}</div>
      ${sl.links.map(l=>`<a class="slink" style="background:${attr(color)}" data-action="slClick" data-arg="${attr(l.id)}">${esc(l.title)}</a>`).join("")}
      <div style="text-align:center;color:var(--muted);font-size:10px;margin-top:14px">⛰️ FablePeak Link</div>
    </div>
  </div>`;
}
export function slSet(k,v){ brand().smartlink[k]= k==="color" ? slColorOf(v) : v; save(); render(); }
export function slLink(id,k,v){ const l=brand().smartlink.links.find(x=>x.id===id); l[k]=v; save(); render(); }
export function slAdd(){ brand().smartlink.links.push({id:uid(),title:"New link",url:"https://",clicks:0}); save(); render(); }
export function slDel(id){ const sl=brand().smartlink; sl.links=sl.links.filter(x=>x.id!==id); save(); render(); }
export function slMove(id,dir){ const ls=brand().smartlink.links; const i=ls.findIndex(x=>x.id===id);
  const j=i+dir; if(j<0||j>=ls.length)return; [ls[i],ls[j]]=[ls[j],ls[i]]; save(); render(); }
/* Preview-only. In cloud mode the counters are real, so the preview must not
   move them: a click here is not a visit to the published page (decision 11). */
export function slClick(id){
  const l=brand().smartlink.links.find(x=>x.id===id);
  if(!l) return;
  if(liveMode()) return toast("Preview only — real clicks are counted on your public page");
  l.clicks++; save(); render(); toast("Click tracked → "+l.url);
}

/* ---------- publishing (cloud only) ---------- */
/* Instant, in-place feedback: rendering the whole view on every keystroke would
   take the focus out of the field being typed into. */
export function slSlugCheck(el){
  const hint=document.getElementById("sl_slug_hint");
  if(!hint) return;
  const raw=String(el.value||"").trim().toLowerCase();
  const problem=raw ? slugProblem(raw) : "";
  hint.textContent = problem || (raw ? "Available so far — " + SL_PUBLIC_BASE + "?b=" + raw : "");
  hint.style.color = problem ? "var(--danger)" : "var(--muted)";
}
export async function slClaim(){
  const input=document.getElementById("sl_slug");
  const wanted=String(input?.value||"").trim().toLowerCase();
  const problem=slugProblem(wanted);
  if(problem) return toast(problem);
  const b=brand();
  try{
    await store.ensureBrandSynced(b);           // the brand row must exist server-side first
    const out=await store.setSmartlinkSlug(b.id, wanted);
    if(!out || out.ok!==true)
      return toast(SL_SLUG_ERRORS[out?.error] || "Could not set that link name.");
    setSlCache({ ...slCache, brandId:b.id, slug: out.slug || wanted });
    render();
    toast(out.changed===false ? "That is already your link name" : "Link name saved ✔");
  }catch(e){ toast(e.message); }
}
/* The slug guard trigger only gates brands.smartlink_slug, so a member may set
   smartlink_public directly under the brands_update policy. */
export async function slPublish(el){
  const wanted=!!el.checked;
  const b=brand();
  if(wanted && !slCache.slug){ el.checked=false; return toast("Claim a link name first."); }
  try{
    await store.setSmartlinkPublic(b.id, wanted);
    setSlCache({ ...slCache, brandId:b.id, published:wanted });
    render();
    toast(wanted ? "Your page is live ✔" : "Your page is no longer public");
  }catch(e){ el.checked=!wanted; toast(e.message); }
}
export function slCopyUrl(){
  const url=slPublicUrl();
  if(!url) return;
  const write=navigator.clipboard?.writeText?.bind(navigator.clipboard);
  if(!write) return toast(url);                 // no clipboard access: show it to copy by hand
  write(url).then(()=>toast("Public link copied ✔"), ()=>toast(url));
}
