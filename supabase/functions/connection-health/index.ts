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
  fetch: typeof fetch;
};

/* ADR 0005 decision 5: the Facebook first-comment capability probe.
 *
 * Meta's reference attributes Page comment *creation* to
 * `pages_manage_engagement`, which this app does not hold. Decision 5 approves
 * finding out for real, on the internal brand, with the permissions already
 * granted — and decision 6's clarified gate says a success on already-held
 * permissions releases Facebook first comments for controlled internal use
 * only, with no change to the pending Meta submission.
 *
 * Kept in sync with `META_VERSION` in `_shared/platforms.ts` by hand: that file
 * does not export it, and this probe must not force an edit to the adapter
 * surface it is trying to answer a question about. */
const META_VERSION = "v25.0";

/** `<page-id>_<post-id>` — the only shape a Page post id takes. The probe
 *  writes a public comment, so the target is the exact id the owner supplied
 *  and is never derived, defaulted or discovered. */
const FACEBOOK_POST_ID = /^\d+_\d+$/;

type ProbeResult = {
  ok: boolean;
  probe: "created" | "denied" | "error";
  comment_created: boolean;
  comment_deleted: boolean;
  comment_id: string | null;
  error_code: number | null;
  error_subcode: number | null;
  error_message: string | null;
  /** Present only when the comment was created but could not be removed: the
   *  owner has a live comment on the Page to delete by hand. */
  cleanup_error?: string;
  permission_hint:
    | "held permissions suffice"
    | "pages_manage_engagement required"
    | "unknown";
};

/** Strip a credential out of anything on its way to a caller or a log. Graph
 *  does not echo the token today; this makes that a property of the code
 *  rather than of the provider. */
function redact(text: string, token: string): string {
  return token ? text.split(token).join("[redacted]") : text;
}

/** Read Graph's `error` envelope, whatever the transport did to it. */
async function graphError(response: Response, token: string) {
  let body: any = null;
  try {
    body = await response.json();
  } catch { /* HTML error page or empty body — fall through to the status */ }
  const error = body?.error ?? {};
  const message = redact(String(
    error.message ?? body?.message ?? `Facebook returned HTTP ${response.status}.`,
  ), token).slice(0, 300);
  return {
    code: typeof error.code === "number" ? error.code : null,
    subcode: typeof error.error_subcode === "number" ? error.error_subcode : null,
    type: String(error.type ?? ""),
    message,
  };
}

/* Honest mapping, and only honest mapping: a denial is only attributed to
   `pages_manage_engagement` where Graph says something that means exactly
   that. Everything else answers "unknown" — a wrong "held permissions
   suffice" would release a feature the app cannot actually perform, and a
   wrong "pages_manage_engagement required" would send a permission into a
   Meta submission decision 6 deliberately keeps it out of. */
function classify(error: { code: number | null; type: string; message: string }): {
  probe: "denied" | "error";
  permission_hint: ProbeResult["permission_hint"];
} {
  const engagement = { probe: "denied" as const, permission_hint: "pages_manage_engagement required" as const };
  // #200 "Permissions error" and #10 "Application does not have permission for
  // this action" are Graph's two permission refusals for a Page write.
  if (error.code === 200 || error.code === 10) return engagement;
  if (/pages_manage_engagement/i.test(error.message)) return engagement;
  // An OAuthException that talks about permission is a refusal, but not one we
  // can attribute to a named scope — #190 (expired/invalid token) reaches here
  // too and is a credential problem, not a capability answer.
  if (error.type === "OAuthException" && error.code !== 190 && /permission/i.test(error.message)) {
    return { probe: "denied", permission_hint: "unknown" };
  }
  return { probe: "error", permission_hint: "unknown" };
}

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
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
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

  /** Write one comment on the owner-named Page post with the Page token this
   *  connection already holds, then remove it. The provider's own words are
   *  returned verbatim (minus any credential): the caller is the owner, and a
   *  paraphrase is exactly what makes a capability answer untrustworthy. */
  async function probeFacebookComment(
    connection: Connection | undefined,
    postRemoteId: string,
  ): Promise<ProbeResult> {
    const base: ProbeResult = {
      ok: false, probe: "error", comment_created: false, comment_deleted: false,
      comment_id: null, error_code: null, error_subcode: null, error_message: null,
      permission_hint: "unknown",
    };
    if (!connection) {
      return { ...base, error_message: "That connection is not in this workspace." };
    }
    if (connection.platform !== "facebook") {
      return { ...base, error_message: "The comment probe only applies to a Facebook Page connection." };
    }
    // The Page half of <page-id>_<post-id> must be this connection's own Page:
    // an owner may probe their Page's capability, never comment on an arbitrary
    // public post through FablePeak's infrastructure.
    if (postRemoteId.split("_")[0] !== String(connection.external_id)) {
      return { ...base, error_message: "The probe post must belong to this connection's own Page." };
    }

    let token: string;
    try {
      token = await dependencies.freshConnectionToken(connection, env);
    } catch (e) {
      // A credential that cannot be refreshed answers nothing about the
      // permission question, so the hint stays unknown.
      return { ...base, error_message: String((e as Error).message ?? e).slice(0, 300) };
    }

    let created: Response;
    try {
      created = await dependencies.fetch(
        `https://graph.facebook.com/${META_VERSION}/${encodeURIComponent(postRemoteId)}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            message: "FablePeak capability probe — will be removed.",
            access_token: token,
          }),
        });
    } catch (e) {
      return {
        ...base,
        error_message: redact(String((e as Error).message ?? e), token).slice(0, 300),
      };
    }

    if (!created.ok) {
      const error = await graphError(created, token);
      return {
        ...base, ...classify(error),
        error_code: error.code, error_subcode: error.subcode, error_message: error.message,
      };
    }

    let commentId: string | null = null;
    try {
      commentId = String(((await created.json()) as any)?.id ?? "") || null;
    } catch { /* 2xx without a readable body — handled as a missing id below */ }
    if (!commentId) {
      // HTTP 200 with no id: the comment may exist and cannot be cleaned up.
      // That is not a permission denial, and it is not a clean success either.
      return {
        ...base, comment_created: true,
        error_message: "Facebook accepted the comment but returned no id. Check the Page and remove it by hand.",
      };
    }

    // The capability question is already answered. Cleanup is reported, never
    // allowed to overwrite that answer.
    const success: ProbeResult = {
      ok: true, probe: "created", comment_created: true, comment_deleted: false,
      comment_id: commentId, error_code: null, error_subcode: null, error_message: null,
      permission_hint: "held permissions suffice",
    };
    try {
      const deleted = await dependencies.fetch(
        `https://graph.facebook.com/${META_VERSION}/${encodeURIComponent(commentId)}` +
        `?access_token=${encodeURIComponent(token)}`, { method: "DELETE" });
      if (deleted.ok) return { ...success, comment_deleted: true };
      const error = await graphError(deleted, token);
      return { ...success, cleanup_error: error.message };
    } catch (e) {
      return {
        ...success,
        cleanup_error: redact(String((e as Error).message ?? e), token).slice(0, 300),
      };
    }
  }

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

    try {
      const jwt = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!jwt) return json({ error: "Not signed in" }, 401);
      const user = await dependencies.getUser(jwt);
      if (!user) return json({ error: "Invalid session" }, 401);

      const { brand_id, account_id, action, post_remote_id } = await req.json();
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
      // ADR 0005 decision 5. The probe writes a real public comment, so it is
      // owner-gated on the same principle as revoke, and — like revoke — the
      // ownership answer comes before the request is validated, so a non-owner
      // learns nothing about the shape of a call they may not make.
      if (action === "probe_fb_comment") {
        if (!await dependencies.isOwner(brand_id, user.id)) {
          return json({ error: "Only workspace owners can run the comment capability probe" }, 403);
        }
        if (!account_id) return json({ error: "account_id is required to probe" }, 400);
        if (!FACEBOOK_POST_ID.test(String(post_remote_id ?? ""))) {
          return json({ error: "post_remote_id must look like <page-id>_<post-id>" }, 400);
        }
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

      if (action === "probe_fb_comment") {
        return json(await probeFacebookComment(
          (connections as Connection[])[0], String(post_remote_id)));
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
