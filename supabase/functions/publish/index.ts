// Publishes posts to the real platforms.
//   POST {post_id}   — publish one post now (called from the app)
//   POST {due:true}  — publish everything scheduled and due (called by pg_cron)
// Refreshes expired OAuth tokens automatically.
import {
  ADAPTERS,
  effectiveText,
  platformConnectionEnabled,
  ProviderRequestError,
  PublishOutcomeUnknownError,
  RetryablePublishError,
} from "../_shared/platforms.ts";
import { getUser, isMember, sbOne, sbRpc, sbUpdate, sbUpsert } from "../_shared/db.ts";
import { freshConnectionToken } from "../_shared/token-manager.ts";
import { monitorScheduledJob } from "../_shared/job-monitor.ts";

const env = (k: string) => Deno.env.get(k);
const APP_TIMEZONE = env("APP_TIMEZONE") ?? "Australia/Perth";
const CORS = {
  "Access-Control-Allow-Origin": env("APP_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
export const INTERRUPTED = "Delivery was interrupted. Verify the platform before retrying.";
const MAX_AUTOMATIC_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000];

export interface PublishDependencies {
  adapters: typeof ADAPTERS;
  platformConnectionEnabled: typeof platformConnectionEnabled;
  env: (key: string) => string | undefined;
  sbOne: typeof sbOne;
  sbUpdate: typeof sbUpdate;
  sbUpsert: typeof sbUpsert;
  freshConnectionToken: typeof freshConnectionToken;
  now: () => string;
}

export type PublishMode = "initial" | "automatic" | "manual";

export async function publishPost(
  post: any,
  overrides: Partial<PublishDependencies> = {},
  mode: PublishMode = "initial",
) {
  const dependencies: PublishDependencies = {
    adapters: ADAPTERS,
    platformConnectionEnabled,
    env,
    sbOne,
    sbUpdate,
    sbUpsert,
    freshConnectionToken,
    now: () => new Date().toISOString(),
    ...overrides,
  };
  const networks: string[] = Array.isArray(post.networks) ? post.networks : [];
  const results: any[] = [];

  for (const platform of networks) {
    const adapter = dependencies.adapters[platform];
    const mark = (patch: any) => dependencies.sbUpsert("post_targets", {
      post_id: post.id, brand_id: post.brand_id, platform,
      updated_at: dependencies.now(), ...patch,
    }, "post_id,platform");

    // A stale claim may be retried after an Edge Function interruption. Never
    // send again to a platform whose successful delivery was already recorded.
    const previous = await dependencies.sbOne("post_targets",
      `select=status,remote_id,remote_url,error,attempts,failure_kind,next_retry_at` +
      `&post_id=eq.${encodeURIComponent(post.id)}` +
      `&platform=eq.${encodeURIComponent(platform)}`);
    const attempts = Number(previous?.attempts ?? 0);
    if (previous?.status === "published") {
      results.push({ platform, status: "published", url: previous.remote_url, recovered: true });
      continue;
    }
    // If execution stopped after the provider request but before its response
    // was recorded, automatically retrying could create a duplicate post.
    if (previous?.status === "publishing" || previous?.failure_kind === "unknown" ||
        previous?.error === INTERRUPTED) {
      await mark({ status: "failed", failure_kind: "unknown", next_retry_at: null,
        attempts, error: INTERRUPTED });
      results.push({ platform, status: "failed", failure_kind: "unknown", error: INTERRUPTED });
      continue;
    }

    // A due retry claims the post atomically, but eligibility remains
    // per-target. Never let one due transient target drag a permanent sibling
    // back through the provider. Manual retry is similarly limited to targets
    // that previously failed with a known outcome.
    const retryDue = previous?.failure_kind === "retryable" &&
      !!previous.next_retry_at && new Date(previous.next_retry_at).getTime() <=
        new Date(dependencies.now()).getTime();
    const retryEligible = mode === "automatic" ? !previous || retryDue
      : mode === "manual" ? ["retryable", "permanent"].includes(previous?.failure_kind)
      : true;
    if (!retryEligible) {
      results.push({
        platform,
        status: previous?.status ?? "skipped",
        failure_kind: previous?.failure_kind ?? "permanent",
        next_retry_at: previous?.next_retry_at ?? null,
        error: previous?.error ?? "Target is not eligible for this retry.",
        preserved: true,
      });
      continue;
    }

    if (!adapter || !dependencies.platformConnectionEnabled(adapter) ||
        !dependencies.env(adapter.clientIdEnv)) {
      await mark({ status: "skipped", failure_kind: "permanent", next_retry_at: null,
        attempts, error: "Platform not configured on the server" });
      results.push({ platform, status: "skipped", failure_kind: "permanent",
        error: "Platform not configured on the server" });
      continue;
    }

    let conn = await dependencies.sbOne("social_connections",
      `select=*&brand_id=eq.${encodeURIComponent(post.brand_id)}` +
      `&platform=eq.${platform}&is_default=eq.true`);
    // Legacy rows created before explicit account selection may not have a
    // default yet. Only that migration case may fall back to the oldest active
    // connection; never bypass an expired/error selected account.
    if (!conn && !adapter.requiresExplicitSelection) conn = await dependencies.sbOne("social_connections",
      `select=*&brand_id=eq.${encodeURIComponent(post.brand_id)}` +
      `&platform=eq.${platform}&status=eq.active&order=connected_at.asc`);
    if (!conn) {
      await mark({ status: "skipped", failure_kind: "permanent", next_retry_at: null,
        attempts, error: "No connected account for this platform" });
      results.push({ platform, status: "skipped", failure_kind: "permanent",
        error: "No connected account for this platform" });
      continue;
    }
    if (conn.status !== "active") {
      const error = "The selected account needs attention — verify or reconnect it before publishing.";
      await mark({ status: "skipped", failure_kind: "permanent", next_retry_at: null,
        attempts, connection_id: conn.id, error });
      results.push({ platform, status: "skipped", failure_kind: "permanent", error });
      continue;
    }
    if (post.media_url && adapter.supportsMedia === false) {
      const error = `${adapter.label} currently supports text-only publishing; media was not sent.`;
      await mark({ status: "failed", failure_kind: "permanent", next_retry_at: null,
        attempts, connection_id: conn.id, error });
      results.push({ platform, status: "failed", failure_kind: "permanent", error });
      continue;
    }

    const currentAttempt = attempts + 1;
    await mark({ status: "publishing", connection_id: conn.id, attempts: currentAttempt,
      failure_kind: null, next_retry_at: null, error: null });
    try {
      const token = await dependencies.freshConnectionToken(conn, dependencies.env);
      // ADR 0005 decision 4: variants resolve here, in the per-target loop, and
      // not at claim time. The three claim RPCs are the atomicity-critical SQL
      // and already return `p.*`, so keeping them shape-agnostic meant no
      // migration to any of them. A post with no `variants` resolves to
      // `post.text` for every platform, which is what keeps existing posts
      // publishing byte-identically.
      const out = await adapter.publish({
        text: effectiveText(post, platform), mediaUrl: post.media_url ?? null,
        accessToken: token, connection: conn,
      });
      await mark({ status: "published", connection_id: conn.id, attempts: currentAttempt,
        remote_id: out.remote_id, remote_url: out.remote_url ?? null,
        failure_kind: null, next_retry_at: null, error: null,
        published_at: dependencies.now() });
      results.push({ platform, status: "published", url: out.remote_url });
    } catch (e) {
      const unknown = e instanceof PublishOutcomeUnknownError;
      const safelyTransient = e instanceof RetryablePublishError ||
        (e instanceof ProviderRequestError && e.retryable);
      const retryable = safelyTransient && currentAttempt < MAX_AUTOMATIC_ATTEMPTS;
      const failureKind = unknown ? "unknown" : retryable ? "retryable" : "permanent";
      const msg = unknown ? INTERRUPTED : String((e as Error).message ?? e).slice(0, 500);
      const nextRetryAt = retryable
        ? new Date(new Date(dependencies.now()).getTime() + RETRY_DELAYS_MS[currentAttempt - 1])
          .toISOString()
        : null;
      await mark({ status: "failed", connection_id: conn.id, attempts: currentAttempt,
        failure_kind: failureKind, next_retry_at: nextRetryAt, error: msg });
      results.push({ platform, status: "failed", failure_kind: failureKind,
        next_retry_at: nextRetryAt, error: msg });
    }
  }

  const retryPending = results.some((r) => r.failure_kind === "retryable");
  const allPublished = results.length > 0 && results.every((r) => r.status === "published");
  await dependencies.sbUpdate("posts", `id=eq.${encodeURIComponent(post.id)}`, {
    status: retryPending ? "scheduled" : allPublished ? "published" : "failed",
    publish_claimed_at: null,
    updated_at: dependencies.now(),
  });

  return results;
}

async function publishClaimedPost(post: any, mode: PublishMode) {
  try {
    return await publishPost(post, {}, mode);
  } catch (error) {
    // Provider failures are handled per target in publishPost. Reaching here
    // means infrastructure failed between claim and completion; release the
    // claim so the post is visible and retryable instead of stuck forever.
    try {
      try {
        await sbUpdate("post_targets",
          `post_id=eq.${encodeURIComponent(post.id)}&status=eq.publishing`, {
            status: "failed",
            failure_kind: "unknown",
            next_retry_at: null,
            error: INTERRUPTED,
            updated_at: new Date().toISOString(),
          });
      } catch { /* the database migration recovers this marker after 15 minutes */ }
      await sbUpdate("posts",
        `id=eq.${encodeURIComponent(post.id)}&status=eq.publishing`, {
          status: "failed",
          publish_claimed_at: null,
          updated_at: new Date().toISOString(),
        });
    } catch { /* keep the original failure; stale-claim recovery is the backstop */ }
    throw error;
  }
}

if (import.meta.main) Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));

    // cron path: publish everything due
    if (body.due) {
      if (req.headers.get("x-cron-secret") !== env("CRON_SECRET")) {
        return json({ error: "forbidden" }, 403);
      }
      const result = await monitorScheduledJob("publish", async () => {
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
            out.push({ post: p.id, results: await publishClaimedPost(p, "automatic") });
          } catch (e) {
            out.push({ post: p.id, error: String((e as Error).message ?? e).slice(0, 500) });
          }
        }
        const published = out.filter((item) =>
          item.results?.some((target: any) => target.status === "published")).length;
        const failed = out.filter((item) => item.error ||
          item.results?.some((target: any) => target.status !== "published")).length;
        return { processed: out.length, published, failed, timezone: APP_TIMEZONE, out };
      });
      return json(result);
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

    const claimRpc = body.retry ? "claim_post_for_retry" : "claim_post_for_publish";
    const claimed = await sbRpc(claimRpc, {
      p_post_id: post.id,
    }) as any[];
    if (!claimed.length) {
      return json({ error: body.retry
        ? "No retryable delivery targets are available"
        : "This post is already publishing or published" }, 409);
    }

    return json({
      results: await publishClaimedPost(claimed[0], body.retry ? "manual" : "initial"),
    });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
