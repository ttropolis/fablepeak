/* Direct module-import unit tests for the frontend (ADR 0003 Phase 3).
 *
 * Until Phase 2b these guarantees were asserted by cutting a function out of
 * index.html with a regex anchored on whatever function happened to follow it,
 * then running the text under `vm`. The split makes the real thing importable,
 * so these are plain imports and plain calls: no source text, no anchors, and
 * the code under test is the code that ships.
 *
 * Only genuinely pure logic lives here. Anything that renders, toasts or reads
 * the DOM belongs in test/behaviour/, where a real document exists.
 */
import assert from "node:assert/strict";
import test from "node:test";

/* Two page-scoped globals the modules expect. `FABLEPEAK_BACKEND` is what
   backend-config.js sets, and it decides which adapter js/store.js selects —
   so it has to exist *before* that module is first evaluated, which is why the
   imports below are dynamic. `localStorage` is read by _rowsToDb. */
globalThis.FABLEPEAK_BACKEND = { url: "https://project.supabase.invalid", anonKey: "test-anon-key" };
let preferredBrand = "";
globalThis.localStorage = {
  getItem: key => (key === "fablepeak_pref_activeBrand" ? preferredBrand : null),
  setItem() {}, removeItem() {},
};

const { deliveryPanel, postStatusFromResults, postVisibleStatus } = await import("../js/planner.js");
const { realMetricSeries } = await import("../js/metrics.js");
const { RemoteAdapter } = await import("../js/remote-store.js");
const { store } = await import("../js/store.js");
const state = await import("../js/state.js");
const { fmtDate } = await import("../js/util.js");
const { esc, attr, safeUrl, slColorOf } = await import("../js/escape.js");

/* ---------------------------------------------------------------- escapers */

test("each escaper defends its own context", () => {
  assert.equal(esc(`<img src=x onerror="p()">`),
    "&lt;img src=x onerror=&quot;p()&quot;&gt;");
  // attr() also encodes whitespace, backtick and `=`, so a payload cannot end
  // the value and start a second attribute.
  assert.equal(attr(`a" onmouseover=b`), "a&#34;&#32;onmouseover&#61;b");
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("data:text/html,x"), "");
  assert.equal(safeUrl("https://example.com/p"), "https://example.com/p");
  assert.equal(slColorOf("#AB12CD"), "#AB12CD");
  assert.equal(slColorOf("red;background:url(x)"), "#22c1dc");
});

/* -------------------------------------------------------- delivery outcomes */

test("delivery panel makes retryable and ambiguous target outcomes actionable", () => {
  const retryable = deliveryPanel({ id:"p1", targets:[{
    platform:"x", status:"failed", failure_kind:"retryable", attempts:1,
    next_retry_at:"2026-08-09T00:05:00.000Z", error:"503 unavailable",
  }]});
  assert.match(retryable, /X \/ Twitter/);
  assert.match(retryable, /Automatic retry scheduled/);
  assert.match(retryable, /data-action="retryPost" data-arg="p1"/);

  const unknown = deliveryPanel({ id:"p2", targets:[{
    platform:"x", status:"failed", failure_kind:"unknown", attempts:1,
    error:"Delivery was interrupted",
  }]});
  assert.match(unknown, /Verify on X \/ Twitter before doing anything else/);
  assert.doesNotMatch(unknown, /data-action="retryPost"/);

  assert.equal(deliveryPanel({ id:"p3", targets:[] }), "",
    "a post with no delivery records renders no panel at all");
});

test("mixed permanent delivery failures remain visible in planner status", () => {
  const mixed = [
    { status:"published", platform:"facebook" },
    { status:"failed", platform:"instagram", failure_kind:"permanent" },
  ];
  assert.equal(postStatusFromResults(mixed), "failed");
  assert.equal(postVisibleStatus({ status:"published", targets:mixed }), "failed");
});

test("a retryable target keeps the post scheduled rather than failing it", () => {
  assert.equal(postStatusFromResults([
    { status:"published", platform:"facebook" },
    { status:"failed", platform:"instagram", failure_kind:"retryable" },
  ]), "scheduled");
  assert.equal(postStatusFromResults([{ status:"published", platform:"facebook" }]), "published");
  assert.equal(postStatusFromResults([]), "failed",
    "no results at all is not a success");
});

/* ------------------------------------------------------------ cloud adapter */

test("cloud data rejects a stale preferred brand before loading accounts", () => {
  preferredBrand = "deleted-brand";
  const result = RemoteAdapter._rowsToDb([{ id:"brand-1", name:"SCH", seed:1 }], [], [], []);
  assert.equal(result.activeBrand, "brand-1");

  preferredBrand = "brand-2";
  const kept = RemoteAdapter._rowsToDb(
    [{ id:"brand-1", name:"A" }, { id:"brand-2", name:"B" }], [], [], []);
  assert.equal(kept.activeBrand, "brand-2", "a brand that still exists is honoured");
  preferredBrand = "";
});

test("cloud initialization is idempotent across auth and demo transitions", async () => {
  const already = { marker: "the client this session already built" };
  RemoteAdapter._sb = already;
  await RemoteAdapter.init();
  assert.equal(RemoteAdapter._sb, already,
    "load() is reused after auth/demo transitions and must not rebuild the client");

  /* A failed init must leave no half-built client behind, or every later call
     would use it. Node refuses `import("https://…")`, which stands in for the
     browser being unable to reach the pinned esm.sh module. */
  RemoteAdapter._sb = null;
  await assert.rejects(() => RemoteAdapter.init());
  assert.equal(RemoteAdapter._sb, null, "a failed init resets _sb so it can be retried");
});

/* ---------------------------------------------------------------- metrics */

const daysAgo = n => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return fmtDate(d);
};

test("real metrics derive daily deltas from cumulative platform snapshots", () => {
  store.user = { id: "user-1", email: "owner@example.com" };   // liveMode()
  state.set("db", { activeBrand: "brand-1", brands: [{ id: "brand-1", name: "Acme", posts: [] }] });
  state.set("metricsCache", {
    brandId: "brand-1", loaded: true, loading: false, error: null,
    rows: [
      {date:daysAgo(3), platform:"youtube", followers:90, impressions:200, engagements:50, posts:0},
      {date:daysAgo(2), platform:"youtube", followers:100, impressions:210, engagements:52, posts:1},
      {date:daysAgo(1), platform:"youtube", followers:110, impressions:230, engagements:55, posts:1},
      {date:daysAgo(1), platform:"instagram", followers:50, impressions:100, engagements:20, posts:2},
      {date:daysAgo(0), platform:"instagram", followers:55, impressions:140, engagements:25, posts:1},
    ],
  });

  assert.deepEqual(
    Array.from(realMetricSeries(3, "all"), row => ({
      followers: row.followers,
      impressions: row.impressions,
      engagement: row.engagement,
      posts: row.posts,
    })),
    [
      {followers:100, impressions:10, engagement:2, posts:1},
      {followers:160, impressions:20, engagement:3, posts:3},
      {followers:165, impressions:40, engagement:5, posts:1},
    ],
  );

  store.user = null;
  assert.equal(realMetricSeries(3, "all"), null,
    "signed out there are no real metrics, only the labelled simulation");
});
