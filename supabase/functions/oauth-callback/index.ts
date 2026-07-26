// OAuth redirect target. Exchanges the code for tokens, identifies the remote
// account, stores the connection, and closes the popup.
import { ADAPTERS, exchangeToken } from "../_shared/platforms.ts";
import { sbOne, sbDelete, sbUpsert } from "../_shared/db.ts";

const env = (k: string) => Deno.env.get(k);
const esc = (s: string) => String(s).replace(/[<>&"]/g, (c) =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));

const page = (title: string, msg: string, ok: boolean) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#1c3d5a;
color:#fff;display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:24px}
.c{max-width:440px}.i{font-size:44px;margin-bottom:12px}h1{font-size:20px;margin:0 0 8px}
p{color:#b6cddd;font-size:14px;line-height:1.6;margin:0 0 18px}
button{background:#22c1dc;border:0;color:#04303a;font-weight:600;padding:10px 18px;border-radius:8px;cursor:pointer}</style>
<div class="c"><div class="i">${ok ? "✅" : "⚠️"}</div><h1>${esc(title)}</h1><p>${esc(msg)}</p>
<button onclick="window.close()">Close</button></div>
<script>
  try { window.opener && window.opener.postMessage(
    {source:"fablepeak-oauth", ok:${ok}}, "*"); } catch(e) {}
  ${ok ? "setTimeout(function(){window.close();}, 1200);" : ""}
</script>`,
  { headers: { "Content-Type": "text/html; charset=utf-8" } });

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
