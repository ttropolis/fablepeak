// ADR 0003 Phase 3: "Publish now" and the reconnect resync, asserted through
// the composer instead of through the source text of publishNow().
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, TODAY } from "../../test-harness/app.mjs";

const accounts = [{
  id: "a1", platform: "youtube", display_name: "Acme TV", status: "active",
  is_default: true, needs_reauth: false, last_verified_at: "2026-06-15T11:55:00Z",
}];

function fixture(extra = {}) {
  return {
    available: ["youtube"],
    accounts,
    db: {
      activeBrand: "b1",
      brands: [{
        id: "b1", name: "Acme", seed: 5, connections: {},
        smartlink: { title: "Acme", bio: "", avatar: "🚀", color: "#22c1dc", links: [] },
        inbox: [],
        posts: [{
          id: "p1", date: TODAY, time: "10:00", text: "Old text",
          networks: ["youtube"], status: "draft",
          media_url: "https://cdn.example.com/video.mp4", targets: [],
        }],
      }],
    },
    ...extra,
  };
}

const names = app => app.storeCalls.map(c => c.name);

test("publish now persists the visible composer values before calling the backend", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: fixture({ publishResults: [{ platform: "youtube", status: "published" }] }),
  });
  t.after(() => app.close());

  await app.click(".calgrid .post");
  await app.waitFor(() => app.$("#pm_text"), { label: "the composer" });
  await app.fill("#pm_text", "Updated text");

  // Whatever the backend was handed must already reflect the edit above: the
  // publish Edge Function reads the row, not the request body.
  app.store.publishNow = async id => {
    app.storeCalls.push({ name: "publishNow", args: [id] });
    assert.equal(app.db.brands[0].posts[0].text, "Updated text",
      "the row was persisted before publish was asked to read it");
    return app.intoPage([{ platform: "youtube", status: "published" }]);
  };

  const before = names(app).length;
  await app.click(app.byText(".modalfoot button", "Publish now"));
  await app.waitFor(() => app.toast().startsWith("Published to"), { label: "the publish toast" });

  const after = names(app).slice(before);
  assert.ok(after.indexOf("persist") > -1 && after.indexOf("persist") < after.indexOf("publishNow"),
    `persist must precede publishNow, got ${after.join(" → ")}`);
  assert.match(app.confirms.at(-1), /^Publish to YouTube right now\?/);

  const post = app.db.brands[0].posts[0];
  assert.equal(post.text, "Updated text");
  assert.deepEqual([...post.networks], ["youtube"]);
  assert.equal("nets" in post, false,
    "the form's `nets` key must never leak into the stored post");
  assert.equal(post.status, "published");
  assert.equal(app.modalOpen(), false);
});

test("a mixed publish result names the failed platform and its reason", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: fixture({ publishResults: [
      { platform: "youtube", status: "failed", error: "quotaExceeded" },
    ] }),
  });
  t.after(() => app.close());

  await app.click(".calgrid .post");
  await app.waitFor(() => app.$("#pm_text"), { label: "the composer" });
  await app.click(app.byText(".modalfoot button", "Publish now"));
  await app.waitFor(() => app.toast().startsWith("Failed:"), { label: "the failure toast" });

  assert.equal(app.toast(), "Failed: YouTube: quotaExceeded");
  assert.equal(app.db.brands[0].posts[0].status, "failed");
});

test("cached cloud edits automatically retry when the browser reconnects", async t => {
  const app = await bootApp({ mode: "cloud", cloud: fixture() });
  t.after(() => app.close());

  const before = names(app).filter(n => n === "persist").length;
  app.window.dispatchEvent(new app.window.Event("online"));
  await app.waitFor(() => app.toast() === "Back online — changes synced ✔",
    { label: "the reconnect toast" });

  assert.ok(names(app).filter(n => n === "persist").length > before,
    "reconnecting pushes the cached diff without waiting for another edit");
});

test("a local workspace has nothing to resync when the browser reconnects", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());

  app.clearToast();
  app.window.dispatchEvent(new app.window.Event("online"));
  await app.flush();
  assert.equal(app.toast(), "", "local mode never claims to have synced anything");
});
