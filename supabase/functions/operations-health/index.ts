// Authenticated operational status for external monitors. This proves the
// Vault secret, pg_cron schedule and Edge Function execution path are working
// together; public deployment smoke tests cannot establish that invariant.
import { sbOne } from "../_shared/db.ts";
import { verifyGitHubActionsRequest } from "../_shared/github-oidc.ts";

const JOBS = {
  publish: 5 * 60_000,
  connections: 2 * 60 * 60_000,
  metrics: 26 * 60 * 60_000,
} as const;

type JobName = keyof typeof JOBS;
type HealthKey = JobName | "monitor-bootstrap";
type JobRun = {
  job_name: string;
  status: "running" | "succeeded" | "failed";
  started_at: string;
  finished_at?: string | null;
  error?: string | null;
  result?: unknown;
};

type Dependencies = {
  env: (key: string) => string | undefined;
  latest: (jobName: HealthKey) => Promise<JobRun | null>;
  now: () => number;
  verifyGitHub: (req: Request) => Promise<boolean>;
};

function workloadFailed(result: unknown) {
  if (!result || typeof result !== "object") return false;
  const failed = Number((result as Record<string, unknown>).failed ?? 0);
  return Number.isFinite(failed) && failed > 0;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

export function createHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    env: key => Deno.env.get(key),
    latest: async jobName => await sbOne(
      "scheduled_job_runs",
      `select=job_name,status,started_at,finished_at,error,result` +
      `&job_name=eq.${encodeURIComponent(jobName)}&order=started_at.desc`,
    ) as JobRun | null,
    now: () => Date.now(),
    verifyGitHub: verifyGitHubActionsRequest,
    ...overrides,
  };

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const secret = dependencies.env("OPERATIONS_HEALTH_SECRET");
    const localOperator = !!secret && req.headers.get("x-cron-secret") === secret;
    if (!localOperator && !await dependencies.verifyGitHub(req)) {
      return json({ error: "forbidden" }, 403);
    }

    try {
      const jobs: Record<string, unknown> = {};
      let ok = true;
      const bootstrap = await dependencies.latest("monitor-bootstrap");
      const bootstrapAt = bootstrap ? new Date(bootstrap.started_at).getTime() : NaN;
      for (const [jobName, maxAge] of Object.entries(JOBS) as [JobName, number][]) {
        const run = await dependencies.latest(jobName);
        const startedAt = run ? new Date(run.started_at).getTime() : NaN;
        const ageMs = Number.isFinite(startedAt) ? dependencies.now() - startedAt : Infinity;
        const warmingUp = !run && Number.isFinite(bootstrapAt) &&
          dependencies.now() - bootstrapAt < maxAge;
        const runningNormally = run?.status === "running" && ageMs < 2 * 60_000;
        const reason = warmingUp ? "warming_up"
          : !run ? "missing"
          : ageMs >= maxAge ? "stale"
          : run.status === "failed" ? "failed"
          : run.status === "running" && !runningNormally ? "stuck"
          : workloadFailed(run.result) ? "work_failed"
          : null;
        const jobOk = reason === null || reason === "warming_up";
        ok &&= jobOk;
        jobs[jobName] = {
          ok: jobOk,
          reason,
          status: run?.status ?? "missing",
          last_run_at: run?.started_at ?? null,
          age_seconds: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 1000)) : null,
          error: run?.error ?? null,
          result: run?.result ?? null,
        };
      }
      return json({ ok, checked_at: new Date(dependencies.now()).toISOString(), jobs }, ok ? 200 : 503);
    } catch (error) {
      return json({ ok: false, error: String((error as Error).message ?? error).slice(0, 500) }, 500);
    }
  };
}

if (import.meta.main) Deno.serve(createHandler());
