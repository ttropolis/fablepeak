// FablePeak — per-platform OAuth + publishing adapters.
// Runs only inside Supabase Edge Functions (Deno). Client secrets come from
// function secrets and are never exposed to the browser.
//
// Every platform implements the same shape so adding one is a single object.

export type Platform =
  | "youtube" | "x" | "instagram" | "facebook" | "linkedin" | "tiktok" | "pinterest";

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  /** identity facts learned during the exchange that belong on the stored
   * connection (for example Meta's app-scoped user id). Merged into the
   * existing `meta`, never replacing it. */
  meta?: Record<string, unknown>;
}

export interface Identity {
  external_id: string;
  display_name: string;
  avatar_url?: string;
  /** asset-scoped token when it differs from the OAuth user token */
  access_token?: string;
  meta?: Record<string, unknown>;
}

export interface PublishInput {
  text: string;
  mediaUrl?: string | null;
  accessToken: string;
  connection: { external_id: string; meta: Record<string, any> };
}

export interface PublishResult { remote_id: string; remote_url?: string; }

/** X refuses a tweet over 280 characters. ADR 0005 decision 12 replaced this
 * adapter's silent `text.slice(0, 280)` with a refusal, so the number is named
 * once and asserted against rather than repeated inside the request body. */
export const X_TEXT_LIMIT = 280;

/** The text one platform actually receives (ADR 0005 decisions 2-4).
 *
 * `posts.variants` is a `{ "<network>": "<text>" }` map that overrides
 * `posts.text` for that network. The amendment to decision 3 is the whole
 * reason this is a function and not the expression `post.variants?.[platform]
 * ?? post.text`: `??` only catches null and undefined, so a variant of `""` or
 * `"   "` would publish an empty or blank post to that network. **Missing,
 * empty and whitespace-only variants all mean "inherit the base text."**
 *
 * A variant that survives that test is sent verbatim, leading and trailing
 * whitespace included — trimming it would be editing the customer's copy.
 *
 * js/planner.js mirrors these exact semantics for the composer's previews,
 * counters and save-time validation. The two must not drift: a post whose
 * counter says it inherits must inherit here too. */
export function effectiveText(
  post: { text?: string | null; variants?: unknown },
  platform: string,
): string {
  const variants = post?.variants;
  const variant = variants && typeof variants === "object" && !Array.isArray(variants)
    ? (variants as Record<string, unknown>)[platform]
    : undefined;
  if (typeof variant === "string" && variant.trim() !== "") return variant;
  return post?.text ?? "";
}

/** Outcome of asking a provider to drop FablePeak's authorization.
 * `unsupported` distinguishes "the provider has no revocation API" from
 * "revocation was performed", so disconnect never claims an action it could
 * not take. */
export interface RevokeResult { revoked: boolean; unsupported?: boolean; }

/** The provider may have accepted the final publish request, but its response
 * was not received. Automatic retrying is unsafe because it can duplicate a
 * public post. */
export class PublishOutcomeUnknownError extends Error {
  override name = "PublishOutcomeUnknownError";
}

/** A provider returned an explicit non-success response. Only transient
 * response classes are safe for an automatic retry; client/auth failures need
 * operator or customer action. */
export class ProviderRequestError extends Error {
  override name = "ProviderRequestError";
  constructor(
    public readonly context: string,
    public readonly status: number,
    detail = "",
  ) {
    super(`${context}: ${status}${detail ? ` ${detail.slice(0, 400)}` : ""}`);
  }

  get retryable() {
    return this.status === 408 || this.status === 425 || this.status === 429 || this.status >= 500;
  }
}

/** Refresh succeeded far enough to prove that the stored authorization can no
 * longer be used (for example invalid_grant or an asset removed by its owner). */
export class CredentialRejectedError extends Error {
  override name = "CredentialRejectedError";
}

/** Failure happened before a final publish request could have created public
 * content, so a bounded retry cannot duplicate a post. */
export class RetryablePublishError extends Error {
  override name = "RetryablePublishError";
}

export interface PlatformAdapter {
  id: Platform;
  label: string;
  /** OAuth 2.0 authorize endpoint */
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** separator required by the provider's authorize endpoint */
  scopeSeparator?: " " | ",";
  usesPKCE: boolean;
  /** extra params appended to the authorize URL */
  authorizeExtra?: Record<string, string>;
  /** optional provider-side login configuration bundled with the OAuth request */
  authorizeConfigEnv?: string;
  /** token exchange needs client_secret in body (vs. basic auth) */
  tokenAuth: "body" | "basic";
  clientIdEnv: string;
  clientSecretEnv: string;
  /** provider-specific authorization-code exchange (for example Instagram's
   * required short-lived -> long-lived token exchange) */
  exchangeCode?(input: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
    clientId: string;
    clientSecret: string;
  }): Promise<TokenSet>;
  /** provider-specific renewal when OAuth refresh_token is not supported */
  refreshAccess?(input: {
    accessToken: string;
    refreshToken?: string;
    clientId: string;
    clientSecret: string;
    connection?: { external_id: string; meta?: Record<string, unknown> };
  }): Promise<TokenSet>;
  /** fetch who we just connected as */
  identify(tokens: TokenSet): Promise<Identity>;
  /** providers that authorize several assets at once can return all of them */
  identifyAll?(tokens: TokenSet): Promise<Identity[]>;
  /** publishing must remain blocked until the user selects one discovered asset */
  requiresExplicitSelection?: boolean;
  /** several discovered assets reuse one rotating user authorization */
  sharedAuthorizationAcrossAssets?: boolean;
  /** verify one stored asset still belongs to the supplied token */
  verify?(accessToken: string, connection: {
    external_id: string;
    display_name?: string;
    meta?: Record<string, unknown>;
  }): Promise<Identity>;
  /** ask the provider to drop this authorization when the customer
   * disconnects or deletes. Best effort by contract: callers must treat a
   * throw as non-fatal. Absent while an adapter is production-frozen. */
  revoke?(tokens: TokenSet): Promise<RevokeResult>;
  /** publish a post; throws with a readable message on failure */
  publish(input: PublishInput): Promise<PublishResult>;
  /** best-effort daily metrics; return null when unsupported */
  metrics?(input: { accessToken: string; connection: any }): Promise<{
    followers?: number; impressions?: number; engagements?: number;
  } | null>;
  /** platforms that cannot post text without an image */
  requiresMedia?: boolean;
  /** false when this adapter deliberately supports text-only publishing */
  supportsMedia?: boolean;
  /** false while an adapter cannot meet the provider's production workflow */
  productionEnabled?: boolean;
}

const j = async (r: Response, ctx: string) => {
  const body = await r.text();
  if (!r.ok) throw new ProviderRequestError(ctx, r.status, body);
  try { return JSON.parse(body); } catch { return {}; }
};

function rethrowFinalPublishFailure(
  error: unknown,
  response: Response,
  message: string,
): never {
  // A success whose body was lost and a provider-side 5xx are both ambiguous:
  // public content may have committed before the response failed. Only an
  // explicit non-5xx rejection is safe to classify normally.
  if (response.ok || (error instanceof ProviderRequestError && error.status >= 500)) {
    throw new PublishOutcomeUnknownError(message);
  }
  throw error;
}

/** Accept only public HTTPS media sources. The YouTube adapter fetches this
 * URL server-side, so allowing loopback/private hosts would create an SSRF
 * path through the publishing function. */
function publicMediaUrl(value: string, platform: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${platform} needs a valid media URL.`); }
  if (url.protocol !== "https:") throw new Error(`${platform} media must use https://.`);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const parts = host.split(".").map(Number);
  const privateV4 = parts.length === 4 && parts.every(Number.isInteger) && (
    parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
  const privateV6 = host === "::1" || host.startsWith("fe8") ||
    host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb") ||
    host.startsWith("fc") || host.startsWith("fd");
  if (!host || host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal") || privateV4 || privateV6) {
    throw new Error(`${platform} media must be hosted at a public URL.`);
  }
  return url.toString();
}

/** Follow redirects one at a time so every destination is validated before
 * the Edge Function connects to it. */
async function fetchPublicMedia(value: string, platform: string): Promise<Response> {
  let url = publicMediaUrl(value, platform);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const response = await fetch(url, { redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    url = publicMediaUrl(new URL(location, url).toString(), platform);
  }
  throw new Error(`${platform} media URL redirected too many times.`);
}

function mediaKind(value: string): "image" | "video" {
  const path = new URL(value).pathname.toLowerCase();
  return /\.(mp4|mov|m4v|webm)$/.test(path) ? "video" : "image";
}

const MAX_PROVIDER_MEDIA_BYTES = 50 * 1024 * 1024;

async function loadProviderMedia(value: string, platform: string) {
  const response = await fetchPublicMedia(value, platform);
  if (!response.ok) throw new Error(`${platform} could not fetch media (${response.status}).`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (!contentType.startsWith("image/") && !contentType.startsWith("video/")) {
    throw new Error(`${platform} needs a direct image or video file URL.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error(`${platform} media source returned an empty file.`);
  if (bytes.length > MAX_PROVIDER_MEDIA_BYTES) {
    throw new Error(`${platform} media exceeds FablePeak's 50 MB upload limit.`);
  }
  return { bytes, contentType };
}

function base64Bytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/* ------------------------------------------------------------------ YouTube */
const youtube: PlatformAdapter = {
  id: "youtube",
  label: "YouTube",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  // upload = publishing; readonly = channel identity and channel totals.
  // Do not request yt-analytics.readonly until we actually expose Analytics
  // reports: Google requires the narrowest scopes used by the live product.
  scopes: [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
  ],
  usesPKCE: true,
  // offline + consent are REQUIRED to receive a refresh_token from Google
  authorizeExtra: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  tokenAuth: "body",
  clientIdEnv: "GOOGLE_CLIENT_ID",
  clientSecretEnv: "GOOGLE_CLIENT_SECRET",

  async identify(t) {
    const d = await j(await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true",
      { headers: { Authorization: `Bearer ${t.access_token}` } }), "youtube identify");
    const ch = d.items?.[0];
    if (!ch) throw new Error("No YouTube channel found on this Google account.");
    return {
      external_id: ch.id,
      display_name: ch.snippet?.title ?? "YouTube channel",
      avatar_url: ch.snippet?.thumbnails?.default?.url,
      meta: { customUrl: ch.snippet?.customUrl },
    };
  },

  /** Google's revocation endpoint accepts either credential. Revoking the
   * refresh token invalidates every access token minted from it, so prefer it
   * when the connection still holds one. */
  async revoke(t) {
    const token = t.refresh_token ?? t.access_token;
    const response = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    if (!response.ok) {
      throw new ProviderRequestError("youtube revoke", response.status, await response.text());
    }
    return { revoked: true };
  },

  // A text "post" on YouTube is a community post — that API is not public.
  // What IS publishable via API is a video upload, so we require media.
  async publish({ text, mediaUrl, accessToken }) {
    if (!mediaUrl) {
      throw new Error(
        "YouTube publishing requires a video file URL — the Community Posts API is not public.");
    }
    const video = await fetchPublicMedia(mediaUrl, "YouTube");
    if (!video.ok) throw new Error(`Could not fetch media (${video.status})`);
    const contentType = video.headers.get("content-type")?.split(";", 1)[0].trim() ?? "";
    if (!contentType.startsWith("video/")) {
      throw new Error("YouTube needs a direct video file URL; the URL did not return video content.");
    }
    if (!video.body) throw new Error("The video source returned no content.");
    const meta = {
      snippet: { title: text.slice(0, 100) || "Untitled", description: text.slice(0, 5000) },
      status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
    };
    // resumable upload: start session, then send bytes
    let start: Response;
    try {
      start = await fetch(
        "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
        { method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json",
                     "X-Upload-Content-Type": contentType,
                     ...(video.headers.get("content-length")
                       ? { "X-Upload-Content-Length": video.headers.get("content-length")! } : {}) },
          body: JSON.stringify(meta) });
    } catch {
      throw new RetryablePublishError("YouTube upload session could not be started.");
    }
    if (!start.ok) throw new ProviderRequestError("youtube upload start", start.status, await start.text());
    const session = start.headers.get("location");
    if (!session) throw new Error("YouTube did not return an upload session URL");
    const uploadHeaders: Record<string, string> = { "Content-Type": contentType };
    const contentLength = video.headers.get("content-length");
    if (contentLength) uploadHeaders["Content-Length"] = contentLength;
    let uploadResponse: Response;
    try {
      uploadResponse = await fetch(session, {
        method: "PUT", headers: uploadHeaders, body: video.body,
      });
    } catch {
      throw new PublishOutcomeUnknownError(
        "YouTube may have accepted this video. Verify the channel before retrying.");
    }
    let up: any;
    try {
      up = await j(uploadResponse, "youtube upload");
    } catch (error) {
      rethrowFinalPublishFailure(error, uploadResponse,
        "YouTube may have accepted this video. Verify the channel before retrying.");
    }
    if (!up.id) throw new PublishOutcomeUnknownError(
      "YouTube may have accepted this video. Verify the channel before retrying.");
    return { remote_id: up.id, remote_url: `https://youtu.be/${up.id}` };
  },

  async metrics({ accessToken }) {
    const d = await j(await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true",
      { headers: { Authorization: `Bearer ${accessToken}` } }), "youtube metrics");
    const s = d.items?.[0]?.statistics;
    if (!s) return null;
    return { followers: Number(s.subscriberCount ?? 0), impressions: Number(s.viewCount ?? 0) };
  },
};

/* ------------------------------------------------------------------------ X */
const X_MEDIA_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime",
]);

async function waitForXMedia(mediaId: string, accessToken: string, processing: any) {
  let info = processing;
  for (let attempt = 0; attempt < 15; attempt++) {
    const state = info?.state;
    if (!state || state === "succeeded") return;
    if (state === "failed") {
      throw new Error(`X could not process this media: ${info?.error?.message ?? "processing failed"}`);
    }
    const seconds = Math.min(Math.max(Number(info?.check_after_secs) || 1, 1), 5);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
    const status = await j(await fetch(
      `https://api.x.com/2/media/upload?command=STATUS&media_id=${encodeURIComponent(mediaId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }), "x media processing");
    info = status.data?.processing_info;
  }
  throw new Error("X is still processing this media. Try publishing again shortly.");
}

async function uploadXMedia(mediaUrl: string, accessToken: string): Promise<string> {
  const { bytes, contentType } = await loadProviderMedia(mediaUrl, "X");
  if (!X_MEDIA_TYPES.has(contentType)) {
    throw new Error(`X does not support ${contentType || "this media type"}.`);
  }
  const xLimit = contentType === "image/gif" ? 15 * 1024 * 1024
    : contentType.startsWith("image/") ? 5 * 1024 * 1024
    : MAX_PROVIDER_MEDIA_BYTES;
  if (bytes.length > xLimit) {
    throw new Error(`X ${contentType === "image/gif" ? "GIF" : "image"} exceeds the provider's ${xLimit / 1024 / 1024} MB limit.`);
  }
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
  const chunked = contentType === "image/gif" || contentType.startsWith("video/");
  if (!chunked) {
    const uploaded = await j(await fetch("https://api.x.com/2/media/upload", {
      method: "POST", headers,
      body: JSON.stringify({
        media: base64Bytes(bytes), media_category: "tweet_image",
        media_type: contentType, shared: false,
      }),
    }), "x media upload");
    if (!uploaded.data?.id) throw new Error("X media upload returned no media ID.");
    return String(uploaded.data.id);
  }

  const initialized = await j(await fetch("https://api.x.com/2/media/upload/initialize", {
    method: "POST", headers,
    body: JSON.stringify({
      media_category: contentType === "image/gif" ? "tweet_gif" : "tweet_video",
      media_type: contentType, total_bytes: bytes.length, shared: false,
    }),
  }), "x media initialize");
  const mediaId = String(initialized.data?.id ?? "");
  if (!mediaId) throw new Error("X media initialization returned no media ID.");
  const chunkSize = 4 * 1024 * 1024;
  for (let offset = 0, segment = 0; offset < bytes.length; offset += chunkSize, segment++) {
    await j(await fetch(`https://api.x.com/2/media/upload/${mediaId}/append`, {
      method: "POST", headers,
      body: JSON.stringify({
        media: base64Bytes(bytes.subarray(offset, offset + chunkSize)),
        segment_index: segment,
      }),
    }), "x media append");
  }
  const finalized = await j(await fetch(`https://api.x.com/2/media/upload/${mediaId}/finalize`, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken}` },
  }), "x media finalize");
  await waitForXMedia(mediaId, accessToken, finalized.data?.processing_info);
  return mediaId;
}

const x: PlatformAdapter = {
  id: "x",
  label: "X / Twitter",
  authorizeUrl: "https://x.com/i/oauth2/authorize",
  tokenUrl: "https://api.x.com/2/oauth2/token",
  scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
  usesPKCE: true,               // PKCE is mandatory on X OAuth 2.0
  tokenAuth: "basic",           // confidential clients authenticate with Basic
  clientIdEnv: "X_CLIENT_ID",
  clientSecretEnv: "X_CLIENT_SECRET",
  supportsMedia: true,
  productionEnabled: false,    // frozen until the external-beta milestone passes

  async identify(t) {
    const d = await j(await fetch(
      "https://api.x.com/2/users/me?user.fields=profile_image_url,username,name",
      { headers: { Authorization: `Bearer ${t.access_token}` } }), "x identify");
    return {
      external_id: d.data.id,
      display_name: "@" + d.data.username,
      avatar_url: d.data.profile_image_url,
    };
  },

  async publish({ text, mediaUrl, accessToken }) {
    // ADR 0005 decision 12. The request body used to slice the text down to the
    // limit: X would accept a post the customer never wrote, with their last
    // sentence quietly missing. The composer now refuses to save an over-length
    // X variant, and this is the same rule restated at the boundary that
    // actually talks to the provider — defence in depth for any path that
    // reaches an adapter without passing through the composer (an imported
    // backup, a direct database write, a future API). A plain Error is
    // classified `permanent`, which is right: no retry can shorten the text.
    // Checked before the media upload so a doomed post costs no upload.
    if (text.length > X_TEXT_LIMIT) {
      throw new Error(
        `X posts are limited to ${X_TEXT_LIMIT} characters — this one is ` +
        `${text.length}. Shorten it, or give X its own shorter variant.`);
    }
    const mediaId = mediaUrl ? await uploadXMedia(mediaUrl, accessToken) : null;
    let response: Response;
    try {
      response = await fetch("https://api.x.com/2/tweets", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          ...(mediaId ? { media: { media_ids: [mediaId] } } : {}),
        }),
      });
    } catch {
      throw new PublishOutcomeUnknownError(
        "X may have accepted this post. Verify the profile before retrying.");
    }
    let publishPayload: any;
    try {
      publishPayload = await j(response, "x publish");
    } catch (error) {
      rethrowFinalPublishFailure(error, response,
        "X may have accepted this post. Verify the profile before retrying.");
    }
    return {
      remote_id: publishPayload.data.id,
      remote_url: `https://x.com/i/status/${publishPayload.data.id}`,
    };
  },

  /** `public_metrics` is served to the `users.read` + `tweet.read` scopes this
   * adapter already requests, so no scope change is needed to read it.
   * `followers_count` is a cumulative account total, which is what
   * metrics_daily stores and converts into day-over-day deltas.
   *
   * X exposes impressions only through per-post organic/private metrics, which
   * need scopes this adapter deliberately does not hold, so impressions are
   * omitted rather than reported as a fabricated zero. */
  async metrics({ accessToken }) {
    const d = await j(await fetch(
      "https://api.x.com/2/users/me?user.fields=public_metrics",
      { headers: { Authorization: `Bearer ${accessToken}` } }), "x metrics");
    const publicMetrics = d.data?.public_metrics;
    if (publicMetrics?.followers_count == null) return null;
    return { followers: Number(publicMetrics.followers_count) };
  },
};

/* ---------------------------------------------------------------- Meta base */
// Meta sunsets each Graph version ~2 years after release — bump deliberately.
const META_VERSION = "v25.0";
const metaToken = `https://graph.facebook.com/${META_VERSION}/oauth/access_token`;
const metaAuthorize = `https://www.facebook.com/${META_VERSION}/dialog/oauth`;

/** Pages the user administers, with their page access tokens. */
async function metaPages(accessToken: string) {
  const d = await j(await fetch(
    `https://graph.facebook.com/${META_VERSION}/me/accounts` +
    `?fields=id,name,access_token,picture{url}` +
    `&access_token=${encodeURIComponent(accessToken)}`), "meta pages");
  return d.data ?? [];
}

/** The app-scoped user id (ASID) of the person who authorized FablePeak.
 *
 * Meta's data-deletion callback identifies the customer by this id and never
 * by the Page ids FablePeak stores as `external_id`, so it is captured on
 * every path that writes a Facebook connection. Best effort by contract:
 * losing the ASID must never fail a connection or a token renewal, so a
 * provider failure returns null and the row simply keeps whatever it had.
 * Requires the long-lived *user* token — a Page token resolves `/me` to the
 * Page itself. */
async function metaAppScopedUserId(userAccessToken: string): Promise<string | null> {
  try {
    const d = await j(await fetch(
      `https://graph.facebook.com/${META_VERSION}/me?fields=id` +
      `&access_token=${encodeURIComponent(userAccessToken)}`), "meta app-scoped user id");
    return d.id ? String(d.id) : null;
  } catch {
    return null;
  }
}

const facebook: PlatformAdapter = {
  id: "facebook",
  label: "Facebook Page",
  authorizeUrl: metaAuthorize,
  tokenUrl: metaToken,
  scopes: ["pages_show_list", "pages_manage_posts", "pages_read_engagement"],
  usesPKCE: false,
  tokenAuth: "body",
  clientIdEnv: "META_APP_ID",
  clientSecretEnv: "META_APP_SECRET",
  authorizeConfigEnv: "META_CONFIG_ID",

  async exchangeCode({ code, redirectUri, clientId, clientSecret }) {
    const short = await exchangeToken(facebook, {
      grant_type: "authorization_code", code, redirect_uri: redirectUri,
    }, clientId, clientSecret);
    const long = await exchangeToken(facebook, {
      grant_type: "fb_exchange_token", fb_exchange_token: short.access_token,
    }, clientId, clientSecret);
    return {
      access_token: long.access_token,
      // Facebook does not issue an OAuth refresh_token. Retain the long-lived
      // user token separately so Page tokens can be reacquired at rollover.
      refresh_token: long.access_token,
      expires_in: long.expires_in,
      scope: facebook.scopes.join(" "),
    };
  },

  async refreshAccess({ refreshToken, clientId, clientSecret, connection }) {
    if (!refreshToken) throw new Error("Facebook did not retain a user token.");
    if (!connection?.external_id) throw new Error("Facebook Page identity is missing.");
    const long = await exchangeToken(facebook, {
      grant_type: "fb_exchange_token", fb_exchange_token: refreshToken,
    }, clientId, clientSecret);
    const page = (await metaPages(long.access_token))
      .find((candidate: any) => String(candidate.id) === String(connection.external_id));
    if (!page?.access_token) {
      throw new CredentialRejectedError(
        "This Facebook Page is no longer available to the authorizing user.");
    }
    const asid = await metaAppScopedUserId(long.access_token);
    return {
      access_token: page.access_token,
      refresh_token: long.access_token,
      expires_in: long.expires_in,
      scope: facebook.scopes.join(" "),
      // Backfills the ASID onto connections created before it was captured, so
      // a deletion callback can match them without waiting for a reconnect.
      ...(asid ? { meta: { asid } } : {}),
    };
  },

  async identify(t) {
    return (await facebook.identifyAll!(t))[0];
  },

  async identifyAll(t) {
    const pages = await metaPages(t.access_token);
    if (!pages.length) throw new Error(
      "No Facebook Page found. The account must administer a Page, and the Page must be " +
      "selected during the permission step.");
    // Every Page authorized in this handshake belongs to the same person, so
    // one lookup labels them all with the id Meta's deletion callback sends.
    const asid = await metaAppScopedUserId(t.access_token);
    return pages.map((p: any) => ({
      external_id: p.id,
      display_name: p.name,
      avatar_url: p.picture?.data?.url,
      access_token: p.access_token,
      meta: asid ? { asid } : {},
    }));
  },

  async verify(accessToken, connection) {
    const p = await j(await fetch(
      `https://graph.facebook.com/${META_VERSION}/${encodeURIComponent(connection.external_id)}` +
      `?fields=id,name,picture{url}&access_token=${encodeURIComponent(accessToken)}`),
      "facebook connection check");
    return {
      external_id: String(p.id),
      display_name: p.name ?? connection.display_name ?? "Facebook Page",
      avatar_url: p.picture?.data?.url,
    };
  },

  /** Meta revokes an app authorization through the authorizing *user* token.
   * Page tokens are derived from it and would only address the Page, so the
   * retained long-lived user token in `refresh_token` is the credential here. */
  async revoke(t) {
    const token = t.refresh_token ?? t.access_token;
    await j(await fetch(
      `https://graph.facebook.com/${META_VERSION}/me/permissions` +
      `?access_token=${encodeURIComponent(token)}`, { method: "DELETE" }),
      "facebook revoke");
    return { revoked: true };
  },

  async publish({ text, mediaUrl, accessToken, connection }) {
    const id = connection.external_id;
    const safeMediaUrl = mediaUrl ? publicMediaUrl(mediaUrl, "Facebook") : null;
    const video = safeMediaUrl && mediaKind(safeMediaUrl) === "video";
    const url = safeMediaUrl
      ? `https://graph.facebook.com/${META_VERSION}/${id}/${video ? "videos" : "photos"}`
      : `https://graph.facebook.com/${META_VERSION}/${id}/feed`;
    const body: Record<string, string> = safeMediaUrl
      ? video
        ? { file_url: safeMediaUrl, description: text, access_token: accessToken }
        : { url: safeMediaUrl, caption: text, access_token: accessToken }
      : { message: text, access_token: accessToken };
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
      });
    } catch {
      throw new PublishOutcomeUnknownError(
        "Facebook may have accepted this post. Verify the Page before retrying.");
    }
    let d: any;
    try {
      d = await j(response, "facebook publish");
    } catch (error) {
      rethrowFinalPublishFailure(error, response,
        "Facebook may have accepted this post. Verify the Page before retrying.");
    }
    const rid = d.post_id ?? d.id;
    if (!rid) throw new PublishOutcomeUnknownError(
      "Facebook may have accepted this post. Verify the Page before retrying.");
    return { remote_id: rid, remote_url: `https://facebook.com/${rid}` };
  },

  async metrics({ accessToken, connection }) {
    const d = await j(await fetch(
      `https://graph.facebook.com/${META_VERSION}/${connection.external_id}` +
      `?fields=followers_count,fan_count&access_token=${encodeURIComponent(accessToken)}`),
      "facebook metrics");
    return { followers: d.followers_count ?? d.fan_count ?? 0 };
  },
};

const instagram: PlatformAdapter = {
  id: "instagram",
  label: "Instagram",
  // Business Login for Instagram is deliberately separate from Facebook
  // Login for Business. Customers authorize their professional Instagram
  // profile directly and do not need to link it to a Facebook Page.
  authorizeUrl: "https://www.instagram.com/oauth/authorize",
  tokenUrl: "https://api.instagram.com/oauth/access_token",
  scopes: ["instagram_business_basic", "instagram_business_content_publish"],
  scopeSeparator: ",",
  usesPKCE: false,
  authorizeExtra: { enable_fb_login: "0", force_authentication: "1" },
  tokenAuth: "body",
  clientIdEnv: "INSTAGRAM_APP_ID",
  clientSecretEnv: "INSTAGRAM_APP_SECRET",
  requiresMedia: true,          // IG has no text-only post type

  async exchangeCode({ code, redirectUri, clientId, clientSecret }) {
    const shortForm = new FormData();
    for (const [key, value] of Object.entries({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    })) shortForm.set(key, value);
    const short = await j(await fetch(instagram.tokenUrl, {
      method: "POST", body: shortForm,
    }), "instagram authorization code");

    // Instagram first returns a short-lived token. Exchange it immediately;
    // only the renewable ~60-day token is persisted. This exchange endpoint
    // is a GET endpoint; POST is interpreted as a Graph object mutation for an
    // object named `access_token` and fails with IGApiException code 100.
    const long = await j(await fetch("https://graph.instagram.com/access_token?" +
      new URLSearchParams({
        grant_type: "ig_exchange_token",
        client_secret: clientSecret,
        access_token: short.access_token,
      })), "instagram long-lived token");
    return {
      access_token: long.access_token,
      // Instagram renews using the current access token rather than issuing a
      // separate refresh token. Keeping this populated tells the connection
      // status projection that the server can renew it without user action.
      refresh_token: long.access_token,
      expires_in: long.expires_in,
      scope: instagram.scopes.join(" "),
    };
  },

  async refreshAccess({ accessToken }) {
    const d = await j(await fetch("https://graph.instagram.com/refresh_access_token?" +
      new URLSearchParams({
        grant_type: "ig_refresh_token", access_token: accessToken,
      })), "instagram token refresh");
    return {
      access_token: d.access_token,
      refresh_token: d.access_token,
      expires_in: d.expires_in,
      scope: instagram.scopes.join(" "),
    };
  },

  async identify(t) {
    const ig = await j(await fetch(
      `https://graph.instagram.com/${META_VERSION}/me` +
      `?fields=id,user_id,username,name,profile_picture_url` +
      `&access_token=${encodeURIComponent(t.access_token)}`), "instagram identify");
    if (!ig.id && !ig.user_id) throw new Error(
      "No Instagram professional account found. Switch the profile to Business or Creator, then retry.");
    return {
      external_id: String(ig.user_id ?? ig.id),
      display_name: "@" + (ig.username ?? "instagram"),
      avatar_url: ig.profile_picture_url,
      meta: { account_name: ig.name ?? null, login_type: "instagram" },
    };
  },

  /** Business Login for Instagram exposes no revocation endpoint: people
   * remove FablePeak from Instagram's own "Apps and websites" settings, and
   * Meta's data-deletion callback covers deletion requests. Reporting that
   * honestly beats calling an endpoint that would silently do nothing. */
  revoke() {
    return Promise.resolve({ revoked: false, unsupported: true });
  },

  // IG publishing is two-step: create a media container, then publish it.
  async publish({ text, mediaUrl, accessToken, connection }) {
    if (!mediaUrl) throw new Error("Instagram requires an image or video URL — it has no text-only post.");
    const safeMediaUrl = publicMediaUrl(mediaUrl, "Instagram");
    const igId = connection.external_id;
    const video = mediaKind(safeMediaUrl) === "video";
    const createParams: Record<string, string> = video
      ? { media_type: "REELS", video_url: safeMediaUrl, caption: text, access_token: accessToken }
      : { image_url: safeMediaUrl, caption: text, access_token: accessToken };
    const container = await j(await fetch(
      `https://graph.instagram.com/${META_VERSION}/${igId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(createParams),
      }), "instagram container");
    // Both image and Reel containers are prepared asynchronously. Publishing
    // before Meta reports FINISHED intermittently fails with OAuth code 9007
    // ("Media ID is not available").
    await waitForInstagramContainer(container.id, accessToken);
    let publishResponse: Response;
    try {
      publishResponse = await fetch(
        `https://graph.instagram.com/${META_VERSION}/${igId}/media_publish`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ creation_id: container.id, access_token: accessToken }),
      });
    } catch {
      throw new PublishOutcomeUnknownError(
        "Instagram may have accepted this post. Verify the profile before retrying.");
    }
    let published: any;
    try {
      published = await j(publishResponse, "instagram publish");
    } catch (error) {
      rethrowFinalPublishFailure(error, publishResponse,
        "Instagram may have accepted this post. Verify the profile before retrying.");
    }
    if (!published.id) throw new PublishOutcomeUnknownError(
      "Instagram may have accepted this post. Verify the profile before retrying.");
    let permalink: string | undefined;
    try {
      const link = await fetch(
        `https://graph.instagram.com/${META_VERSION}/${published.id}` +
        `?fields=permalink&access_token=${encodeURIComponent(accessToken)}`);
      if (link.ok) permalink = (await link.json()).permalink;
    } catch { /* publishing succeeded; a missing convenience link must not retry it */ }
    return { remote_id: published.id, remote_url: permalink };
  },

  async metrics({ accessToken, connection }) {
    const d = await j(await fetch(
      `https://graph.instagram.com/${META_VERSION}/${connection.external_id}` +
      `?fields=followers_count,media_count&access_token=${encodeURIComponent(accessToken)}`),
      "instagram metrics");
    return { followers: d.followers_count ?? 0 };
  },
};

async function waitForInstagramContainer(containerId: string, accessToken: string) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const status = await j(await fetch(
      `https://graph.instagram.com/${META_VERSION}/${containerId}` +
      `?fields=status_code,status&access_token=${encodeURIComponent(accessToken)}`),
      "instagram media processing");
    if (status.status_code === "FINISHED") return;
    if (["ERROR", "EXPIRED"].includes(status.status_code)) {
      throw new Error(`Instagram could not process this media: ${status.status ?? status.status_code}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Instagram is still processing this media. Try publishing again shortly.");
}

/* ----------------------------------------------------------------- LinkedIn */
const LINKEDIN_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif"]);

const linkedin: PlatformAdapter = {
  id: "linkedin",
  label: "LinkedIn",
  authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
  tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
  scopes: ["openid", "profile", "w_member_social"],
  usesPKCE: false,
  tokenAuth: "body",
  clientIdEnv: "LINKEDIN_CLIENT_ID",
  clientSecretEnv: "LINKEDIN_CLIENT_SECRET",
  supportsMedia: true,
  productionEnabled: false,    // frozen until the external-beta milestone passes

  async identify(t) {
    const d = await j(await fetch("https://api.linkedin.com/v2/userinfo",
      { headers: { Authorization: `Bearer ${t.access_token}` } }), "linkedin identify");
    return { external_id: d.sub, display_name: d.name ?? "LinkedIn", avatar_url: d.picture };
  },

  async publish({ text, mediaUrl, accessToken, connection }) {
    const author = `urn:li:person:${connection.external_id}`;
    const version = Deno.env.get("LINKEDIN_VERSION") ?? "202601";
    const linkedInHeaders = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
      "LinkedIn-Version": version,
    };
    let imageUrn: string | null = null;
    if (mediaUrl) {
      const { bytes, contentType } = await loadProviderMedia(mediaUrl, "LinkedIn");
      if (!LINKEDIN_IMAGE_TYPES.has(contentType)) {
        throw new Error("LinkedIn currently supports image attachments only; remove the video and try again.");
      }
      const initialized = await j(await fetch(
        "https://api.linkedin.com/rest/images?action=initializeUpload", {
          method: "POST", headers: linkedInHeaders,
          body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
        }), "linkedin image initialize");
      const uploadUrl = String(initialized.value?.uploadUrl ?? "");
      imageUrn = String(initialized.value?.image ?? "");
      if (!uploadUrl || !imageUrn) throw new Error("LinkedIn image initialization was incomplete.");
      const uploadHost = new URL(publicMediaUrl(uploadUrl, "LinkedIn")).hostname.toLowerCase();
      if (!(uploadHost === "linkedin.com" || uploadHost.endsWith(".linkedin.com") ||
            uploadHost === "licdn.com" || uploadHost.endsWith(".licdn.com"))) {
        throw new Error("LinkedIn returned an invalid image upload host.");
      }
      const uploaded = await fetch(uploadUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": contentType },
        body: bytes,
      });
      if (!uploaded.ok) throw new ProviderRequestError(
        "linkedin image upload", uploaded.status, await uploaded.text());
    }
    // /rest/posts replaces the legacy /v2/ugcPosts. Both headers are mandatory;
    // LINKEDIN_VERSION sunsets on a ~1-year clock, so keep it configurable.
    let publishResponse: Response;
    try {
      publishResponse = await fetch("https://api.linkedin.com/rest/posts", {
        method: "POST", headers: linkedInHeaders,
        body: JSON.stringify({
        author,
        commentary: text,
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        ...(imageUrn ? { content: { media: { id: imageUrn } } } : {}),
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
      });
    } catch {
      throw new PublishOutcomeUnknownError(
        "LinkedIn may have accepted this post. Verify the profile before retrying.");
    }
    if (!publishResponse.ok) {
      const failure = new ProviderRequestError(
        "linkedin publish", publishResponse.status, await publishResponse.text());
      if (publishResponse.status >= 500) throw new PublishOutcomeUnknownError(
        "LinkedIn may have accepted this post. Verify the profile before retrying.");
      throw failure;
    }
    let id = publishResponse.headers.get("x-restli-id");
    if (!id) {
      try { id = (await publishResponse.json()).id; }
      catch { throw new PublishOutcomeUnknownError(
        "LinkedIn may have accepted this post. Verify the profile before retrying."); }
    }
    if (!id) throw new PublishOutcomeUnknownError(
      "LinkedIn may have accepted this post. Verify the profile before retrying.");
    return { remote_id: id, remote_url: `https://www.linkedin.com/feed/update/${id}` };
  },

  // No metrics(). Deliberate, and deliberately absent rather than a metrics()
  // that returns null.
  //
  // Nothing truthful is retrievable with the scopes above. `openid`/`profile`
  // buy /v2/userinfo, which carries identity only — no connection, follower or
  // impression figure. Network size needs `r_1st_connections_size`, and
  // follower or share statistics need the Community Management / Marketing
  // partner APIs; both are review-gated, and requesting them here is out of
  // scope for this adapter.
  //
  // Given nothing is retrievable, absent beats returning null. ingest-metrics
  // skips a platform with no metrics() *before* incrementing `attempted`, but
  // counts a null-returning adapter as attempted and then writes no row, so the
  // daily job result would report attempted > ingested + failed. Operators read
  // that gap as a silently dropped ingestion (the beta evidence record treats
  // attempted == ingested + failed as the healthy shape), which would be a
  // false alarm every single night. Omitting metrics() states the same fact —
  // LinkedIn analytics are not available — without corrupting the counter that
  // says whether real ingestion work succeeded.
};

/* -------------------------------------------------------------------- TikTok */
const tiktok: PlatformAdapter = {
  id: "tiktok",
  label: "TikTok",
  authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
  tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
  scopes: ["user.info.basic", "video.publish"],
  usesPKCE: true,
  tokenAuth: "body",
  clientIdEnv: "TIKTOK_CLIENT_KEY",
  clientSecretEnv: "TIKTOK_CLIENT_SECRET",
  requiresMedia: true,
  // TikTok requires creator-info-driven privacy/interaction controls, explicit
  // consent, duration validation, and final-status tracking. Keep OAuth and
  // publishing unreachable until that complete user flow exists.
  productionEnabled: false,

  async identify(t) {
    const d = await j(await fetch(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url",
      { headers: { Authorization: `Bearer ${t.access_token}` } }), "tiktok identify");
    const u = d.data?.user ?? {};
    return { external_id: u.open_id, display_name: u.display_name ?? "TikTok", avatar_url: u.avatar_url };
  },

  async publish({ text, mediaUrl, accessToken }) {
    if (!mediaUrl) throw new Error("TikTok requires a video URL.");
    const safeMediaUrl = publicMediaUrl(mediaUrl, "TikTok");
    let response: Response;
    try {
      response = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          post_info: { title: text.slice(0, 150), privacy_level: "SELF_ONLY" },
          source_info: { source: "PULL_FROM_URL", video_url: safeMediaUrl },
        }),
      });
    } catch {
      throw new PublishOutcomeUnknownError(
        "TikTok may have accepted this video. Verify the profile before retrying.");
    }
    let d: any;
    try {
      d = await j(response, "tiktok publish");
    } catch (error) {
      rethrowFinalPublishFailure(error, response,
        "TikTok may have accepted this video. Verify the profile before retrying.");
    }
    return { remote_id: d.data?.publish_id ?? "unknown" };
  },
};

/* ---------------------------------------------------------------- Pinterest */
async function pinterestToken(
  params: Record<string, string>,
  clientId: string,
  clientSecret: string,
): Promise<TokenSet> {
  const response = await fetch("https://api.pinterest.com/v5/oauth/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${clientId}:${clientSecret}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  return await j(response, "pinterest token exchange");
}

async function pinterestBoards(accessToken: string) {
  const boards: any[] = [];
  let bookmark: string | null = null;
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (bookmark) query.set("bookmark", bookmark);
    const page = await j(await fetch(`https://api.pinterest.com/v5/boards?${query}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }), "pinterest boards");
    boards.push(...(page.items ?? []));
    bookmark = page.bookmark || null;
  } while (bookmark);
  return boards;
}

const pinterest: PlatformAdapter = {
  id: "pinterest",
  label: "Pinterest",
  authorizeUrl: "https://www.pinterest.com/oauth/",
  tokenUrl: "https://api.pinterest.com/v5/oauth/token",
  scopes: ["boards:read", "boards:write", "pins:read", "pins:write"],
  scopeSeparator: ",",
  usesPKCE: false,
  tokenAuth: "basic",
  clientIdEnv: "PINTEREST_CLIENT_ID",
  clientSecretEnv: "PINTEREST_CLIENT_SECRET",
  supportsMedia: true,
  requiresMedia: true,
  requiresExplicitSelection: true,
  sharedAuthorizationAcrossAssets: true,
  // Keep discovery and publishing unavailable until production credentials
  // and a real-account acceptance test have both passed.
  productionEnabled: false,

  async exchangeCode({ code, redirectUri, clientId, clientSecret }) {
    return await pinterestToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      continuous_refresh: "true",
    }, clientId, clientSecret);
  },

  async refreshAccess({ refreshToken, clientId, clientSecret }) {
    if (!refreshToken) throw new Error("Pinterest did not issue a refresh token.");
    return await pinterestToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }, clientId, clientSecret);
  },

  async identify(tokens) {
    const boards = await pinterestBoards(tokens.access_token);
    if (!boards.length) throw new Error(
      "No Pinterest boards were found. Create a public board, then reconnect.");
    const board = boards[0];
    return {
      external_id: String(board.id),
      display_name: board.name ?? "Pinterest board",
      meta: { owner_username: board.owner?.username ?? null },
    };
  },

  async identifyAll(tokens) {
    const boards = await pinterestBoards(tokens.access_token);
    if (!boards.length) throw new Error(
      "No Pinterest boards were found. Create a public board, then reconnect.");
    return boards.map((board: any) => ({
      external_id: String(board.id),
      display_name: `${board.name ?? "Pinterest board"}${board.owner?.username ? ` · @${board.owner.username}` : ""}`,
      meta: { owner_username: board.owner?.username ?? null },
    }));
  },

  async verify(accessToken, connection) {
    const board = await j(await fetch(
      `https://api.pinterest.com/v5/boards/${encodeURIComponent(connection.external_id)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }), "pinterest board");
    return {
      external_id: String(board.id),
      display_name: `${board.name ?? "Pinterest board"}${board.owner?.username ? ` · @${board.owner.username}` : ""}`,
      meta: { owner_username: board.owner?.username ?? null },
    };
  },

  async publish({ text, mediaUrl, accessToken, connection }) {
    if (!mediaUrl) throw new Error("Pinterest requires an image URL for every Pin.");
    const safeMediaUrl = publicMediaUrl(mediaUrl, "Pinterest");
    const media = await fetchPublicMedia(safeMediaUrl, "Pinterest");
    if (!media.ok) throw new Error(`Pinterest could not fetch media (${media.status}).`);
    const contentType = media.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    await media.body?.cancel();
    if (contentType.startsWith("video/") || mediaKind(safeMediaUrl) === "video") {
      throw new Error("Pinterest video Pins are not supported yet; choose an image instead.");
    }
    if (!contentType.startsWith("image/")) {
      throw new Error("Pinterest needs a direct image file URL.");
    }

    let response: Response;
    try {
      response = await fetch("https://api.pinterest.com/v5/pins", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          board_id: connection.external_id,
          title: text.slice(0, 100) || "Untitled Pin",
          description: text.slice(0, 800),
          media_source: { source_type: "image_url", url: safeMediaUrl },
        }),
      });
    } catch {
      throw new PublishOutcomeUnknownError(
        "Pinterest may have accepted this Pin. Verify the board before retrying.");
    }
    let pin: any;
    try {
      pin = await j(response, "pinterest publish");
    } catch (error) {
      rethrowFinalPublishFailure(error, response,
        "Pinterest may have accepted this Pin. Verify the board before retrying.");
    }
    if (!pin.id) throw new PublishOutcomeUnknownError(
      "Pinterest may have accepted this Pin. Verify the board before retrying.");
    return { remote_id: String(pin.id), remote_url: `https://www.pinterest.com/pin/${pin.id}/` };
  },

  /** Board follower count — the only audience total reachable with the
   * `boards:read` scope this adapter already requests. A FablePeak Pinterest
   * connection *is* one board (`external_id` is the board id), so the board's
   * own cumulative follower total is the honest audience figure for it.
   *
   * The account-level `/v5/user_account` object (`follower_count`,
   * `monthly_views`) is the obvious alternative, but it requires
   * `user_accounts:read`, which this adapter does not request and which must
   * not be added here. Pinterest has no impression figure inside `boards:read`,
   * so impressions stay unreported instead of guessed. */
  async metrics({ accessToken, connection }) {
    const board = await j(await fetch(
      `https://api.pinterest.com/v5/boards/${encodeURIComponent(connection.external_id)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }), "pinterest metrics");
    if (board?.follower_count == null) return null;
    return { followers: Number(board.follower_count) };
  },
};

export const ADAPTERS: Record<string, PlatformAdapter> = {
  youtube, x, instagram, facebook, linkedin, tiktok, pinterest,
};

export function platformConnectionEnabled(adapter: PlatformAdapter) {
  return adapter.productionEnabled !== false;
}

/** Which platforms have credentials configured in this deployment. */
export function configuredPlatforms(env: (k: string) => string | undefined) {
  if (!env("SOCIAL_TOKEN_ENCRYPTION_KEY")) return [];
  return Object.values(ADAPTERS)
    .filter((a) => platformConnectionEnabled(a) &&
      env(a.clientIdEnv) && env(a.clientSecretEnv) &&
      (!a.authorizeConfigEnv || env(a.authorizeConfigEnv)))
    .map((a) => a.id);
}

/** Exchange an authorization code (or refresh token) for tokens. */
export async function exchangeToken(
  a: PlatformAdapter,
  params: Record<string, string>,
  clientId: string,
  clientSecret: string,
): Promise<TokenSet> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const body: Record<string, string> = { ...params, client_id: clientId };
  if (a.tokenAuth === "basic") {
    headers.Authorization = "Basic " + btoa(`${clientId}:${clientSecret}`);
  } else {
    body.client_secret = clientSecret;
  }
  const r = await fetch(a.tokenUrl, { method: "POST", headers, body: new URLSearchParams(body) });
  const txt = await r.text();
  if (!r.ok) throw new ProviderRequestError(`token exchange (${a.id})`, r.status, txt);
  return JSON.parse(txt);
}

/** Exchange a provider callback code while hiding provider-specific token
 * choreography from the callback function. */
export async function exchangeAuthorizationCode(
  a: PlatformAdapter,
  input: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
    clientId: string;
    clientSecret: string;
  },
): Promise<TokenSet> {
  if (a.exchangeCode) return a.exchangeCode(input);
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
  };
  if (input.codeVerifier) params.code_verifier = input.codeVerifier;
  if (a.id === "tiktok") params.client_key = input.clientId;
  return exchangeToken(a, params, input.clientId, input.clientSecret);
}

/** Renew a connection through the provider's native mechanism. */
export async function refreshPlatformToken(
  a: PlatformAdapter,
  input: {
    accessToken: string;
    refreshToken?: string;
    clientId: string;
    clientSecret: string;
    connection?: { external_id: string; meta?: Record<string, unknown> };
  },
): Promise<TokenSet> {
  if (a.refreshAccess) return a.refreshAccess(input);
  if (!input.refreshToken) throw new Error("Provider did not issue a refresh token.");
  return exchangeToken(a, {
    grant_type: "refresh_token", refresh_token: input.refreshToken,
  }, input.clientId, input.clientSecret);
}
