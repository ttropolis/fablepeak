// Publishes posts to the real platforms.
//   POST {post_id}   — publish one post now (called from the app)
//   POST {due:true}  — publish everything scheduled and due (called by pg_cron)
// Refreshes expired OAuth tokens automatically.
import { ADAPTERS, platformConnectionEnabled } from "../_shared/platforms.ts";
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
const INTERRUPTED = "Delivery was interrupted. Verify the platform before retrying.";

async function publishPost(post: any) {
  const networks: string[] = Array.isArray(post.networks) ? post.networks : [];
  const results: any[] = [];

  for (const platform of networks) {
    const adapter = ADAPTERS[platform];
    const mark = (patch: any) => sbUpsert("post_targets", {
      post_id: post.id, brand_id: post.brand_id, platform,
      updated_at: new Date().toISOString(), ...patch,
    }, "post_id,platform");

    // A stale claim may be retried after an Edge Function interruption. Never
    // send again to a platform whose successful delivery was already recorded.
    const previous = await sbOne("post_targets",
      `select=status,remote_id,remote_url,error&post_id=eq.${encodeURIComponent(post.id)}` +
      `&platform=eq.${encodeURIComponent(platform)}`);
    if (previous?.status === "published") {
      results.push({ platform, status: "published", url: previous.remote_url, recovered: true });
      continue;
    }
    // If execution stopped after the provider request but before its response
    // was recorded, automatically retrying could create a duplicate post.
    if (previous?.status === "publishing" || previous?.error === INTERRUPTED) {
      await mark({ status: "failed", error: INTERRUPTED });
      results.push({ platform, status: "failed", error: INTERRUPTED });
      continue;
    }

    if (!adapter || !platformConnectionEnabled(adapter) || !env(adapter.clientIdEnv)) {
      await mark({ status: "skipped", error: "Platform not configured on the server" });
      results.push({ platform, status: "skipped", error: "Platform not configured on the server" });
      continue;
    }

    let conn = await sbOne("social_connections",
      `select=*&brand_id=eq.${encodeURIComponent(post.brand_id)}` +
      `&platform=eq.${platform}&is_default=eq.true`);
    // Legacy rows created before explicit account selection may not have a
    // default yet. Only that migration case may fall back to the oldest active
    // connection; never bypass an expired/error selected account.
    if (!conn) conn = await sbOne("social_connections",
      `select=*&brand_id=eq.${encodeURIComponent(post.brand_id)}` +
      `&platform=eq.${platform}&status=eq.active&order=connected_at.asc`);
    if (!conn) {
      await mark({ status: "skipped", error: "No connected account for this platform" });
      results.push({ platform, status: "skipped", error: "No connected account for this platform" });
      continue;
    }
    if (conn.status !== "active") {
      const error = "The selected account needs attention — verify or reconnect it before publishing.";
      await mark({ status: "skipped", connection_id: conn.id, error });
      results.push({ platform, status: "skipped", error });
      continue;
    }
    if (post.media_url && adapter.supportsMedia === false) {
      const error = `${adapter.label} currently supports text-only publishing; media was not sent.`;
      await mark({ status: "failed", connection_id: conn.id, error });
      results.push({ platform, status: "failed", error });
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

async function publishClaimedPost(post: any) {
  try {
    return await publishPost(post);
  } catch (error) {
    // Provider failures are handled per target in publishPost. Reaching here
    // means infrastructure failed between claim and completion; release the
    // claim so the post is visible and retryable instead of stuck forever.
    try {
      try {
        await sbUpdate("post_targets",
          `post_id=eq.${encodeURIComponent(post.id)}&status=eq.publishing`, {
            status: "failed",
            error: INTERRUPTED,
            updated_at: new Date().toISOString(),
          });
      } catch { /* the database migration recovers this marker after 15 minutes */ }
      await sbUpdate("posts",
        `id=eq.${encodeURIComponent(post.id)}&status=eq.publishing`, {
          status: "draft",
          publish_claimed_at: null,
          updated_at: new Date().toISOString(),
        });
    } catch { /* keep the original failure; stale-claim recovery is the backstop */ }
    throw error;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

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
      for (const p of ready) {
        try {
          out.push({ post: p.id, results: await publishClaimedPost(p) });
        } catch (e) {
          out.push({ post: p.id, error: String((e as Error).message ?? e).slice(0, 500) });
        }
      }
      const published = out.filter((item) =>
        item.results?.some((result: any) => result.status === "published")).length;
      return json({ processed: out.length, published, timezone: APP_TIMEZONE, out });
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

    return json({ results: await publishClaimedPost(claimed[0]) });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
