// ADR 0003 flow 5 (delivery panel): per-target outcomes from post_targets drive retry, verification and planner status.
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "../../test-harness/app.mjs";

const brandBase = {
  id: "b1", name: "Acme", seed: 3, connections: {},
  smartlink: { title: "Acme", bio: "", avatar: "🚀", color: "#22c1dc", links: [] },
  inbox: [],
};
const accounts = [{
  id: "a1", platform: "instagram", display_name: "@acme", status: "active",
  is_default: true, needs_reauth: false, last_verified_at: "2026-06-15T11:55:00Z",
}];

function fixture(targets, status = "scheduled") {
  return {
    available: ["instagram"],
    accounts,
    db: {
      activeBrand: "b1",
      brands: [{
        ...brandBase,
        posts: [{
          id: "p1", date: "2026-06-15", time: "09:00", text: "Multi-network drop",
          networks: ["instagram", "facebook"], status, media_url: "", targets,
        }],
      }],
    },
  };
}

const chip = app => app.$(".calgrid .post");
async function openPost(app) {
  await app.click(chip(app));
  await app.waitFor(() => app.$(".delivery-panel") || app.$("#pm_text"),
    { label: "the post modal" });
}
const rows = app => app.$$(".delivery-panel .delivery-row").map(row => ({
  cls: row.className,
  network: row.querySelector("strong").textContent,
  detail: row.querySelector("span").textContent,
  error: row.querySelector("small")?.textContent ?? null,
}));

test("a post with no delivery records shows no delivery panel", async t => {
  const app = await bootApp({ mode: "cloud", cloud: fixture([]) });
  t.after(() => app.close());
  await openPost(app);
  assert.equal(app.$(".delivery-panel"), null);
});

test("retryable failures offer a retry and keep the post out of the failed state", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: fixture([
      { post_id: "p1", platform: "instagram", status: "published",
        remote_url: "https://instagram.com/p/abc", failure_kind: null, error: null },
      { post_id: "p1", platform: "facebook", status: "failed", failure_kind: "retryable",
        error: "Rate limited", next_retry_at: "2026-06-15T13:00:00Z" },
    ]),
  });
  t.after(() => app.close());

  assert.equal(chip(app).className, "post scheduled",
    "a retryable failure is not yet a failure the planner should shout about");

  await openPost(app);
  const [instagram, facebook] = rows(app);
  assert.equal(instagram.cls, "delivery-row published");
  assert.equal(instagram.network, "Instagram");
  assert.equal(instagram.detail, "Published — view post");
  assert.equal(instagram.error, null);
  assert.equal(app.$(".delivery-panel a").href, "https://instagram.com/p/abc");
  assert.equal(facebook.network, "Facebook");
  assert.match(facebook.detail, /^Automatic retry scheduled for .+/);
  assert.equal(facebook.error, "Rate limited");
  assert.ok(app.byText(".delivery-panel button", "Retry failed targets now"));
});

test("an unknown outcome asks for verification and offers no retry", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: fixture([
      { post_id: "p1", platform: "instagram", status: "failed", failure_kind: "unknown",
        error: "Timed out waiting for Instagram" },
    ]),
  });
  t.after(() => app.close());

  assert.equal(chip(app).className, "post failed",
    "an ambiguous outcome must surface in the planner");

  await openPost(app);
  const [target] = rows(app);
  assert.equal(target.network, "Instagram");
  assert.equal(target.detail,
    "Verify on Instagram before doing anything else — delivery may have succeeded.");
  assert.equal(target.error, "Timed out waiting for Instagram");
  assert.equal(app.byText(".delivery-panel button", "Retry failed targets now"), null,
    "an ambiguous target must never offer a one-click resend");
});

test("a permanent failure mixed with a success shows as failed in the planner", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: fixture([
      { post_id: "p1", platform: "instagram", status: "published", remote_url: "", failure_kind: null },
      { post_id: "p1", platform: "facebook", status: "failed", failure_kind: "permanent",
        error: "The Page was deleted" },
    ], "published"),
  });
  t.after(() => app.close());

  assert.equal(chip(app).className, "post failed");
  await openPost(app);
  const [instagram, facebook] = rows(app);
  assert.equal(instagram.detail, "Published");
  assert.equal(instagram.error, null);
  assert.equal(facebook.detail, "The Page was deleted");
  assert.equal(facebook.error, "The Page was deleted");
  assert.ok(app.byText(".delivery-panel button", "Retry failed targets now"));
});

test("retrying asks for confirmation, calls the backend and re-reads the delivery records", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: fixture([
      { post_id: "p1", platform: "instagram", status: "published", remote_url: "", failure_kind: null },
      { post_id: "p1", platform: "facebook", status: "failed", failure_kind: "retryable",
        error: "Rate limited" },
    ]),
  });
  t.after(() => app.close());

  const settled = [
    { post_id: "p1", platform: "instagram", status: "published", remote_url: "", failure_kind: null },
    { post_id: "p1", platform: "facebook", status: "published", remote_url: "", failure_kind: null },
  ];
  app.store.retryPost = async id => {
    app.storeCalls.push({ name: "retryPost", args: [id] });
    return app.intoPage(settled.map(({ platform, status }) => ({ platform, status })));
  };
  app.store.listTargets = async () => app.intoPage(settled);

  await openPost(app);
  await app.click(app.byText(".delivery-panel button", "Retry failed targets now"));
  await app.waitFor(() => app.toast() === "Delivery retry completed — review the per-network results",
    { label: "the retry to finish" });

  assert.deepEqual(app.storeCalls.filter(c => c.name === "retryPost"), [{ name: "retryPost", args: ["p1"] }]);
  assert.match(app.confirms.at(-1), /^Retry only failed deliveries that are safe to send again\?/);
  assert.equal(app.modalOpen(), false);
  assert.equal(chip(app).className, "post published");
});
