// Authenticated, read-only proof that Vault, pg_cron and each scheduled Edge
// Function are executing together. Local runs skip without the production
// secret; CI fails so a missing monitor credential cannot look healthy.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const secret = process.env.FABLEPEAK_OPERATIONS_HEALTH_SECRET;
const oidcUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const oidcRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
if (!secret && !oidcUrl) {
  if (process.env.CI) throw new Error("GitHub OIDC is required in CI");
  console.log("SKIP  cron health requires GitHub OIDC or FABLEPEAK_OPERATIONS_HEALTH_SECRET");
  process.exit(0);
}

const configSource = await readFile(new URL("../backend-config.js", import.meta.url), "utf8");
const supabaseUrl = configSource.match(/url:\s*["']([^"']+)["']/)?.[1];
const anonKey = configSource.match(/anonKey:\s*["']([^"']+)["']/)?.[1];
assert.ok(supabaseUrl && anonKey, "backend-config.js must contain the Supabase URL and anon key");

let oidcToken = "";
if (!secret) {
  assert.ok(oidcUrl && oidcRequestToken, "GitHub OIDC request variables are incomplete");
  const requestUrl = new URL(oidcUrl);
  requestUrl.searchParams.set("audience", "fablepeak-operations");
  const tokenResponse = await fetch(requestUrl, {
    headers: { Authorization: `Bearer ${oidcRequestToken}` },
  });
  assert.equal(tokenResponse.status, 200, "GitHub did not issue an operations OIDC token");
  oidcToken = (await tokenResponse.json()).value;
  assert.ok(oidcToken, "GitHub returned no operations OIDC token");
}

const response = await fetch(`${supabaseUrl}/functions/v1/operations-health`, {
  method: "POST",
  headers: {
    apikey: anonKey,
    "Content-Type": "application/json",
    ...(secret ? { "x-cron-secret": secret } : { Authorization: `Bearer ${oidcToken}` }),
  },
  body: "{}",
});
const body = await response.json().catch(() => ({}));
assert.equal(response.status, 200,
  `scheduled operations are unhealthy (${response.status}): ${JSON.stringify(body)}`);
assert.equal(body.ok, true, `scheduled operations are unhealthy: ${JSON.stringify(body)}`);
console.log("PASS  authenticated scheduled operations are healthy");
