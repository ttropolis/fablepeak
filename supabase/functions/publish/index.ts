// Publishes posts to the real platforms.
//   POST {post_id}   — publish one post now (called from the app)
//   POST {due:true}  — publish everything scheduled and due (called by pg_cron)
// Refreshes expired OAuth tokens automatically.
import { ADAPTERS } from "../_shared/platforms.ts";
import { getUser, isMember, sbOne, sbRpc, sbUpdate, sbUpsert } from "../_shared/db.ts";
import { freshConnectionToken } from "../_shared/token-manager.ts";

const env = (k: string) => Deno.env.get(k);
const APP_TIMEZONE = env("APP_TIMEZONE") ?? "Australia/Perth";
const CORS = {
  "Access-Control-Allow-Origin": env("APP_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function publishPost(post: any) {
  const networks: string[] = Array.isArray(post.networks) ? post.networks : [];
  const results: any[] = [];

  for (const platform of networks) {
    const adapter = ADAPTERS[platform];
    const mark = (patch: any) => sbUpsert("post_targets", {
      post_id: post.id, brand_id: post.brand_id, platform,
      updated_at: new Date().toISOString(), ...patch,
    }, "post_id,platform");

    if (!adapter || !env(adapter.clientIdEnv)) {
      await mark({ status: "skipped", error: "Platform not configured on the server" });
      results.push({ platform, status: "skipped", error: "Platform not configured on the server" });
      continue;
    }

    const conn = await sbOne("social_connections",
      `select=*&brand_id=eq.${encodeURIComponent(post.brand_id)}` +
      `&platform=eq.${platform}&status=eq.active&order=is_default.desc,connected_at.asc`);
    if (!conn) {
      await mark({ status: "skipped", error: "No connected account for this platform" });
      results.push({ platform, status: "skipped", error: "No connected account for this platform" });
      continue;
    }

    await mark({ status: "publishing", connection_id: conn.id });
    try {
      const token = await freshConnectionToken(conn, env);
      const out = await adapter.publish({
        text: post.text, mediaUrl: post.media_url ?? null,
        accessToken: token, connection: conn,
      });
      await mark({ status: "published", connection_id: conn.id,
        remote_id: out.remote_id, remote_url: out.remote_url ?? null,
        error: null, published_at: new Date().toISOString() });
      results.push({ platform, status: "published", url: out.remote_url });
    } catch (e) {
      const msg = String((e as Error).message ?? e).slice(0, 500);
      await mark({ status: "failed", connection_id: conn.id, error: msg });
      results.push({ platform, status: "failed", error: msg });
    }
  }

  const anyOk = results.some((r) => r.status === "published");
  await sbUpdate("posts", `id=eq.${encodeURIComponent(post.id)}`, {
    status: anyOk ? "published" : "draft",
    publish_claimed_at: null,
    updated_at: new Date().toISOString(),
  });

  return results;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}));

    // cron path: publish everything due
    if (body.due) {
      if (req.headers.get("x-cron-secret") !== env("CRON_SECRET")) {
        return json({ error: "forbidden" }, 403);
      }
      // Postgres compares the post's wall-clock date/time in APP_TIMEZONE and
      // atomically changes it to "publishing". Concurrent cron runs therefore
      // cannot deliver the same scheduled post twice.
      const ready = await sbRpc("claim_due_posts", {
        p_timezone: APP_TIMEZONE,
        p_limit: 25,
      }) as any[];
      const out = [];
      for (const p of ready) out.push({ post: p.id, results: await publishPost(p) });
      return json({ published: out.length, timezone: APP_TIMEZONE, out });
    }

    // app path: authenticated user publishes one of their posts now
    const jwt = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const user = await getUser(jwt);
    if (!user) return json({ error: "Invalid session" }, 401);

    const post = await sbOne("posts", `select=*&id=eq.${encodeURIComponent(body.post_id ?? "")}`);
    if (!post) return json({ error: "Post not found" }, 404);
    if (!await isMember(post.brand_id, user.id)) {
      return json({ error: "No access to this post" }, 403);
    }

    const claimed = await sbRpc("claim_post_for_publish", {
      p_post_id: post.id,
    }) as any[];
    if (!claimed.length) {
      return json({ error: "This post is already publishing or published" }, 409);
    }

    return json({ results: await publishPost(claimed[0]) });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
