// Publishes posts to the real platforms.
//   POST {post_id}   — publish one post now (called from the app)
//   POST {due:true}  — publish everything scheduled and due (called by pg_cron)
// Refreshes expired OAuth tokens automatically.
import { ADAPTERS, exchangeToken } from "../_shared/platforms.ts";
import { getUser, isMember, sbSelect, sbOne, sbUpdate, sbUpsert } from "../_shared/db.ts";

const env = (k: string) => Deno.env.get(k);
const CORS = {
  "Access-Control-Allow-Origin": env("APP_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/** Returns a valid access token, refreshing it first if it has expired. */
async function freshToken(conn: any): Promise<string> {
  const exp = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : null;
  if (!exp || exp - Date.now() > 120_000) return conn.access_token;
  if (!conn.refresh_token) {
    await sbUpdate("social_connections", `id=eq.${conn.id}`, {
      status: "expired",
      last_error: "Access expired and no refresh token — reconnect this account.",
    });
    throw new Error("Access expired — reconnect this account.");
  }
  const a = ADAPTERS[conn.platform];
  const tokens = await exchangeToken(a,
    { grant_type: "refresh_token", refresh_token: conn.refresh_token },
    env(a.clientIdEnv)!, env(a.clientSecretEnv)!);
  await sbUpdate("social_connections", `id=eq.${conn.id}`, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? conn.refresh_token,
    token_expires_at: tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
    status: "active", last_error: null, updated_at: new Date().toISOString(),
  });
  return tokens.access_token;
}

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
      `&platform=eq.${platform}&status=eq.active`);
    if (!conn) {
      await mark({ status: "skipped", error: "No connected account for this platform" });
      results.push({ platform, status: "skipped", error: "No connected account for this platform" });
      continue;
    }

    await mark({ status: "publishing", connection_id: conn.id });
    try {
      const token = await freshToken(conn);
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
    status: anyOk ? "published" : "draft", updated_at: new Date().toISOString(),
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
      const due = await sbSelect("posts", "select=*&status=eq.scheduled&limit=25");
      const now = Date.now();
      const ready = due.filter((p: any) =>
        new Date(`${p.date}T${p.time ?? "10:00"}:00`).getTime() <= now);
      const out = [];
      for (const p of ready) out.push({ post: p.id, results: await publishPost(p) });
      return json({ published: out.length, out });
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

    return json({ results: await publishPost(post) });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
