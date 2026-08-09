import { createHandler } from "./index.ts";

const assertEquals = (actual: unknown, expected: unknown, message = "values differ") => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

Deno.test("operations health requires the cron secret", async () => {
  const handler = createHandler({
    env: key => key === "OPERATIONS_HEALTH_SECRET" ? "secret" : undefined,
    latest: async () => { throw new Error("must not query"); },
    now: () => Date.parse("2026-08-09T12:00:00Z"),
  });
  const response = await handler(new Request("https://example.test", { method: "POST" }));
  assertEquals(response.status, 403);
});

Deno.test("operations health fails when any scheduled job is stale or failed", async () => {
  const rows: Record<string, any> = {
    publish: { job_name:"publish", status:"succeeded", started_at:"2026-08-09T11:50:00Z" },
    connections: { job_name:"connections", status:"failed", started_at:"2026-08-09T11:17:00Z", error:"refresh failed" },
    metrics: { job_name:"metrics", status:"succeeded", started_at:"2026-08-08T10:00:00Z" },
  };
  const handler = createHandler({
    env: key => key === "OPERATIONS_HEALTH_SECRET" ? "secret" : undefined,
    latest: async job => rows[job] ?? null,
    now: () => Date.parse("2026-08-09T12:00:00Z"),
  });
  const response = await handler(new Request("https://example.test", {
    method: "POST", headers: { "x-cron-secret": "secret" },
  }));
  const body = await response.json();
  assertEquals(response.status, 503);
  assertEquals(body.ok, false);
  assertEquals(body.jobs.publish.reason, "stale");
  assertEquals(body.jobs.connections.reason, "failed");
  assertEquals(body.jobs.metrics.reason, "stale");
});

Deno.test("operations health passes when every scheduled job is recent", async () => {
  const rows: Record<string, any> = {
    publish: { job_name:"publish", status:"succeeded", started_at:"2026-08-09T11:59:00Z" },
    connections: { job_name:"connections", status:"succeeded", started_at:"2026-08-09T11:17:00Z" },
    metrics: { job_name:"metrics", status:"succeeded", started_at:"2026-08-08T19:17:00Z" },
  };
  const handler = createHandler({
    env: key => key === "OPERATIONS_HEALTH_SECRET" ? "secret" : undefined,
    latest: async job => rows[job] ?? null,
    now: () => Date.parse("2026-08-09T12:00:00Z"),
  });
  const response = await handler(new Request("https://example.test", {
    method: "POST", headers: { "x-cron-secret": "secret" },
  }));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).ok, true);
});

Deno.test("operations health fails when a recent run completed with workload failures", async () => {
  const rows: Record<string, any> = {
    publish: {
      job_name:"publish", status:"succeeded", started_at:"2026-08-09T11:59:00Z",
      result:{ processed:2, published:0, failed:2 },
    },
    connections: {
      job_name:"connections", status:"succeeded", started_at:"2026-08-09T11:17:00Z",
      result:{ checked:2, refreshed:0, failed:2 },
    },
    metrics: {
      job_name:"metrics", status:"succeeded", started_at:"2026-08-08T19:17:00Z",
      result:{ attempted:2, ingested:0, failed:2 },
    },
  };
  const handler = createHandler({
    env: key => key === "OPERATIONS_HEALTH_SECRET" ? "secret" : undefined,
    latest: async job => rows[job] ?? null,
    now: () => Date.parse("2026-08-09T12:00:00Z"),
  });
  const response = await handler(new Request("https://example.test", {
    method: "POST", headers: { "x-cron-secret": "secret" },
  }));
  const body = await response.json();
  assertEquals(response.status, 503);
  assertEquals(body.jobs.publish.reason, "work_failed");
  assertEquals(body.jobs.connections.reason, "work_failed");
  assertEquals(body.jobs.metrics.reason, "work_failed");
});

Deno.test("new monitoring gets one honest schedule window to warm up", async () => {
  const handler = createHandler({
    env: key => key === "OPERATIONS_HEALTH_SECRET" ? "secret" : undefined,
    latest: async job => job === "monitor-bootstrap" ? {
      job_name:job, status:"succeeded", started_at:"2026-08-09T11:58:00Z",
    } : null,
    now: () => Date.parse("2026-08-09T12:00:00Z"),
  });
  const response = await handler(new Request("https://example.test", {
    method: "POST", headers: { "x-cron-secret": "secret" },
  }));
  const body = await response.json();
  assertEquals(response.status, 200);
  assertEquals(body.jobs.publish.reason, "warming_up");
  assertEquals(body.jobs.connections.reason, "warming_up");
  assertEquals(body.jobs.metrics.reason, "warming_up");
});
