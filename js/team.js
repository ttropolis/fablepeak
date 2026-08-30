/* =============== TEAM: members and invitations ===============
   ADR 0006 delivery item 2, UI half. Two surfaces:

     1. Settings → Team card — who is in this workspace, and (owners only) an
        invite form plus the pending list with Revoke.
     2. The Invitations banner — shown above whatever view is open, for anyone
        whose confirmed address has a pending invite. Accept or Decline, never
        a silent auto-join (decision 4).

   Every guarantee lives in Postgres: invites_select/insert/update are
   is_owner(brand_id), create_invite and revoke_invite re-check is_owner, and
   accept/decline authorise on the caller's own confirmed auth.users address.
   Nothing here is a boundary — it decides which controls are offered, exactly
   like js/workspace.js's isOwner().

   Local and demo workspaces have no accounts, so there is nobody to invite.
   They get a clearly labelled simulated card whose controls toast and reach no
   network (ADR 0004 decision 11, restated by ADR 0006 §5). */
import { OWNER_ONLY_TITLE } from "./constants.js";
import { attr, esc } from "./escape.js";
import {
  inviteCache, setInviteCache, setRoleCache, setTeamCache, teamCache, view,
} from "./state.js";
import { liveMode, store } from "./store.js";
import { brand, isOwner, load, myRole } from "./workspace.js";
import { render, toast } from "./shell.js";

/* create_invite's typed refusals, mapped to what an owner should read. An
   unlisted code still says something true rather than nothing. */
const INVITE_ERRORS = {
  already_member: "That person is already in this workspace.",
  already_invited: "They already have a pending invitation — revoke it first to change the role.",
  invalid_email: "Enter a complete email address.",
  invalid_role: "Choose owner or editor.",
  self_invite: "That is your own address.",
  not_found: "That invitation is no longer available.",
  not_pending: "That invitation has already been answered.",
  expired: "That invitation has expired — ask for a new one.",
  email_unconfirmed: "Confirm your email address first — check your inbox for the link.",
};
const inviteError = out =>
  INVITE_ERRORS[out?.error] || "Could not complete that. Try again in a moment.";

const DAY = 864e5;
/** "expires in 6 days" / "expired" — the only thing the UI says about a date,
    so an invite's age never has to be read off a timestamp. */
export function inviteExpiry(iso){
  const at = Date.parse(String(iso ?? ""));
  if(!Number.isFinite(at)) return "";
  const days = Math.ceil((at - Date.now()) / DAY);
  if(days <= 0) return "expired";
  return days === 1 ? "expires tomorrow" : `expires in ${days} days`;
}
const expired = iso => inviteExpiry(iso) === "expired";

/* ---------- the active brand's roster and pending list ---------- */
/* Fetched once per brand, the same shape as ensureMetricsLoaded,
   ensureSmartlinkLoaded and ensureRoleLoaded. listInvites returns [] for an
   editor because the policy says so, not because this code hid it. */
export function ensureTeamLoaded(brandId){
  if(!liveMode() || !brandId) return;
  if(teamCache.brandId===brandId && (teamCache.loaded || teamCache.loading)) return;
  setTeamCache({ brandId, members:[], invites:[], loaded:false, loading:true, error:null });
  Promise.all([
    store.listMembers(brandId),
    Promise.resolve(store.listInvites(brandId)).catch(() => []),
  ])
    .then(([members, invites]) => {
      if(teamCache.brandId !== brandId) return;      // brand switched mid-flight
      setTeamCache({ brandId, members: members||[], invites: invites||[],
                     loaded:true, loading:false, error:null });
      if(view==="settings") render();
    })
    .catch(e => {
      if(teamCache.brandId !== brandId) return;
      setTeamCache({ brandId, members:[], invites:[], loaded:true, loading:false,
                     error:String(e.message || e) });
      if(view==="settings") render();
    });
}
/** Re-read after a write, without waiting for a brand switch. */
function reloadTeam(){
  // Accepting an invitation reloads the whole workspace, so this can run at a
  // moment when there is no active brand to re-read.
  const active = brand();
  if(!active) return;
  setTeamCache({ brandId:null, members:[], invites:[], loaded:false, loading:false, error:null });
  ensureTeamLoaded(active.id);
}

/* ---------- invitations addressed to this user ---------- */
/* Not per brand: an invitee is not in the brand yet, and list_my_invites()
   deliberately never returns a brand_id. Loaded once per session and after
   every accept/decline. */
export function ensureInvitesLoaded(){
  if(!liveMode()) return;
  if(inviteCache.loaded || inviteCache.loading) return;
  setInviteCache({ items:[], loaded:false, loading:true });
  Promise.resolve(store.myInvitations())
    .then(items => { setInviteCache({ items: items||[], loaded:true, loading:false }); render(); })
    // A failed lookup shows no banner, which is the honest default: an invite
    // nobody can read is one nobody can accept either.
    .catch(() => setInviteCache({ items:[], loaded:true, loading:false }));
}
function reloadInvites(){
  setInviteCache({ items:[], loaded:false, loading:false });
  ensureInvitesLoaded();
}

/* ---------- the Invitations banner ---------- */
/* Rendered above whatever view is open, including the first-brand onboarding
   screen — a brand-new account whose only reason to exist is someone else's
   invitation must not have to go hunting through Settings for it.

   `brand_name` is server-supplied and is the ONLY workspace fact an
   un-accepted invitee holds; it still goes through esc(), because it is a
   string another account typed. */
export function invitationsBanner(){
  if(!liveMode() || !inviteCache.loaded || !inviteCache.items.length) return "";
  return `<div class="card" id="inviteBanner" style="border-left:4px solid var(--accent);margin-bottom:14px">
    <h4 style="margin-bottom:4px">Invitations</h4>
    <div style="color:var(--muted);font-size:13px;margin-bottom:10px">
      ${inviteCache.items.length===1
        ? "Someone invited you to their workspace. Nothing is shared with you until you accept."
        : `You have ${inviteCache.items.length} workspace invitations. Nothing is shared with you until you accept.`}</div>
    ${inviteCache.items.map(i=>`
      <div class="inviterow" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <strong style="flex:1;min-width:160px">${esc(i.brand_name)}</strong>
        <span style="color:var(--muted);font-size:12px">as ${esc(i.invite_role)} · ${esc(inviteExpiry(i.expires_at))}</span>
        <button class="btn mini" data-action="acceptInvite" data-arg="${attr(i.invite_id)}">Accept</button>
        <button class="btn ghost mini" data-action="declineInvite" data-arg="${attr(i.invite_id)}">Decline</button>
      </div>`).join("")}
  </div>`;
}

/* ---------- Settings → Team card ---------- */
function memberRow(m){
  const you = store.user && m.member_email === String(store.user.email||"").toLowerCase();
  return `<div class="teamrow" style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
    <span style="flex:1;min-width:150px;word-break:break-all">${esc(m.member_email)}${
      you ? ` <span style="color:var(--muted);font-size:12px">(you)</span>` : ""}</span>
    <span class="rolechip" style="color:var(--muted);font-size:12px">${esc(m.member_role)}</span>
  </div>`;
}
function pendingRow(i){
  const stale = expired(i.expires_at);
  return `<div class="pendingrow" style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
    <span style="flex:1;min-width:150px;word-break:break-all">${esc(i.email)}</span>
    <span style="color:${stale?"var(--danger)":"var(--muted)"};font-size:12px">${
      esc(i.role)} · ${esc(inviteExpiry(i.expires_at))}</span>
    <button class="btn ghost mini" data-action="revokeInvite" data-arg="${attr(i.id)}">Revoke</button>
  </div>`;
}
/* ---------- leaving a workspace ---------- */
/* The UI half of members_delete's self-delete arm
   (20260830100000_owner_role_enforcement.sql §4). Offered to every member,
   because every member can use it; disabled for exactly one person — the
   workspace's only owner, whose departure brand_members_keep_an_owner refuses.
   Disabling is the affordance, the trigger is the guarantee, which is why an
   unanswered role lookup leaves the control live rather than blocked: myRole()
   is null then, and null is not "owner". */
const LAST_OWNER_TITLE =
  "You're this workspace's only owner. Make somebody else an owner first, " +
  "or delete the workspace from Settings → Brands.";
/** Am *I* the last owner? Read off the roster brand_member_list already
    returned — every member may read it (decision 12), so this needs no second
    lookup and no owner-only data. A roster that failed to load counts nobody,
    which leaves the control live and the refusal to the trigger. */
function onlyOwner(){
  return myRole() === "owner"
    && teamCache.members.filter(m => m.member_role === "owner").length === 1;
}
function leaveRow(){
  const blocked = onlyOwner();
  return `<div style="border-top:1px solid var(--line);margin-top:14px;padding-top:12px">
    <button class="btn ghost mini" data-action="leaveBrand"
      ${blocked ? `disabled title="${attr(LAST_OWNER_TITLE)}"` : ""}>Leave workspace</button>
    <div style="color:var(--muted);font-size:11.5px;margin-top:6px">${
      blocked ? esc(LAST_OWNER_TITLE)
        : "You'll lose access to this workspace until somebody invites you back."}</div>
  </div>`;
}

/* The simulated card. Two members and one pending invite, exactly as ADR 0006
   §5 specifies, labelled so nobody mistakes it for a real team — and every
   control routes to simulatedTeamAction(), which toasts and touches nothing. */
function simulatedTeamCard(){
  return `<div class="card" style="flex:1;min-width:280px;border-left:4px solid var(--chip-draft)">
    <h4 style="margin-bottom:6px">Team</h4>
    <div style="color:var(--muted);font-size:13px;margin-bottom:12px">
      <strong>Simulated — team features need a cloud account.</strong>
      ${store.name==="cloud"
        ? "Sign in to invite real teammates to a real workspace."
        : "This deployment runs without accounts, so there is nobody to invite."}</div>
    <div class="teamrow" style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
      <span style="flex:1">you@example.com <span style="color:var(--muted);font-size:12px">(you)</span></span>
      <span class="rolechip" style="color:var(--muted);font-size:12px">owner</span>
    </div>
    <div class="teamrow" style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
      <span style="flex:1">sam@example.com</span>
      <span class="rolechip" style="color:var(--muted);font-size:12px">editor</span>
    </div>
    <div style="color:var(--muted);font-size:12px;margin:12px 0 6px">Pending invitation</div>
    <div class="pendingrow" style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
      <span style="flex:1">alex@example.com</span>
      <span style="color:var(--muted);font-size:12px">editor · expires in 9 days</span>
      <button class="btn ghost mini" data-action="simulatedTeamAction">Revoke</button>
    </div>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <input type="text" id="teamEmail" placeholder="teammate@example.com" style="flex:1;min-width:150px">
      <button class="btn mini" data-action="simulatedTeamAction">Invite</button>
    </div>
    <div style="border-top:1px solid var(--line);margin-top:14px;padding-top:12px">
      <button class="btn ghost mini" data-action="simulatedTeamAction">Leave workspace</button>
      <div style="color:var(--muted);font-size:11.5px;margin-top:6px">
        Simulated — there is no membership here to give up, so this changes nothing.</div>
    </div>
  </div>`;
}
/** Settings → Team. Returns markup; renderSettings() places it in the card row. */
export function renderTeamCard(){
  if(!liveMode()) return simulatedTeamCard();
  ensureTeamLoaded(brand().id);
  const owner = isOwner();
  if(!teamCache.loaded || teamCache.brandId!==brand().id){
    return `<div class="card" style="flex:1;min-width:280px">
      <h4 style="margin-bottom:6px">Team</h4>
      <div style="color:var(--muted);font-size:13px">Loading this workspace's members…</div>
    </div>`;
  }
  const pending = teamCache.invites;
  return `<div class="card" style="flex:1;min-width:280px">
    <h4 style="margin-bottom:6px">Team</h4>
    <div style="color:var(--muted);font-size:13px;margin-bottom:12px">
      Everyone here can compose, schedule, reply and upload. Owners also delete
      the brand, connect and disconnect accounts, publish the SmartLinks page,
      and manage this list.</div>
    ${teamCache.error
      ? `<div style="color:var(--danger);font-size:12px;margin-bottom:10px">Could not load the team (${esc(teamCache.error)}).</div>`
      : ""}
    ${teamCache.members.map(memberRow).join("") ||
      `<div style="color:var(--muted);font-size:13px">Nobody else is in this workspace yet.</div>`}
    ${owner ? `
      ${pending.length ? `<div style="color:var(--muted);font-size:12px;margin:12px 0 6px">
        Pending invitation${pending.length>1?"s":""}</div>${pending.map(pendingRow).join("")}` : ""}
      <div style="color:var(--muted);font-size:12px;margin:12px 0 6px">Invite someone</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input type="email" id="teamEmail" placeholder="teammate@example.com"
          style="flex:1;min-width:150px" data-enter="inviteMember">
        <select id="teamRole" style="width:100px">
          <option value="editor">Editor</option>
          <option value="owner">Owner</option>
        </select>
        <button class="btn mini" data-action="inviteMember">Invite</button>
      </div>
      <div style="color:var(--muted);font-size:11.5px;margin-top:8px">
        FablePeak does not send email yet, so tell them yourself: they sign up at
        this address with the same email, confirm it, then Accept the invitation
        that appears. Invitations expire after 14 days.</div>`
    : `<div style="color:var(--muted);font-size:12px;margin-top:12px"
         title="${attr(OWNER_ONLY_TITLE)}">
        You're an editor in this workspace. Only its owners can invite or remove people.</div>`}
    ${leaveRow()}
  </div>`;
}

/* ---------- actions ---------- */
export function simulatedTeamAction(){
  toast("Simulated team — sign in to a cloud workspace to invite real people");
}
export async function inviteMember(){
  const email = String(document.getElementById("teamEmail")?.value || "").trim().toLowerCase();
  const role = String(document.getElementById("teamRole")?.value || "editor");
  if(!email) return toast("Enter their email address");
  try{
    const out = await store.inviteMember(brand().id, email, role);
    if(!out || out.ok!==true) return toast(inviteError(out));
    reloadTeam(); render();
    toast("Invitation created — now tell them to sign up with that address");
  }catch(e){ toast(String(e.message||e).slice(0,120)); }
}
export async function revokeInvite(id){
  try{
    const out = await store.revokeInvite(id);
    if(!out || out.ok!==true) return toast(inviteError(out));
    reloadTeam(); render();
    toast("Invitation revoked");
  }catch(e){ toast(String(e.message||e).slice(0,120)); }
}
/* Accepting adds a brand_members row, so the workspace the app is holding is
   now out of date by exactly one brand. Reload it rather than patching `db` by
   hand: load() is the one function that knows how to build a workspace from the
   server, and the new brand has to arrive with its posts, inbox and links. */
export async function acceptInvite(id){
  try{
    const out = await store.acceptInvite(id);
    if(!out || out.ok!==true) return toast(inviteError(out));
    reloadInvites();
    await load();
    reloadTeam();
    render();
    toast("You've joined the workspace ✔");
  }catch(e){ toast(String(e.message||e).slice(0,120)); }
}
/* Leaving is acceptInvite() run backwards: the caller's own brand_members row
   goes, so the workspace the app is holding is out of date by exactly one
   brand. Re-read it rather than splice `db` by hand — load() is the one
   function that knows how to build a workspace from the server, and it is also
   what picks the brand to land on. When the one that just went was the last,
   that is the onboarding screen, which is the honest state for an account with
   no workspace left. Nothing here calls save(): the departed brand is still in
   the local snapshot for a moment, and persisting it would ask the server to
   delete a brand this account no longer has any business deleting. */
export async function leaveBrand(){
  const active = brand();
  if(!active) return;
  if(!confirm("Leave this workspace? You'll lose access until re-invited.")) return;
  try{
    await store.leaveBrand(active.id);
    // The role and the roster were answers about a workspace this account is no
    // longer in; both are re-read for whichever brand load() lands on.
    setRoleCache({ brandId:null, role:null, loaded:false, loading:false });
    setTeamCache({ brandId:null, members:[], invites:[], loaded:false, loading:false, error:null });
    await load();
    reloadTeam();
    render();
    toast("You've left that workspace");
  }catch(e){ toast(String(e.message||e).slice(0,120)); }
}
export async function declineInvite(id){
  try{
    const out = await store.declineInvite(id);
    if(!out || out.ok!==true) return toast(inviteError(out));
    reloadInvites(); render();
    toast("Invitation declined");
  }catch(e){ toast(String(e.message||e).slice(0,120)); }
}
