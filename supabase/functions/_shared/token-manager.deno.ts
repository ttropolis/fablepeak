import {
  maintainConnectionTokens,
  refreshFailureDisposition,
  revokeUserAuthorizations,
} from "./token-manager.ts";
import { CredentialRejectedError, ProviderRequestError } from "./platforms.ts";

const originalFetch = globalThis.fetch;

const assertEquals = (actual: unknown, expected: unknown, message = "values differ") => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

Deno.test("proactive maintenance renews every due authorization including non-default accounts", async () => {
  const renewed: string[] = [];
  const now = Date.parse("2026-08-09T00:00:00Z");
  const outcomes = await maintainConnectionTokens([
    {
      id: "default-page", platform: "facebook", external_id: "page-1",
      status: "active", is_default: true,
      token_expires_at: "2026-08-12T00:00:00Z", access_token: "token-1",
    },
    {
      id: "other-page", platform: "facebook", external_id: "page-2",
      status: "active", is_default: false,
      token_expires_at: "2026-08-13T00:00:00Z", access_token: "token-2",
    },
    {
      id: "later", platform: "youtube", external_id: "channel-1",
      status: "active", is_default: true,
      token_expires_at: "2026-08-20T00:00:00Z", access_token: "token-3",
    },
  ], () => undefined, {
    now: () => now,
    renew: async connection => { renewed.push(connection.id); return "fresh"; },
  });

  assertEquals(renewed, ["default-page", "other-page"]);
  assertEquals(outcomes.map(outcome => [outcome.connection_id, outcome.status]), [
    ["default-page", "refreshed"],
    ["other-page", "refreshed"],
    ["later", "not_due"],
  ]);
});

Deno.test("proactive maintenance renews a shared authorization once", async () => {
  const renewed: string[] = [];
  const shared = { authorization_id: "auth-1" };
  const outcomes = await maintainConnectionTokens([
    {
      id: "board-1", brand_id: "brand-1", platform: "pinterest", external_id: "board-1",
      status: "active", token_expires_at: "2026-08-10T00:00:00Z",
      access_token: "token-1", meta: shared,
    },
    {
      id: "board-2", brand_id: "brand-1", platform: "pinterest", external_id: "board-2",
      status: "active", token_expires_at: "2026-08-10T00:00:00Z",
      access_token: "token-1", meta: shared,
    },
  ], () => undefined, {
    now: () => Date.parse("2026-08-09T00:00:00Z"),
    renew: async connection => { renewed.push(connection.id); return "fresh"; },
  });

  assertEquals(renewed, ["board-1"]);
  assertEquals(outcomes.map(outcome => outcome.status), ["refreshed", "covered"]);
});

Deno.test("a shared authorization failure is reported for every exposed asset", async () => {
  let renewals = 0;
  const outcomes = await maintainConnectionTokens([
    {
      id: "board-1", brand_id: "brand-1", platform: "pinterest", external_id: "board-1",
      status: "active", token_expires_at: "2026-08-10T00:00:00Z", access_token: "token-1",
      meta: { authorization_id: "auth-1" },
    },
    {
      id: "board-2", brand_id: "brand-1", platform: "pinterest", external_id: "board-2",
      status: "active", token_expires_at: "2026-08-10T00:00:00Z", access_token: "token-1",
      meta: { authorization_id: "auth-1" },
    },
  ], () => undefined, {
    now: () => Date.parse("2026-08-09T00:00:00Z"),
    renew: async () => { renewals++; throw new Error("refresh token rejected"); },
  });

  assertEquals(renewals, 1);
  assertEquals(outcomes.map(outcome => [outcome.status, outcome.error]), [
    ["failed", "refresh token rejected"],
    ["failed", "refresh token rejected"],
  ]);
});

Deno.test("account deletion revokes every live authorization with the user credential", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : "";
    calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname} ` +
      `${url.searchParams.get("access_token") ?? body}`);
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const outcomes = await revokeUserAuthorizations([
      {
        id: "page-conn", platform: "facebook", external_id: "page-1",
        access_token: "page-token", refresh_token: "user-token",
      },
      {
        id: "channel-conn", platform: "youtube", external_id: "channel-1",
        access_token: "google-access", refresh_token: "google-refresh",
      },
    ], () => undefined);

    assertEquals(calls, [
      // The Page token would only address the Page; Meta needs the user token.
      "DELETE graph.facebook.com/v25.0/me/permissions user-token",
      "POST oauth2.googleapis.com/revoke token=google-refresh",
    ]);
    assertEquals(outcomes, [
      { connection_id: "page-conn", status: "revoked" },
      { connection_id: "channel-conn", status: "revoked" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("a provider revocation failure is reported and never blocks deletion", async () => {
  globalThis.fetch = (input) => String(input).includes("facebook")
    ? Promise.reject(new TypeError("network unavailable"))
    : Promise.resolve(new Response("revoke unavailable", { status: 503 }));

  try {
    const outcomes = await revokeUserAuthorizations([
      {
        id: "page-conn", platform: "facebook", external_id: "page-1",
        access_token: "page-token", refresh_token: "user-token",
      },
      {
        id: "channel-conn", platform: "youtube", external_id: "channel-1",
        access_token: "google-access",
      },
    ], () => undefined);

    assertEquals(outcomes.map(outcome => outcome.status), ["failed", "failed"]);
    assertEquals(outcomes[0].error, "network unavailable");
    assertEquals(outcomes[1].error?.startsWith("youtube revoke: 503"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("platforms without a revocation API are skipped without a provider call", async () => {
  globalThis.fetch = (input) => Promise.reject(new Error(`Unexpected request: ${input}`));

  try {
    const outcomes = await revokeUserAuthorizations([
      // Instagram has no revocation endpoint; it reports the fact instead.
      { id: "ig-conn", platform: "instagram", external_id: "ig-1", access_token: "ig-token" },
      // Production-frozen adapters deliberately omit `revoke` entirely.
      { id: "li-conn", platform: "linkedin", external_id: "li-1", access_token: "li-token" },
      // A connection whose credentials were already cleared cannot be revoked.
      { id: "empty-conn", platform: "youtube", external_id: "channel-1" },
    ], () => undefined);

    assertEquals(outcomes, [
      { connection_id: "ig-conn", status: "unsupported" },
      { connection_id: "li-conn", status: "unsupported" },
      { connection_id: "empty-conn", status: "unsupported" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("transient proactive refresh failures preserve a still-valid authorization", () => {
  const expiry = Date.parse("2026-08-12T00:00:00Z");
  const now = Date.parse("2026-08-09T00:00:00Z");
  assertEquals(refreshFailureDisposition(
    new ProviderRequestError("instagram token refresh", 503, "unavailable"), expiry, now,
  ), "preserve");
  assertEquals(refreshFailureDisposition(new TypeError("network unavailable"), expiry, now), "preserve");
});

Deno.test("credential rejection or actual expiry disables the authorization", () => {
  const future = Date.parse("2026-08-12T00:00:00Z");
  const now = Date.parse("2026-08-09T00:00:00Z");
  assertEquals(refreshFailureDisposition(
    new CredentialRejectedError("refresh token rejected"), future, now,
  ), "expire");
  assertEquals(refreshFailureDisposition(
    new ProviderRequestError("token refresh", 401, "invalid token"), future, now,
  ), "expire");
  assertEquals(refreshFailureDisposition(new TypeError("network unavailable"), now - 1, now), "expire");
});
