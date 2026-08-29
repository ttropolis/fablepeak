import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

/* ADR 0003 Phase 2b. index.html is markup and CSS again: the application is
   native ES modules under js/, loaded through one entry. This is the layout
   contract — every module is reachable from that entry, parses as a module, and
   no application JavaScript has crept back into the page. */
test("the app is one ES module entry, and every js/ module parses", async () => {
  const html = await read("index.html");
  assert.match(html, /<script type="module" src="\.\/js\/main\.js"><\/script>/,
    "index.html must load the app through js/main.js");
  assert.doesNotMatch(html, /<script>[\s\S]*?<\/script>/,
    "no inline application script may come back — module scope is not global");

  const files = (await readdir(new URL("js/", root))).filter(name => name.endsWith(".js")).sort();
  assert.ok(files.includes("main.js") && files.length > 5,
    `expected the js/ module directory, found ${files.join(", ")}`);
  for (const name of files) {
    const source = await read(`js/${name}`);
    assert.doesNotThrow(() => new vm.SourceTextModule(source, { identifier: name }),
      `js/${name} must parse as an ES module`);
  }

  /* Reachability: following every static import from the entry has to arrive at
     all of them, or a file is dead code — or, worse, precached and never run. */
  const seen = new Set(["main.js"]);
  for (const name of seen) {
    const source = await read(`js/${name}`);
    for (const [, specifier] of source.matchAll(/from\s+"\.\/([\w.-]+\.js)"/g)) seen.add(specifier);
  }
  assert.deepEqual([...seen].sort(), files,
    "every js/ module must be reachable from js/main.js");
});

test("Edge Function claims posts before publishing", async () => {
  const source = await read("supabase/functions/publish/index.ts");
  assert.match(source, /sbRpc\("claim_due_posts"/);
  assert.match(source, /"claim_post_for_retry"\s*:\s*"claim_post_for_publish"/);
  assert.doesNotMatch(source, /new Date\(`\$\{p\.date\}/);
  assert.match(source, /APP_TIMEZONE.*Australia\/Perth/);
  assert.match(source, /publishClaimedPost/);
  assert.match(source, /status=eq\.publishing/);
  assert.match(source, /retryPending \? "scheduled"[\s\S]*?allPublished \? "published" : "failed"/);
  assert.match(source, /previous\?\.status === "published"/,
    "a recovered claim must not repeat a delivery already recorded as successful");
  assert.match(source, /previous\?\.status === "publishing"/,
    "an uncertain provider result must require verification instead of an automatic retry");
  assert.match(source, /Delivery was interrupted\. Verify the platform before retrying/);
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

test("stale publishing claims become visible and manually retryable", async () => {
  const migration = await read(
    "supabase/migrations/20260805090000_recover_stale_publish_claims.sql",
  );
  assert.match(migration, /publish_claimed_at < now\(\) - interval '15 minutes'/i);
  assert.match(migration, /set status = 'failed'/i);
  assert.match(migration, /set status = 'draft'/i);
  assert.match(migration, /Delivery was interrupted/i);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /grant execute[^;]+to service_role/i);
});

test("delivery recovery distinguishes safe retries from unknown outcomes", async () => {
  const migration = await read(
    "supabase/migrations/20260809110000_delivery_recovery.sql",
  );
  assert.match(migration,
    /status in \('draft', 'scheduled', 'publishing', 'published', 'failed'\)/);
  assert.match(migration, /failure_kind[\s\S]*?'retryable'[\s\S]*?'permanent'[\s\S]*?'unknown'/);
  assert.match(migration, /next_retry_at/);
  assert.match(migration, /attempts < 3/);
  assert.match(migration, /failure_kind = 'retryable'/);
  assert.match(migration, /next_retry_at <= now\(\)/);
  assert.match(migration, /failure_kind = 'unknown'/);
  assert.match(migration, /create or replace function public\.claim_post_for_retry/);
  assert.match(migration, /coalesce\(t\.failure_kind, 'permanent'\) <> 'unknown'/,
    "manual retry must not resend a target with an ambiguous provider outcome");
});

test("authenticated delivery retries use the dedicated safe-retry claim", async () => {
  const source = await read("supabase/functions/publish/index.ts");
  assert.match(source, /body\.retry\s*\?\s*"claim_post_for_retry"\s*:\s*"claim_post_for_publish"/);
  assert.match(source, /No retryable delivery targets are available/);
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

test("backend token-refresh failures require an explicit reconnect", async () => {
  const source = await read("supabase/functions/_shared/token-manager.ts");
  assert.match(source, /catch \(e\) \{[\s\S]*?await expire\(/);
  assert.match(source, /Could not refresh access — reconnect this account/);
  assert.match(source, /status: "active"/);
  assert.match(source, /last_error: null/);
});

/* The release-coupling contract: bumping the app without bumping the service
   worker's cache name would leave returning users on the old bundle forever.
   test-browser/service-worker.browser.mjs asserts the runtime half — that the
   cache Chromium actually created is the one this version names. */
test("PWA cache version matches the visible app release", async () => {
  const constants = await read("js/constants.js");
  const worker = await read("sw.js");
  const appVersion = constants.match(/const APP_VERSION = "([^"]+)"/)?.[1];
  const cacheVersion = worker.match(/const CACHE = "fablepeak-v([^"]+)"/)?.[1];
  assert.ok(appVersion, "APP_VERSION should exist");
  assert.equal(cacheVersion, appVersion);
});

test("PWA never caches authenticated API responses or serves app HTML for assets", async () => {
  const worker = await read("sw.js");
  assert.match(worker, /url\.origin === self\.location\.origin/);
  assert.match(worker, /url\.origin === "https:\/\/esm\.sh"/);
  assert.match(worker, /if \(!sameOrigin && !trustedModule\) return/);
  assert.match(worker, /headers\.has\("authorization"\)/);
  assert.match(worker, /e\.request\.mode === "navigate"/);
  assert.doesNotMatch(worker, /ignoreSearch:\s*true/);
  assert.match(worker, /status: 503/);
});

/* Source-text by design: an exact-version pin and a cross-origin check are
   assertions about what must *not* change. The auth-event wiring is here for
   the same reason — reaching it needs a real Supabase client, which no tier
   has; test/frontend-units.test.mjs owns the parts of init() that can run. */
test("browser SDK is pinned and OAuth completion messages are source-checked", async () => {
  const remote = await read("js/remote-store.js");
  assert.match(remote, /@supabase\/supabase-js@\d+\.\d+\.\d+/);
  assert.doesNotMatch(remote, /@supabase\/supabase-js@2["']/);
  assert.match(remote, /e\.origin !== location\.origin \|\| e\.source !== popup/);
  assert.match(remote, /event === "SIGNED_OUT"/,
    "a sign-out anywhere must clear the cached user");
  assert.match(remote, /event === "PASSWORD_RECOVERY"/);
});
