// Central OAuth token lifecycle for all jobs that call social platforms.
// Provider-specific refresh behavior lives behind the platform adapter seam;
// persistence and connection health transitions live here once for every job.
import {
  ADAPTERS,
  CredentialRejectedError,
  ProviderRequestError,
  refreshPlatformToken,
  RetryablePublishError,
} from "./platforms.ts";
import { sbUpdate } from "./db.ts";
import { decryptToken, encryptToken } from "./token-crypto.ts";

export type Connection = {
  id: string;
  brand_id?: string;
  platform: string;
  external_id: string;
  status?: string | null;
  is_default?: boolean | null;
  meta?: Record<string, unknown> | null;
  access_token?: string | null;
  refresh_token?: string | null;
  token_expires_at?: string | null;
  scopes?: string | null;
};

export const PROACTIVE_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type TokenMaintenanceOutcome = {
  connection_id: string;
  status: "refreshed" | "failed" | "covered" | "not_due" | "not_refreshable";
  error?: string;
};

type TokenMaintenanceDependencies = {
  now: () => number;
  renew: (
    connection: Connection,
    env: (key: string) => string | undefined,
  ) => Promise<string>;
};

export async function freshConnectionToken(
  conn: Connection,
  env: (key: string) => string | undefined,
): Promise<string> {
  return connectionToken(conn, env, 120_000);
}

async function connectionToken(
  conn: Connection,
  env: (key: string) => string | undefined,
  refreshWindowMs: number,
): Promise<string> {
  if (!conn.access_token) throw new Error("Missing access token — reconnect this account.");
  const accessToken = await decryptToken(conn.access_token);
  const refreshToken = await decryptToken(conn.refresh_token);
  if (!accessToken) throw new Error("Missing access token — reconnect this account.");

  const expiresAt = conn.token_expires_at
    ? new Date(conn.token_expires_at).getTime()
    : null;
  if (!expiresAt || expiresAt - Date.now() > refreshWindowMs) return accessToken;

  const adapter = ADAPTERS[conn.platform];
  const clientId = adapter && env(adapter.clientIdEnv);
  const clientSecret = adapter && env(adapter.clientSecretEnv);
  const updateQuery = connectionUpdateQuery(conn, !!adapter?.sharedAuthorizationAcrossAssets);
  try {
    if (!adapter || !clientId || !clientSecret) {
      throw new Error("Platform credentials are unavailable.");
    }
    if (!adapter.refreshAccess && !refreshToken) {
      throw new Error("Provider did not issue a refresh token.");
    }
    const tokens = await refreshPlatformToken(adapter, {
      accessToken,
      refreshToken: refreshToken ?? undefined,
      clientId,
      clientSecret,
      connection: { external_id: conn.external_id, meta: conn.meta ?? undefined },
    });
    if (!tokens.access_token) throw new Error("Provider returned no access token.");

    // Pinterest exposes many selectable boards through one rotating user
    // authorization. Keep sibling board rows on the same newly-issued token;
    // otherwise refreshing one board can strand the others on an old refresh
    // credential.
    await sbUpdate("social_connections", updateQuery, {
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
    const disposition = refreshFailureDisposition(e, expiresAt, Date.now());
    if (disposition === "expire") {
      await expire(updateQuery, `Could not refresh access — reconnect this account. ${detail}`);
      throw new Error("Could not refresh access — reconnect this account.");
    }
    await recordRefreshIssue(updateQuery,
      `Temporary refresh failure; the current token remains active. ${detail}`);
    throw new RetryablePublishError(
      "Access renewal is temporarily unavailable; FablePeak will retry safely.");
  }
}

export function refreshFailureDisposition(
  error: unknown,
  expiresAt: number,
  now: number,
): "preserve" | "expire" {
  if (expiresAt <= now) return "expire";
  if (error instanceof CredentialRejectedError) return "expire";
  if (error instanceof ProviderRequestError && [400, 401, 403].includes(error.status)) {
    return "expire";
  }
  return "preserve";
}

/**
 * Proactively renew every active authorization approaching expiry. Shared
 * authorizations (for example, one Pinterest login exposing several boards)
 * are renewed once because token-manager updates every sibling row together.
 */
export async function maintainConnectionTokens(
  connections: Connection[],
  env: (key: string) => string | undefined,
  overrides: Partial<TokenMaintenanceDependencies> = {},
): Promise<TokenMaintenanceOutcome[]> {
  const dependencies: TokenMaintenanceDependencies = {
    now: () => Date.now(),
    renew: (connection, runtimeEnv) =>
      connectionToken(connection, runtimeEnv, PROACTIVE_REFRESH_WINDOW_MS),
    ...overrides,
  };
  const authorizationOutcomes = new Map<string, TokenMaintenanceOutcome>();
  const outcomes: TokenMaintenanceOutcome[] = [];

  for (const connection of connections) {
    const expiresAt = connection.token_expires_at
      ? new Date(connection.token_expires_at).getTime()
      : NaN;
    if (connection.status !== "active" || !Number.isFinite(expiresAt)) {
      outcomes.push({ connection_id: connection.id, status: "not_refreshable" });
      continue;
    }
    if (expiresAt - dependencies.now() > PROACTIVE_REFRESH_WINDOW_MS) {
      outcomes.push({ connection_id: connection.id, status: "not_due" });
      continue;
    }

    const authorizationId = connection.meta?.authorization_id;
    const authorizationKey = authorizationId
      ? `${connection.brand_id ?? ""}:${connection.platform}:${String(authorizationId)}`
      : connection.id;
    const prior = authorizationOutcomes.get(authorizationKey);
    if (prior) {
      outcomes.push(prior.status === "failed"
        ? { connection_id: connection.id, status: "failed", error: prior.error }
        : { connection_id: connection.id, status: "covered" });
      continue;
    }

    try {
      await dependencies.renew(connection, env);
      const outcome: TokenMaintenanceOutcome = {
        connection_id: connection.id,
        status: "refreshed",
      };
      authorizationOutcomes.set(authorizationKey, outcome);
      outcomes.push(outcome);
    } catch (error) {
      const outcome: TokenMaintenanceOutcome = {
        connection_id: connection.id,
        status: "failed",
        error: String((error as Error).message ?? error).slice(0, 300),
      };
      authorizationOutcomes.set(authorizationKey, outcome);
      outcomes.push(outcome);
    }
  }

  return outcomes;
}

function connectionUpdateQuery(conn: Connection, shared: boolean) {
  const authorizationId = conn.meta?.authorization_id;
  return shared && conn.brand_id && authorizationId
    ? `brand_id=eq.${encodeURIComponent(conn.brand_id)}` +
      `&platform=eq.${encodeURIComponent(conn.platform)}` +
      `&meta->>authorization_id=eq.${encodeURIComponent(String(authorizationId))}`
    : `id=eq.${encodeURIComponent(conn.id)}`;
}

async function expire(filter: string, message: string) {
  await sbUpdate("social_connections", filter, {
    status: "expired",
    last_error: message,
    updated_at: new Date().toISOString(),
  });
}

async function recordRefreshIssue(filter: string, message: string) {
  await sbUpdate("social_connections", filter, {
    last_error: message,
    updated_at: new Date().toISOString(),
  });
}
