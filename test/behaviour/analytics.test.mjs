// ADR 0003 Phase 3: Analytics tells the truth about where its numbers came
// from, and measures follower growth from the first day that was actually
// measured rather than from a zero it invented.
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "../../test-harness/app.mjs";

const brand = {
  id: "b1", name: "Acme", seed: 4, connections: {},
  smartlink: { title: "Acme", bio: "", avatar: "🚀", color: "#22c1dc", links: [] },
  inbox: [], posts: [],
};
const accounts = [{
  id: "a1", platform: "instagram", display_name: "@acme", status: "active",
  is_default: true, needs_reauth: false, last_verified_at: "2026-06-15T11:55:00Z",
}];

/* Only the last three days of the 30-day window carry rows. The 27 days before
   them were never measured, which is exactly the case the baseline must skip. */
const metrics = [
  { date: "2026-06-13", platform: "instagram", followers: 100, impressions: 1000, engagements: 100, posts: 1 },
  { date: "2026-06-14", platform: "instagram", followers: 110, impressions: 1200, engagements: 130, posts: 2 },
  { date: "2026-06-15", platform: "instagram", followers: 130, impressions: 1500, engagements: 180, posts: 1 },
];

async function openAnalytics(app) {
  await app.click(app.byText("#nav button", "Analytics"));
  await app.waitFor(() => app.text("h1") === "Analytics", { label: "the analytics view" });
}
const kpi = (app, label) =>
  app.$$(".kpi").find(card => card.querySelector(".l").textContent === label);

test("real follower growth starts at the first measured baseline", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: { db: { activeBrand: "b1", brands: [brand] }, available: ["instagram"], accounts, metrics },
  });
  t.after(() => app.close());

  await openAnalytics(app);
  await app.waitFor(() => app.main().textContent.includes("Real platform metrics"),
    { label: "the real-metrics banner" });

  const followers = kpi(app, "Followers");
  assert.equal(followers.querySelector(".n").textContent, "130");
  assert.equal(followers.querySelector(".d").textContent.replace(/\s+/g, " ").trim(),
    "▲ 30 this month",
    "130 − 100, the first measured day — not 130 − 0, the first day of the window");
  assert.match(followers.querySelector(".d").className, /\bup\b/);

  assert.equal(kpi(app, "Posts published").querySelector(".n").textContent, "4",
    "posts come from the measured rows, not from the local calendar");
  assert.match(app.main().textContent, /Pulled from connected platforms by the daily metrics job/);
  assert.match(app.main().textContent, /Estimated Best times to post/,
    "the heatmap stays labelled as an estimate even beside real metrics");
});

test("a workspace with no ingested rows says its numbers are simulated", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: { db: { activeBrand: "b1", brands: [brand] }, available: ["instagram"], accounts, metrics: [] },
  });
  t.after(() => app.close());

  await openAnalytics(app);
  await app.waitFor(() => app.main().textContent.includes("simulated"),
    { label: "the simulated-metrics banner" });
  assert.match(app.main().textContent, /⚠️ These numbers are simulated\./);
  assert.doesNotMatch(app.main().textContent, /● Real platform metrics/);
});

test("a metrics failure says so instead of passing the fallback off as real", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: { db: { activeBrand: "b1", brands: [brand] }, available: ["instagram"], accounts },
  });
  t.after(() => app.close());

  app.store.listMetrics = async () => { throw new Error("permission denied"); };
  app.setState("metricsCache", app.intoPage(
    { brandId: null, rows: [], loaded: false, loading: false, error: null }));

  await openAnalytics(app);
  await app.waitFor(() => app.main().textContent.includes("Real metrics could not be loaded"),
    { label: "the metrics error notice" });
  assert.match(app.main().textContent, /permission denied/);
  assert.match(app.main().textContent, /Showing generated sample data/);
});
