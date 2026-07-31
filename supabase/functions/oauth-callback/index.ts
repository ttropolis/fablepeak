// OAuth redirect target. Exchanges the code for tokens, identifies the remote
// account, stores the connection, and closes the popup.
import { ADAPTERS, exchangeToken } from "../_shared/platforms.ts";
import { sbOne, sbDelete, sbUpsert } from "../_shared/db.ts";

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

Deno.serve(async (req) => {
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

    const adapter = ADAPTERS[st.platform];
    const clientId = env(adapter.clientIdEnv)!, clientSecret = env(adapter.clientSecretEnv)!;
    const redirectUri = `${env("SUPABASE_URL")}/functions/v1/oauth-callback`;

    const params: Record<string, string> = {
      grant_type: "authorization_code", code, redirect_uri: redirectUri,
    };
    if (st.code_verifier) params.code_verifier = st.code_verifier;
    if (adapter.id === "tiktok") params.client_key = clientId;

    const tokens = await exchangeToken(adapter, params, clientId, clientSecret);
    const identity = await adapter.identify(tokens);

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;

    await sbUpsert("social_connections", {
      brand_id: st.brand_id,
      user_id: st.user_id,
      platform: st.platform,
      external_id: identity.external_id,
      display_name: identity.display_name,
      avatar_url: identity.avatar_url ?? null,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? null,
      token_expires_at: expiresAt,
      scopes: tokens.scope ?? adapter.scopes.join(" "),
      meta: identity.meta ?? {},
      status: "active",
      last_error: null,
      updated_at: new Date().toISOString(),
    }, "brand_id,platform,external_id");

    return page(`${adapter.label} connected`,
      `Connected as ${identity.display_name}. You can close this window.`, true);
  } catch (e) {
    return page("Connection failed", String((e as Error).message ?? e), false);
  }
});
