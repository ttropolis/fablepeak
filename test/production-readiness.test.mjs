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
  const html = await read("index.html");
  const deletion = await read("data-deletion.html");
  assert.match(source, /getUser\(jwt\)/);
  assert.match(source, /body\.confirm !== "DELETE"/);
  assert.match(source, /sbDelete\("social_connections", `user_id=eq\./);
  assert.match(source, /others\.some\(\(member\) => member\.role === "owner"\)/);
  assert.match(source, /\{ role: "owner" \}/);
  assert.match(source, /await deleteWorkspaceMedia\(membership\.brand_id, serviceKey\)/);
  assert.match(source, /storage\/v1\/object\/list\/social-media/);
  assert.match(source, /auth\/v1\/admin\/users\/\$\{user\.id\}/);
  assert.match(html, /async function deleteCloudAccount/);
  assert.match(html, /Type DELETE to continue/);
  assert.match(html, /signInWithPassword/);
  assert.match(html, /Password confirmation failed/);
  assert.match(deletion, /Under <strong>Delete account<\/strong>/);
});

test("production checklist matches implemented Meta and Google scopes", async () => {
  const checklist = await read("PRODUCTION_ONBOARDING.md");
  const platforms = await read("supabase/functions/_shared/platforms.ts");
  for (const scope of [
    "pages_show_list", "pages_manage_posts", "pages_read_engagement",
    "instagram_business_basic", "instagram_business_content_publish",
    "youtube.upload", "youtube.readonly", "yt-analytics.readonly",
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

test("signed-in customers can upload provider-fetchable media within their workspace", async () => {
  const html = await read("index.html");
  const migration = await read(
    "supabase/migrations/20260802140000_workspace_media.sql",
  );
  assert.match(migration, /'social-media', 'social-media', true, 52428800/);
  assert.match(migration, /public\.is_member\(\(storage\.foldername\(name\)\)\[1\]\)/);
  assert.match(migration, /for insert to authenticated/);
  assert.match(migration, /for delete to authenticated/);
  assert.match(html, /async uploadMedia\(file, brandId\)/);
  assert.match(html, /storage\.from\("social-media"\)\.upload/);
  assert.match(html, /async function uploadPostMedia/);
  assert.match(html, /file\.size>50\*1024\*1024/);
});

test("live customer connections stay focused on the three launch platforms", async () => {
  const html = await read("index.html");
  assert.match(html, /const LAUNCH_PLATFORMS = \["instagram", "facebook", "youtube"\]/);
  assert.match(html, /NETWORKS\.filter\(n => LAUNCH_PLATFORMS\.includes\(n\.id\)\)/);
});

test("production smoke test is read-only and covers public security gates", async () => {
  const script = await read("scripts/production-smoke.mjs");
  assert.match(script, /FablePeak v1\.2\.0 is live/);
  assert.match(script, /OAuth discovery reports the three launch platforms/);
  assert.match(script, /connection-health/);
  assert.match(script, /delete-account/);
  assert.doesNotMatch(script, /Authorization:/);
});
