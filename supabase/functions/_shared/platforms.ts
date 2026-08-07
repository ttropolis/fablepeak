// FablePeak — per-platform OAuth + publishing adapters.
// Runs only inside Supabase Edge Functions (Deno). Client secrets come from
// function secrets and are never exposed to the browser.
//
// Every platform implements the same shape so adding one is a single object.

export type Platform =
  | "youtube" | "x" | "instagram" | "facebook" | "linkedin" | "tiktok";

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
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
  /** verify one stored asset still belongs to the supplied token */
  verify?(accessToken: string, connection: {
    external_id: string;
    display_name?: string;
    meta?: Record<string, unknown>;
  }): Promise<Identity>;
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
  if (!r.ok) throw new Error(`${ctx}: ${r.status} ${body.slice(0, 400)}`);
  try { return JSON.parse(body); } catch { return {}; }
};

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
    const start = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      { method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json",
                   "X-Upload-Content-Type": contentType,
                   ...(video.headers.get("content-length")
                     ? { "X-Upload-Content-Length": video.headers.get("content-length")! } : {}) },
        body: JSON.stringify(meta) });
    if (!start.ok) throw new Error(`youtube upload start: ${start.status} ${await start.text()}`);
    const session = start.headers.get("location");
    if (!session) throw new Error("YouTube did not return an upload session URL");
    const uploadHeaders: Record<string, string> = { "Content-Type": contentType };
    const contentLength = video.headers.get("content-length");
    if (contentLength) uploadHeaders["Content-Length"] = contentLength;
    const up = await j(await fetch(session, {
      method: "PUT", headers: uploadHeaders, body: video.body,
    }), "youtube upload");
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
  supportsMedia: false,

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

  async publish({ text, accessToken }) {
    const d = await j(await fetch("https://api.x.com/2/tweets", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 280) }),
    }), "x publish");
    return { remote_id: d.data.id, remote_url: `https://x.com/i/status/${d.data.id}` };
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
    `?fields=id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}` +
    `&access_token=${encodeURIComponent(accessToken)}`), "meta pages");
  return d.data ?? [];
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
      throw new Error("This Facebook Page is no longer available to the authorizing user.");
    }
    return {
      access_token: page.access_token,
      refresh_token: long.access_token,
      expires_in: long.expires_in,
      scope: facebook.scopes.join(" "),
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
    return pages.map((p: any) => ({
      external_id: p.id,
      display_name: p.name,
      avatar_url: p.picture?.data?.url,
      access_token: p.access_token,
      meta: {},
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
    const d = await j(await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    }), "facebook publish");
    const rid = d.post_id ?? d.id;
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
    if (video) await waitForInstagramContainer(container.id, accessToken);
    const published = await j(await fetch(
      `https://graph.instagram.com/${META_VERSION}/${igId}/media_publish`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ creation_id: container.id, access_token: accessToken }),
      }), "instagram publish");
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
      throw new Error(`Instagram could not process this video: ${status.status ?? status.status_code}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Instagram is still processing this video. Try publishing again shortly.");
}

/* ----------------------------------------------------------------- LinkedIn */
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
  supportsMedia: false,

  async identify(t) {
    const d = await j(await fetch("https://api.linkedin.com/v2/userinfo",
      { headers: { Authorization: `Bearer ${t.access_token}` } }), "linkedin identify");
    return { external_id: d.sub, display_name: d.name ?? "LinkedIn", avatar_url: d.picture };
  },

  async publish({ text, accessToken, connection }) {
    const author = `urn:li:person:${connection.external_id}`;
    // /rest/posts replaces the legacy /v2/ugcPosts. Both headers are mandatory;
    // LINKEDIN_VERSION sunsets on a ~1-year clock, so keep it configurable.
    const d = await fetch("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
        "LinkedIn-Version": Deno.env.get("LINKEDIN_VERSION") ?? "202601",
      },
      body: JSON.stringify({
        author,
        commentary: text,
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
    });
    if (!d.ok) throw new Error(`linkedin publish: ${d.status} ${(await d.text()).slice(0, 300)}`);
    const id = d.headers.get("x-restli-id") ?? (await d.json()).id;
    return { remote_id: id, remote_url: `https://www.linkedin.com/feed/update/${id}` };
  },
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
    const d = await j(await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        post_info: { title: text.slice(0, 150), privacy_level: "SELF_ONLY" },
        source_info: { source: "PULL_FROM_URL", video_url: safeMediaUrl },
      }),
    }), "tiktok publish");
    return { remote_id: d.data?.publish_id ?? "unknown" };
  },
};

export const ADAPTERS: Record<string, PlatformAdapter> = {
  youtube, x, instagram, facebook, linkedin, tiktok,
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
  if (!r.ok) throw new Error(`token exchange (${a.id}): ${r.status} ${txt.slice(0, 400)}`);
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
