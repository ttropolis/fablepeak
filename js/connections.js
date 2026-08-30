/* =============== CONNECTIONS =============== */
import { NETWORKS, OWNER_ONLY_TITLE } from "./constants.js";
import { attr, esc, safeUrl } from "./escape.js";
import { connCache, setConnCache, view } from "./state.js";
import { liveMode, store } from "./store.js";
import { brand, isOwner, netOf, save } from "./workspace.js";
import { render, toast } from "./shell.js";

/* Honest, user-facing constraints per platform (from each platform's own docs). */
const PLATFORM_NOTES = {
  youtube:   "Uploads a video (needs a video URL). New API projects publish as private until Google audits them.",
  x:         "Paid API. Publishes text, images, GIFs and video after uploading the attachment to X.",
  instagram: "Business or Creator profiles connect directly. No Facebook Page is required. Every post needs media.",
  facebook:  "Posts text, images or video to a Page you administer.",
  linkedin:  "Publishes text or one image to a personal profile. Video and Company Page publishing remain separate follow-ups.",
  tiktok:    "Disabled until FablePeak implements TikTok's required creator controls, consent flow and status tracking.",
  pinterest: "Image Pin publishing and explicit board selection are implemented. Connection stays disabled until Pinterest credentials and a real-account acceptance test are complete.",
  gbp:       "Planned. Google API approval, location selection and Business Profile post publishing are not implemented yet.",
};
const PLATFORM_PENDING_STATUS = {
  instagram: "Meta review or tester access pending",
  facebook:  "Meta review or tester access pending",
  youtube:   "Google setup pending",
  x:         "Paid API credentials pending",
  linkedin:  "Developer app credentials pending",
  tiktok:    "Deferred — compliance workflow pending",
  pinterest: "Developer app and acceptance test pending",
  gbp:       "Not implemented",
};

export function renderConnections(m){
  const b = brand();

  if(!liveMode()){
    m.innerHTML = `
    <h1>Connections</h1>
    <div class="sub">Simulated connections for <strong>${esc(b.name)}</strong>.</div>
    <div class="card" style="border-left:4px solid var(--chip-draft);margin-bottom:14px">
      <strong>These are placeholders, not real accounts.</strong>
      <div style="color:var(--muted);font-size:13px;margin-top:6px">
        ${store.name==="cloud"
          ? "Sign in to connect real Instagram, YouTube, Facebook, LinkedIn, X or TikTok accounts."
          : "Real platform connections need the cloud backend. Local mode can only simulate them."}
      </div>
    </div>
    <div class="conngrid">
      ${NETWORKS.map(n=>{
        const handle=b.connections[n.id];
        return `<div class="card conn">
          <div class="top"><div class="nico" style="background:${attr(n.color)}">${n.short}</div>
            <div><strong>${n.name}</strong><div class="st ${handle?"on":""}">${handle?("Simulated · "+esc(handle)):"Not connected"}</div></div></div>
          ${handle
            ? `<button class="btn ghost mini" data-action="disconnectNet" data-arg="${attr(n.id)}">Remove</button>`
            : `<div style="display:flex;gap:6px">
                 <input type="text" id="h_${attr(n.id)}" placeholder="@handle">
                 <button class="btn ghost mini" data-action="connectNet" data-arg="${attr(n.id)}">Simulate</button></div>`}
        </div>`;
      }).join("")}
    </div>`;
    return;
  }

  // ---- live mode ----
  if(!connCache.loaded || connCache.brandId !== b.id){
    m.innerHTML = `<h1>Connections</h1><div class="sub">Checking your connected accounts…</div>`;
    refreshConnections(b.id);
    return;
  }

  const byPlatform = {};
  connCache.accounts.forEach(a => { (byPlatform[a.platform] ||= []).push(a); });
  const anyConfigured = connCache.available.length > 0;
  /* Disconnecting and choosing the publishing account are owner-only (ADR 0006):
     disconnect_account and select_social_account both check is_owner, and
     connection-health refuses a non-owner's revoke. Hidden rather than disabled
     — a row of dead buttons on every account reads as a broken page. Connecting
     is unchanged: an editor may still authorize a new profile. */
  const owner = isOwner();

  m.innerHTML = `
  <h1>Connections</h1>
  <div class="sub">Connect the real social accounts for <strong>${esc(b.name)}</strong>.
    Posts you schedule will publish to whatever is connected here.</div>
  ${anyConfigured ? "" : `
    <div class="card" style="border-left:4px solid var(--chip-draft);margin-bottom:14px">
      <strong>Social connections are temporarily unavailable.</strong>
      <div style="color:var(--muted);font-size:13px;margin-top:6px">
        Please try again later. You do not need to create developer credentials or configure anything yourself.</div>
    </div>`}
  <div class="conngrid">
    ${NETWORKS.map(n => {
      const accounts = byPlatform[n.id] || [];
      const ready = connCache.available.includes(n.id);
      const pendingStatus = PLATFORM_PENDING_STATUS[n.id] || "Setup pending";
      return `<div class="card conn">
        <div class="top"><div class="nico" style="background:${attr(n.color)}">${n.short}</div>
          <div style="min-width:0">
            <strong>${n.name}</strong>
            <div class="st ${accounts.some(a=>a.status==="active")?"on":""}">
              ${accounts.length
                ? esc((accounts.find(a=>a.is_default) || accounts[0]).display_name || "Connected")
                : ready ? "Available to connect" : esc(pendingStatus)}</div>
          </div></div>
        <div style="color:var(--muted);font-size:11.5px;line-height:1.5">${PLATFORM_NOTES[n.id]}</div>
        ${accounts.map(a => `
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:8px">
            ${safeUrl(a.avatar_url) ? `<img src="${attr(safeUrl(a.avatar_url))}" alt="" style="width:25px;height:25px;border-radius:50%;object-fit:cover">` : ""}
            <strong style="font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(a.display_name || "Connected account")}</strong>
            ${a.is_default && a.status==="active"
              ? `<span style="color:var(--chip-pub);font-size:11px">✓ Publishing account</span>`
              : a.status==="active" && owner
                ? `<button class="btn ghost mini" data-action="selectReal" data-arg="${attr(a.id)}">Use for publishing</button>`
                : ""}
            ${a.last_verified_at && a.status==="active"
              ? `<span style="color:var(--muted);font-size:10px" title="${attr(a.last_verified_at)}">Verified</span>` : ""}
            ${a.needs_reauth || ["expired","revoked"].includes(a.status)
              ? `<span style="color:var(--danger);font-size:12px">⚠️ Needs reconnecting</span>`
              : a.status==="error"
                ? `<span style="color:var(--danger);font-size:12px">⚠️ Connection check failed</span>` : ""}
            ${owner
              ? `<button class="btn ghost mini" data-action="disconnectReal" data-arg="${attr(a.id)}">Disconnect</button>`
              : ""}
          </div>
          ${a.last_error ? `<div style="color:var(--danger);font-size:11px">${esc(a.last_error)}</div>` : ""}`).join("")}
        ${ready && !accounts.length
          ? `<button class="btn mini" data-action="connectReal" data-arg="${attr(n.id)}">Connect</button>`
          : ready && accounts.length
            ? `<button class="btn ghost mini" data-action="connectReal" data-arg="${attr(n.id)}">${accounts.some(a=>a.status!=="active")?"Reconnect":n.id==="facebook"?"Refresh Pages":n.id==="pinterest"?"Refresh boards":"Connect another"}</button>`
          : `<button class="btn ghost mini" disabled title="${attr(pendingStatus)}">Connect</button>`}
      </div>`;
    }).join("")}
  </div>
  ${owner?"":`<div style="color:var(--muted);font-size:12px;margin-top:12px" title="${attr(OWNER_ONLY_TITLE)}">
    You're an editor in this workspace. Only its owners can disconnect an account
    or change which one publishes.</div>`}
  <div style="color:var(--muted);font-size:12px;margin-top:12px">Every planned network is shown here. A disabled card names the exact setup, approval or implementation gate that remains.</div>`;
}

export async function refreshConnections(brandId){
  let [available, accounts] = await Promise.all([
    store.availablePlatforms(), store.listAccounts(brandId),
  ]);
  const staleBefore = Date.now() - 15*60*1000;
  const needsCheck = accounts.some(a => !a.last_verified_at ||
    new Date(a.last_verified_at).getTime() < staleBefore);
  if(needsCheck){
    try{
      await store.verifyAccounts(brandId);
      accounts = await store.listAccounts(brandId);
    }catch(e){ /* retain the last known token-free status; UI shows retry state */ }
  }
  setConnCache({ brandId, available, accounts, loaded:true });
  if(["connections","planner","analytics","reports"].includes(view)) render();
}
export async function connectReal(platform){
  try{
    toast("Preparing " + netOf(platform).name + "…");
    await store.ensureBrandSynced(brand());   // brand must exist server-side first
    await store.startOAuth(platform, brand().id);
    connCache.loaded = false;
    await refreshConnections(brand().id);
    const got = connCache.accounts.some(a => a.platform === platform);
    toast(got ? netOf(platform).name + " connected ✔" : "Connection not completed");
  }catch(e){ toast(e.message); }
}
export async function disconnectReal(id){
  const name=connCache.accounts.find(a=>a.id===id)?.display_name;
  if(!confirm(`Disconnect ${name || "this account"}? Scheduled posts will stop publishing to it.`)) return;
  try{
    await store.disconnectAccount(id, brand().id);
    connCache.loaded = false;
    await refreshConnections(brand().id);
    toast("Disconnected");
  }catch(e){ toast(e.message); }
}
export async function selectReal(id){
  const name=connCache.accounts.find(a=>a.id===id)?.display_name;
  try{
    await store.selectAccount(id);
    connCache.loaded = false;
    await refreshConnections(brand().id);
    toast((name || "Account") + " selected for publishing ✔");
  }catch(e){ toast(e.message); }
}
/* simulated connections (demo / local mode only) */
export function connectNet(id){
  const inp=document.getElementById("h_"+id);
  const h=inp.value.trim()||"@"+brand().name.toLowerCase().replace(/\s+/g,"");
  brand().connections[id]=h; save(); render(); toast(netOf(id).name+" simulated");
}
export function disconnectNet(id){ delete brand().connections[id]; save(); render(); toast(netOf(id).name+" removed"); }
