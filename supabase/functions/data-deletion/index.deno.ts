import { createHandler, verifySignedRequest } from "./index.ts";

const assertEquals = (actual: unknown, expected: unknown, message = "values differ") => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Build a Meta-shaped `signed_request` the way the provider does. */
async function signedRequest(payload: Record<string, unknown>, secret: string) {
  const encodedPayload = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(encodedPayload),
  ));
  return `${base64Url(signature)}.${encodedPayload}`;
}

const metaPayload = (userId: string) => ({
  algorithm: "HMAC-SHA256",
  issued_at: 1_756_000_000,
  user_id: userId,
});

type Recorded = { table: string; row: any };

function harness(overrides: Record<string, unknown> = {}) {
  const recorded: Recorded[] = [];
  const deleted: string[] = [];
  const updated: Array<{ filter: string; patch: any }> = [];
  const handler = createHandler({
    env: key => ({
      META_APP_SECRET: "meta-secret",
      INSTAGRAM_APP_SECRET: "instagram-secret",
      APP_ORIGIN: "https://fablepeak.com",
    } as Record<string, string>)[key],
    listConnections: async () => [],
    deleteConnections: async (table, filter) => { deleted.push(`${table}?${filter}`); return null; },
    updateConnections: async (table, filter, patch) => {
      updated.push({ filter: `${table}?${filter}`, patch });
      return null;
    },
    recordRequest: async (table, row) => { recorded.push({ table, row }); return null; },
    confirmationCode: () => "abc123",
    ...overrides,
  });
  return { handler, recorded, deleted, updated };
}

const post = (body: string) => new Request("https://example.test", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body,
});

Deno.test("a valid Meta signature deletes the matching connection and confirms", async () => {
  const matched = [{ id: "conn-1", brand_id: "brand-1", platform: "instagram", is_default: true }];
  const queries: string[] = [];
  const { handler, recorded, deleted, updated } = harness({
    listConnections: async (_table: string, query: string) => {
      queries.push(query);
      return queries.length === 1 ? matched : [{ id: "conn-2" }];
    },
  });
  const request = await signedRequest(metaPayload("ig-9"), "instagram-secret");
  const response = await handler(post(`signed_request=${encodeURIComponent(request)}`));

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    url: "https://fablepeak.com/data-deletion.html?code=abc123",
    confirmation_code: "abc123",
  });
  assertEquals(deleted, [
    "social_connections?platform=eq.instagram&external_id=eq.ig-9",
  ]);
  assertEquals(updated, [
    { filter: "social_connections?id=eq.conn-2", patch: { is_default: true } },
  ]);
  assertEquals(recorded, [{
    table: "provider_deletion_requests",
    row: {
      provider_user_id: "ig-9",
      platform: "instagram",
      status: "completed",
      confirmation_code: "abc123",
    },
  }]);
});

Deno.test("a request with no matching connection is still recorded", async () => {
  const { handler, recorded, deleted } = harness();
  const request = await signedRequest(metaPayload("1000123"), "meta-secret");
  const response = await handler(post(`signed_request=${encodeURIComponent(request)}`));

  assertEquals(response.status, 200);
  assertEquals(deleted, []);
  assertEquals(recorded[0].row, {
    provider_user_id: "1000123",
    platform: "facebook",
    status: "no_matching_connection",
    confirmation_code: "abc123",
  });
});

Deno.test("a Facebook callback matches the connection by its app-scoped user id", async () => {
  const queries: string[] = [];
  const { handler, recorded, deleted, updated } = harness({
    listConnections: async (_table: string, query: string) => {
      queries.push(query);
      // No Page id can equal the app-scoped user id Meta sends; the ASID
      // captured on the connection is what identifies the person.
      if (query.includes("meta->>asid=eq.1000123")) {
        return [{ id: "conn-1", brand_id: "brand-1", platform: "facebook", is_default: true }];
      }
      return query.startsWith("select=id&brand_id=") ? [{ id: "conn-2" }] : [];
    },
  });
  const request = await signedRequest(metaPayload("1000123"), "meta-secret");
  const response = await handler(post(`signed_request=${encodeURIComponent(request)}`));

  assertEquals(response.status, 200);
  assertEquals(deleted, [
    "social_connections?platform=eq.facebook&meta->>asid=eq.1000123",
  ]);
  assertEquals(updated, [
    { filter: "social_connections?id=eq.conn-2", patch: { is_default: true } },
  ]);
  assertEquals(recorded[0].row, {
    provider_user_id: "1000123",
    platform: "facebook",
    status: "completed",
    confirmation_code: "abc123",
  });
});

Deno.test("a Facebook connection stored without an app-scoped id takes the manual path", async () => {
  const queries: string[] = [];
  const { handler, recorded, deleted } = harness({
    listConnections: async (_table: string, query: string) => {
      queries.push(query);
      return [];
    },
  });
  const request = await signedRequest(metaPayload("1000123"), "meta-secret");
  const response = await handler(post(`signed_request=${encodeURIComponent(request)}`));

  assertEquals(response.status, 200);
  // Both scoped identifiers are tried; neither is inferred from the other.
  assertEquals(queries, [
    "select=id,brand_id,platform,is_default&platform=eq.facebook&external_id=eq.1000123",
    "select=id,brand_id,platform,is_default&platform=eq.facebook&meta->>asid=eq.1000123",
  ]);
  assertEquals(deleted, []);
  assertEquals(recorded[0].row.status, "no_matching_connection");
});

Deno.test("an Instagram callback never widens its match beyond the stored account id", async () => {
  const queries: string[] = [];
  const { handler } = harness({
    listConnections: async (_table: string, query: string) => {
      queries.push(query);
      return [];
    },
  });
  const request = await signedRequest(metaPayload("ig-9"), "instagram-secret");
  await handler(post(`signed_request=${encodeURIComponent(request)}`));

  assertEquals(queries, [
    "select=id,brand_id,platform,is_default&platform=eq.instagram&external_id=eq.ig-9",
  ]);
});

Deno.test("the Instagram app secret verifies when the Meta secret does not", async () => {
  const { handler, recorded } = harness();
  const request = await signedRequest(metaPayload("ig-42"), "instagram-secret");
  const response = await handler(post(`signed_request=${encodeURIComponent(request)}`));

  assertEquals(response.status, 200);
  assertEquals(recorded[0].row.platform, "instagram");
});

Deno.test("a tampered payload is rejected without any deletion", async () => {
  const { handler, recorded, deleted } = harness();
  const request = await signedRequest(metaPayload("1000123"), "meta-secret");
  const [signature] = request.split(".");
  const forged = base64Url(new TextEncoder().encode(
    JSON.stringify(metaPayload("999999")),
  ));
  const response = await handler(post(
    `signed_request=${encodeURIComponent(`${signature}.${forged}`)}`,
  ));

  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: "invalid signed_request" });
  assertEquals(deleted, []);
  assertEquals(recorded, []);
});

Deno.test("a signature from the wrong secret is rejected", async () => {
  const { handler, recorded } = harness();
  const request = await signedRequest(metaPayload("1000123"), "not-our-secret");
  const response = await handler(post(`signed_request=${encodeURIComponent(request)}`));

  assertEquals(response.status, 400);
  assertEquals(recorded, []);
});

Deno.test("malformed and unsigned callbacks are rejected", async () => {
  const { handler } = harness();
  for (const body of ["", "signed_request=", "signed_request=not-a-signed-request"]) {
    assertEquals((await handler(post(body))).status, 400, body);
  }
  const unsupportedAlgorithm = await signedRequest(
    { algorithm: "NONE", user_id: "1000123" }, "meta-secret",
  );
  assertEquals(
    (await handler(post(`signed_request=${encodeURIComponent(unsupportedAlgorithm)}`))).status,
    400,
  );
});

Deno.test("the callback only answers POST and only when a secret is configured", async () => {
  const { handler } = harness();
  assertEquals(
    (await handler(new Request("https://example.test", { method: "GET" }))).status,
    405,
  );
  const unconfigured = createHandler({ env: () => undefined });
  const request = await signedRequest(metaPayload("1000123"), "meta-secret");
  const response = await unconfigured(post(`signed_request=${encodeURIComponent(request)}`));
  assertEquals(response.status, 503);
});

Deno.test("signature verification accepts only the exact signed payload segment", async () => {
  const request = await signedRequest(metaPayload("1000123"), "meta-secret");
  assertEquals(await verifySignedRequest(request, "meta-secret"), { user_id: "1000123" });
  assertEquals(await verifySignedRequest(request, "meta-secre"), null);
  assertEquals(await verifySignedRequest(`${request}.extra`, "meta-secret"), null);
  const withoutUser = await signedRequest({ algorithm: "HMAC-SHA256" }, "meta-secret");
  assertEquals(await verifySignedRequest(withoutUser, "meta-secret"), null);
});
