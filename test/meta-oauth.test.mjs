import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("Facebook Pages use Facebook Login for Business configuration", async () => {
  const platforms = await read("supabase/functions/_shared/platforms.ts");
  const oauthStart = await read("supabase/functions/oauth-start/index.ts");

  const facebook = platforms.match(
    /const facebook: PlatformAdapter = \{([\s\S]*?)\n\};\n\nconst instagram/,
  );
  const instagram = platforms.match(
    /const instagram: PlatformAdapter = \{([\s\S]*?)\n\};\n\nasync function waitForInstagramContainer/,
  );
  assert.ok(facebook, "Facebook adapter should exist");
  assert.ok(instagram, "Instagram adapter should exist");
  assert.match(facebook[1], /authorizeConfigEnv: "META_CONFIG_ID"/);
  assert.doesNotMatch(facebook[1], /business_management/);
  assert.match(facebook[1], /grant_type: "fb_exchange_token"/);
  assert.match(facebook[1], /fb_exchange_token: short\.access_token/);
  assert.match(facebook[1], /refresh_token: long\.access_token/);
  assert.match(facebook[1], /async refreshAccess/);
  assert.match(facebook[1], /await metaPages\(long\.access_token\)/);
  assert.match(facebook[1], /connection\.external_id/);

  assert.match(oauthStart, /if \(configId\) p\.set\("config_id", configId\)/);
  assert.match(oauthStart, /else p\.set\("scope", adapter\.scopes\.join/);
});

test("Facebook stays unavailable until its config ID is deployed", async () => {
  const platforms = await read("supabase/functions/_shared/platforms.ts");
  assert.match(
    platforms,
    /!a\.authorizeConfigEnv \|\| env\(a\.authorizeConfigEnv\)/,
  );
});

test("Instagram uses direct professional login without a Facebook Page", async () => {
  const platforms = await read("supabase/functions/_shared/platforms.ts");
  const instagram = platforms.match(
    /const instagram: PlatformAdapter = \{([\s\S]*?)\n\};\n\nasync function waitForInstagramContainer/,
  );
  assert.ok(instagram, "Instagram adapter should exist");
  assert.match(instagram[1], /authorizeUrl: "https:\/\/www\.instagram\.com\/oauth\/authorize"/);
  assert.match(instagram[1], /tokenUrl: "https:\/\/api\.instagram\.com\/oauth\/access_token"/);
  assert.match(instagram[1], /clientIdEnv: "INSTAGRAM_APP_ID"/);
  assert.match(instagram[1], /clientSecretEnv: "INSTAGRAM_APP_SECRET"/);
  assert.match(instagram[1], /"instagram_business_basic"/);
  assert.match(instagram[1], /"instagram_business_content_publish"/);
  assert.doesNotMatch(instagram[1], /pages_show_list|pages_read_engagement|page_access_token/);
  assert.match(instagram[1], /scopeSeparator: ","/);
  assert.match(instagram[1], /enable_fb_login: "0"/);
});

test("Instagram persists renewable long-lived tokens and uses its Graph host", async () => {
  const platforms = await read("supabase/functions/_shared/platforms.ts");
  const instagram = platforms.match(
    /const instagram: PlatformAdapter = \{([\s\S]*?)\n\};\n\nasync function waitForInstagramContainer/,
  );
  assert.ok(instagram);
  assert.match(instagram[1], /const shortForm = new FormData\(\)/);
  assert.match(instagram[1], /fetch\(instagram\.tokenUrl/);
  assert.match(instagram[1], /fetch\("https:\/\/graph\.instagram\.com\/access_token", \{\s*method: "POST"/);
  assert.match(instagram[1], /grant_type: "ig_exchange_token"/);
  assert.match(instagram[1], /refresh_access_token\?/);
  assert.match(instagram[1], /grant_type: "ig_refresh_token"/);
  assert.match(instagram[1], /https:\/\/graph\.instagram\.com\/\$\{META_VERSION\}\/me/);
  assert.match(instagram[1], /https:\/\/graph\.instagram\.com\/\$\{META_VERSION\}\/\$\{igId\}\/media/);
  assert.doesNotMatch(instagram[1], /graph\.facebook\.com/);
});

test("Meta publishing distinguishes images from videos and waits for Reels", async () => {
  const platforms = await read("supabase/functions/_shared/platforms.ts");
  assert.match(platforms, /function mediaKind\(value: string\)/);
  assert.match(platforms, /video \? "videos" : "photos"/);
  assert.match(platforms, /media_type: "REELS", video_url: safeMediaUrl/);
  assert.match(platforms, /await waitForInstagramContainer\(container\.id, accessToken\)/);
  assert.match(platforms, /status\.status_code === "FINISHED"/);
  assert.match(platforms, /fields=permalink/);
  assert.doesNotMatch(platforms, /instagram\.com\/p\/\$\{published\.id\}/);
});

test("all platform jobs share one token lifecycle module", async () => {
  const manager = await read("supabase/functions/_shared/token-manager.ts");
  assert.match(manager, /refreshPlatformToken/);
  assert.match(manager, /decryptToken\(conn\.access_token\)/);
  assert.match(manager, /encryptToken\(tokens\.access_token\)/);
  assert.match(manager, /tokens\.scope \?\? conn\.scopes/);
  assert.match(manager, /status: "expired"/);
  assert.match(manager, /status: "active"/);
  assert.match(manager, /Could not refresh access/);

  for (const file of ["supabase/functions/publish/index.ts", "supabase/functions/ingest-metrics/index.ts"]) {
    const source = await read(file);
    assert.match(source, /freshConnectionToken\(conn, env\)/);
    assert.doesNotMatch(source, /async function freshToken/);
  }
});

test("provider tokens are authenticated-encrypted and legacy rows can migrate", async () => {
  const { encryptToken, decryptToken, tokenIsEncrypted } = await import(
    "../supabase/functions/_shared/token-crypto.ts"
  );
  const key = Buffer.alloc(32, 7).toString("base64url");
  const sealed = await encryptToken("provider-secret", key);
  assert.ok(sealed);
  assert.equal(tokenIsEncrypted(sealed), true);
  assert.equal(await decryptToken(sealed, key), "provider-secret");
  assert.equal(await decryptToken("legacy-plaintext", key), "legacy-plaintext");
  await assert.rejects(
    decryptToken(sealed, Buffer.alloc(32, 8).toString("base64url")),
    /could not be decrypted/,
  );
});

test("OAuth is unavailable until token encryption is configured", async () => {
  const platforms = await read("supabase/functions/_shared/platforms.ts");
  const start = await read("supabase/functions/oauth-start/index.ts");
  assert.match(platforms, /if \(!env\("SOCIAL_TOKEN_ENCRYPTION_KEY"\)\) return \[\]/);
  assert.match(start, /"SOCIAL_TOKEN_ENCRYPTION_KEY"/);
});

test("OAuth state is single-use and expires after ten minutes", async () => {
  const start = await read("supabase/functions/oauth-start/index.ts");
  const callback = await read("supabase/functions/oauth-callback/index.ts");
  assert.match(start, /Date\.now\(\) - 10 \* 60_000/);
  assert.match(start, /sbDelete\("oauth_states", `created_at=lt\./);
  assert.match(callback, /sbDelete\("oauth_states", `state=eq\./);
  assert.match(callback, /Date\.now\(\) - stateCreatedAt > 10 \* 60_000/);
  assert.match(callback, /isMember\(st\.brand_id, st\.user_id\)/);
});

test("Facebook exposes every authorized Page for explicit selection", async () => {
  const platforms = await read("supabase/functions/_shared/platforms.ts");
  const callback = await read("supabase/functions/oauth-callback/index.ts");
  const facebook = platforms.match(
    /const facebook: PlatformAdapter = \{([\s\S]*?)\n\};\n\nconst instagram/,
  );
  assert.ok(facebook);
  assert.match(facebook[1], /async identifyAll\(t\)/);
  assert.match(facebook[1], /return pages\.map/);
  assert.match(callback, /adapter\.identifyAll/);
  assert.match(callback, /identities\.map/);
  assert.match(callback, /is_default:/);
});

test("selected social account is tenant-checked and used for publishing", async () => {
  const migration = await read(
    "supabase/migrations/20260802120000_social_account_selection.sql",
  );
  const publish = await read("supabase/functions/publish/index.ts");
  const metrics = await read("supabase/functions/ingest-metrics/index.ts");
  const html = await read("index.html");

  assert.match(migration, /create or replace function public\.select_social_account/);
  assert.match(migration, /if not public\.is_member\(b\)/);
  assert.match(migration, /where is_default/);
  assert.match(publish, /is_default=eq\.true/);
  assert.match(publish, /if \(conn\.status !== "active"\)/);
  assert.match(publish, /never bypass an expired\/error selected account/);
  assert.match(metrics, /is_default=eq\.true/);
  assert.match(html, /Use for publishing/);
  assert.match(html, /store\.selectAccount\(id\)/);
  assert.doesNotMatch(html, /selectReal\('\$\{a\.id\}','\$\{esc\(a\.display_name/);
  assert.doesNotMatch(html, /disconnectReal\('\$\{a\.id\}','\$\{esc\(a\.display_name/);
});

test("public account view migrations only append columns", async () => {
  const selection = await read(
    "supabase/migrations/20260802120000_social_account_selection.sql",
  );
  const health = await read(
    "supabase/migrations/20260802130000_connection_health.sql",
  );
  assert.ok(selection.indexOf("as needs_reauth") < selection.indexOf("c.is_default"));
  assert.ok(health.indexOf("as needs_reauth") < health.indexOf("c.is_default"));
  assert.ok(health.indexOf("c.is_default") < health.indexOf("c.last_verified_at"));
});

test("connection health verifies the exact provider identity behind tenant auth", async () => {
  const health = await read("supabase/functions/connection-health/index.ts");
  const callback = await read("supabase/functions/oauth-callback/index.ts");
  const html = await read("index.html");
  const migration = await read(
    "supabase/migrations/20260802130000_connection_health.sql",
  );

  assert.match(health, /getUser\(jwt\)/);
  assert.match(health, /isMember\(brand_id, user\.id\)/);
  assert.match(health, /freshConnectionToken\(connection, env\)/);
  assert.match(health, /identity\.external_id[\s\S]*connection\.external_id/);
  assert.match(health, /last_verified_at: verifiedAt/);
  assert.match(callback, /last_verified_at: now/);
  assert.match(migration, /last_verified_at timestamptz/);
  assert.match(html, /store\.verifyAccounts\(brandId\)/);
  assert.match(html, /15\*60\*1000/);
});
