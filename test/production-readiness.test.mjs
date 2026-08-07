import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("public review URLs exist and are linked from customer onboarding", async () => {
  const index = await read("index.html");
  const worker = await read("sw.js");
  for (const file of ["privacy.html", "terms.html", "data-deletion.html"]) {
    const page = await read(file);
    assert.match(page, /<!doctype html>/i);
    assert.match(page, /<meta name="viewport"/i);
    assert.match(index, new RegExp(`href="/${file.replace(".", "\\.")}"`));
    assert.match(worker, new RegExp(`"\\./${file.replace(".", "\\.")}"`));
    assert.doesNotMatch(page, /TODO|CHANGEME|\{\{.+?\}\}/i);
  }
});

test("privacy and deletion notices describe provider-token handling", async () => {
  const privacy = await read("privacy.html");
  const deletion = await read("data-deletion.html");
  assert.match(privacy, /application-encrypted before database storage/i);
  assert.match(privacy, /do not sell/i);
  assert.match(deletion, /Disconnect/i);
  assert.match(deletion, /removes the stored provider credentials/i);
  assert.match(deletion, /Request deletion by email/i);
});

test("self-service deletion removes credentials and preserves shared workspaces", async () => {
  const source = await read("supabase/functions/delete-account/index.ts");
  const migration = await read(
    "supabase/migrations/20260802150000_account_deletion.sql",
  );
  const html = await read("index.html");
  const deletion = await read("data-deletion.html");
  assert.match(source, /getUser\(jwt\)/);
  assert.match(source, /body\.confirm !== "DELETE"/);
  assert.match(source, /grant_type=password/);
  assert.match(source, /password: body\.password/);
  assert.match(source, /sbRpc\("prepare_account_deletion"/);
  assert.match(migration, /create table if not exists public\.account_deletion_jobs/);
  assert.match(migration, /delete from public\.social_connections where user_id = target_user/);
  assert.match(migration, /update public\.brand_members set role = 'owner'/);
  assert.match(migration, /security definer/);
  assert.match(source, /for \(const brandId of brandIds\) await deleteWorkspaceMedia/);
  assert.match(source, /storage\/v1\/object\/list\/social-media/);
  assert.match(source, /offset \+= 1000/);
  assert.match(source, /paths\.slice\(start, start \+ 1000\)/);
  assert.match(source, /auth\/v1\/admin\/users\/\$\{user\.id\}/);
  assert.match(html, /async function deleteCloudAccount/);
  assert.match(html, /Type DELETE to continue/);
  assert.match(html, /JSON\.stringify\(\{confirm:"DELETE",password\}\)/);
  assert.match(deletion, /Under <strong>Delete account<\/strong>/);
});

test("production auth redirects point at the deployed application", async () => {
  const config = await read("supabase/config.toml");
  assert.match(config, /site_url = "https:\/\/fablepeak\.com"/);
  assert.match(config, /additional_redirect_urls = \["https:\/\/fablepeak\.com"/);
});

test("local database reset does not reference a missing seed file", async () => {
  const config = await read("supabase/config.toml");
  assert.match(config, /\[db\.seed\][\s\S]*?enabled = false/);
});

test("the migration chain contains a fresh-project schema baseline", async () => {
  const first = await read(
    "supabase/migrations/20260731090000_reliable_scheduling.sql",
  );
  const refreshable = await read(
    "supabase/migrations/20260801193000_fix_refreshable_account_status.sql",
  );
  for (const table of [
    "brands", "posts", "brand_members", "social_connections",
    "oauth_states", "post_targets", "metrics_daily",
  ]) {
    assert.match(first, new RegExp(`create table if not exists public\\.${table}`));
  }
  assert.ok(
    first.indexOf("create table if not exists public.posts") <
      first.indexOf("alter table public.posts add column if not exists publish_claimed_at"),
    "base tables must be created before incremental scheduling changes",
  );
  assert.ok(
    refreshable.indexOf("drop view if exists public.social_accounts_public") <
      refreshable.indexOf("create or replace view public.social_accounts_public"),
    "historical view migrations must drop incompatible fresh-baseline projections first",
  );
});

test("production checklist matches implemented Meta and Google scopes", async () => {
  const checklist = await read("PRODUCTION_ONBOARDING.md");
  const platforms = await read("supabase/functions/_shared/platforms.ts");
  for (const scope of [
    "pages_show_list", "pages_manage_posts", "pages_read_engagement",
    "instagram_business_basic", "instagram_business_content_publish",
    "youtube.upload", "youtube.readonly",
  ]) {
    assert.match(platforms, new RegExp(scope.replace(/[.-]/g, "\\$&")));
    assert.match(checklist, new RegExp(scope.replace(/[.-]/g, "\\$&")));
  }
  assert.match(checklist, /unrelated to\s+the FablePeak owners\/developers/i);
});

test("general signup includes confirmation-grade passwords and recovery", async () => {
  const html = await read("index.html");
  const config = await read("supabase/config.toml");
  assert.match(config, /minimum_password_length = 8/);
  assert.match(config, /enable_confirmations = true/);
  assert.match(config, /secure_password_change = true/);
  assert.match(html, /resetPasswordForEmail/);
  assert.match(html, /event === "PASSWORD_RECOVERY"/);
  assert.match(html, /async function completePasswordReset/);
  assert.match(html, /pw\.length<8/);
});

test("Edge Function gateway settings preserve callback and cron authentication", async () => {
  const config = await read("supabase/config.toml");
  for (const fn of [
    "oauth-start", "oauth-callback", "connection-health",
    "publish", "ingest-metrics", "delete-account",
  ]) {
    assert.match(config, new RegExp(`\\[functions\\.${fn}\\]\\nverify_jwt = false`));
  }
});

test("Edge Function mutation endpoints reject unsupported HTTP methods", async () => {
  for (const fn of [
    "oauth-start", "connection-health", "publish", "ingest-metrics", "delete-account",
  ]) {
    const source = await read(`supabase/functions/${fn}/index.ts`);
    assert.match(source, /req\.method !== "POST"/,
      `${fn} should reject non-POST mutation requests`);
    assert.match(source, /method not allowed/);
  }
  const callback = await read("supabase/functions/oauth-callback/index.ts");
  assert.match(callback, /jsr:@supabase\/server@1\.4\.1/);
});

test("signed-in customers can upload provider-fetchable media within their workspace", async () => {
  const html = await read("index.html");
  const migration = await read(
    "supabase/migrations/20260802140000_workspace_media.sql",
  );
  assert.match(migration, /'social-media', 'social-media', true, 52428800/);
  assert.match(migration, /public\.is_member\(\(storage\.foldername\(name\)\)\[1\]\)/);
  assert.match(migration, /for insert to authenticated/);
  assert.match(migration, /for delete to authenticated/);
  assert.match(html, /async uploadMedia\(file, brandId, onProgress=\(\)=>\{\}\)/);
  assert.match(html, /storage\.from\("social-media"\)\.upload/);
  assert.match(html, /async function uploadPostMedia/);
  assert.match(html, /file\.size>50\*1024\*1024/);
  assert.match(html, /tus-js-client@4\.3\.1/);
  assert.match(html, /storage\.supabase\.co\/storage\/v1\/upload\/resumable/);
  assert.match(html, /chunkSize:6\*1024\*1024/);
  assert.match(html, /capture="environment"/);
  assert.match(html, /Preparing iPhone photo/);
  assert.match(html, /Wait for the media upload to finish/);
});

test("the installable phone experience has launch shortcuts and a mobile planner", async () => {
  const html = await read("index.html");
  const manifest = JSON.parse(await read("manifest.json"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.orientation, "any");
  assert.deepEqual(manifest.shortcuts.map(shortcut => shortcut.url), [
    "./?action=new-post", "./?action=planner", "./?action=connections",
  ]);
  assert.match(html, /function handleLaunchAction/);
  assert.match(html, /beforeinstallprompt/);
  assert.match(html, /Use FablePeak on your phone/);
  assert.match(html, /class="mobile-agenda"/);
  assert.match(html, /class="agenda-post"/);
  assert.match(html, /beforeunload/);
  assert.match(html, /matchMedia\("\(min-width: 821px\)"\)\.matches/,
    "phone auth screens should not summon the software keyboard automatically");
});

test("live customer connections show an honest status for every planned platform", async () => {
  const html = await read("index.html");
  assert.doesNotMatch(html, /LAUNCH_PLATFORMS/);
  assert.match(html, /const PLATFORM_PENDING_STATUS =/);
  assert.match(html, /NETWORKS\.map\(n => \{/);
  for (const status of [
    "Meta review or tester access pending",
    "Paid API credentials pending",
    "Developer app credentials pending",
    "Deferred — compliance workflow pending",
    "Not implemented",
  ]) assert.match(html, new RegExp(status));
});

test("incomplete provider workflows cannot be enabled by secrets alone", async () => {
  const platforms = await read("supabase/functions/_shared/platforms.ts");
  const start = await read("supabase/functions/oauth-start/index.ts");
  const publish = await read("supabase/functions/publish/index.ts");
  const tiktok = platforms.match(
    /const tiktok: PlatformAdapter = \{([\s\S]*?)\n\};\n\nexport const ADAPTERS/,
  );
  assert.ok(tiktok);
  assert.match(tiktok[1], /productionEnabled: false/);
  assert.match(platforms, /platformConnectionEnabled\(a\)/);
  assert.match(start, /!platformConnectionEnabled\(adapter\)/);
  assert.match(publish, /!dependencies\.platformConnectionEnabled\(adapter\)/);
});

test("Pinterest requires explicit board selection and remains production-gated", async () => {
  const platforms = await read("supabase/functions/_shared/platforms.ts");
  const callback = await read("supabase/functions/oauth-callback/index.ts");
  const publish = await read("supabase/functions/publish/index.ts");
  const pinterest = platforms.match(
    /const pinterest: PlatformAdapter = \{([\s\S]*?)\n\};\n\nexport const ADAPTERS/,
  );
  assert.ok(pinterest);
  assert.match(pinterest[1], /scopes: \["boards:read", "boards:write", "pins:read", "pins:write"\]/);
  assert.match(pinterest[1], /requiresExplicitSelection: true/);
  assert.match(pinterest[1], /sharedAuthorizationAcrossAssets: true/);
  assert.match(pinterest[1], /productionEnabled: false/);
  assert.match(pinterest[1], /source_type: "image_url"/);
  assert.match(pinterest[1], /video Pins are not supported yet/);
  assert.match(callback, /adapter\.requiresExplicitSelection \? false : index === 0/);
  assert.match(callback,
    /adapter\.sharedAuthorizationAcrossAssets[\s\S]*?crypto\.randomUUID\(\)/);
  assert.match(callback, /authorization_id: authorizationId/);
  assert.match(callback, /sbRpc\("replace_shared_social_connections"/);
  const atomicConnections = await read(
    "supabase/migrations/20260807170000_pinterest_atomic_connections.sql",
  );
  assert.match(atomicConnections, /pg_advisory_xact_lock/);
  assert.match(atomicConnections,
    /delete from public\.social_connections[\s\S]*?insert into public\.social_connections/);
  assert.match(atomicConnections, /p_platform <> 'pinterest'/);
  assert.match(atomicConnections, /grant execute[\s\S]*?to service_role/);
  assert.match(publish, /!conn && !adapter\.requiresExplicitSelection/);
  const tokenManager = await read("supabase/functions/_shared/token-manager.ts");
  assert.match(tokenManager,
    /adapter\.sharedAuthorizationAcrossAssets && conn\.brand_id && authorizationId/);
  assert.match(tokenManager, /meta->>authorization_id=eq\./);
  const health = await read("supabase/functions/connection-health/index.ts");
  assert.match(health, /const sharedAccessTokens = new Map<string, string>\(\)/);
  assert.match(health, /sharedAccessTokens\.get\(authorizationId\)/);
  assert.match(health, /sharedAccessTokens\.set\(authorizationId, accessToken\)/);
});

test("media-capable adapters never silently discard an attachment", async () => {
  const html = await read("index.html");
  const platforms = await read("supabase/functions/_shared/platforms.ts");
  const publish = await read("supabase/functions/publish/index.ts");
  const x = platforms.match(/const x: PlatformAdapter = \{([\s\S]*?)\n\};\n\n\/\* ---------------------------------------------------------------- Meta base/);
  const linkedin = platforms.match(/const linkedin: PlatformAdapter = \{([\s\S]*?)\n\};\n\n\/\* -------------------------------------------------------------------- TikTok/);
  assert.ok(x && linkedin);
  assert.match(x[1], /supportsMedia: true/);
  assert.match(x[1], /media_ids: \[mediaId\]/);
  assert.match(linkedin[1], /supportsMedia: true/);
  assert.match(linkedin[1], /content: \{ media: \{ id: imageUrn \} \}/);
  assert.match(linkedin[1], /currently supports image attachments only/);
  assert.match(html, /LinkedIn currently supports image attachments only/);
  assert.match(publish, /post\.media_url && adapter\.supportsMedia === false/);
  assert.match(publish, /media was not sent/);
});

test("mixed-network failures identify the failed platform and reason", async () => {
  const html = await read("index.html");
  assert.match(html, /const failures = bad\.map\(r=>/);
  assert.match(html, /\$\{netOf\(r\.platform\)\.name\}: \$\{r\.error\|\|r\.status\}/);
  assert.doesNotMatch(html, /\$\{bad\.length\} failed/);
});

test("ambiguous provider outcomes require verification before retrying", async () => {
  const platforms = await read("supabase/functions/_shared/platforms.ts");
  const publish = await read("supabase/functions/publish/index.ts");
  assert.match(platforms, /class PublishOutcomeUnknownError extends Error/);
  assert.match(platforms, /Instagram may have accepted this post\. Verify the profile before retrying\./);
  assert.match(publish, /e instanceof PublishOutcomeUnknownError[\s\S]*?\? INTERRUPTED/);
});

test("production smoke test is read-only and covers public security gates", async () => {
  const script = await read("scripts/production-smoke.mjs");
  assert.match(script, /expectedVersion/);
  assert.match(script, /mobile PWA manifest and launch shortcuts are live/);
  assert.match(script, /mobile PWA icons are publicly downloadable/);
  assert.match(script, /service worker matches the deployed app release/);
  assert.match(script, /OAuth discovery reports the three launch platforms/);
  assert.match(script, /connection-health/);
  assert.match(script, /delete-account/);
  assert.doesNotMatch(script, /Authorization:/);
});

test("CI type-checks functions and rebuilds the database from migrations", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const pkg = JSON.parse(await read("package.json"));
  assert.match(pkg.scripts.check, /npm test/);
  assert.match(pkg.scripts["check:functions"], /deno@2\.9\.4 check/);
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /supabase db start/);
  assert.match(workflow, /supabase db reset --local --no-seed/);
});

test("cloud startup failures do not promise an unsafe local sync fallback", async () => {
  const html = await read("index.html");
  assert.match(html, /Cloud unavailable — reconnect to sign in, or explore the demo/);
  assert.doesNotMatch(html, /Cloud unavailable — running locally/);
  assert.match(html, /document\.querySelector\("aside"\)\.inert = true/);
  assert.match(html, /document\.getElementById\("main"\)\.inert = true/);
  assert.match(html, /document\.getElementById\("main"\)\.replaceChildren\(\)/);
  assert.match(html, /document\.getElementById\("nav"\)\.replaceChildren\(\)/);
  assert.match(html, /document\.querySelector\("aside"\)\.inert = false/);
});
