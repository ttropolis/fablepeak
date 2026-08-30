// ADR 0006 decisions 9, 11 and 13 — the approval workflow's UI half.
//
// The guarantee is the posts_guard_status_transition trigger
// (test/post-approval.test.mjs asserts that). This suite asserts the product:
// an editor is offered submit and never schedule, an owner is offered the
// decision, the note the owner writes reaches the author, the calendar says
// which posts are waiting, and — the one that matters most for a feature
// shipped dormant — a workspace with the flag off looks exactly as it did
// before any of this existed.
import assert from "node:assert/strict";
import test from "node:test";
import { TODAY, bootApp } from "../../test-harness/app.mjs";

const post = (id, status, extra = {}) => ({
  id, date: TODAY, time: "10:00", text: `Post ${id}`, networks: ["x"],
  status, media_url: "", variants: {}, approval_note: "", ...extra,
});
const brand = (id, name, approval, posts) => ({
  id, name, seed: 5, connections: { x: "@acme" }, inbox: [], posts,
  approval_required: approval,
  smartlink: { title: name, bio: "", avatar: "🚀", color: "#22c1dc",
    links: [{ id: "l1", title: "Site", url: "https://example.com", clicks: 0 }] },
});
const account = {
  id: "a1", platform: "x", display_name: "@acme", status: "active",
  is_default: true, needs_reauth: false, last_verified_at: "2026-06-15T11:55:00Z",
  last_error: null, avatar_url: null,
};

/** A signed-in cloud workspace whose only brand is `approval`-gated or not. */
async function boot(t, { role = "owner", approval = true, posts = [] } = {}) {
  const app = await bootApp({
    mode: "cloud",
    cloud: {
      role, available: ["x"], accounts: [account],
      db: { activeBrand: "b1", brands: [brand("b1", "Acme", approval, posts)] },
    },
  });
  t.after(() => app.close());
  await app.waitFor(() => app.state.roleCache.loaded, { label: "the role lookup" });
  return app;
}
const open = async (app, id) => { await app.call("openPostModal", id); await app.flush(); };
const statuses = app => [...app.$("#pm_status").options].map(o => o.value);
const labels = app => [...app.$("#pm_status").options].map(o => o.textContent);
const save = app => app.click(app.$(".modalfoot .right button.btn:not(.ghost)"));
const postOf = (app, id) => app.db.brands[0].posts.find(p => p.id === id);
const chipOf = (app, id) => app.$(`.post[data-arg="${id}"]`);

/* ---------- the editor's half: submit and withdraw ---------- */

test("an editor can submit for approval and can never select scheduled", async t => {
  const app = await boot(t, { role: "editor", posts: [post("p1", "draft")] });

  await open(app, "p1");
  assert.deepEqual(statuses(app), ["draft", "pending_approval"],
    "the ladder stops at pending approval for an editor");
  assert.deepEqual(labels(app), ["draft", "pending approval"],
    "the value is a database word; the label is English");
  assert.equal(app.byText(".modalfoot button", "Publish now"), null,
    "Publish now is service-executed, so it is withdrawn rather than left as a bypass");

  await app.fill("#pm_status", "pending_approval");
  await save(app);
  assert.equal(postOf(app, "p1").status, "pending_approval");
  assert.match(app.toast(), /Submitted for approval/);
  assert.equal(chipOf(app, "p1").className, "post pending_approval");
});

test("an editor can withdraw a submission back to a draft", async t => {
  const app = await boot(t, { role: "editor", posts: [post("p1", "pending_approval")] });

  await open(app, "p1");
  assert.match(app.modal().textContent, /Waiting for approval/);
  assert.equal(app.$("#pm_approval_note"), null, "the note box belongs to the decider");
  assert.equal(app.byText(".approval-panel button", "Approve & schedule"), null);

  await app.fill("#pm_status", "draft");
  await save(app);
  assert.equal(postOf(app, "p1").status, "draft");
});

/* ---------- the owner's half: approve and request changes ---------- */

test("an owner approves a pending post, and the spent note goes with it", async t => {
  const app = await boot(t, {
    posts: [post("p1", "pending_approval", { approval_note: "Earlier feedback" })],
  });

  await open(app, "p1");
  assert.deepEqual(statuses(app), ["draft", "pending_approval", "scheduled"]);
  await app.click(app.byText(".approval-panel button", "Approve & schedule"));

  const p = postOf(app, "p1");
  assert.equal(p.status, "scheduled");
  assert.equal(p.approval_note, "", "an approved post carries no outstanding feedback");
  assert.match(app.toast(), /Approved/);
  assert.equal(app.modalOpen(), false);
  assert.equal(chipOf(app, "p1").className, "post scheduled");
});

test("a rejection needs a note, and the note reaches the author", async t => {
  const app = await boot(t, { posts: [post("p1", "pending_approval")] });

  await open(app, "p1");
  await app.click(app.byText(".approval-panel button", "Request changes"));
  assert.match(app.toast(), /Say what needs changing/);
  assert.equal(postOf(app, "p1").status, "pending_approval", "nothing moved");
  assert.equal(app.modalOpen(), true);

  await app.fill("#pm_approval_note", "Shorten the opening line.");
  await app.click(app.byText(".approval-panel button", "Request changes"));
  const p = postOf(app, "p1");
  assert.equal(p.status, "draft");
  assert.equal(p.approval_note, "Shorten the opening line.");
  assert.equal(chipOf(app, "p1").className, "post draft");

  // …and the same refusal guards the plain Save path, which can make the same
  // move through the status select
  await open(app, "p1");
  await app.fill("#pm_status", "pending_approval");
  await save(app);
  assert.equal(postOf(app, "p1").approval_note, "",
    "a fresh submission clears the decision it answers");
});

test("an owner cannot send a post back through the select without a note either", async t => {
  const app = await boot(t, { posts: [post("p1", "pending_approval")] });
  await open(app, "p1");
  await app.fill("#pm_approval_note", "   ");
  await app.fill("#pm_status", "draft");
  await save(app);
  assert.match(app.toast(), /Add a note saying what needs changing/);
  assert.equal(postOf(app, "p1").status, "pending_approval");
});

test("the note is rendered as text, however it was written", async t => {
  const PAYLOAD = `"><img src=x onerror="alert(1)">`;
  const app = await boot(t, {
    role: "editor",
    posts: [post("p1", "draft", { approval_note: PAYLOAD })],
  });

  await open(app, "p1");
  const panel = app.$(".approval-panel");
  assert.match(panel.textContent, /Changes requested/);
  assert.ok(panel.textContent.includes(PAYLOAD), "the author sees exactly what was written");
  assert.equal(panel.querySelector("img"), null, "and nothing was parsed as markup");
});

/* ---------- the calendar: chip, legend, filter, badge ---------- */

test("the calendar names the new state, and the filter narrows to it", async t => {
  const app = await boot(t, {
    posts: [post("p1", "pending_approval"), post("p2", "draft"), post("p3", "scheduled")],
  });

  assert.match(app.main().textContent, /Needs approval/, "the legend gains an entry");
  assert.equal(chipOf(app, "p1").getAttribute("aria-label"),
    "10:00, pending approval: Post p1", "the chip says it in English");
  assert.equal(app.$$(".post").length, 3);

  await app.click(app.byText("#pm_approval_filter button", "Needs approval"));
  assert.equal(app.$$(".post").length, 1, "only the pending post is on the calendar");
  assert.ok(chipOf(app, "p1"));
  assert.equal(chipOf(app, "p2"), null);

  await app.click(app.byText("#pm_approval_filter button", "All posts"));
  assert.equal(app.$$(".post").length, 3, "switching back is the whole undo");
});

test("the nav badge counts what is waiting, for the owner who can act on it", async t => {
  const app = await boot(t, {
    posts: [post("p1", "pending_approval"), post("p2", "pending_approval")],
  });
  assert.equal(app.text("nav .navbadge"), "2");
  assert.match(app.$("nav .navbadge").getAttribute("aria-label"), /2 waiting for approval/);

  const editor = await bootApp({
    mode: "cloud",
    cloud: {
      role: "editor", available: ["x"], accounts: [account],
      db: { activeBrand: "b1", brands: [brand("b1", "Acme", true,
        [post("p1", "pending_approval")])] },
    },
  });
  t.after(() => editor.close());
  await editor.waitFor(() => editor.state.roleCache.loaded, { label: "the role lookup" });
  assert.equal(editor.$("nav .navbadge"), null,
    "an editor cannot act on the count, so they are not shown one");
  assert.ok(editor.byText("#pm_approval_filter button", "Needs approval"),
    "but they can still see what they submitted");
});

/* ---------- Settings: the opt-in itself ---------- */

test("only an owner can turn approval on, and an editor is told who can", async t => {
  const app = await boot(t, { approval: false });
  await app.click(app.byText("#nav button", "Settings"));
  assert.equal(app.$("#brandApproval").disabled, false);
  assert.equal(app.$("#brandApproval").checked, false, "off is the shipped default");

  await app.check("#brandApproval", true);
  await app.waitFor(() => app.storeCalls.some(c => c.name === "setApprovalRequired"));
  assert.deepEqual(app.storeCalls.find(c => c.name === "setApprovalRequired").args, ["b1", true]);
  assert.match(app.toast(), /now need an owner's approval/);
  assert.equal(app.db.brands[0].approval_required, true);

  const editor = await boot(t, { role: "editor", approval: true });
  await editor.click(editor.byText("#nav button", "Settings"));
  assert.equal(editor.$("#brandApproval").disabled, true);
  assert.equal(editor.$("#brandApproval").title, "Only workspace owners can change this.");
  assert.equal(editor.$("#brandApproval").checked, true, "an editor still sees the state");
  assert.match(editor.main().textContent, /Only this workspace's owners can turn approval/);
});

test("a refused toggle puts the switch back where the server left it", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: {
      role: "owner", available: [], accounts: [],
      approvalError: "only a workspace owner can change whether posts need approval",
      db: { activeBrand: "b1", brands: [brand("b1", "Acme", false, [])] },
    },
  });
  t.after(() => app.close());
  await app.click(app.byText("#nav button", "Settings"));
  await app.check("#brandApproval", true);
  await app.waitFor(() => app.toast().includes("only a workspace owner"));
  assert.equal(app.$("#brandApproval").checked, false);
  assert.equal(app.db.brands[0].approval_required, false);
});

/* ---------- the regression that matters: the flag off ---------- */

test("with approval off, the planner and composer are exactly what they were", async t => {
  const app = await boot(t, {
    approval: false, posts: [post("p1", "draft"), post("p2", "scheduled")],
  });

  assert.equal(app.$("#pm_approval_filter"), null, "no filter for a brand that has not opted in");
  assert.equal(app.$("nav .navbadge"), null, "no badge");
  assert.equal(app.main().textContent.includes("Needs approval"), false, "no legend entry");

  await open(app, "p1");
  assert.deepEqual(statuses(app), ["draft", "scheduled"]);
  assert.equal(app.$(".approval-panel"), null);
  assert.ok(app.byText(".modalfoot button", "Publish now"), "Publish now is untouched");
  await app.fill("#pm_status", "scheduled");
  await save(app);
  assert.equal(postOf(app, "p1").status, "scheduled");
  assert.match(app.toast(), /Post updated/);
});

test("a post left pending when the flag went off keeps its own status as an option", async t => {
  const app = await boot(t, { approval: false, posts: [post("p1", "pending_approval")] });
  // the chip is still on the calendar, so the legend still explains it
  assert.match(app.main().textContent, /Needs approval/);
  await open(app, "p1");
  assert.deepEqual(statuses(app), ["draft", "pending_approval", "scheduled"]);
  assert.equal(app.$("#pm_status").value, "pending_approval",
    "a save must not silently move a post the composer did not ask about");
});

/* ---------- demo mode ---------- */

test("demo mode labels the toggle as simulated and reaches no network", async t => {
  const app = await bootApp({ mode: "demo" });
  t.after(() => app.close());

  await app.click(app.byText("#nav button", "Settings"));
  const label = app.$("#brandApproval").closest("label");
  assert.match(label.textContent, /Simulated — approval needs a cloud workspace/);
  assert.equal(app.$("#brandApproval").disabled, false, "simulated controls are pressable");

  await app.check("#brandApproval", true);
  assert.match(app.toast(), /Simulated/);
  assert.equal(app.$("#brandApproval").checked, false, "and change nothing");
  assert.deepEqual(app.blockedRequests, [], "ADR 0004 decision 11: no network at all");

  await app.click(app.byText("#nav button", "Planner"));
  assert.equal(app.$("#pm_approval_filter"), null);
  assert.equal(app.$("nav .navbadge"), null);
});
