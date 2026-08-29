// ADR 0003 flow 4 (drag reschedule): the rendered drag contract here, the drop itself in the Playwright tier.
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "../../test-harness/app.mjs";

const chipsOn = (app, date) =>
  app.$$(".post", app.$(`[aria-label="Schedule a post on ${date}"]`).parentElement);

const cloudFixture = {
  db: {
    activeBrand: "b1",
    brands: [{
      id: "b1", name: "Acme", seed: 11, connections: {},
      smartlink: { title: "Acme", bio: "", avatar: "🚀", color: "#22c1dc", links: [] },
      inbox: [],
      posts: [
        { id: "p-live", date: "2026-06-10", time: "09:00", text: "Already out there",
          networks: ["instagram"], status: "published", media_url: "", targets: [] },
        { id: "p-draft", date: "2026-06-18", time: "09:00", text: "Still a draft",
          networks: ["instagram"], status: "draft", media_url: "", targets: [] },
      ],
    }],
  },
  available: ["instagram"],
  accounts: [{
    id: "a1", platform: "instagram", display_name: "@acme", status: "active",
    is_default: true, needs_reauth: false, last_verified_at: "2026-06-15T11:55:00Z",
  }],
};

test("local mode marks every calendar chip draggable", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());

  const chips = app.$$(".calgrid .post");
  assert.ok(chips.length >= 7);
  assert.deepEqual([...new Set(chips.map(c => c.getAttribute("draggable")))], ["true"]);
});

test("live published posts are rendered undraggable while drafts stay draggable", async t => {
  const app = await bootApp({ mode: "cloud", cloud: cloudFixture });
  t.after(() => app.close());

  assert.equal(app.eval("liveMode()"), true);
  assert.equal(chipsOn(app, "2026-06-10")[0].getAttribute("draggable"), "false",
    "a published post must not be draggable in live mode");
  assert.equal(chipsOn(app, "2026-06-18")[0].getAttribute("draggable"), "true");
});

/* jsdom implements neither DataTransfer nor DragEvent (both are `undefined` on
   the window), so a drop can only be produced by hand-building a fake event
   object and calling the handler directly. That would assert the harness, not
   the app. ADR 0003 decision 2 puts real HTML5 drag-and-drop in the Playwright
   tier; this is the marker for it.
   Still covered elsewhere: dropPost()'s guard is exercised by the existing
   vm-based test in test/scheduling.test.mjs, and the rendered drag contract is
   asserted above. */
test("dropping a post on another day reschedules it", { skip: "Playwright tier (ADR 0003 §1b): jsdom has no DataTransfer/DragEvent" }, () => {});
test("dropping a live published post refuses with a toast", { skip: "Playwright tier (ADR 0003 §1b): jsdom has no DataTransfer/DragEvent" }, () => {});

test("jsdom really does lack the drag-and-drop platform APIs", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  // Guard the skip above: if a future jsdom ships these, this fails and the two
  // skipped flows can move back into this tier.
  assert.equal(typeof app.window.DataTransfer, "undefined");
  assert.equal(typeof app.window.DragEvent, "undefined");
});
