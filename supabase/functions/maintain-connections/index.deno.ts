import { createHandler } from "./index.ts";

const assertEquals = (actual: unknown, expected: unknown, message = "values differ") => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

Deno.test("connection maintenance rejects callers without the cron secret", async () => {
  const handler = createHandler({
    env: key => key === "CRON_SECRET" ? "secret" : undefined,
    listConnections: async () => { throw new Error("must not query"); },
    maintain: async () => [],
    monitor: async (_job, work) => await work(),
  });
  const response = await handler(new Request("https://example.test", { method: "POST" }));
  assertEquals(response.status, 403);
});

Deno.test("connection maintenance checks every active connection and returns outcomes", async () => {
  let query = "";
  const handler = createHandler({
    env: key => key === "CRON_SECRET" ? "secret" : undefined,
    listConnections: async (_table, requestedQuery) => {
      query = requestedQuery;
      return [{ id: "non-default", status: "active" }];
    },
    maintain: async connections => connections.map(connection => ({
      connection_id: connection.id,
      status: "refreshed" as const,
    })),
    monitor: async (_job, work) => await work(),
  });
  const response = await handler(new Request("https://example.test", {
    method: "POST",
    headers: { "x-cron-secret": "secret" },
  }));
  assertEquals(response.status, 200);
  assertEquals(query, "select=*&status=eq.active");
  assertEquals(await response.json(), {
    checked: 1,
    refreshed: 1,
    failed: 0,
    needs_reconnect: 0,
    outcomes: [{ connection_id: "non-default", status: "refreshed" }],
  });
});

Deno.test("connections a provider cannot renew are reported apart from failures", async () => {
  const handler = createHandler({
    env: key => key === "CRON_SECRET" ? "secret" : undefined,
    listConnections: async () => [{ id: "li-conn", status: "active" }],
    maintain: async connections => connections.map(connection => ({
      connection_id: connection.id,
      status: "needs_reconnect" as const,
      error: "LinkedIn cannot renew this authorization automatically — " +
        "reconnect this account to keep publishing.",
    })),
    monitor: async (_job, work) => await work(),
  });
  const response = await handler(new Request("https://example.test", {
    method: "POST",
    headers: { "x-cron-secret": "secret" },
  }));
  const body = await response.json();
  assertEquals([body.checked, body.refreshed, body.failed, body.needs_reconnect], [1, 0, 0, 1]);
});
