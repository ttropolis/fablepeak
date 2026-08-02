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
  usesPKCE: boolean;
  /** extra params appended to the authorize URL */
  authorizeExtra?: Record<string, string>;
  /** token exchange needs client_secret in body (vs. basic auth) */
  tokenAuth: "body" | "basic";
  clientIdEnv: string;
  clientSecretEnv: string;
  /** fetch who we just connected as */
  identify(tokens: TokenSet): Promise<Identity>;
  /** publish a post; throws with a readable message on failure */
  publish(input: PublishInput): Promise<PublishResult>;
  /** best-effort daily metrics; return null when unsupported */
  metrics?(input: { accessToken: string; connection: any }): Promise<{
    followers?: number; impressions?: number; engagements?: number;
  } | null>;
  /** platforms that cannot post text without an image */
  requiresMedia?: boolean;
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

/* ------------------------------------------------------------------ YouTube */
const youtube: PlatformAdapter = {
  id: "youtube",
  label: "YouTube",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  // upload = publishing; readonly + yt-analytics = metrics
  scopes: [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
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
  scopes: ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "business_management"],
  usesPKCE: false,
  tokenAuth: "body",
  clientIdEnv: "META_APP_ID",
  clientSecretEnv: "META_APP_SECRET",

  async identify(t) {
    const pages = await metaPages(t.access_token);
    const p = pages[0];
    if (!p) throw new Error(
      "No Facebook Page found. The account must administer a Page, and the Page must be " +
      "selected during the permission step.");
    return {
      external_id: p.id,
      display_name: p.name,
      avatar_url: p.picture?.data?.url,
      meta: { page_access_token: p.access_token },
    };
  },

  async publish({ text, mediaUrl, connection }) {
    const pageToken = connection.meta?.page_access_token;
    if (!pageToken) throw new Error("Missing Page access token — reconnect the Page.");
    const id = connection.external_id;
    const safeMediaUrl = mediaUrl ? publicMediaUrl(mediaUrl, "Facebook") : null;
    const url = safeMediaUrl
      ? `https://graph.facebook.com/${META_VERSION}/${id}/photos`
      : `https://graph.facebook.com/${META_VERSION}/${id}/feed`;
    const body: Record<string, string> = safeMediaUrl
      ? { url: safeMediaUrl, caption: text, access_token: pageToken }
      : { message: text, access_token: pageToken };
    const d = await j(await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    }), "facebook publish");
    const rid = d.post_id ?? d.id;
    return { remote_id: rid, remote_url: `https://facebook.com/${rid}` };
  },

  async metrics({ connection }) {
    const pageToken = connection.meta?.page_access_token;
    if (!pageToken) return null;
    const d = await j(await fetch(
      `https://graph.facebook.com/${META_VERSION}/${connection.external_id}` +
      `?fields=followers_count,fan_count&access_token=${encodeURIComponent(pageToken)}`),
      "facebook metrics");
    return { followers: d.followers_count ?? d.fan_count ?? 0 };
  },
};

const instagram: PlatformAdapter = {
  id: "instagram",
  label: "Instagram",
  authorizeUrl: metaAuthorize,
  tokenUrl: metaToken,
  scopes: [
    "instagram_basic", "instagram_content_publish", "instagram_manage_insights",
    "pages_show_list", "pages_read_engagement", "business_management",
  ],
  usesPKCE: false,
  tokenAuth: "body",
  clientIdEnv: "META_APP_ID",
  clientSecretEnv: "META_APP_SECRET",
  requiresMedia: true,          // IG has no text-only post type

  async identify(t) {
    const pages = await metaPages(t.access_token);
    const withIg = pages.find((p: any) => p.instagram_business_account);
    if (!withIg) throw new Error(
      "No Instagram Business/Creator account found. Convert the Instagram account to " +
      "Business or Creator and link it to a Facebook Page, then reconnect.");
    const ig = withIg.instagram_business_account;
    return {
      external_id: ig.id,
      display_name: "@" + (ig.username ?? "instagram"),
      avatar_url: ig.profile_picture_url,
      meta: { page_id: withIg.id, page_access_token: withIg.access_token },
    };
  },

  // IG publishing is two-step: create a media container, then publish it.
  async publish({ text, mediaUrl, connection }) {
    if (!mediaUrl) throw new Error("Instagram requires an image or video URL — it has no text-only post.");
    const safeMediaUrl = publicMediaUrl(mediaUrl, "Instagram");
    const token = connection.meta?.page_access_token;
    if (!token) throw new Error("Missing Instagram access token — reconnect the account.");
    const igId = connection.external_id;
    const container = await j(await fetch(
      `https://graph.facebook.com/${META_VERSION}/${igId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ image_url: safeMediaUrl, caption: text, access_token: token }),
      }), "instagram container");
    const published = await j(await fetch(
      `https://graph.facebook.com/${META_VERSION}/${igId}/media_publish`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ creation_id: container.id, access_token: token }),
      }), "instagram publish");
    return { remote_id: published.id, remote_url: `https://www.instagram.com/p/${published.id}` };
  },

  async metrics({ connection }) {
    const token = connection.meta?.page_access_token;
    if (!token) return null;
    const d = await j(await fetch(
      `https://graph.facebook.com/${META_VERSION}/${connection.external_id}` +
      `?fields=followers_count,media_count&access_token=${encodeURIComponent(token)}`),
      "instagram metrics");
    return { followers: d.followers_count ?? 0 };
  },
};

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

/** Which platforms have credentials configured in this deployment. */
export function configuredPlatforms(env: (k: string) => string | undefined) {
  return Object.values(ADAPTERS)
    .filter((a) => env(a.clientIdEnv) && env(a.clientSecretEnv))
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
