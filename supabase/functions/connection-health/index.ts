// Authenticated, account-specific connection verification. The public account
// view reports the last verified result; provider credentials never leave this
// function.
import { ADAPTERS } from "../_shared/platforms.ts";
import {
  type Connection,
  freshConnectionToken,
  revokeUserAuthorizations,
} from "../_shared/token-manager.ts";
import { getUser, isMember, isOwner, sbSelect, sbUpdate } from "../_shared/db.ts";

/* Every backend this handler touches, injectable so the authorization rules
   below can be tested without a database or a provider (the ai-assist shape).
   The keys are named after the helpers they default to, so a reader greps one
   name and finds both the import and the call. */
type Dependencies = {
  env: (key: string) => string | undefined;
  getUser: typeof getUser;
  isMember: typeof isMember;
  isOwner: typeof isOwner;
  sbSelect: typeof sbSelect;
  sbUpdate: typeof sbUpdate;
  revokeUserAuthorizations: typeof revokeUserAuthorizations;
  freshConnectionToken: typeof freshConnectionToken;
};

export function createHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    env: (key: string) => Deno.env.get(key),
    getUser,
    isMember,
    isOwner,
    sbSelect,
    sbUpdate,
    revokeUserAuthorizations,
    freshConnectionToken,
    ...overrides,
  };
  const env = dependencies.env;

  const CORS = {
    "Access-Control-Allow-Origin": env("APP_ORIGIN") ?? "*",
    "Access-Control-Allow-Headers": "authorization, content-type, apikey",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

    try {
      const jwt = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!jwt) return json({ error: "Not signed in" }, 401);
      const user = await dependencies.getUser(jwt);
      if (!user) return json({ error: "Invalid session" }, 401);

      const { brand_id, account_id, action } = await req.json();
      if (!brand_id || !await dependencies.isMember(brand_id, user.id)) {
        return json({ error: "You don't have access to that brand" }, 403);
      }
      // Verification is a read every member needs: the Connections view calls it
      // on every visit and the composer depends on its result. Revocation is the
      // provider half of Disconnect, which ADR 0006 makes owner-only — so it is
      // gated here as well as in the disconnect_account RPC. Ownership is checked
      // before the request is validated, so a non-owner learns nothing about the
      // shape of a call they may not make.
      if (action === "revoke") {
        if (!await dependencies.isOwner(brand_id, user.id)) {
          return json({ error: "Only workspace owners can disconnect an account" }, 403);
        }
        // Revoking is deliberately per-connection: a whole-brand revoke would be
        // a destructive action no disconnect button ever asks for.
        if (!account_id) return json({ error: "account_id is required to revoke" }, 400);
      }

      let query = `select=*&brand_id=eq.${encodeURIComponent(brand_id)}`;
      if (account_id) query += `&id=eq.${encodeURIComponent(account_id)}`;
      const connections = await dependencies.sbSelect("social_connections", query);

      // Provider-side revocation seam for disconnect. The row itself is still
      // removed by the disconnect_account RPC, which resolves ownership from the
      // caller's own auth.uid(); this function only makes the provider call that
      // the browser cannot, because it never sees the stored credentials.
      if (action === "revoke") {
        return json({
          results: await dependencies.revokeUserAuthorizations(connections as Connection[], env),
        });
      }

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
            accessToken = await dependencies.freshConnectionToken(connection, env);
            if (authorizationId) sharedAccessTokens.set(authorizationId, accessToken);
          }
          const identity = adapter.verify
            ? await adapter.verify(accessToken, connection)
            : await adapter.identify({ access_token: accessToken });
          if (String(identity.external_id) !== String(connection.external_id)) {
            throw new Error("The provider returned a different account. Reconnect this profile.");
          }
          const verifiedAt = new Date().toISOString();
          await dependencies.sbUpdate("social_connections", `id=eq.${encodeURIComponent(connection.id)}`, {
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
          await dependencies.sbUpdate("social_connections", `id=eq.${encodeURIComponent(connection.id)}`, {
            status, last_error: message, updated_at: new Date().toISOString(),
          });
          results.push({ id: connection.id, ok: false, error: message });
        }
      }

      return json({ results });
    } catch (e) {
      return json({ error: String((e as Error).message ?? e) }, 500);
    }
  };
}

if (import.meta.main) Deno.serve(createHandler());
