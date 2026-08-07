// Begins an OAuth connection. Called by the browser with the user's Supabase
// JWT; returns the platform authorize URL to open. No secrets leave the server.
import {
  ADAPTERS, configuredPlatforms, platformConnectionEnabled,
} from "../_shared/platforms.ts";
import { getUser, isMember, sbDelete, sbInsert } from "../_shared/db.ts";

const env = (k: string) => Deno.env.get(k);
const CORS = {
  "Access-Control-Allow-Origin": env("APP_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function b64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  // discovery: which platforms this deployment can actually connect
  if (req.method === "GET" && url.searchParams.get("action") === "available") {
    return json({ platforms: configuredPlatforms(env) });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const jwt = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const user = await getUser(jwt);
    if (!user) return json({ error: "Invalid session" }, 401);

    const { platform, brand_id, redirect_to } = await req.json();
    const adapter = ADAPTERS[platform];
    if (!adapter) return json({ error: `Unknown platform: ${platform}` }, 400);
    if (!platformConnectionEnabled(adapter)) {
      return json({
        error: `${adapter.label} is not available until its required publishing workflow is complete.`,
      }, 400);
    }

    const clientId = env(adapter.clientIdEnv);
    const missingSecrets = [adapter.clientIdEnv, adapter.clientSecretEnv,
      "SOCIAL_TOKEN_ENCRYPTION_KEY",
      adapter.authorizeConfigEnv].filter((key): key is string => Boolean(key && !env(key)));
    if (!clientId || missingSecrets.length) {
      return json({ error:
        `${adapter.label} is not configured yet. Add ${missingSecrets.join(", ")} ` +
        `to the Edge Function secrets.` }, 400);
    }

    if (!await isMember(brand_id, user.id)) {
      return json({ error: "You don't have access to that brand" }, 403);
    }

    // OAuth state is single-use and short-lived. Opportunistic cleanup keeps
    // abandoned popup attempts from accumulating indefinitely.
    const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
    await sbDelete("oauth_states", `created_at=lt.${encodeURIComponent(staleBefore)}`);

    const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
    let verifier: string | undefined, challenge: string | undefined;
    if (adapter.usesPKCE) ({ verifier, challenge } = await pkce());

    await sbInsert("oauth_states", {
      state, user_id: user.id, brand_id, platform,
      code_verifier: verifier ?? null, redirect_to: redirect_to ?? null,
    });

    const redirectUri = `${env("SUPABASE_URL")}/functions/v1/oauth-callback`;
    const p = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      ...(adapter.authorizeExtra ?? {}),
    });
    const configId = adapter.authorizeConfigEnv ? env(adapter.authorizeConfigEnv) : undefined;
    if (configId) p.set("config_id", configId);
    else p.set("scope", adapter.scopes.join(adapter.scopeSeparator ??
      (adapter.id === "tiktok" ? "," : " ")));
    if (challenge) { p.set("code_challenge", challenge); p.set("code_challenge_method", "S256"); }
    if (adapter.id === "tiktok") { p.delete("client_id"); p.set("client_key", clientId); }

    return json({ url: `${adapter.authorizeUrl}?${p}`, redirect_uri: redirectUri });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
