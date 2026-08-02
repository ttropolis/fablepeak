// Central OAuth token lifecycle for all jobs that call social platforms.
// Provider-specific refresh behavior lives behind the platform adapter seam;
// persistence and connection health transitions live here once for every job.
import { ADAPTERS, refreshPlatformToken } from "./platforms.ts";
import { sbUpdate } from "./db.ts";
import { decryptToken, encryptToken } from "./token-crypto.ts";

type Connection = {
  id: string;
  platform: string;
  access_token?: string | null;
  refresh_token?: string | null;
  token_expires_at?: string | null;
  scopes?: string | null;
};

export async function freshConnectionToken(
  conn: Connection,
  env: (key: string) => string | undefined,
): Promise<string> {
  if (!conn.access_token) throw new Error("Missing access token — reconnect this account.");
  const accessToken = await decryptToken(conn.access_token);
  const refreshToken = await decryptToken(conn.refresh_token);
  if (!accessToken) throw new Error("Missing access token — reconnect this account.");

  const expiresAt = conn.token_expires_at
    ? new Date(conn.token_expires_at).getTime()
    : null;
  if (!expiresAt || expiresAt - Date.now() > 120_000) return accessToken;

  const adapter = ADAPTERS[conn.platform];
  const clientId = adapter && env(adapter.clientIdEnv);
  const clientSecret = adapter && env(adapter.clientSecretEnv);
  if (!adapter || !clientId || !clientSecret) {
    await expire(conn.id, "Platform credentials are unavailable — reconnect after the administrator fixes them.");
    throw new Error("Platform credentials are unavailable.");
  }

  if (!adapter.refreshAccess && !refreshToken) {
    await expire(conn.id, "Access expired and no refresh token was issued — reconnect this account.");
    throw new Error("Access expired — reconnect this account.");
  }

  try {
    const tokens = await refreshPlatformToken(adapter, {
      accessToken,
      refreshToken: refreshToken ?? undefined,
      clientId,
      clientSecret,
    });
    if (!tokens.access_token) throw new Error("Provider returned no access token.");

    await sbUpdate("social_connections", `id=eq.${encodeURIComponent(conn.id)}`, {
      access_token: await encryptToken(tokens.access_token),
      refresh_token: await encryptToken(tokens.refresh_token ?? refreshToken),
      token_expires_at: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null,
      scopes: tokens.scope ?? conn.scopes ?? null,
      status: "active",
      last_error: null,
      updated_at: new Date().toISOString(),
    });
    return tokens.access_token;
  } catch (e) {
    const detail = String((e as Error).message ?? e).slice(0, 300);
    await expire(conn.id, `Could not refresh access — reconnect this account. ${detail}`);
    throw new Error("Could not refresh access — reconnect this account.");
  }
}

async function expire(id: string, message: string) {
  await sbUpdate("social_connections", `id=eq.${encodeURIComponent(id)}`, {
    status: "expired",
    last_error: message,
    updated_at: new Date().toISOString(),
  });
}
