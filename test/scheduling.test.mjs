import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("browser JavaScript parses", async () => {
  const html = await read("index.html");
  const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/);
  assert.ok(inline, "expected one inline application script");
  assert.doesNotThrow(() => new Function(inline[1]));
});

test("signed-in cloud mode never marks scheduled posts published locally", async () => {
  const html = await read("index.html");
  const tick = html.match(/function tickPublish\(\)\{([\s\S]*?)\n\}/);
  assert.ok(tick, "tickPublish should exist");
  assert.match(tick[1], /if\(store\.name === "cloud" && store\.user\) return;/);
  assert.match(tick[1], /p\.status="published"/, "local demo publishing should remain available");
});

test("Edge Function claims posts before publishing", async () => {
  const source = await read("supabase/functions/publish/index.ts");
  assert.match(source, /sbRpc\("claim_due_posts"/);
  assert.match(source, /sbRpc\("claim_post_for_publish"/);
  assert.doesNotMatch(source, /new Date\(`\$\{p\.date\}/);
  assert.match(source, /APP_TIMEZONE.*Australia\/Perth/);
});

test("scheduler migration is atomic, timezone-aware, and removes the legacy job", async () => {
  const migration = await read(
    "supabase/migrations/20260731090000_reliable_scheduling.sql",
  );
  assert.match(migration, /status in \('draft', 'scheduled', 'publishing', 'published'\)/);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /now\(\) at time zone p_timezone/i);
  assert.match(migration, /'fablepeak-auto-publish'/);
  assert.match(migration, /cron\.unschedule/);
  assert.match(migration, /'fablepeak-publish-due'/);
  assert.match(migration, /vault\.decrypted_secrets/);

  const baseSchema = await read("supabase/schema.sql");
  assert.doesNotMatch(
    baseSchema,
    /update public\.posts set status='published'/,
    "base schema must not fake a successful platform delivery",
  );
});

test("connected-account view can read protected rows without exposing tokens", async () => {
  const schema = await read("supabase/schema_social.sql");
  const view = schema.match(
    /create or replace view public\.social_accounts_public([\s\S]*?)grant select on public\.social_accounts_public/,
  );
  assert.ok(view, "social_accounts_public view should be defined");
  assert.doesNotMatch(
    view[1],
    /security_invoker\s*=\s*on/i,
    "an invoker view cannot read the token table because client RLS intentionally has no policies",
  );
  assert.match(view[1], /security_invoker\s*=\s*off/i);
  assert.match(view[1], /where public\.is_member\(c\.brand_id\)/i);
  assert.doesNotMatch(view[1], /access_token|refresh_token/i);
});

test("account refresh rerenders every view that consumes connection state", async () => {
  const html = await read("index.html");
  const refresh = html.match(
    /async function refreshConnections\(brandId\)\{([\s\S]*?)\n\}/,
  );
  assert.ok(refresh, "refreshConnections should exist");
  for (const view of ["connections", "planner", "analytics", "reports"]) {
    assert.match(
      refresh[1],
      new RegExp(`(?:^|["'])${view}(?:["']|$)`),
      `${view} should rerender after connected accounts load`,
    );
  }
});

test("real metrics aggregate daily values and carry follower totals forward", async () => {
  const html = await read("index.html");
  const fn = html.match(
    /(function realMetricSeries\(days, netId\)\{[\s\S]*?\n\})\n\nfunction ensureMetricsLoaded/,
  );
  assert.ok(fn, "realMetricSeries should exist");

  const fmtDate = d =>
    d.getFullYear() + "-" +
    String(d.getMonth()+1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
  const date = daysAgo => {
    const d = new Date();
    d.setDate(d.getDate()-daysAgo);
    return fmtDate(d);
  };
  const context = {
    liveMode: () => true,
    brand: () => ({id: "brand-1"}),
    fmtDate,
    metricsCache: {
      brandId: "brand-1",
      loaded: true,
      error: null,
      rows: [
        {date:date(2), platform:"youtube", followers:100, impressions:10, engagements:2, posts:1},
        {date:date(1), platform:"youtube", followers:110, impressions:20, engagements:3, posts:1},
        {date:date(1), platform:"instagram", followers:50, impressions:30, engagements:4, posts:2},
        {date:date(0), platform:"instagram", followers:55, impressions:40, engagements:5, posts:1},
      ],
    },
  };
  vm.runInNewContext(`${fn[1]}; result = realMetricSeries(3, "all");`, context);

  assert.deepEqual(
    Array.from(context.result, row => ({
      followers: row.followers,
      impressions: row.impressions,
      engagement: row.engagement,
      posts: row.posts,
    })),
    [
      {followers:150, impressions:10, engagement:2, posts:1},
      {followers:160, impressions:50, engagement:7, posts:3},
      {followers:165, impressions:40, engagement:5, posts:1},
    ],
  );
});
