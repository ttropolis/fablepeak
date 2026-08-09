// Proactively renews provider credentials before they enter their expiry
// window. Invoked by pg_cron; provider credentials never leave the function.
import { sbSelect } from "../_shared/db.ts";
import { monitorScheduledJob } from "../_shared/job-monitor.ts";
import {
  type Connection,
  maintainConnectionTokens,
  type TokenMaintenanceOutcome,
} from "../_shared/token-manager.ts";

type Dependencies = {
  env: (key: string) => string | undefined;
  listConnections: typeof sbSelect;
  maintain: (
    connections: Connection[],
    env: (key: string) => string | undefined,
  ) => Promise<TokenMaintenanceOutcome[]>;
  monitor: <T>(jobName: string, work: () => Promise<T>) => Promise<T>;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

export function createHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    env: key => Deno.env.get(key),
    listConnections: sbSelect,
    maintain: maintainConnectionTokens,
    monitor: monitorScheduledJob,
    ...overrides,
  };

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const secret = dependencies.env("CRON_SECRET");
    if (!secret || req.headers.get("x-cron-secret") !== secret) {
      return json({ error: "forbidden" }, 403);
    }

    try {
      const result = await dependencies.monitor("connections", async () => {
        const connections = await dependencies.listConnections(
          "social_connections",
          "select=*&status=eq.active",
        ) as Connection[];
        const outcomes = await dependencies.maintain(connections, dependencies.env);
        return {
          checked: connections.length,
          refreshed: outcomes.filter(outcome => outcome.status === "refreshed").length,
          failed: outcomes.filter(outcome => outcome.status === "failed").length,
          outcomes,
        };
      });
      return json(result);
    } catch (error) {
      return json({ error: String((error as Error).message ?? error).slice(0, 500) }, 500);
    }
  };
}

if (import.meta.main) Deno.serve(createHandler());
