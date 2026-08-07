// OAuth redirect target. Exchanges the code for tokens, identifies the remote
// account, stores the connection, and closes the popup.
import { ADAPTERS, exchangeAuthorizationCode } from "../_shared/platforms.ts";
import { isMember, sbDelete, sbOne, sbRpc, sbUpsert } from "../_shared/db.ts";
import { providerConnectionError } from "../_shared/oauth-errors.ts";
import { encryptToken } from "../_shared/token-crypto.ts";
import { withSupabase } from "jsr:@supabase/server@1.4.1";

const env = (k: string) => Deno.env.get(k);

// Hosted Supabase Edge Functions rewrite text/html GET responses to text/plain.
// Redirect to the app's static completion page so the browser can render it.
const page = (title: string, msg: string, ok: boolean) => {
  const target = new URL("/oauth-complete.html", env("APP_ORIGIN") ?? "https://fablepeak.com");
  target.searchParams.set("ok", ok ? "1" : "0");
  target.searchParams.set("title", title);
  target.searchParams.set("message", msg);
  return Response.redirect(target, 303);
};

const handleCallback = async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthErr = url.searchParams.get("error_description") ?? url.searchParams.get("error");

  if (oauthErr) return page("Connection cancelled", oauthErr, false);
  if (!code || !state) return page("Connection failed", "Missing authorization code.", false);

  try {
    const st = await sbOne("oauth_states", `select=*&state=eq.${encodeURIComponent(state)}`);
    if (!st) return page("Connection failed", "This link expired. Try connecting again.", false);
    await sbDelete("oauth_states", `state=eq.${encodeURIComponent(state)}`);
    const stateCreatedAt = new Date(st.created_at).getTime();
    if (!Number.isFinite(stateCreatedAt) || Date.now() - stateCreatedAt > 10 * 60_000) {
      return page("Connection failed", "This link expired. Try connecting again.", false);
    }
    if (!await isMember(st.brand_id, st.user_id)) {
      return page("Connection failed",
        "You no longer have access to this workspace. Ask an owner to invite you again.", false);
    }

    const adapter = ADAPTERS[st.platform];
    const clientId = env(adapter.clientIdEnv)!, clientSecret = env(adapter.clientSecretEnv)!;
    const redirectUri = `${env("SUPABASE_URL")}/functions/v1/oauth-callback`;

    const tokens = await exchangeAuthorizationCode(adapter, {
      code,
      redirectUri,
      codeVerifier: st.code_verifier ?? undefined,
      clientId,
      clientSecret,
    });
    const identities = adapter.identifyAll
      ? await adapter.identifyAll(tokens)
      : [await adapter.identify(tokens)];
    if (!identities.length) throw new Error(`No ${adapter.label} account was authorized.`);

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;

    const currentDefault = await sbOne("social_connections",
      `select=external_id&brand_id=eq.${encodeURIComponent(st.brand_id)}` +
      `&platform=eq.${encodeURIComponent(st.platform)}&is_default=eq.true`);
    const now = new Date().toISOString();
    const authorizationId = adapter.sharedAuthorizationAcrossAssets
      ? crypto.randomUUID()
      : null;
    const rows = await Promise.all(identities.map(async (identity, index) => ({
        brand_id: st.brand_id,
        user_id: st.user_id,
        platform: st.platform,
        external_id: identity.external_id,
        display_name: identity.display_name,
        avatar_url: identity.avatar_url ?? null,
        access_token: await encryptToken(identity.access_token ?? tokens.access_token),
        refresh_token: await encryptToken(tokens.refresh_token),
        token_expires_at: expiresAt,
        scopes: tokens.scope ?? adapter.scopes.join(" "),
        meta: {
          ...(identity.meta ?? {}),
          ...(authorizationId ? { authorization_id: authorizationId } : {}),
        },
        is_default: currentDefault
          ? currentDefault.external_id === identity.external_id
          : adapter.requiresExplicitSelection ? false : index === 0,
        status: "active",
        last_error: null,
        last_verified_at: now,
        updated_at: now,
      })));
    if (adapter.sharedAuthorizationAcrossAssets) {
      // The minimal Pinterest scopes do not expose a stable user-account ID,
      // and group boards can overlap between users. The database transaction
      // serializes concurrent callbacks and atomically replaces the one
      // Pinterest authorization allowed for this workspace.
      await sbRpc("replace_shared_social_connections", {
        p_brand_id: st.brand_id,
        p_platform: st.platform,
        p_rows: rows,
      });
    } else {
      await sbUpsert("social_connections", rows, "brand_id,platform,external_id");
    }

    return page(`${adapter.label} connected`,
      identities.length === 1
        ? `Connected as ${identities[0].display_name}. You can close this window.`
        : `Connected ${identities.length} ${adapter.id === "pinterest" ? "boards" : "Pages"}. ` +
          `Choose which one to publish to in FablePeak.`, true);
  } catch (e) {
    return page("Connection failed", providerConnectionError(e), false);
  }
};

export default {
  fetch: withSupabase({ auth: "none" }, handleCallback),
};
