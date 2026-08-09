import { sbInsert, sbUpdate } from "./db.ts";

export type JobRunStart = {
  id: string;
  job_name: string;
  status: "running";
  started_at: string;
};

export type JobRunFinish = {
  status: "succeeded" | "failed";
  finished_at: string;
  result: unknown;
  error: string | null;
};

export interface JobRunStore {
  start(run: JobRunStart): Promise<void>;
  finish(id: string, result: JobRunFinish): Promise<void>;
}

const postgresStore: JobRunStore = {
  start: async run => { await sbInsert("scheduled_job_runs", run); },
  finish: async (id, result) => {
    await sbUpdate("scheduled_job_runs", `id=eq.${encodeURIComponent(id)}`, result);
  },
};

type MonitorDependencies = {
  store: JobRunStore;
  now: () => string;
  id: () => string;
};

/** Execute one scheduled job and make its terminal outcome durable. */
export async function monitorScheduledJob<T>(
  jobName: string,
  work: () => Promise<T>,
  overrides: Partial<MonitorDependencies> = {},
): Promise<T> {
  const dependencies: MonitorDependencies = {
    store: postgresStore,
    now: () => new Date().toISOString(),
    id: () => crypto.randomUUID(),
    ...overrides,
  };
  const id = dependencies.id();
  await dependencies.store.start({
    id,
    job_name: jobName,
    status: "running",
    started_at: dependencies.now(),
  });

  try {
    const result = await work();
    await dependencies.store.finish(id, {
      status: "succeeded",
      finished_at: dependencies.now(),
      result,
      error: null,
    });
    return result;
  } catch (error) {
    const message = String((error as Error).message ?? error).slice(0, 1000);
    await dependencies.store.finish(id, {
      status: "failed",
      finished_at: dependencies.now(),
      result: null,
      error: message,
    });
    throw error;
  }
}
