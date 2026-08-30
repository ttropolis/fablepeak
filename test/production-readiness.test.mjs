import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("public review URLs exist and are linked from customer onboarding", async () => {
  // The links live in the signed-out welcome gate, which is js/welcome.js since
  // the Phase 2b split; index.html is markup and CSS only.
  const index = await read("js/welcome.js");
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
  const html = await read("js/settings.js");
  const adapter = await read("js/remote-store.js");
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
  assert.match(adapter, /JSON\.stringify\(\{confirm:"DELETE",password\}\)/);
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
  const adapter = await read("js/remote-store.js");
  const gate = await read("js/welcome.js");
  const config = await read("supabase/config.toml");
  assert.match(config, /minimum_password_length = 8/);
  assert.match(config, /enable_confirmations = true/);
  assert.match(config, /secure_password_change = true/);
  assert.match(adapter, /resetPasswordForEmail/);
  assert.match(adapter, /event === "PASSWORD_RECOVERY"/);
  assert.match(gate, /async function completePasswordReset/);
  assert.match(gate, /pw\.length<8/);
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

test("proactive connection maintenance is deployed and scheduled independently of metrics", async () => {
  const config = await read("supabase/config.toml");
  const pkg = JSON.parse(await read("package.json"));
  const migration = await read(
    "supabase/migrations/20260809100000_proactive_connection_maintenance.sql",
  );
  assert.match(config, /\[functions\.maintain-connections\]\nverify_jwt = false/);
  assert.match(pkg.scripts["check:functions"], /maintain-connections\/index\.ts/);
  assert.match(pkg.scripts["test:functions"], /token-manager\.deno\.ts/);
  assert.match(pkg.scripts["test:functions"], /maintain-connections\/index\.deno\.ts/);
  assert.match(migration, /fablepeak-maintain-connections/);
  assert.match(migration, /\/functions\/v1\/maintain-connections/);
  assert.match(migration, /17 \* \* \* \*/,
    "renewal should run hourly so provider expiry is not tied to the daily metrics job");
});

test("every scheduled path records a durable terminal run", async () => {
  const migration = await read(
    "supabase/migrations/20260809120000_scheduled_job_health.sql",
  );
  assert.match(migration, /create table if not exists public\.scheduled_job_runs/);
  assert.match(migration, /status in \('running', 'succeeded', 'failed'\)/);
  assert.match(migration, /alter table public\.scheduled_job_runs enable row level security/);
  for (const [file, job] of [
    ["supabase/functions/publish/index.ts", "publish"],
    ["supabase/functions/ingest-metrics/index.ts", "metrics"],
    ["supabase/functions/maintain-connections/index.ts", "connections"],
  ]) {
    const source = await read(file);
    assert.match(source, new RegExp(`(?:monitorScheduledJob|dependencies\\.monitor)\\(\"${job}\"`),
      `${job} must be monitored`);
  }
});

test("scheduled production smoke alerts on authenticated cron health", async () => {
  const config = await read("supabase/config.toml");
  const pkg = JSON.parse(await read("package.json"));
  const workflow = await read(".github/workflows/production-smoke.yml");
  const smoke = await read("scripts/cron-health-smoke.mjs");
  assert.match(config, /\[functions\.operations-health\]\nverify_jwt = false/);
  assert.match(pkg.scripts["check:functions"], /operations-health\/index\.ts/);
  assert.match(pkg.scripts["test:functions"], /operations-health\/index\.deno\.ts/);
  assert.equal(pkg.scripts["smoke:cron"], "node scripts/cron-health-smoke.mjs");
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /npm run smoke:cron/);
  assert.match(smoke, /\/functions\/v1\/operations-health/);
  assert.match(smoke, /x-cron-secret/);
  assert.match(smoke, /ACTIONS_ID_TOKEN_REQUEST_URL/);
  assert.match(smoke, /audience.*fablepeak-operations/);
  assert.match(smoke, /process\.env\.CI/,
    "CI must fail rather than silently skip when its monitoring secret is absent");
});

test("AI assist keeps the provider key server-side and meters every customer", async () => {
  const config = await read("supabase/config.toml");
  const pkg = JSON.parse(await read("package.json"));
  const source = await read("supabase/functions/ai-assist/index.ts");
  const migration = await read(
    "supabase/migrations/20260829120000_ai_assist_requests.sql",
  );
  const tiers = await read(
    "supabase/migrations/20260830090000_ai_assist_tiers.sql",
  );
  const adapter = await read("js/remote-store.js");
  const setup = await read("PLATFORM_SETUP.md");

  assert.match(config, /\[functions\.ai-assist\]\nverify_jwt = false/);
  assert.match(pkg.scripts["check:functions"], /ai-assist\/index\.ts/);
  assert.match(pkg.scripts["test:functions"], /ai-assist\/index\.deno\.ts/);

  // The function does its own authentication, exactly like connection-health.
  assert.match(source, /dependencies\.authenticate\(jwt\)/);
  assert.match(source, /dependencies\.isMember\(brandId, user\.id\)/);
  // Every provider key is read from the environment, never logged, never
  // returned — one adapter per capability tier, all behind the same interface.
  for (const secret of [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_TOKEN",
  ]) {
    assert.match(source, new RegExp(`dependencies\\.env\\("${secret}"\\)`));
  }
  assert.doesNotMatch(source, /console\.(log|error)\([^)]*(apiKey|token)/);
  assert.match(source, /AI assist is not configured on the server/);
  // A declined request returns HTTP 200 — stop_reason is checked before content.
  assert.ok(
    source.indexOf('stop_reason === "refusal"') < source.indexOf("payload?.content ?? []"),
    "the refusal stop reason must be handled before the content blocks are read",
  );
  // Sampling and thinking parameters are rejected by the advanced tier's model.
  assert.doesNotMatch(source, /temperature|budget_tokens/);

  // A customer picks a capability tier, never a vendor: entitlement is decided
  // server-side, and no client-facing string names a provider.
  assert.match(source, /dependencies\.entitlements\(user\.id, brandId\)/);
  assert.match(source, /That AI tier isn't available on your plan yet\./);
  assert.match(adapter, /tier: "standard"/,
    "the browser states the tier it is entitled to rather than relying on a default");
  // Every sentence a browser can be shown is one of these constants.
  const messages = source.match(
    /const NOT_CONFIGURED =[\s\S]*?const TIER_UNAVAILABLE = "[^"]*";/,
  );
  assert.ok(messages, "the customer-facing messages must stay in one reviewable block");
  for (const vendor of [/anthropic/i, /claude/i, /openai/i, /gpt/i, /cloudflare/i, /llama/i]) {
    assert.doesNotMatch(messages[0], vendor,
      "a customer-facing message must not name a provider");
  }

  assert.match(migration, /create table if not exists public\.ai_assist_requests/);
  assert.match(migration, /alter table public\.ai_assist_requests enable row level security/);
  assert.match(migration, /grant all on public\.ai_assist_requests to service_role/);
  // The meter records which tier a request spent — forward-only, defaulted so
  // pre-tier rows stay valid.
  assert.match(tiers, /add column if not exists tier text not null default 'standard'/);
  assert.match(tiers, /check \(tier in \('standard', 'enhanced', 'advanced'\)\)/);
  assert.match(source, /recordRequest\("ai_assist_requests", \{\s*user_id: user\.id,\s*action,\s*tier,/);
  assert.match(setup, /ANTHROPIC_API_KEY/);
  assert.match(setup, /CLOUDFLARE_AI_TOKEN/);
  assert.match(setup, /AI_PROVIDER/);
});

test("Edge Function mutation endpoints reject unsupported HTTP methods", async () => {
  for (const fn of [
    "oauth-start", "connection-health", "publish", "ingest-metrics", "delete-account",
    "ai-assist",
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
  const adapter = await read("js/remote-store.js");
  const composer = await read("js/planner.js");
  const migration = await read(
    "supabase/migrations/20260802140000_workspace_media.sql",
  );
  assert.match(migration, /'social-media', 'social-media', true, 52428800/);
  assert.match(migration, /public\.is_member\(\(storage\.foldername\(name\)\)\[1\]\)/);
  assert.match(migration, /for insert to authenticated/);
  assert.match(migration, /for delete to authenticated/);
  assert.match(adapter, /async uploadMedia\(file, brandId, onProgress=\(\)=>\{\}\)/);
  assert.match(adapter, /storage\.from\("social-media"\)\.upload/);
  assert.match(composer, /async function uploadPostMedia/);
  assert.match(composer, /file\.size>50\*1024\*1024/);
  assert.match(adapter, /tus-js-client@4\.3\.1/);
  assert.match(adapter, /storage\.supabase\.co\/storage\/v1\/upload\/resumable/);
  assert.match(adapter, /chunkSize:6\*1024\*1024/);
  assert.match(composer, /capture="environment"/);
  assert.match(composer, /Preparing iPhone photo/);
  assert.match(composer, /Wait for the media upload to finish/);
});

test("the installable phone experience has launch shortcuts and a mobile planner", async () => {
  const boot = await read("js/main.js");
  const shell = await read("js/shell.js");
  const composer = await read("js/planner.js");
  const settings = await read("js/settings.js");
  const gate = await read("js/welcome.js");
  const manifest = JSON.parse(await read("manifest.json"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.orientation, "any");
  assert.deepEqual(manifest.shortcuts.map(shortcut => shortcut.url), [
    "./?action=new-post", "./?action=planner", "./?action=connections",
  ]);
  assert.match(shell, /function handleLaunchAction/);
  assert.match(boot, /beforeinstallprompt/);
  assert.match(settings, /Use FablePeak on your phone/);
  assert.match(composer, /class="mobile-agenda"/);
  assert.match(composer, /class="agenda-post"/);
  assert.match(boot, /beforeunload/);
  assert.match(gate, /matchMedia\("\(min-width: 821px\)"\)\.matches/,
    "phone auth screens should not summon the software keyboard automatically");
});

test("core mobile workflows expose live feedback and keyboard-operable controls", async () => {
  const html = await read("index.html");
  const shell = await read("js/shell.js");
  const composer = await read("js/planner.js");
  const inbox = await read("js/inbox.js");
  assert.match(html, /id="toast"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="modalBody"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(shell, /function handleModalKeydown\(event\)/);
  assert.match(shell, /event\.key==="Escape"/);
  assert.match(shell, /event\.key!=="Tab"/);
  assert.match(shell, /previousModalFocus\?\.focus/);
  assert.match(composer, /<button type="button" class="post \$\{attr\(visibleStatus\)\}"/);
  assert.match(inbox, /<button type="button" class="card msg/);
  assert.match(composer, /<small class="netreason">Not connected<\/small>/,
    "disabled network explanations must be visible without hover");
  assert.match(html, /:focus-visible/);
});

/** index.html plus every js/ module, keyed by path. */
async function appSources() {
  const names = (await readdir(new URL("js/", root))).filter(name => name.endsWith(".js"));
  const entries = await Promise.all(names.map(async name => [`js/${name}`, await read(`js/${name}`)]));
  return { "index.html": await read("index.html"), ...Object.fromEntries(entries) };
}

/* ADR 0003 §2a, now load-bearing. An inline onclick resolves against global
   scope, and since Phase 2b the app lives in module scope, so a single inline
   handler is a dead control rather than a style lapse. This is the permanent
   guard that they do not come back — and that no rendered data-* action name
   can be misspelled into a silently dead control either. It scans the rendered
   markup wherever it now lives: the page and every module that builds HTML. */
test("no markup carries an inline event handler, and every action name is registered", async () => {
  const sources = await appSources();
  const actions = sources["js/actions.js"];

  for (const [name, source] of Object.entries(sources)) {
    const inline = [...source.matchAll(/\son[a-z]+\s*=\s*["']/gi)].map(m => m[0].trim());
    assert.deepEqual(inline, [],
      `${name} must carry no inline on* handler — use data-action + ACTIONS`);
  }

  const registry = actions.match(/export const ACTIONS = \{([\s\S]*?)\n\};/);
  assert.ok(registry, "the delegated action registry should exist");
  const registered = new Set(
    [...registry[1].matchAll(/^\s{2}([A-Za-z]\w*):/gm)].map(m => m[1]));
  assert.ok(registered.size >= 45, `expected a full action table, got ${registered.size}`);

  const used = new Set(Object.values(sources).flatMap(source => [...source.matchAll(
    /\sdata-(?:action|change|input|enter|drag|drop)="([^"$]+)"/g)].map(m => m[1])));
  assert.ok(used.size > 0, "rendered markup should name actions");
  assert.deepEqual([...used].filter(name => !registered.has(name)), [],
    "every data-action / data-change / data-input / data-enter / data-drag / " +
    "data-drop name must resolve in the ACTIONS table");

  assert.match(actions, /document\.addEventListener\("click",\s*ev => runAction\(ev, "action"\)\)/,
    "the click listener is installed once, on a root that survives render()");
  assert.match(actions, /export function installDelegatedHandlers\(\)/);
  assert.match(sources["js/main.js"], /installDelegatedHandlers\(\);/,
    "…and the entry module actually installs it");
});

/* ADR 0003 decision 3 retired file:// in favour of the installed PWA, which
   makes sw.js the offline story. The app is now twenty ES modules, so one
   missing from the precache list is a blank page offline, not a degraded one. */
test("the service worker precaches every module the app is built from", async () => {
  const worker = await read("sw.js");
  const modules = (await readdir(new URL("js/", root)))
    .filter(name => name.endsWith(".js")).map(name => `./js/${name}`).sort();
  const assets = worker.match(/const ASSETS = \[([\s\S]*?)\];/);
  assert.ok(assets, "sw.js should declare its precache list");
  const listed = [...assets[1].matchAll(/"(\.\/js\/[\w.-]+\.js)"/g)].map(m => m[1]).sort();
  assert.deepEqual(listed, modules,
    "js/ and the sw.js precache list must name exactly the same modules");
  assert.match(assets[1], /"\.\/index\.html"/);
  assert.doesNotMatch(assets[1], /backend-config/,
    "backend-config.js is absent by design on local deployments and must stay uncached");
});

test("live customer connections show an honest status for every planned platform", async () => {
  const html = await read("js/connections.js");
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

test("provider expansion remains frozen for the internal-first beta milestone", async () => {
  const platforms = await read("supabase/functions/_shared/platforms.ts");
  const decision = await read("docs/adr/0001-internal-first-external-beta-readiness.md");
  for (const name of ["x", "linkedin"]) {
    const adapter = platforms.match(
      new RegExp(`const ${name}: PlatformAdapter = \\{([\\s\\S]*?)\\n\\};\\n\\n/\\*`),
    );
    assert.ok(adapter, `${name} adapter should exist`);
    assert.match(adapter[1], /productionEnabled: false/,
      `${name} must require an explicit post-milestone code change`);
  }
  assert.match(decision, /Production provider scope is frozen to Facebook, Instagram and YouTube/);
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
    /connectionUpdateQuery\(conn, !!adapter\?\.sharedAuthorizationAcrossAssets\)/);
  assert.match(tokenManager, /shared && conn\.brand_id && authorizationId/);
  assert.match(tokenManager, /meta->>authorization_id=eq\./);
  const health = await read("supabase/functions/connection-health/index.ts");
  assert.match(health, /const sharedAccessTokens = new Map<string, string>\(\)/);
  assert.match(health, /sharedAccessTokens\.get\(authorizationId\)/);
  assert.match(health, /sharedAccessTokens\.set\(authorizationId, accessToken\)/);
});

test("media-capable adapters never silently discard an attachment", async () => {
  const html = await read("js/planner.js");
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
  const html = await read("js/planner.js");
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
  const workspace = await read("js/workspace.js");
  const gate = await read("js/welcome.js");
  assert.match(workspace, /Cloud unavailable — reconnect to sign in, or explore the demo/);
  assert.doesNotMatch(workspace, /Cloud unavailable — running locally/);
  assert.match(gate, /document\.querySelector\("aside"\)\.inert = true/);
  assert.match(gate, /document\.getElementById\("main"\)\.inert = true/);
  assert.match(gate, /document\.getElementById\("main"\)\.replaceChildren\(\)/);
  assert.match(gate, /document\.getElementById\("nav"\)\.replaceChildren\(\)/);
  assert.match(gate, /document\.querySelector\("aside"\)\.inert = false/);
});

/* ADR 0005 delivery item 3 — per-network copy variants.
 *
 * These are source assertions rather than behaviour, because what they pin has
 * no runtime in this repo: SQL that only a real Postgres executes, and a
 * whitelist whose omission is silent by construction. */

test("per-network variants are validated where posts are actually written", async () => {
  const migration = await read("supabase/migrations/20260830120000_post_variants.sql");

  assert.match(migration,
    /alter table public\.posts\s+add column if not exists variants jsonb not null default '\{\}'/,
    "existing rows must default to an empty map so they publish byte-identically");

  /* The seam. Posts reach the database through the browser's own upsert under
     the posts_all RLS policy — there is no post-write Edge Function to put this
     in, and RLS answers "whose post is this?", not "is this map well-formed?".
     A CHECK constraint is the one gate every writer passes: today's browser,
     a future function, psql, a replayed backup. */
  assert.match(migration, /create or replace function public\.valid_post_variants\(v jsonb\)/);
  assert.match(migration, /immutable/,
    "a CHECK constraint may only call an IMMUTABLE function");
  assert.match(migration,
    /add constraint posts_variants_valid check \(public\.valid_post_variants\(variants\)\)/);
  assert.match(migration, /jsonb_typeof\(v\) = 'object'/, "the map itself must be an object");
  assert.match(migration, /jsonb_typeof\(entry\.value\) <> 'string'/,
    "values must be strings — never numbers, objects or nulls");
  for (const platform of [
    "youtube", "x", "instagram", "facebook", "linkedin", "tiktok", "pinterest", "gbp",
  ]) {
    assert.match(migration, new RegExp(`'${platform}'`),
      `${platform} is a platform this app publishes to, so it is a legal key`);
  }
  // Honest caps: a ceiling that stops unbounded jsonb, plus X's real 280, which
  // decision 12 refuses rather than truncates.
  assert.match(migration, /length\(entry\.value #>> '\{\}'\) > 63206/);
  assert.match(migration, /entry\.key = 'x' and length\(entry\.value #>> '\{\}'\) > 280/);

  // The claim RPCs stay shape-agnostic: `p.*` already carries the new column.
  const scheduling = await read("supabase/migrations/20260731090000_reliable_scheduling.sql");
  assert.match(scheduling, /returns setof public\.posts/);
  assert.doesNotMatch(migration, /claim_post_for_publish|claim_due_posts/,
    "variant resolution happens in the publish loop, so no claim RPC changes");
});

test("a column the sync whitelist does not name is invisible, so variants is named three times", async () => {
  const adapter = await read("js/remote-store.js");
  assert.match(adapter,
    /posts:\s+\["id","brand_id","date","time","text","networks","status","media_url","variants","approval_note"\]/,
    "FIELDS.posts decides what is diffed and upserted");
  assert.match(adapter, /variants: p\.variants \|\| \{\}/, "server row -> app post");
  assert.match(adapter, /variants:p\.variants \|\| \{\}/, "app post -> server row");
});

test("the effective-text resolver is one rule, shared by the publish path and mirrored in the composer", async () => {
  const platforms = await read("supabase/functions/_shared/platforms.ts");
  const publish = await read("supabase/functions/publish/index.ts");
  const planner = await read("js/planner.js");

  // The amendment to decision 3: `??` is not enough, on either side.
  for (const [source, label] of [[platforms, "the publish path"], [planner, "the composer"]]) {
    /* The behaviour is pinned by tests on both sides — the Deno resolver suite
       and the composer's inherit-when-blank round trip. What a source assertion
       adds is that neither side can drift back to `?? ` alone without this
       failing: the guard is a type check *and* a blank check, together. */
    assert.match(source, /typeof variant\s*===\s*"string"\s*&&\s*variant\.trim\(\)\s*!==\s*""/,
      `${label} must treat missing, non-string, empty and whitespace-only variants alike`);
  }
  assert.match(publish, /text: effectiveText\(post, platform\)/,
    "resolution happens per target in the publish loop (decision 4)");

  // Decision 12: the adapter refuses over-length text instead of truncating it.
  assert.match(platforms, /export const X_TEXT_LIMIT = 280/);
  // The truncation is gone from the request body, not merely commented about.
  assert.doesNotMatch(platforms, /text:\s*text\.slice\(/);
  assert.match(platforms, /if \(text\.length > X_TEXT_LIMIT\)/);
  assert.match(planner, /export const HARD_TEXT_CAPS = \{ x: 280 \}/);
});
