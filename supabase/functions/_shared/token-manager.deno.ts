import { refreshFailureDisposition, maintainConnectionTokens } from "./token-manager.ts";
import { CredentialRejectedError, ProviderRequestError } from "./platforms.ts";

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
