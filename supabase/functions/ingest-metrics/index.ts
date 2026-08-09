// Pulls real metrics from every connected account into metrics_daily.
// Invoked daily by pg_cron. Never called directly by the browser — the app
// reads the metrics_daily table (RLS-protected) instead.
import { ADAPTERS } from "../_shared/platforms.ts";
import { sbSelect, sbUpdate, sbUpsert, sbCount } from "../_shared/db.ts";
import { freshConnectionToken } from "../_shared/token-manager.ts";
import { monitorScheduledJob } from "../_shared/job-monitor.ts";

const env = (k: string) => Deno.env.get(k);
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (req.headers.get("x-cron-secret") !== env("CRON_SECRET")) {
    return json({ error: "forbidden" }, 403);
  }
  try {
    const result = await monitorScheduledJob("metrics", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const conns = await sbSelect("social_connections", "select=*&status=eq.active&is_default=eq.true");
      const out: any[] = [];
      let attempted = 0;

      for (const conn of conns) {
        const adapter = ADAPTERS[conn.platform];
        if (!adapter?.metrics) continue;
        attempted++;
        try {
          const token = await freshConnectionToken(conn, env);
          const m = await adapter.metrics({ accessToken: token, connection: conn });
          if (!m) continue;

          const posts = await sbCount("post_targets",
            `brand_id=eq.${encodeURIComponent(conn.brand_id)}&platform=eq.${conn.platform}` +
            `&status=eq.published&published_at=gte.${today}T00:00:00Z`);

          await sbUpsert("metrics_daily", {
            brand_id: conn.brand_id, platform: conn.platform, date: today,
            followers: m.followers ?? null, impressions: m.impressions ?? null,
            engagements: m.engagements ?? null, posts,
            raw: m, fetched_at: new Date().toISOString(),
          }, "brand_id,platform,date");
          out.push({ platform: conn.platform, brand: conn.brand_id, ok: true });
        } catch (e) {
          const msg = String((e as Error).message ?? e).slice(0, 300);
          await sbUpdate("social_connections", `id=eq.${conn.id}`, { last_error: msg });
          out.push({ platform: conn.platform, brand: conn.brand_id, ok: false, error: msg });
        }
      }
      const ingested = out.filter(item => item.ok).length;
      const failed = out.filter(item => !item.ok).length;
      return { attempted, ingested, failed, out };
    });
    return json(result);
  } catch (error) {
    return json({ error: String((error as Error).message ?? error).slice(0, 500) }, 500);
  }
});
