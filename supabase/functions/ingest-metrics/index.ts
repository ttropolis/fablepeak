// Pulls real metrics from every connected account into metrics_daily.
// Invoked daily by pg_cron. Never called directly by the browser — the app
// reads the metrics_daily table (RLS-protected) instead.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ADAPTERS, exchangeToken } from "../_shared/platforms.ts";

const env = (k: string) => Deno.env.get(k);
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

async function freshToken(db: any, conn: any): Promise<string> {
  const exp = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : null;
  if (!exp || exp - Date.now() > 120_000) return conn.access_token;
  if (!conn.refresh_token) throw new Error("expired, no refresh token");
  const a = ADAPTERS[conn.platform];
  const t = await exchangeToken(a,
    { grant_type: "refresh_token", refresh_token: conn.refresh_token },
    env(a.clientIdEnv)!, env(a.clientSecretEnv)!);
  await db.from("social_connections").update({
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? conn.refresh_token,
    token_expires_at: t.expires_in
      ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq("id", conn.id);
  return t.access_token;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== env("CRON_SECRET")) {
    return json({ error: "forbidden" }, 403);
  }
  const db = createClient(env("SUPABASE_URL")!, env("SUPABASE_SERVICE_ROLE_KEY")!);
  const today = new Date().toISOString().slice(0, 10);

  const { data: conns } = await db.from("social_connections").select("*").eq("status", "active");
  const out: any[] = [];

  for (const conn of conns ?? []) {
    const adapter = ADAPTERS[conn.platform];
    if (!adapter?.metrics) continue;
    try {
      const token = await freshToken(db, conn);
      const m = await adapter.metrics({ accessToken: token, connection: conn });
      if (!m) continue;

      // posts we actually published today, per platform
      const { count } = await db.from("post_targets")
        .select("id", { count: "exact", head: true })
        .eq("brand_id", conn.brand_id).eq("platform", conn.platform)
        .eq("status", "published").gte("published_at", `${today}T00:00:00Z`);

      await db.from("metrics_daily").upsert({
        brand_id: conn.brand_id, platform: conn.platform, date: today,
        followers: m.followers ?? null, impressions: m.impressions ?? null,
        engagements: m.engagements ?? null, posts: count ?? 0,
        raw: m, fetched_at: new Date().toISOString(),
      }, { onConflict: "brand_id,platform,date" });
      out.push({ platform: conn.platform, brand: conn.brand_id, ok: true });
    } catch (e) {
      const msg = String((e as Error).message ?? e).slice(0, 300);
      await db.from("social_connections").update({ last_error: msg }).eq("id", conn.id);
      out.push({ platform: conn.platform, brand: conn.brand_id, ok: false, error: msg });
    }
  }
  return json({ ingested: out.length, out });
});
