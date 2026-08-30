// Read-only production checks. This never signs in, changes data, or prints the
// public anon key. Authenticated external-account validation is a separate gate.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const configSource = await readFile(new URL("../backend-config.js", import.meta.url), "utf8");
// APP_VERSION lives in js/constants.js since the ADR 0003 Phase 2b module split.
const appSource = await readFile(new URL("../js/constants.js", import.meta.url), "utf8");
const supabaseUrl = configSource.match(/url:\s*["']([^"']+)["']/)?.[1];
const anonKey = configSource.match(/anonKey:\s*["']([^"']+)["']/)?.[1];
const expectedVersion = appSource.match(/const APP_VERSION = "([^"]+)"/)?.[1];
assert.ok(supabaseUrl && anonKey, "backend-config.js must contain the public Supabase URL and anon key");
assert.ok(expectedVersion, "js/constants.js must declare APP_VERSION");

const productionOrigin = "https://fablepeak.com";
const fetchFresh = (path, init = {}) => fetch(`${productionOrigin}${path}`, {
  ...init,
  headers: { "Cache-Control": "no-cache", ...init.headers },
});

const checks = [];
async function check(name, action) {
  try {
    await action();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: String(error.message ?? error) });
  }
}

await check(`FablePeak v${expectedVersion} is live`, async () => {
  const page = await fetchFresh("/", { redirect: "follow" });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<script type="module" src="\.\/js\/main\.js"><\/script>/,
    "the deployed page must still load the app through its ES module entry");
  // The version is in a module now, so read it from the module GitHub Pages serves.
  const response = await fetchFresh("/js/constants.js");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /javascript/,
    "a module served with the wrong MIME type is refused by the browser");
  const deployedVersion = (await response.text()).match(/const APP_VERSION = "([^"]+)"/)?.[1];
  assert.equal(deployedVersion, expectedVersion,
    `expected v${expectedVersion}, found ${deployedVersion ?? "no version"}`);
});

await check("mobile PWA manifest and launch shortcuts are live", async () => {
  const response = await fetchFresh("/manifest.json");
  assert.equal(response.status, 200);
  const manifest = await response.json();
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  const iconSizes = new Set((manifest.icons ?? []).map((icon) => icon.sizes));
  assert.ok(iconSizes.has("192x192"), "manifest is missing its 192px icon");
  assert.ok(iconSizes.has("512x512"), "manifest is missing its 512px icon");
  const shortcuts = new Set((manifest.shortcuts ?? []).map((shortcut) => shortcut.url));
  for (const url of ["./?action=new-post", "./?action=planner", "./?action=connections"]) {
    assert.ok(shortcuts.has(url), `manifest is missing shortcut ${url}`);
  }
});

await check("mobile PWA icons are publicly downloadable", async () => {
  for (const icon of ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]) {
    const response = await fetchFresh(`/${icon}`);
    assert.equal(response.status, 200, `${icon} returned ${response.status}`);
    assert.match(response.headers.get("content-type") ?? "", /image\/png/, `${icon} is not served as PNG`);
    assert.ok((await response.arrayBuffer()).byteLength > 500, `${icon} is unexpectedly small`);
  }
});

await check("service worker matches the deployed app release", async () => {
  const response = await fetchFresh("/sw.js");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /javascript/);
  const worker = await response.text();
  assert.ok(worker.includes(`fablepeak-v${expectedVersion}`),
    `service worker does not use the v${expectedVersion} cache`);
  assert.match(worker, /authorization/,
    "service worker must continue excluding authenticated responses from its cache");
});

for (const page of ["privacy.html", "terms.html", "data-deletion.html"]) {
  await check(`${page} is public`, async () => {
    const response = await fetchFresh(`/${page}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  });
}

const functionHeaders = { apikey: anonKey, "Content-Type": "application/json" };
await check("OAuth discovery reports the three launch platforms", async () => {
  const response = await fetch(`${supabaseUrl}/functions/v1/oauth-start?action=available`, {
    headers: { apikey: anonKey },
  });
  assert.equal(response.status, 200);
  const platforms = (await response.json()).platforms?.slice().sort();
  // While the TikTok app review runs, the TIKTOK_SANDBOX server flag
  // deliberately adds tiktok to discovery. That one extra is allowed; any
  // other frozen platform appearing here is still an accidental exposure.
  const allowed = ["facebook", "instagram", "tiktok", "youtube"];
  assert.deepEqual(platforms.filter(p => p !== "tiktok"),
    ["facebook", "instagram", "youtube"]);
  assert.ok(platforms.every(p => allowed.includes(p)),
    `unexpected platform in discovery: ${platforms.join(",")}`);
});

for (const [fn, body, expected] of [
  ["connection-health", { brand_id: "smoke-test" }, 401],
  ["delete-account", { confirm: "DELETE" }, 401],
  ["publish", { post_id: "smoke-test" }, 401],
  ["ingest-metrics", {}, 403],
]) {
  await check(`${fn} rejects an unauthenticated request`, async () => {
    const response = await fetch(`${supabaseUrl}/functions/v1/${fn}`, {
      method: "POST", headers: functionHeaders, body: JSON.stringify(body),
    });
    assert.equal(response.status, expected);
  });
}

for (const result of checks) {
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.error ? ` — ${result.error}` : ""}`);
}
const failures = checks.filter((result) => !result.ok);
if (failures.length) process.exitCode = 1;
