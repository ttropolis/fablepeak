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
  assert.doesNotMatch(view[1], /\baccess_token\b\s*(?:,|\n|as)/i);
  assert.doesNotMatch(view[1], /\brefresh_token\b\s*(?:,|\n|as)/i);
  assert.match(
    view[1],
    /token_expires_at[\s\S]*?<\s*now\(\)[\s\S]*?refresh_token\s+is\s+null/i,
    "an expired access token remains usable when the server has a refresh token",
  );
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

test("cloud data rejects a stale preferred brand before loading accounts", async () => {
  const html = await read("index.html");
  const method = html.match(
    /_rowsToDb\(brands, posts, inbox\)\{([\s\S]*?)\n  \},\n  _dbToRows/,
  );
  assert.ok(method, "RemoteAdapter._rowsToDb should exist");
  const context = {
    localStorage: { getItem: () => "deleted-brand" },
  };
  vm.runInNewContext(
    `result = ({ _rowsToDb(brands, posts, inbox) {${method[1]}\n} })` +
      `._rowsToDb([{id:"brand-1",name:"SCH",seed:1}], [], []);`,
    context,
  );
  assert.equal(context.result.activeBrand, "brand-1");
});

test("real metrics derive daily deltas from cumulative platform snapshots", async () => {
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
        {date:date(3), platform:"youtube", followers:90, impressions:200, engagements:50, posts:0},
        {date:date(2), platform:"youtube", followers:100, impressions:210, engagements:52, posts:1},
        {date:date(1), platform:"youtube", followers:110, impressions:230, engagements:55, posts:1},
        {date:date(1), platform:"instagram", followers:50, impressions:100, engagements:20, posts:2},
        {date:date(0), platform:"instagram", followers:55, impressions:140, engagements:25, posts:1},
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
      {followers:100, impressions:10, engagement:2, posts:1},
      {followers:160, impressions:20, engagement:3, posts:3},
      {followers:165, impressions:40, engagement:5, posts:1},
    ],
  );
});

test("live published posts cannot be dragged back into the publishing queue", async () => {
  const html = await read("index.html");
  const fn = html.match(/(function dropPost\(ev,ds\)\{[\s\S]*?\n\})\nfunction openPostModal/);
  assert.ok(fn, "dropPost should exist");

  const post = {id:"post-1", date:"2026-08-01", status:"published"};
  const context = {
    liveMode: () => true,
    brand: () => ({posts:[post]}),
    save: () => { context.saved = true; },
    render: () => {},
    toast: message => { context.message = message; },
    event: {
      preventDefault(){},
      currentTarget:{classList:{remove(){}}},
      dataTransfer:{getData:()=>"post-1"},
    },
  };
  vm.runInNewContext(`${fn[1]}; dropPost(event,"2026-08-10");`, context);

  assert.equal(post.date, "2026-08-01");
  assert.equal(post.status, "published");
  assert.equal(context.saved, undefined);
  assert.match(context.message, /can't be rescheduled/);
});

test("post validation rejects watch pages and insecure media sources", async () => {
  const html = await read("index.html");
  const fn = html.match(
    /(function validatePostForm\(\{text,nets,date,time,media_url\}\)\{[\s\S]*?\n\})\nfunction savePost/,
  );
  assert.ok(fn, "validatePostForm should exist");
  const context = {
    URL,
    toast: message => { context.message = message; },
    netOf: id => ({name:id}),
  };
  vm.runInNewContext(fn[1], context);

  const base = {text:"Episode", nets:["youtube"], date:"2026-08-02", time:"10:00"};
  assert.equal(context.validatePostForm({...base, media_url:"https://youtube.com/watch?v=x"}), undefined);
  assert.match(context.message, /direct video file URL/);
  assert.equal(context.validatePostForm({...base, media_url:"http://cdn.example/video.mp4"}), undefined);
  assert.match(context.message, /https:\/\//);
  assert.equal(context.validatePostForm({...base, media_url:"https://cdn.example/video.mp4"}), true);
});

test("publish now persists the visible modal values before calling the backend", async () => {
  const html = await read("index.html");
  const fn = html.match(/(async function publishNow\(id\)\{[\s\S]*?\n\})\nfunction deletePost/);
  assert.ok(fn, "publishNow should exist");
  const post = {id:"post-1", text:"Old text", networks:["youtube"], status:"draft"};
  const order = [];
  const values = {
    text:"Updated text", nets:["youtube"], date:"2026-08-03", time:"11:00",
    status:"draft", media_url:"https://cdn.example/video.mp4",
  };
  const context = {
    brand: () => ({posts:[post]}),
    readPostForm: () => values,
    validatePostForm: () => true,
    confirm: () => true,
    toast: () => {},
    netOf: () => ({name:"YouTube"}),
    persistNow: async () => { order.push("persist"); },
    store: {publishNow: async () => {
      order.push("publish");
      assert.equal(post.text, "Updated text");
      return [];
    }},
    save: () => { order.push("save"); },
    closeModal: () => {},
    render: () => {},
    console,
  };
  await vm.runInNewContext(`${fn[1]}; publishNow("post-1");`, context);
  assert.deepEqual(order, ["persist","publish","save"]);
  assert.deepEqual(post.networks, ["youtube"]);
  assert.equal("nets" in post, false);
});

test("cached cloud edits automatically retry when the browser reconnects", async () => {
  const html = await read("index.html");
  const listener = html.match(
    /(window\.addEventListener\("online", async \(\) => \{[\s\S]*?\n\}\);)/,
  );
  assert.ok(listener, "online sync listener should exist");
  const context = {
    window: {addEventListener: (_name, callback) => { context.online = callback; }},
    store: {name:"cloud", user:{id:"user-1"}},
    db: {brands:[{id:"brand-1"}]},
    persistNow: async () => { context.persisted = true; },
    toast: message => { context.message = message; },
  };
  vm.runInNewContext(listener[1], context);
  await context.online();
  assert.equal(context.persisted, true);
  assert.match(context.message, /changes synced/);
});

test("backend token-refresh failures require an explicit reconnect", async () => {
  for (const file of ["supabase/functions/publish/index.ts", "supabase/functions/ingest-metrics/index.ts"]) {
    const source = await read(file);
    assert.match(source, /catch \(e\) \{[\s\S]*?status: "expired"/,
      `${file} should expire a connection when refresh fails`);
    assert.match(source, /Could not refresh access — reconnect this account/);
    assert.match(source, /status: "active", last_error: null/,
      `${file} should clear the reconnect error after a successful refresh`);
  }
});

test("PWA cache version matches the visible app release", async () => {
  const html = await read("index.html");
  const worker = await read("sw.js");
  const appVersion = html.match(/const APP_VERSION = "([^"]+)"/)?.[1];
  const cacheVersion = worker.match(/const CACHE = "fablepeak-v([^"]+)"/)?.[1];
  assert.ok(appVersion, "APP_VERSION should exist");
  assert.equal(cacheVersion, appVersion);
});

test("real follower growth starts at the first measured baseline", async () => {
  const html = await read("index.html");
  assert.match(html, /const followerSeries = usingReal \? s\.filter\(x=>x\.followersMeasured\) : s;/);
  assert.match(html, /const firstFollowers = followerSeries\[0\]\?\.followers \?\? last\.followers;/);
  assert.match(html, /const fDelta=last\.followers-firstFollowers;/);
});
