// Read-only production checks. This never signs in, changes data, or prints the
// public anon key. Authenticated external-account validation is a separate gate.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const configSource = await readFile(new URL("../backend-config.js", import.meta.url), "utf8");
const supabaseUrl = configSource.match(/url:\s*["']([^"']+)["']/)?.[1];
const anonKey = configSource.match(/anonKey:\s*["']([^"']+)["']/)?.[1];
assert.ok(supabaseUrl && anonKey, "backend-config.js must contain the public Supabase URL and anon key");

const checks = [];
async function check(name, action) {
  try {
    await action();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: String(error.message ?? error) });
  }
}

await check("FablePeak v1.2.0 is live", async () => {
  const response = await fetch("https://fablepeak.com/", { redirect: "follow" });
  assert.equal(response.status, 200);
  const deployedVersion = (await response.text()).match(/const APP_VERSION = "([^"]+)"/)?.[1];
  assert.equal(deployedVersion, "1.2.0", `expected v1.2.0, found ${deployedVersion ?? "no version"}`);
});

for (const page of ["privacy.html", "terms.html", "data-deletion.html"]) {
  await check(`${page} is public`, async () => {
    const response = await fetch(`https://fablepeak.com/${page}`);
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
  assert.deepEqual(platforms, ["facebook", "instagram", "youtube"]);
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
