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

/**
 * This authorization can never be renewed: the provider issued no refresh
 * credential and the adapter has no provider-specific renewal path. LinkedIn is
 * the live case — refresh tokens are reserved for its partner program, so a
 * 60-day token simply ends.
 *
 * Distinct from a refresh that failed, because retrying cannot help. Waiting
 * only moves the discovery to publish time, so the connection is marked for
 * reconnection while the current token still works.
 */
export class UnrenewableAuthorizationError extends Error {
  override name = "UnrenewableAuthorizationError";
}

export type TokenMaintenanceOutcome = {
  connection_id: string;
  status:
    | "refreshed"
    | "failed"
    | "covered"
    | "not_due"
    | "not_refreshable"
    | "needs_reconnect";
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

export type RevocationOutcome = {
  connection_id: string;
  status: "revoked" | "unsupported" | "failed";
  error?: string;
};

/**
 * Ask the provider to drop FablePeak's authorization for one connection.
 *
 * Best effort by contract: a customer must always be able to disconnect or
 * delete, so a provider outage, an already-invalid credential or a missing
 * revocation API is reported as an outcome and never thrown.
 */
export async function revokeConnectionAuthorization(
  conn: Connection,
  env: (key: string) => string | undefined,
): Promise<RevocationOutcome> {
  const adapter = ADAPTERS[conn.platform];
  if (!adapter?.revoke) return { connection_id: conn.id, status: "unsupported" };
  try {
    const rawKey = env("SOCIAL_TOKEN_ENCRYPTION_KEY") ?? "";
    const accessToken = await decryptToken(conn.access_token, rawKey);
    const refreshToken = await decryptToken(conn.refresh_token, rawKey);
    if (!accessToken && !refreshToken) {
      return { connection_id: conn.id, status: "unsupported" };
    }
    const outcome = await adapter.revoke({
      access_token: accessToken ?? refreshToken!,
      refresh_token: refreshToken ?? undefined,
    });
    return {
      connection_id: conn.id,
      status: outcome.revoked ? "revoked" : "unsupported",
    };
  } catch (error) {
    return {
      connection_id: conn.id,
      status: "failed",
      error: String((error as Error).message ?? error).slice(0, 300),
    };
  }
}

/**
 * Revoke a whole set of authorizations — every connection of an account being
 * deleted, or the single connection being disconnected. Returns one outcome per
 * connection and never throws, so callers can proceed to local removal
 * unconditionally.
 */
export async function revokeUserAuthorizations(
  connections: Connection[],
  env: (key: string) => string | undefined,
): Promise<RevocationOutcome[]> {
  const outcomes: RevocationOutcome[] = [];
  for (const connection of connections) {
    outcomes.push(await revokeConnectionAuthorization(connection, env));
  }
  return outcomes;
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
      throw new UnrenewableAuthorizationError(
        `${adapter.label} cannot renew this authorization automatically — ` +
        `reconnect this account to keep publishing.`);
    }
    const tokens = await refreshPlatformToken(adapter, {
      accessToken,
      refreshToken: refreshToken ?? undefined,
      clientId,
      clientSecret,
      connection: { external_id: conn.external_id, meta: conn.meta ?? undefined },
    });
    if (!tokens.access_token) throw new Error("Provider returned no access token.");

    // Identity facts the renewal discovered are merged onto this row's own
    // meta. Skipped for shared authorizations, where one patch rewrites every
    // sibling row and would overwrite their per-asset meta with this one's.
    const renewedMeta = tokens.meta && !adapter.sharedAuthorizationAcrossAssets
      ? { ...(conn.meta ?? {}), ...tokens.meta }
      : null;

    // Pinterest exposes many selectable boards through one rotating user
    // authorization. Keep sibling board rows on the same newly-issued token;
    // otherwise refreshing one board can strand the others on an old refresh
    // credential.
    await sbUpdate("social_connections", updateQuery, {
      ...(renewedMeta ? { meta: renewedMeta } : {}),
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
      // An authorization that was never renewable already explains itself; the
      // customer sees `last_error` verbatim, so do not prefix it with a refresh
      // attempt that never happened.
      const unrenewable = e instanceof UnrenewableAuthorizationError;
      const message = unrenewable
        ? detail
        : "Could not refresh access — reconnect this account.";
      await expire(updateQuery, unrenewable ? message : `${message} ${detail}`);
      throw unrenewable ? e : new Error(message);
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
  // Nothing can renew this credential, so preserving it only postpones the
  // reconnect until the token dies mid-publish.
  if (error instanceof UnrenewableAuthorizationError) return "expire";
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
      // A renewal covers every sibling asset, and so does a verdict that the
      // shared authorization cannot be renewed at all.
      outcomes.push(prior.status === "failed" || prior.status === "needs_reconnect"
        ? { connection_id: connection.id, status: prior.status, error: prior.error }
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
      // A credential that was never renewable is not a maintenance failure:
      // the run did its job by marking the connection for reconnection while
      // the token still works. Reporting it separately keeps the failure count
      // meaningful for the cron monitor.
      const outcome: TokenMaintenanceOutcome = {
        connection_id: connection.id,
        status: error instanceof UnrenewableAuthorizationError
          ? "needs_reconnect"
          : "failed",
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
