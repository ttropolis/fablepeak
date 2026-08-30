// ADR 0006 delivery item 2, UI half: in-app team invitations.
//
// The guarantees are in Postgres — invites_* policies on is_owner, create_invite
// and revoke_invite re-checking ownership, accept/decline authorising on the
// caller's own confirmed auth.users address (test/team-invitations.test.mjs
// asserts those). This suite asserts what a person actually sees and can press:
// that an owner gets the invite form, that an editor does not, that an invitee
// is offered an explicit Accept/Decline and that accepting brings the workspace
// with it, and that demo mode says out loud that it is simulating.
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "../../test-harness/app.mjs";

const brand = (id, name) => ({
  id, name, seed: 5, connections: {}, inbox: [], posts: [],
  smartlink: { title: name, bio: "", avatar: "🚀", color: "#22c1dc",
    links: [{ id: "l1", title: "Site", url: "https://example.com", clicks: 0 }] },
});
const db = { activeBrand: "b1", brands: [brand("b1", "Acme")] };

const MEMBERS = [
  { member_id: "user-1", member_email: "owner@example.com", member_role: "owner" },
  { member_id: "user-2", member_email: "editor@example.com", member_role: "editor" },
];
// The frozen clock is 2026-06-15; these are 9 days out and 2 days stale.
const LIVE = "2026-06-24T12:00:00Z";
const STALE = "2026-06-13T12:00:00Z";
const INVITE = {
  id: "inv-1", email: "pending@example.com", role: "editor",
  status: "pending", created_at: "2026-06-10T12:00:00Z", expires_at: LIVE,
};

const cloud = (extra = {}) => ({ db, members: MEMBERS, ...extra });

async function openSettings(app) {
  await app.click(app.byText("#nav button", "Settings"));
  await app.flush();
}
/** the Settings → Team card, found the way a person finds it: by its heading */
const teamCard = app => app.byText(".card", "Team");
const rowEmails = (app, selector) =>
  app.$$(selector, teamCard(app)).map(r => r.textContent.replace(/\s+/g, " ").trim());

test("an owner sees the roster, the pending list and the invite form", async t => {
  const app = await bootApp({ mode: "cloud", cloud: cloud({ invites: [INVITE] }) });
  t.after(() => app.close());
  await openSettings(app);
  await app.waitFor(() => app.state.teamCache.loaded, { label: "the team lookup" });
  await app.flush();

  const card = teamCard(app);
  assert.ok(card, "Settings shows a Team card in cloud mode");
  // decision 12: co-members see each other's addresses, not bare UUIDs
  assert.match(rowEmails(app, ".teamrow")[0], /owner@example\.com \(you\)/);
  assert.match(rowEmails(app, ".teamrow")[1], /editor@example\.com/);
  assert.equal(card.textContent.includes("user-2"), false, "never a raw UUID");

  // the pending invitation, with the deadline in words and a Revoke control
  assert.match(rowEmails(app, ".pendingrow")[0], /pending@example\.com/);
  // the deadline in words, never a raw timestamp (the exact day count depends
  // on the runner's timezone, so the shape is what matters)
  assert.match(card.textContent, /expires in \d+ days/);
  assert.equal(card.textContent.includes(LIVE), false);
  assert.ok(app.byText("button", "Revoke", card));

  assert.ok(app.$("#teamEmail", card), "the invite form is here");
  assert.ok(app.$("#teamRole", card));
  // there is no mail provider in v1, and the card has to say so
  assert.match(card.textContent, /does not send email yet/);
  assert.match(card.textContent, /expire after 14 days/);
});

test("inviting sends the address and role, then re-reads the pending list", async t => {
  const app = await bootApp({ mode: "cloud", cloud: cloud() });
  t.after(() => app.close());
  await openSettings(app);
  await app.waitFor(() => app.state.teamCache.loaded, { label: "the team lookup" });
  await app.flush();

  // the invite lands in the pending list the moment the RPC answers
  app.store.listInvites = async () => app.intoPage([INVITE]);
  await app.fill("#teamEmail", "  Pending@Example.COM  ");
  await app.fill("#teamRole", "owner");
  await app.click(app.byText("button", "Invite", teamCard(app)));
  await app.waitFor(() => app.storeCalls.some(c => c.name === "inviteMember"),
    { label: "the invite call" });

  const call = app.storeCalls.find(c => c.name === "inviteMember");
  // normalised in the browser too, so what the owner reads back is what the
  // invitee's confirmed address will be compared against
  assert.deepEqual(call.args, ["b1", "pending@example.com", "owner"]);
  assert.match(app.toast(), /tell them to sign up/);
  await app.waitFor(() => app.$(".pendingrow"), { label: "the refreshed pending list" });
  assert.match(rowEmails(app, ".pendingrow")[0], /pending@example\.com/);
});

test("a refused invite is a message, not a failure", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: cloud({ inviteResult: { ok: false, error: "already_member" } }),
  });
  t.after(() => app.close());
  await openSettings(app);
  await app.waitFor(() => app.state.teamCache.loaded, { label: "the team lookup" });
  await app.flush();

  await app.fill("#teamEmail", "editor@example.com");
  await app.click(app.byText("button", "Invite", teamCard(app)));
  await app.waitFor(() => app.toast(), { label: "the refusal" });
  assert.match(app.toast(), /already in this workspace/);
});

test("revoking calls the RPC and drops the row", async t => {
  const app = await bootApp({ mode: "cloud", cloud: cloud({ invites: [INVITE] }) });
  t.after(() => app.close());
  await openSettings(app);
  await app.waitFor(() => app.state.teamCache.loaded, { label: "the team lookup" });
  await app.flush();

  app.store.listInvites = async () => app.intoPage([]);
  await app.click(app.byText("button", "Revoke", teamCard(app)));
  await app.waitFor(() => app.storeCalls.some(c => c.name === "revokeInvite"),
    { label: "the revoke call" });
  assert.deepEqual(app.storeCalls.find(c => c.name === "revokeInvite").args, ["inv-1"]);
  await app.waitFor(() => !app.$(".pendingrow"), { label: "the row to go" });
  assert.match(app.toast(), /revoked/);
});

test("an expired invitation is labelled, and re-inviting the same address is offered", async t => {
  // The database side is the sweep in create_invite; the UI's job is to stop
  // showing a stale row as if it were live.
  const app = await bootApp({
    mode: "cloud",
    cloud: cloud({ invites: [{ ...INVITE, expires_at: STALE }] }),
  });
  t.after(() => app.close());
  await openSettings(app);
  await app.waitFor(() => app.state.teamCache.loaded, { label: "the team lookup" });
  await app.flush();

  assert.match(rowEmails(app, ".pendingrow")[0], /expired/);
  // and nothing blocks a fresh invite to that same address
  await app.fill("#teamEmail", "pending@example.com");
  await app.click(app.byText("button", "Invite", teamCard(app)));
  await app.waitFor(() => app.storeCalls.some(c => c.name === "inviteMember"),
    { label: "the re-invite" });
  assert.deepEqual(app.storeCalls.find(c => c.name === "inviteMember").args,
    ["b1", "pending@example.com", "editor"]);
});

test("an editor reads the roster but is offered no way to manage it", async t => {
  // invites: [] is not a render gate — invites_select is is_owner(brand_id), so
  // this is what the database itself hands an editor.
  const app = await bootApp({
    mode: "cloud", cloud: cloud({ role: "editor", invites: [] }),
  });
  t.after(() => app.close());
  await app.waitFor(() => app.state.roleCache.loaded, { label: "the role lookup" });
  await openSettings(app);
  await app.waitFor(() => app.state.teamCache.loaded, { label: "the team lookup" });
  await app.flush();

  const card = teamCard(app);
  assert.equal(app.$$(".teamrow", card).length, 2, "the roster is still readable");
  assert.equal(app.$("#teamEmail", card), null, "no invite form");
  assert.equal(app.$("#teamRole", card), null);
  assert.equal(app.byText("button", "Revoke", card), null);
  assert.match(card.textContent, /Only its owners can invite or remove people/);
});

test("an invitee is offered Accept or Decline, and accepting brings the workspace", async t => {
  const invitation = {
    invite_id: "inv-9", brand_name: "Beta Studio", invite_role: "editor",
    invited_at: "2026-06-10T12:00:00Z", expires_at: LIVE,
  };
  const app = await bootApp({
    mode: "cloud",
    cloud: cloud({ invitations: [invitation] }),
  });
  t.after(() => app.close());
  await app.waitFor(() => app.$("#inviteBanner"), { label: "the invitations banner" });

  const banner = app.$("#inviteBanner");
  assert.match(banner.textContent, /Beta Studio/);
  assert.match(banner.textContent, /as editor/);
  assert.match(banner.textContent, /Nothing is shared with you until you accept/);
  // nothing about the workspace beyond its name reached the browser
  assert.equal(app.$$("#brandSel option").length, 1);

  // Accepting adds a brand_members row server-side, so the workspace has to be
  // re-read rather than patched: the new brand arrives with its own content.
  const joined = { activeBrand: "b1", brands: [brand("b1", "Acme"), brand("b9", "Beta Studio")] };
  app.store.load = async () => app.intoPage(joined);
  app.store.myInvitations = async () => app.intoPage([]);

  await app.click(app.byText("#inviteBanner button", "Accept"));
  await app.waitFor(() => app.storeCalls.some(c => c.name === "acceptInvite"),
    { label: "the accept call" });
  assert.deepEqual(app.storeCalls.find(c => c.name === "acceptInvite").args, ["inv-9"]);

  await app.waitFor(() => app.$$("#brandSel option").length === 2,
    { label: "the joined workspace to load" });
  assert.deepEqual(app.$$("#brandSel option").map(o => o.textContent), ["Acme", "Beta Studio"]);
  await app.waitFor(() => !app.$("#inviteBanner"), { label: "the banner to clear" });
});

test("declining answers the invitation and leaves the workspace alone", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: cloud({ invitations: [{
      invite_id: "inv-9", brand_name: "Beta Studio", invite_role: "owner",
      invited_at: "2026-06-10T12:00:00Z", expires_at: LIVE }] }),
  });
  t.after(() => app.close());
  await app.waitFor(() => app.$("#inviteBanner"), { label: "the invitations banner" });

  app.store.myInvitations = async () => app.intoPage([]);
  await app.click(app.byText("#inviteBanner button", "Decline"));
  await app.waitFor(() => app.storeCalls.some(c => c.name === "declineInvite"),
    { label: "the decline call" });
  assert.deepEqual(app.storeCalls.find(c => c.name === "declineInvite").args, ["inv-9"]);
  await app.waitFor(() => !app.$("#inviteBanner"), { label: "the banner to clear" });
  assert.equal(app.storeCalls.some(c => c.name === "acceptInvite"), false);
  assert.deepEqual(app.$$("#brandSel option").map(o => o.textContent), ["Acme"]);
});

test("an invitation follows the user across views, including onboarding", async t => {
  // An account created only to accept someone else's invitation has no brand of
  // its own, so the banner must survive the first-brand onboarding screen.
  const app = await bootApp({
    mode: "cloud",
    cloud: { db: null, members: [], invitations: [{
      invite_id: "inv-9", brand_name: "Beta Studio", invite_role: "editor",
      invited_at: "2026-06-10T12:00:00Z", expires_at: LIVE }] },
  });
  t.after(() => app.close());
  await app.waitFor(() => app.$("#inviteBanner"), { label: "the invitations banner" });
  assert.ok(app.$("#ob_name"), "the onboarding form is still there");
  assert.match(app.$("#inviteBanner").textContent, /Beta Studio/);
});

test("an address is rendered as text wherever it appears", async t => {
  const hostile = "<img src=x onerror=alert(1)>@example.com";
  const app = await bootApp({
    mode: "cloud",
    cloud: cloud({
      members: [{ member_id: "user-9", member_email: hostile, member_role: "editor" }],
      invites: [{ ...INVITE, email: hostile }],
      invitations: [{ invite_id: "inv-9", brand_name: "<script>x</script>Beta",
        invite_role: "editor", invited_at: LIVE, expires_at: LIVE }],
    }),
  });
  t.after(() => app.close());
  await openSettings(app);
  await app.waitFor(() => app.state.teamCache.loaded, { label: "the team lookup" });
  await app.flush();

  assert.equal(app.$("#main img"), null, "no element was built from an address");
  assert.equal(app.$("#main script"), null);
  assert.ok(app.main().textContent.includes(hostile), "it is shown verbatim, as text");
  assert.ok(app.$("#inviteBanner").textContent.includes("<script>x</script>Beta"));
});

test("demo mode simulates the team, says so, and reaches no network", async t => {
  const app = await bootApp({ mode: "demo" });
  t.after(() => app.close());
  await openSettings(app);

  const card = teamCard(app);
  assert.match(card.textContent, /Simulated — team features need a cloud account/);
  assert.equal(app.$$(".teamrow", card).length, 2, "two simulated members (ADR 0006 §5)");
  assert.equal(app.$$(".pendingrow", card).length, 1, "one simulated pending invite");

  // every control toasts instead of mutating, and nothing is ever fetched
  await app.click(app.byText("button", "Invite", card));
  assert.match(app.toast(), /Simulated team/);
  await app.click(app.byText("button", "Revoke", card));
  assert.match(app.toast(), /Simulated team/);
  assert.equal(app.$("#inviteBanner"), null, "no invitations without an account");
  assert.deepEqual(app.blockedRequests, []);
});

test("local mode has no accounts, so the Team card is the simulated one", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);

  const card = teamCard(app);
  assert.match(card.textContent, /Simulated — team features need a cloud account/);
  assert.match(card.textContent, /runs without accounts/);
  assert.equal(app.state.teamCache.loaded, false, "no team lookup without a cloud account");
  assert.equal(app.state.inviteCache.loaded, false);
  assert.deepEqual(app.blockedRequests, []);
});
