// A delivered TikTok draft is a successful delivery (post_targets.status =
// "published", delivered_as = "draft", remote_url NULL) that never went
// public. This exercises the real render path — the calendar chip and the
// delivery panel — rather than the isolated postVisibleStatus()/deliveryPanel()
// unit tests in test/frontend-units.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "../../test-harness/app.mjs";

const account = { id: "a1", platform: "tiktok", display_name: "@acme", status: "active",
  is_default: true, needs_reauth: false, last_verified_at: "2026-06-15T11:55:00Z" };

function fixture(targets) {
  return {
    available: ["tiktok"],
    accounts: [account],
    db: {
      activeBrand: "b1",
      brands: [{
        id: "b1", name: "Acme", seed: 3, connections: {},
        smartlink: { title: "Acme", bio: "", avatar: "🚀", color: "#22c1dc", links: [] },
        inbox: [],
        posts: [{
          id: "p1", date: "2026-06-15", time: "09:00", text: "Behind the scenes",
          networks: ["tiktok"], status: "published", media_url: "https://cdn.example.com/clip.mp4",
          tiktok_mode: "draft", targets,
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

test("a delivered TikTok draft's chip and delivery panel say sent to drafts, never published", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: fixture([
      { post_id: "p1", platform: "tiktok", status: "published", delivered_as: "draft",
        remote_id: "publish-1", remote_url: null, failure_kind: null, error: null },
    ]),
  });
  t.after(() => app.close());

  assert.equal(chip(app).className, "post drafted",
    "a draft-only delivery must not chip as published");
  assert.match(chip(app).getAttribute("aria-label"), /Sent to drafts/);
  assert.doesNotMatch(chip(app).getAttribute("aria-label"), /[Pp]ublished/);

  await openPost(app);
  const panelText = app.text(".delivery-panel");
  assert.match(panelText, /Sent to TikTok drafts/);
  assert.doesNotMatch(panelText, /Published/);
  assert.doesNotMatch(panelText, /view post/);
  assert.equal(app.$(".delivery-panel a"), null, "no permalink for a post with no public URL");
});
