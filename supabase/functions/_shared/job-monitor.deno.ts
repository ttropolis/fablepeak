import { monitorScheduledJob, type JobRunStore } from "./job-monitor.ts";

const assertEquals = (actual: unknown, expected: unknown, message = "values differ") => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

function memoryStore() {
  const rows = new Map<string, Record<string, unknown>>();
  const store: JobRunStore = {
    start: async run => { rows.set(run.id, { ...run }); },
    finish: async (id, result) => { rows.set(id, { ...rows.get(id), ...result }); },
  };
  return { rows, store };
}

Deno.test("scheduled job success is durably observable through the run store", async () => {
  const memory = memoryStore();
  const result = await monitorScheduledJob("publish", async () => ({ processed: 2 }), {
    store: memory.store,
    now: () => "2026-08-09T00:00:00.000Z",
    id: () => "run-1",
  });

  assertEquals(result, { processed: 2 });
  assertEquals(memory.rows.get("run-1"), {
    id: "run-1", job_name: "publish", status: "succeeded",
    started_at: "2026-08-09T00:00:00.000Z",
    finished_at: "2026-08-09T00:00:00.000Z",
    result: { processed: 2 }, error: null,
  });
});

Deno.test("scheduled job failure is retained and rethrown", async () => {
  const memory = memoryStore();
  let error = "";
  try {
    await monitorScheduledJob("metrics", async () => { throw new Error("provider unavailable"); }, {
      store: memory.store,
      now: () => "2026-08-09T01:00:00.000Z",
      id: () => "run-2",
    });
  } catch (caught) {
    error = String((caught as Error).message);
  }

  assertEquals(error, "provider unavailable");
  assertEquals(memory.rows.get("run-2"), {
    id: "run-2", job_name: "metrics", status: "failed",
    started_at: "2026-08-09T01:00:00.000Z",
    finished_at: "2026-08-09T01:00:00.000Z",
    result: null, error: "provider unavailable",
  });
});
