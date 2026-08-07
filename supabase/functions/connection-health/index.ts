// Authenticated, account-specific connection verification. The public account
// view reports the last verified result; provider credentials never leave this
// function.
import { ADAPTERS } from "../_shared/platforms.ts";
import { freshConnectionToken } from "../_shared/token-manager.ts";
import { getUser, isMember, sbSelect, sbUpdate } from "../_shared/db.ts";

const env = (key: string) => Deno.env.get(key);
const CORS = {
  "Access-Control-Allow-Origin": env("APP_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, "Content-Type": "application/json" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const jwt = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const user = await getUser(jwt);
    if (!user) return json({ error: "Invalid session" }, 401);

    const { brand_id, account_id } = await req.json();
    if (!brand_id || !await isMember(brand_id, user.id)) {
      return json({ error: "You don't have access to that brand" }, 403);
    }

    let query = `select=*&brand_id=eq.${encodeURIComponent(brand_id)}`;
    if (account_id) query += `&id=eq.${encodeURIComponent(account_id)}`;
    const connections = await sbSelect("social_connections", query);
    const results = [];
    const sharedAccessTokens = new Map<string, string>();

    for (const connection of connections) {
      const adapter = ADAPTERS[connection.platform];
      if (!adapter) continue;
      try {
        const authorizationId = adapter.sharedAuthorizationAcrossAssets
          ? String(connection.meta?.authorization_id ?? "")
          : "";
        let accessToken = authorizationId
          ? sharedAccessTokens.get(authorizationId)
          : undefined;
        if (!accessToken) {
          accessToken = await freshConnectionToken(connection, env);
          if (authorizationId) sharedAccessTokens.set(authorizationId, accessToken);
        }
        const identity = adapter.verify
          ? await adapter.verify(accessToken, connection)
          : await adapter.identify({ access_token: accessToken });
        if (String(identity.external_id) !== String(connection.external_id)) {
          throw new Error("The provider returned a different account. Reconnect this profile.");
        }
        const verifiedAt = new Date().toISOString();
        await sbUpdate("social_connections", `id=eq.${encodeURIComponent(connection.id)}`, {
          display_name: identity.display_name,
          avatar_url: identity.avatar_url ?? connection.avatar_url ?? null,
          status: "active",
          last_error: null,
          last_verified_at: verifiedAt,
          updated_at: verifiedAt,
        });
        results.push({ id: connection.id, ok: true, verified_at: verifiedAt });
      } catch (e) {
        const message = String((e as Error).message ?? e).slice(0, 300);
        const status = /reconnect|expired/i.test(message) ? "expired" : "error";
        await sbUpdate("social_connections", `id=eq.${encodeURIComponent(connection.id)}`, {
          status, last_error: message, updated_at: new Date().toISOString(),
        });
        results.push({ id: connection.id, ok: false, error: message });
      }
    }

    return json({ results });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
