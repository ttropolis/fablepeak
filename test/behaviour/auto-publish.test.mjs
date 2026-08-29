// ADR 0003 Phase 3: simulated auto-publish is local/demo only — a signed-in
// cloud workspace is claimed and published by the server, never by the browser.
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, TODAY } from "../../test-harness/app.mjs";

const LS_KEY = "fablepeak_v1";

/** One brand with a scheduled post whose time is already in the past
 *  (the harness clock is frozen at 2026-06-15 12:00 local). */
function overdue() {
  return {
    activeBrand: "b1",
    brands: [{
      id: "b1", name: "Acme", seed: 7, connections: { instagram: "@acme" },
      smartlink: { title: "Acme", bio: "", avatar: "🚀", color: "#22c1dc", links: [] },
      inbox: [],
      posts: [
        { id: "p-due", date: TODAY, time: "09:00", text: "Due an hour ago",
          networks: ["instagram"], status: "scheduled", media_url: "" },
        { id: "p-later", date: TODAY, time: "23:00", text: "Still to come",
          networks: ["instagram"], status: "scheduled", media_url: "" },
      ],
    }],
  };
}
const statusOf = (app, id) => app.db.brands[0].posts.find(p => p.id === id).status;

test("local mode publishes a scheduled post once its time has passed", async t => {
  const app = await bootApp({
    mode: "local", storage: { [LS_KEY]: JSON.stringify(overdue()) },
  });
  t.after(() => app.close());

  assert.equal(statusOf(app, "p-due"), "published",
    "the local simulation is what makes demo data feel alive");
  assert.equal(statusOf(app, "p-later"), "scheduled",
    "a post that is not due yet is left alone");
  assert.equal(app.byText(".calgrid .post", "Due an hour ago").className, "post published");
});

test("demo mode publishes locally too — it is the same simulation", async t => {
  const app = await bootApp({
    mode: "demo", storage: { [LS_KEY]: JSON.stringify(overdue()) },
  });
  t.after(() => app.close());
  assert.equal(statusOf(app, "p-due"), "published");
});

test("a signed-in cloud workspace never marks a scheduled post published locally", async t => {
  const app = await bootApp({ mode: "cloud", cloud: { db: overdue() } });
  t.after(() => app.close());

  assert.equal(app.call("liveMode"), true);
  assert.equal(statusOf(app, "p-due"), "scheduled",
    "only the publish Edge Function may claim and publish a cloud post");
  assert.equal(app.byText(".calgrid .post", "Due an hour ago").className, "post scheduled");

  // Re-rendering is what runs the tick, so prove it stays refused on a second pass.
  app.call("render");
  assert.equal(statusOf(app, "p-due"), "scheduled");
});
