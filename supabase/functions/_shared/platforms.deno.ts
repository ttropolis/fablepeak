import {
  ADAPTERS,
  effectiveText,
  configuredPlatforms,
  exchangeAuthorizationCode,
  platformConnectionEnabled,
  ProviderRequestError,
  PublishOutcomeUnknownError,
  refreshPlatformToken,
  TIKTOK_OPTIONS_REQUIRED,
  TIKTOK_STATUS_POLL,
  X_TEXT_LIMIT,
} from "./platforms.ts";
import { INTERRUPTED, publishPost } from "../publish/index.ts";

const originalFetch = globalThis.fetch;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("Instagram waits for an image container before publishing", async () => {
  const requests: string[] = [];
  globalThis.fetch = (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (url.endsWith("/media")) return Promise.resolve(json({ id: "container-1" }));
    if (url.includes("/container-1?")) return Promise.resolve(json({ status_code: "FINISHED" }));
    if (url.endsWith("/media_publish")) return Promise.resolve(json({ id: "post-1" }));
    if (url.includes("/post-1?")) return Promise.resolve(json({ permalink: "https://instagram.com/p/post-1/" }));
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    const result = await ADAPTERS.instagram.publish({
      text: "Episode 53",
      mediaUrl: "https://cdn.example/episode-53.png",
      accessToken: "token",
      connection: { external_id: "account-1", meta: {} },
    });
    if (result.remote_id !== "post-1") throw new Error("Expected the published media ID");
    const statusIndex = requests.findIndex((request) => request.includes("/container-1"));
    const publishIndex = requests.findIndex((request) => request.endsWith("/media_publish"));
    if (statusIndex < 0 || publishIndex <= statusIndex) {
      throw new Error(`Expected readiness check before publish: ${requests.join(", ")}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Instagram processing errors prevent media_publish", async () => {
  let publishCalled = false;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.endsWith("/media")) return Promise.resolve(json({ id: "container-2" }));
    if (url.includes("/container-2?")) {
      return Promise.resolve(json({ status_code: "ERROR", status: "Invalid image" }));
    }
    if (url.endsWith("/media_publish")) publishCalled = true;
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    await ADAPTERS.instagram.publish({
      text: "Episode 53",
      mediaUrl: "https://cdn.example/episode-53.png",
      accessToken: "token",
      connection: { external_id: "account-1", meta: {} },
    }).then(
      () => { throw new Error("Expected Instagram processing to fail"); },
      (error) => {
        if (!String(error.message).includes("Invalid image")) throw error;
      },
    );
    if (publishCalled) throw new Error("media_publish must not run after a processing error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Instagram marks a lost publish response as an unknown outcome", async () => {
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.endsWith("/media")) return Promise.resolve(json({ id: "container-3" }));
    if (url.includes("/container-3?")) return Promise.resolve(json({ status_code: "FINISHED" }));
    if (url.endsWith("/media_publish")) return Promise.reject(new TypeError("connection reset"));
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    await ADAPTERS.instagram.publish({
      text: "Episode 53",
      mediaUrl: "https://cdn.example/episode-53.png",
      accessToken: "token",
      connection: { external_id: "account-1", meta: {} },
    }).then(
      () => { throw new Error("Expected an unknown publish outcome"); },
      (error) => {
        if (!(error instanceof PublishOutcomeUnknownError)) throw error;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Instagram marks a successful final response without a media ID as unknown", async () => {
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.endsWith("/media")) return Promise.resolve(json({ id: "container-missing-id" }));
    if (url.includes("/container-missing-id?")) {
      return Promise.resolve(json({ status_code: "FINISHED" }));
    }
    if (url.endsWith("/media_publish")) return Promise.resolve(json({}));
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    let caught: unknown;
    try {
      await ADAPTERS.instagram.publish({
        text: "Episode 53", mediaUrl: "https://cdn.example/episode-53.png",
        accessToken: "token", connection: { external_id: "account-1", meta: {} },
      });
    } catch (error) { caught = error; }
    if (!(caught instanceof PublishOutcomeUnknownError)) {
      throw new Error(`Expected unknown Instagram outcome, received ${String(caught)}`);
    }
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("Facebook marks transport loss on the final publish request as unknown", async () => {
  globalThis.fetch = () => Promise.reject(new TypeError("connection reset"));
  try {
    let caught: unknown;
    try {
      await ADAPTERS.facebook.publish({
        text: "Launch", accessToken: "token", mediaUrl: null,
        connection: { external_id: "page-1", meta: {} },
      });
    } catch (error) { caught = error; }
    if (!(caught instanceof PublishOutcomeUnknownError)) {
      throw new Error(`Expected unknown Facebook outcome, received ${String(caught)}`);
    }
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("Facebook treats a final 5xx response as unknown rather than duplicate-safe", async () => {
  globalThis.fetch = () => Promise.resolve(json({ error: "upstream failed" }, 503));
  try {
    let caught: unknown;
    try {
      await ADAPTERS.facebook.publish({
        text: "Launch", accessToken: "token", mediaUrl: null,
        connection: { external_id: "page-1", meta: {} },
      });
    } catch (error) { caught = error; }
    if (!(caught instanceof PublishOutcomeUnknownError)) {
      throw new Error(`Expected unknown Facebook 5xx outcome, received ${String(caught)}`);
    }
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("YouTube marks transport loss during the final upload as unknown", async () => {
  let request = 0;
  globalThis.fetch = (_input, init) => {
    request++;
    if (request === 1) return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "video/mp4", "content-length": "3" },
    }));
    if (request === 2) return Promise.resolve(new Response(null, {
      status: 200, headers: { location: "https://upload.youtube.test/session-1" },
    }));
    if (request === 3 && init?.method === "PUT") {
      return Promise.reject(new TypeError("connection reset"));
    }
    return Promise.reject(new Error(`Unexpected YouTube request ${request}`));
  };
  try {
    let caught: unknown;
    try {
      await ADAPTERS.youtube.publish({
        text: "Launch", accessToken: "token", mediaUrl: "https://cdn.test/video.mp4",
        connection: { external_id: "channel-1", meta: {} },
      });
    } catch (error) { caught = error; }
    if (!(caught instanceof PublishOutcomeUnknownError)) {
      throw new Error(`Expected unknown YouTube outcome, received ${String(caught)}`);
    }
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("YouTube treats a final upload 5xx as unknown rather than starting over", async () => {
  let request = 0;
  globalThis.fetch = () => {
    request++;
    if (request === 1) return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "video/mp4", "content-length": "3" },
    }));
    if (request === 2) return Promise.resolve(new Response(null, {
      status: 200, headers: { location: "https://upload.youtube.test/session-1" },
    }));
    if (request === 3) return Promise.resolve(json({ error: "backend error" }, 503));
    return Promise.reject(new Error(`Unexpected YouTube request ${request}`));
  };
  try {
    let caught: unknown;
    try {
      await ADAPTERS.youtube.publish({
        text: "Launch", accessToken: "token", mediaUrl: "https://cdn.test/video.mp4",
        connection: { external_id: "channel-1", meta: {} },
      });
    } catch (error) { caught = error; }
    if (!(caught instanceof PublishOutcomeUnknownError)) {
      throw new Error(`Expected unknown YouTube 5xx outcome, received ${String(caught)}`);
    }
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("X uploads an image and attaches its media ID", async () => {
  const requests: string[] = [];
  let postBody: any;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://cdn.example/launch.png") {
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "image/png", "Content-Length": "3" },
      }));
    }
    if (url === "https://api.x.com/2/media/upload") {
      return Promise.resolve(json({ data: { id: "media-1" } }));
    }
    if (url === "https://api.x.com/2/tweets") {
      postBody = JSON.parse(String(init?.body));
      return Promise.resolve(json({ data: { id: "tweet-1" } }, 201));
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    await ADAPTERS.x.publish({
      text: "Launch",
      mediaUrl: "https://cdn.example/launch.png",
      accessToken: "token",
      connection: { external_id: "user-1", meta: {} },
    });
    if (!requests.includes("https://api.x.com/2/media/upload")) {
      throw new Error("Expected X media upload");
    }
    if (postBody?.media?.media_ids?.[0] !== "media-1") {
      throw new Error(`Expected attached media ID, received ${JSON.stringify(postBody)}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("X preserves text-only publishing", async () => {
  let body: any;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (url !== "https://api.x.com/2/tweets") {
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }
    body = JSON.parse(String(init?.body));
    return Promise.resolve(json({ data: { id: "tweet-text-1" } }, 201));
  };
  try {
    await ADAPTERS.x.publish({
      text: "Text only", accessToken: "token",
      connection: { external_id: "user-1", meta: {} },
    });
    if (body.text !== "Text only" || body.media) {
      throw new Error(`Unexpected X text body: ${JSON.stringify(body)}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("X finalizes a chunked video before attaching it", async () => {
  const requests: string[] = [];
  let postBody: any;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://cdn.example/launch.mp4") {
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "video/mp4", "Content-Length": "3" },
      }));
    }
    if (url.endsWith("/media/upload/initialize")) {
      return Promise.resolve(json({ data: { id: "video-1" } }));
    }
    if (url.endsWith("/media/upload/video-1/append")) {
      return Promise.resolve(json({ data: { expires_at: 1 } }));
    }
    if (url.endsWith("/media/upload/video-1/finalize")) {
      return Promise.resolve(json({ data: {
        processing_info: { state: "pending", check_after_secs: 0 },
      } }));
    }
    if (url.endsWith("/media/upload?command=STATUS&media_id=video-1")) {
      return Promise.resolve(json({ data: { processing_info: { state: "succeeded" } } }));
    }
    if (url === "https://api.x.com/2/tweets") {
      postBody = JSON.parse(String(init?.body));
      return Promise.resolve(json({ data: { id: "tweet-video-1" } }, 201));
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    await ADAPTERS.x.publish({
      text: "Launch",
      mediaUrl: "https://cdn.example/launch.mp4",
      accessToken: "token",
      connection: { external_id: "user-1", meta: {} },
    });
    const finalized = requests.findIndex((url) => url.endsWith("/video-1/finalize"));
    const processed = requests.findIndex((url) =>
      url.endsWith("/media/upload?command=STATUS&media_id=video-1"));
    const posted = requests.findIndex((url) => url.endsWith("/2/tweets"));
    if (finalized < 0 || processed <= finalized || posted <= processed) {
      throw new Error(`Expected finalize and status before post: ${requests.join(", ")}`);
    }
    if (postBody?.media?.media_ids?.[0] !== "video-1") {
      throw new Error(`Expected attached video ID, received ${JSON.stringify(postBody)}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("X upload failures do not create a post", async () => {
  let postCalled = false;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url === "https://cdn.example/broken.png") {
      return Promise.resolve(new Response(new Uint8Array([1]), {
        headers: { "Content-Type": "image/png" },
      }));
    }
    if (url === "https://api.x.com/2/media/upload") {
      return Promise.resolve(json({ error: "unavailable" }, 500));
    }
    if (url === "https://api.x.com/2/tweets") postCalled = true;
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    await ADAPTERS.x.publish({
      text: "Launch", mediaUrl: "https://cdn.example/broken.png",
      accessToken: "token", connection: { external_id: "user-1", meta: {} },
    }).then(
      () => { throw new Error("Expected X upload failure"); },
      (error) => { if (!String(error.message).includes("x media upload: 500")) throw error; },
    );
    if (postCalled) throw new Error("X post must not be created after upload failure");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("LinkedIn uploads an image URN before creating the post", async () => {
  const requests: string[] = [];
  let postBody: any;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "https://cdn.example/launch.png") {
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "image/png", "Content-Length": "3" },
      }));
    }
    if (url === "https://api.linkedin.com/rest/images?action=initializeUpload") {
      return Promise.resolve(json({ value: {
        uploadUrl: "https://www.linkedin.com/dms-uploads/image-1",
        image: "urn:li:image:image-1",
      } }));
    }
    if (url === "https://www.linkedin.com/dms-uploads/image-1") {
      return Promise.resolve(new Response(null, { status: 201 }));
    }
    if (url === "https://api.linkedin.com/rest/posts") {
      postBody = JSON.parse(String(init?.body));
      return Promise.resolve(new Response(null, {
        status: 201,
        headers: { "x-restli-id": "urn:li:share:post-1" },
      }));
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    await ADAPTERS.linkedin.publish({
      text: "Launch",
      mediaUrl: "https://cdn.example/launch.png",
      accessToken: "token",
      connection: { external_id: "person-1", meta: {} },
    });
    if (postBody?.content?.media?.id !== "urn:li:image:image-1") {
      throw new Error(`Expected LinkedIn image URN, received ${JSON.stringify(postBody)}`);
    }
    const uploadIndex = requests.findIndex((request) => request.includes("dms-uploads/image-1"));
    const postIndex = requests.findIndex((request) => request.includes("/rest/posts"));
    if (uploadIndex < 0 || postIndex <= uploadIndex) {
      throw new Error(`Expected image upload before post: ${requests.join(", ")}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("LinkedIn preserves text-only publishing", async () => {
  let body: any;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (url !== "https://api.linkedin.com/rest/posts") {
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }
    body = JSON.parse(String(init?.body));
    return Promise.resolve(new Response(null, {
      status: 201, headers: { "x-restli-id": "urn:li:share:text-1" },
    }));
  };
  try {
    await ADAPTERS.linkedin.publish({
      text: "Text only", accessToken: "token",
      connection: { external_id: "person-1", meta: {} },
    });
    if (body.commentary !== "Text only" || body.content) {
      throw new Error(`Unexpected LinkedIn text body: ${JSON.stringify(body)}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("LinkedIn rejects video before creating a post", async () => {
  let linkedinCalled = false;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url === "https://cdn.example/launch.mp4") {
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "video/mp4", "Content-Length": "3" },
      }));
    }
    if (url.includes("linkedin.com")) linkedinCalled = true;
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    await ADAPTERS.linkedin.publish({
      text: "Launch",
      mediaUrl: "https://cdn.example/launch.mp4",
      accessToken: "token",
      connection: { external_id: "person-1", meta: {} },
    }).then(
      () => { throw new Error("Expected LinkedIn video rejection"); },
      (error) => {
        if (!String(error.message).includes("image")) throw error;
      },
    );
    if (linkedinCalled) throw new Error("LinkedIn API must not be called for video");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("LinkedIn upload failures do not create a post", async () => {
  let postCalled = false;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url === "https://cdn.example/broken.png") {
      return Promise.resolve(new Response(new Uint8Array([1]), {
        headers: { "Content-Type": "image/png" },
      }));
    }
    if (url.endsWith("/rest/images?action=initializeUpload")) {
      return Promise.resolve(json({ value: {
        uploadUrl: "https://www.linkedin.com/dms-uploads/broken",
        image: "urn:li:image:broken",
      } }));
    }
    if (url === "https://www.linkedin.com/dms-uploads/broken") {
      return Promise.resolve(new Response("unavailable", { status: 500 }));
    }
    if (url.endsWith("/rest/posts")) postCalled = true;
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    await ADAPTERS.linkedin.publish({
      text: "Launch", mediaUrl: "https://cdn.example/broken.png",
      accessToken: "token", connection: { external_id: "person-1", meta: {} },
    }).then(
      () => { throw new Error("Expected LinkedIn upload failure"); },
      (error) => { if (!String(error.message).includes("linkedin image upload: 500")) throw error; },
    );
    if (postCalled) throw new Error("LinkedIn post must not be created after upload failure");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("LinkedIn stays production-frozen and gains no renewal it was never granted", () => {
  const linkedin = ADAPTERS.linkedin;
  if (linkedin.productionEnabled !== false) {
    throw new Error("LinkedIn must stay production-frozen");
  }
  if (linkedin.refreshAccess) {
    throw new Error("LinkedIn refresh tokens require LinkedIn partner approval");
  }
  if (linkedin.scopes.join(" ") !== "openid profile w_member_social") {
    throw new Error(`Unexpected LinkedIn scopes: ${linkedin.scopes.join(" ")}`);
  }
});

Deno.test("Facebook labels every discovered Page with the authorizing app-scoped user id", async () => {
  const requests: string[] = [];
  globalThis.fetch = (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/me/accounts")) {
      return Promise.resolve(json({
        data: [
          { id: "page-1", name: "Coffee", access_token: "page-token-1" },
          { id: "page-2", name: "Roastery", access_token: "page-token-2" },
        ],
      }));
    }
    if (url.includes("/me?fields=id")) return Promise.resolve(json({ id: "asid-9" }));
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    const identities = await ADAPTERS.facebook.identifyAll!({ access_token: "user-token" });
    const stored = identities.map((identity) => (identity.meta as any)?.asid);
    if (stored.join(",") !== "asid-9,asid-9") {
      throw new Error(`Every Page must carry the ASID, received ${JSON.stringify(stored)}`);
    }
    // A Page token resolves /me to the Page, so the lookup must use the user token.
    const lookup = requests.find((url) => url.includes("/me?fields=id")) ?? "";
    if (!lookup.includes("access_token=user-token")) {
      throw new Error(`ASID lookup must use the user token, received ${lookup}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Facebook renewal backfills the app-scoped user id onto an existing connection", async () => {
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes("/oauth/access_token")) {
      return Promise.resolve(json({ access_token: "fresh-user-token", expires_in: 5_184_000 }));
    }
    if (url.includes("/me/accounts")) {
      return Promise.resolve(json({
        data: [{ id: "page-1", name: "Coffee", access_token: "fresh-page-token" }],
      }));
    }
    if (url.includes("/me?fields=id")) return Promise.resolve(json({ id: "asid-9" }));
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    const tokens = await refreshPlatformToken(ADAPTERS.facebook, {
      accessToken: "stale-page-token",
      refreshToken: "stored-user-token",
      clientId: "client",
      clientSecret: "secret",
      connection: { external_id: "page-1", meta: {} },
    });
    if (tokens.access_token !== "fresh-page-token") {
      throw new Error(`Expected the renewed Page token, received ${tokens.access_token}`);
    }
    if ((tokens.meta as any)?.asid !== "asid-9") {
      throw new Error(`Renewal must carry the ASID, received ${JSON.stringify(tokens.meta)}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("a failed app-scoped id lookup never blocks connecting a Page", async () => {
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes("/me/accounts")) {
      return Promise.resolve(json({
        data: [{ id: "page-1", name: "Coffee", access_token: "page-token-1" }],
      }));
    }
    if (url.includes("/me?fields=id")) return Promise.resolve(json({ error: {} }, 500));
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    const identities = await ADAPTERS.facebook.identifyAll!({ access_token: "user-token" });
    if (identities.length !== 1 || identities[0].external_id !== "page-1") {
      throw new Error(`Expected the Page to connect, received ${JSON.stringify(identities)}`);
    }
    if (Object.keys(identities[0].meta ?? {}).length !== 0) {
      throw new Error(`Expected no ASID, received ${JSON.stringify(identities[0].meta)}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Pinterest discovers every board and leaves destination selection to the user", async () => {
  const requests: string[] = [];
  globalThis.fetch = (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("page_size=100") && !url.includes("bookmark=")) {
      return Promise.resolve(json({
        items: [{ id: "board-1", name: "Recipes", owner: { username: "shiloh" } }],
        bookmark: "next-page",
      }));
    }
    if (url.includes("bookmark=next-page")) {
      return Promise.resolve(json({
        items: [{ id: "board-2", name: "Podcast", owner: { username: "shiloh" } }],
        bookmark: null,
      }));
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    const boards = await ADAPTERS.pinterest.identifyAll!({ access_token: "token" });
    if (boards.map((board) => board.external_id).join(",") !== "board-1,board-2") {
      throw new Error(`Expected both Pinterest boards, received ${JSON.stringify(boards)}`);
    }
    if (!ADAPTERS.pinterest.requiresExplicitSelection) {
      throw new Error("Pinterest must require explicit board selection");
    }
    if (requests.length !== 2) throw new Error(`Expected pagination, received ${requests.length} requests`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Pinterest OAuth exchanges and refreshes tokens with Basic authentication", async () => {
  const requests: Array<{ authorization: string | null; body: URLSearchParams }> = [];
  globalThis.fetch = (_input, init) => {
    requests.push({
      authorization: new Headers(init?.headers).get("Authorization"),
      body: new URLSearchParams(String(init?.body)),
    });
    return Promise.resolve(json({
      access_token: `access-${requests.length}`,
      refresh_token: `refresh-${requests.length}`,
      expires_in: 2_592_000,
    }));
  };

  try {
    await exchangeAuthorizationCode(ADAPTERS.pinterest, {
      code: "code", redirectUri: "https://example.com/callback",
      clientId: "client", clientSecret: "secret",
    });
    await refreshPlatformToken(ADAPTERS.pinterest, {
      accessToken: "old-access", refreshToken: "old-refresh",
      clientId: "client", clientSecret: "secret",
    });
    if (!requests.every((request) => request.authorization === `Basic ${btoa("client:secret")}`)) {
      throw new Error("Expected Pinterest token requests to use HTTP Basic authentication");
    }
    if (requests[0].body.get("grant_type") !== "authorization_code" ||
        requests[1].body.get("grant_type") !== "refresh_token" ||
        requests[1].body.get("refresh_token") !== "old-refresh") {
      throw new Error(`Unexpected Pinterest token lifecycle: ${JSON.stringify(requests.map((r) => Object.fromEntries(r.body)))}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Pinterest publishes an image Pin to the selected board", async () => {
  let pinBody: any;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (url === "https://cdn.example/pin.png") {
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "image/png" },
      }));
    }
    if (url === "https://api.pinterest.com/v5/pins") {
      pinBody = JSON.parse(String(init?.body));
      return Promise.resolve(json({ id: "pin-1" }, 201));
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    const result = await ADAPTERS.pinterest.publish({
      text: "Episode 53", mediaUrl: "https://cdn.example/pin.png",
      accessToken: "token", connection: { external_id: "board-2", meta: {} },
    });
    if (pinBody?.board_id !== "board-2" ||
        pinBody?.media_source?.source_type !== "image_url" ||
        pinBody?.media_source?.url !== "https://cdn.example/pin.png") {
      throw new Error(`Unexpected Pinterest Pin body: ${JSON.stringify(pinBody)}`);
    }
    if (result.remote_id !== "pin-1" || !result.remote_url?.includes("/pin/pin-1/")) {
      throw new Error(`Unexpected Pinterest result: ${JSON.stringify(result)}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Pinterest rejects video before creating a Pin", async () => {
  let pinCalled = false;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url === "https://cdn.example/pin.mp4") {
      return Promise.resolve(new Response(new Uint8Array([1]), {
        headers: { "Content-Type": "video/mp4" },
      }));
    }
    if (url === "https://api.pinterest.com/v5/pins") pinCalled = true;
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    await ADAPTERS.pinterest.publish({
      text: "Episode 53", mediaUrl: "https://cdn.example/pin.mp4",
      accessToken: "token", connection: { external_id: "board-2", meta: {} },
    }).then(
      () => { throw new Error("Expected Pinterest video rejection"); },
      (error) => { if (!String(error.message).includes("video Pins are not supported")) throw error; },
    );
    if (pinCalled) throw new Error("Pinterest API must not be called for video");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Pinterest publishing cannot fall back to another workspace's board", async () => {
  let providerCalled = false;
  const queries: string[] = [];
  const results = await publishPost({
    id: "post-b", brand_id: "brand-b", networks: ["pinterest"],
    text: "Episode 53", media_url: "https://cdn.example/pin.png",
  }, {
    adapters: {
      pinterest: {
        label: "Pinterest", clientIdEnv: "PINTEREST_CLIENT_ID",
        requiresExplicitSelection: true,
        publish: async () => {
          providerCalled = true;
          return { remote_id: "wrong-pin" };
        },
      },
    } as any,
    platformConnectionEnabled: () => true,
    env: () => "configured",
    sbOne: async (table: string, query: string) => {
      queries.push(query);
      if (table === "post_targets") return null;
      // A board exists for brand A. The publisher must never see or fall back
      // to it while resolving a post owned by brand B.
      return query.includes("brand_id=eq.brand-b") ? null : {
        id: "board-connection-a", brand_id: "brand-a", status: "active",
        external_id: "board-a", meta: {},
      };
    },
    sbUpsert: async (_table: string, row: any) => row,
    sbUpdate: async (_table: string, _query: string, patch: any) => patch,
    freshConnectionToken: async () => "brand-a-token",
    now: () => "2026-08-07T00:00:00.000Z",
  } as any);

  if (providerCalled) throw new Error("Pinterest must not publish through another workspace's board");
  if (results[0]?.status !== "skipped" ||
      results[0]?.error !== "No connected account for this platform") {
    throw new Error(`Expected tenant-scoped skip, received ${JSON.stringify(results)}`);
  }
  const boardQueries = queries.filter((query) =>
    query.includes("select=*") && query.includes("brand_id="));
  if (!queries.some((query) => query.includes("brand_id=eq.brand-b")) || boardQueries.length !== 1) {
    throw new Error(`Expected one brand-scoped board lookup without fallback: ${queries.join(", ")}`);
  }
});

Deno.test("X metrics report the cumulative follower total and no invented impressions", async () => {
  const requests: string[] = [];
  globalThis.fetch = (input) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://api.x.com/2/users/me?user.fields=public_metrics") {
      return Promise.resolve(json({ data: {
        id: "user-1",
        public_metrics: {
          followers_count: 4210, following_count: 87, post_count: 512, listed_count: 9,
        },
      } }));
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    const measured = await ADAPTERS.x.metrics!({
      accessToken: "token", connection: { external_id: "user-1", meta: {} },
    });
    if (measured?.followers !== 4210) {
      throw new Error(`Expected 4210 followers, received ${JSON.stringify(measured)}`);
    }
    // X exposes no impression figure inside these scopes; reporting one would
    // be fabricated.
    if (measured.impressions !== undefined || measured.engagements !== undefined) {
      throw new Error(`X must not report metrics it cannot read: ${JSON.stringify(measured)}`);
    }
    if (requests.length !== 1) {
      throw new Error(`Expected one metrics request, received ${requests.join(", ")}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("X metrics surface a provider failure as a ProviderRequestError", async () => {
  globalThis.fetch = () => Promise.resolve(json({ title: "Unauthorized" }, 401));

  try {
    await ADAPTERS.x.metrics!({
      accessToken: "expired", connection: { external_id: "user-1", meta: {} },
    }).then(
      () => { throw new Error("Expected X metrics to fail"); },
      (error) => {
        if (!(error instanceof ProviderRequestError)) {
          throw new Error(`Expected ProviderRequestError, received ${error?.name}`);
        }
        if (!String(error.message).includes("x metrics: 401")) throw error;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Pinterest metrics report the connected board's follower total", async () => {
  const requests: string[] = [];
  globalThis.fetch = (input) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://api.pinterest.com/v5/boards/board-1") {
      return Promise.resolve(json({
        id: "board-1", name: "Coffee", follower_count: 133, pin_count: 42,
      }));
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };

  try {
    const measured = await ADAPTERS.pinterest.metrics!({
      accessToken: "token", connection: { external_id: "board-1", meta: {} },
    });
    if (measured?.followers !== 133) {
      throw new Error(`Expected 133 followers, received ${JSON.stringify(measured)}`);
    }
    // monthly_views lives on /v5/user_account, which needs a scope this
    // adapter deliberately does not request.
    if (measured.impressions !== undefined) {
      throw new Error(`Pinterest must not report unreadable impressions: ${JSON.stringify(measured)}`);
    }
    if (requests.length !== 1 || requests[0].includes("/user_account")) {
      throw new Error(`Expected one board metrics request, received ${requests.join(", ")}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Pinterest metrics surface a provider failure as a ProviderRequestError", async () => {
  globalThis.fetch = () => Promise.resolve(json({ message: "Board not found" }, 404));

  try {
    await ADAPTERS.pinterest.metrics!({
      accessToken: "token", connection: { external_id: "board-gone", meta: {} },
    }).then(
      () => { throw new Error("Expected Pinterest metrics to fail"); },
      (error) => {
        if (!(error instanceof ProviderRequestError)) {
          throw new Error(`Expected ProviderRequestError, received ${error?.name}`);
        }
        if (!String(error.message).includes("pinterest metrics: 404")) throw error;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("LinkedIn exposes no metrics adapter while its scopes cannot read any", () => {
  // Absent rather than a null-returning metrics(): ingest-metrics skips a
  // platform with no metrics() before counting an attempt, so the daily job
  // keeps attempted == ingested + failed instead of reporting a phantom
  // dropped ingestion every night.
  if (ADAPTERS.linkedin.metrics !== undefined) {
    throw new Error(
      "LinkedIn analytics need partner scopes; metrics() must stay absent, not return null");
  }
});

Deno.test("mixed-network publishing preserves success while scheduling a safe failed target retry", async () => {
  const targetMarks: any[] = [];
  const postUpdates: any[] = [];
  const called: string[] = [];
  const adapters = {
    x: {
      label: "X / Twitter", clientIdEnv: "X_CLIENT_ID", supportsMedia: true,
      publish: async () => {
        called.push("x");
        return { remote_id: "tweet-1", remote_url: "https://x.com/i/status/tweet-1" };
      },
    },
    linkedin: {
      label: "LinkedIn", clientIdEnv: "LINKEDIN_CLIENT_ID", supportsMedia: true,
      publish: async () => {
        called.push("linkedin");
        throw new ProviderRequestError("linkedin image upload", 500, "unavailable");
      },
    },
  };
  const dependencies: any = {
    adapters,
    platformConnectionEnabled: () => true,
    env: () => "configured",
    sbOne: async (table: string, query: string) => {
      if (table === "post_targets") return null;
      if (table === "social_connections") {
        return {
          id: query.includes("platform=eq.x") ? "connection-x" : "connection-linkedin",
          status: "active", external_id: "account-1", meta: {},
        };
      }
      return null;
    },
    sbUpsert: async (_table: string, row: any) => { targetMarks.push(row); return row; },
    sbUpdate: async (_table: string, _query: string, patch: any) => {
      postUpdates.push(patch); return patch;
    },
    freshConnectionToken: async () => "token",
    now: () => "2026-08-07T00:00:00.000Z",
  };

  const results = await publishPost({
    id: "post-1", brand_id: "brand-1", networks: ["x", "linkedin"],
    text: "Launch", media_url: "https://cdn.example/launch.png",
  }, dependencies);

  if (called.join(",") !== "x,linkedin") throw new Error(`Unexpected calls: ${called}`);
  if (results[0]?.status !== "published" || results[1]?.status !== "failed") {
    throw new Error(`Expected partial success, received ${JSON.stringify(results)}`);
  }
  if (postUpdates.at(-1)?.status !== "scheduled") {
    throw new Error("A retryable target should keep the post scheduled without repeating its success");
  }
  if (!targetMarks.some((mark) => mark.platform === "linkedin" && mark.status === "failed")) {
    throw new Error("Expected the LinkedIn upload failure to be recorded");
  }
});

Deno.test("interrupted targets are not automatically retried", async () => {
  let providerCalled = false;
  const results = await publishPost({
    id: "post-2", brand_id: "brand-1", networks: ["x"], text: "Launch",
  }, {
    adapters: {
      x: {
        label: "X / Twitter", clientIdEnv: "X_CLIENT_ID",
        publish: async () => {
          providerCalled = true;
          return { remote_id: "duplicate" };
        },
      },
    } as any,
    platformConnectionEnabled: () => true,
    env: () => "configured",
    sbOne: async (table: string) => table === "post_targets"
      ? { status: "failed", error: INTERRUPTED }
      : null,
    sbUpsert: async (_table: string, row: any) => row,
    sbUpdate: async (_table: string, _query: string, patch: any) => patch,
    freshConnectionToken: async () => "token",
    now: () => "2026-08-07T00:00:00.000Z",
  } as any);

  if (providerCalled) throw new Error("Interrupted delivery must not call the provider again");
  if (results[0]?.error !== INTERRUPTED) {
    throw new Error(`Expected interrupted result, received ${JSON.stringify(results)}`);
  }
});

Deno.test("a definitive provider failure is retained as a bounded automatic retry", async () => {
  const targetMarks: any[] = [];
  const postUpdates: any[] = [];
  const results = await publishPost({
    id: "post-retry", brand_id: "brand-1", networks: ["x"], text: "Launch",
  }, {
    adapters: {
      x: {
        label: "X / Twitter", clientIdEnv: "X_CLIENT_ID",
        publish: async () => { throw new ProviderRequestError("x publish", 503, "unavailable"); },
      },
    } as any,
    platformConnectionEnabled: () => true,
    env: () => "configured",
    sbOne: async (table: string) => table === "post_targets" ? null : {
      id: "connection-x", status: "active", external_id: "account-1", meta: {},
    },
    sbUpsert: async (_table: string, row: any) => { targetMarks.push(row); return row; },
    sbUpdate: async (_table: string, _query: string, patch: any) => {
      postUpdates.push(patch); return patch;
    },
    freshConnectionToken: async () => "token",
    now: () => "2026-08-09T00:00:00.000Z",
  } as any);

  const failure = targetMarks.at(-1);
  if (results[0]?.failure_kind !== "retryable") {
    throw new Error(`Expected retryable outcome, received ${JSON.stringify(results)}`);
  }
  if (failure?.attempts !== 1 || failure?.failure_kind !== "retryable" ||
      failure?.next_retry_at !== "2026-08-09T00:05:00.000Z") {
    throw new Error(`Expected first bounded retry, received ${JSON.stringify(failure)}`);
  }
  if (postUpdates.at(-1)?.status !== "scheduled") {
    throw new Error("A post with a safe retry pending must remain in the scheduler");
  }
});

Deno.test("validation and authentication failures are permanent and never automatically retried", async () => {
  const targetMarks: any[] = [];
  const postUpdates: any[] = [];
  const results = await publishPost({
    id: "post-permanent", brand_id: "brand-1", networks: ["x"], text: "Launch",
  }, {
    adapters: {
      x: {
        label: "X / Twitter", clientIdEnv: "X_CLIENT_ID",
        publish: async () => { throw new ProviderRequestError("x publish", 401, "token revoked"); },
      },
    } as any,
    platformConnectionEnabled: () => true,
    env: () => "configured",
    sbOne: async (table: string) => table === "post_targets" ? null : {
      id: "connection-x", status: "active", external_id: "account-1", meta: {},
    },
    sbUpsert: async (_table: string, row: any) => { targetMarks.push(row); return row; },
    sbUpdate: async (_table: string, _query: string, patch: any) => {
      postUpdates.push(patch); return patch;
    },
    freshConnectionToken: async () => "token",
    now: () => "2026-08-09T00:00:00.000Z",
  } as any);

  if (results[0]?.failure_kind !== "permanent" || targetMarks.at(-1)?.next_retry_at !== null) {
    throw new Error(`Expected permanent outcome, received ${JSON.stringify(results)}`);
  }
  if (postUpdates.at(-1)?.status !== "failed") {
    throw new Error("A permanent delivery failure must be visible as needs-attention");
  }
});

Deno.test("an automatic retry never resends a sibling permanent target", async () => {
  const called: string[] = [];
  const results = await publishPost({
    id: "post-selective", brand_id: "brand-1", networks: ["x", "linkedin"], text: "Launch",
  }, {
    adapters: {
      x: {
        label: "X / Twitter", clientIdEnv: "X_CLIENT_ID",
        publish: async () => { called.push("x"); return { remote_id: "tweet-2" }; },
      },
      linkedin: {
        label: "LinkedIn", clientIdEnv: "LINKEDIN_CLIENT_ID",
        publish: async () => { called.push("linkedin"); return { remote_id: "post-2" }; },
      },
    } as any,
    platformConnectionEnabled: () => true,
    env: () => "configured",
    sbOne: async (table: string, query: string) => {
      if (table === "post_targets") return query.includes("platform=eq.x") ? {
        status:"failed", attempts:1, failure_kind:"retryable",
        next_retry_at:"2026-08-09T00:00:00.000Z", error:"rate limited",
      } : {
        status:"failed", attempts:1, failure_kind:"permanent",
        next_retry_at:null, error:"invalid media",
      };
      return { id:`connection-${called.length}`, status:"active", external_id:"account", meta:{} };
    },
    sbUpsert: async (_table: string, row: any) => row,
    sbUpdate: async (_table: string, _query: string, patch: any) => patch,
    freshConnectionToken: async () => "token",
    now: () => "2026-08-09T00:05:00.000Z",
  } as any, "automatic");

  if (called.join(",") !== "x") {
    throw new Error(`Automatic retry resent an ineligible target: ${called.join(",")}`);
  }
  if (results[1]?.failure_kind !== "permanent") {
    throw new Error(`Permanent sibling outcome was not preserved: ${JSON.stringify(results)}`);
  }
});

Deno.test("automatic scheduling publishes a brand-new target with no prior outcome", async () => {
  let providerCalled = false;
  const results = await publishPost({
    id: "post-new-due", brand_id: "brand-1", networks: ["x"], text: "Launch",
  }, {
    adapters: {
      x: {
        label: "X / Twitter", clientIdEnv: "X_CLIENT_ID",
        publish: async () => { providerCalled = true; return { remote_id: "tweet-new" }; },
      },
    } as any,
    platformConnectionEnabled: () => true,
    env: () => "configured",
    sbOne: async (table: string) => table === "post_targets" ? null : {
      id:"connection-x", status:"active", external_id:"account", meta:{},
    },
    sbUpsert: async (_table: string, row: any) => row,
    sbUpdate: async (_table: string, _query: string, patch: any) => patch,
    freshConnectionToken: async () => "token",
    now: () => "2026-08-09T00:05:00.000Z",
  } as any, "automatic");

  if (!providerCalled || results[0]?.status !== "published") {
    throw new Error(`Brand-new scheduled target was not published: ${JSON.stringify(results)}`);
  }
});

/* ---------------------------------------------------------------------------
   ADR 0005 delivery item 3 — per-network copy variants.

   The resolver is the whole contract: everything below either pins its
   semantics or pins that publishPost routes its answer to the right adapter.
   --------------------------------------------------------------------------- */

Deno.test("a missing, empty or whitespace-only variant all inherit the base text", () => {
  // The amendment to decision 3. `post.variants?.[platform] ?? post.text` would
  // pass the first case and publish an empty or blank post for the other three.
  const cases: Array<[unknown, string]> = [
    [undefined, "no variants map at all"],
    [{}, "an empty map"],
    [{ x: "" }, "an empty variant"],
    [{ x: "   " }, "a whitespace-only variant"],
    [{ x: "\n\t " }, "a variant of newlines and tabs"],
    [{ x: null }, "a null variant"],
    [{ x: 42 }, "a variant that is not a string"],
    [{ instagram: "Other network" }, "a variant belonging to another network"],
  ];
  for (const [variants, description] of cases) {
    const resolved = effectiveText({ text: "Base copy", variants }, "x");
    if (resolved !== "Base copy") {
      throw new Error(`${description} must inherit the base text, got ${JSON.stringify(resolved)}`);
    }
  }
});

Deno.test("a real variant overrides the base text verbatim, for its network only", () => {
  const post = { text: "Base copy", variants: { x: "  Short version  " } };
  if (effectiveText(post, "x") !== "  Short version  ") {
    throw new Error("a non-blank variant must be sent exactly as written, whitespace included");
  }
  if (effectiveText(post, "facebook") !== "Base copy") {
    throw new Error("a variant must not leak to a network that has none");
  }
  // A hostile map shape must not throw its way into the publish loop.
  for (const variants of [null, "not a map", ["array"], 7]) {
    if (effectiveText({ text: "Base copy", variants }, "x") !== "Base copy") {
      throw new Error(`a variants value of ${JSON.stringify(variants)} must resolve to the base text`);
    }
  }
});

/** A publishPost harness that records the text each adapter was handed. */
function textRecordingDependencies(platforms: string[]) {
  const sent: Record<string, string> = {};
  const adapters: Record<string, any> = {};
  for (const platform of platforms) {
    adapters[platform] = {
      label: platform, clientIdEnv: `${platform.toUpperCase()}_CLIENT_ID`, supportsMedia: true,
      publish: async (input: any) => {
        sent[platform] = input.text;
        return { remote_id: `${platform}-1` };
      },
    };
  }
  return {
    sent,
    dependencies: {
      adapters,
      platformConnectionEnabled: () => true,
      env: () => "configured",
      sbOne: async (table: string) => table === "post_targets" ? null : {
        id: "connection-1", status: "active", external_id: "account-1", meta: {},
      },
      sbUpsert: async (_table: string, row: any) => row,
      sbUpdate: async (_table: string, _query: string, patch: any) => patch,
      freshConnectionToken: async () => "token",
      now: () => "2026-08-30T00:00:00.000Z",
    } as any,
  };
}

Deno.test("a post with no variants sends the same base text to every network", async () => {
  // The backward-compatibility contract of decision 3, asserted directly rather
  // than inferred from the older publishPost tests that happen to omit the key.
  const { sent, dependencies } = textRecordingDependencies(["x", "facebook", "instagram"]);
  await publishPost({
    id: "post-compat", brand_id: "brand-1", networks: ["x", "facebook", "instagram"],
    text: "One message for everyone", media_url: null,
  }, dependencies);

  for (const platform of ["x", "facebook", "instagram"]) {
    if (sent[platform] !== "One message for everyone") {
      throw new Error(`${platform} received ${JSON.stringify(sent[platform])} instead of the base text`);
    }
  }
});

Deno.test("each network receives its own variant, and the base text where it has none", async () => {
  const { sent, dependencies } = textRecordingDependencies(["x", "facebook", "instagram"]);
  await publishPost({
    id: "post-variants", brand_id: "brand-1", networks: ["x", "facebook", "instagram"],
    text: "The long, considered version for a feed with room for it.",
    variants: {
      x: "The short one.",
      instagram: "   ",                       // blank: inherits, never publishes blank
      linkedin: "For a network this post does not name",
    },
  }, dependencies);

  if (sent.x !== "The short one.") {
    throw new Error(`X received ${JSON.stringify(sent.x)} instead of its variant`);
  }
  if (sent.facebook !== "The long, considered version for a feed with room for it.") {
    throw new Error("a network without a variant must receive the base text");
  }
  if (sent.instagram !== "The long, considered version for a feed with room for it.") {
    throw new Error("a whitespace-only variant must inherit, not publish blank");
  }
  if (Object.values(sent).includes("For a network this post does not name")) {
    throw new Error("a variant for an unselected network must never be sent");
  }
});

Deno.test("X refuses an over-length post instead of silently truncating it", async () => {
  // ADR 0005 decision 12. This adapter used to send `text.slice(0, 280)`, which
  // published a post the customer never wrote. X is production-frozen, so this
  // path is dormant — and it is still the wrong thing to leave in the code.
  let requested = false;
  globalThis.fetch = () => {
    requested = true;
    return Promise.resolve(json({ data: { id: "tweet-1" } }));
  };
  try {
    const overLength = "n".repeat(X_TEXT_LIMIT + 1);
    let message = "";
    try {
      await ADAPTERS.x.publish({
        text: overLength, mediaUrl: null, accessToken: "token",
        connection: { external_id: "account-1", meta: {} },
      });
    } catch (error) {
      message = String((error as Error).message);
    }
    if (!message) throw new Error("an over-length X post must be refused");
    if (!message.includes(String(X_TEXT_LIMIT)) || !message.includes("281")) {
      throw new Error(`the refusal must name the limit and the actual length: ${message}`);
    }
    if (requested) throw new Error("nothing may reach X once the text is known to be too long");

    // Exactly at the limit still publishes, and publishes in full.
    let sentText = "";
    globalThis.fetch = (_input, init) => {
      sentText = JSON.parse(String(init?.body)).text;
      return Promise.resolve(json({ data: { id: "tweet-1" } }));
    };
    await ADAPTERS.x.publish({
      text: "y".repeat(X_TEXT_LIMIT), mediaUrl: null, accessToken: "token",
      connection: { external_id: "account-1", meta: {} },
    });
    if (sentText.length !== X_TEXT_LIMIT) {
      throw new Error(`a post at the limit must be sent whole, got ${sentText.length} characters`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("an over-length X variant fails that target permanently and never blocks its siblings", async () => {
  const marks: any[] = [];
  const called: string[] = [];
  const results = await publishPost({
    id: "post-x-cap", brand_id: "brand-1", networks: ["x", "facebook"],
    text: "A perfectly ordinary post.",
    variants: { x: "z".repeat(X_TEXT_LIMIT + 40) },
  }, {
    adapters: {
      x: {
        label: "X / Twitter", clientIdEnv: "X_CLIENT_ID",
        publish: ADAPTERS.x.publish,
      },
      facebook: {
        label: "Facebook", clientIdEnv: "FACEBOOK_CLIENT_ID",
        publish: async (input: any) => {
          called.push(input.text);
          return { remote_id: "fb-1" };
        },
      },
    } as any,
    platformConnectionEnabled: () => true,
    env: () => "configured",
    sbOne: async (table: string) => table === "post_targets" ? null : {
      id: "connection-1", status: "active", external_id: "account-1", meta: {},
    },
    sbUpsert: async (_table: string, row: any) => { marks.push(row); return row; },
    sbUpdate: async (_table: string, _query: string, patch: any) => patch,
    freshConnectionToken: async () => "token",
    now: () => "2026-08-30T00:00:00.000Z",
  } as any);

  if (results[0]?.failure_kind !== "permanent") {
    throw new Error(`an over-length variant is not retryable: ${JSON.stringify(results[0])}`);
  }
  if (marks.at(-2)?.next_retry_at !== null && marks.at(-1)?.next_retry_at !== null) {
    throw new Error("a refusal no retry can fix must not schedule one");
  }
  if (called.join("") !== "A perfectly ordinary post.") {
    throw new Error("the sibling network must still receive its own text");
  }
});

Deno.test("platforms.ts effectiveText matches the shared fixture table", async () => {
  // Same table js/planner.js is held to (test/effective-text-parity.test.mjs):
  // the two resolvers must answer identically or the composer's "inherits"
  // label lies about what publishes. JSON module import needs no fs permission.
  const fixture = (await import("../../../test/fixtures/effective-text-cases.json", {
    with: { type: "json" },
  })).default;
  for (const c of fixture.cases) {
    const got = effectiveText(c.post, c.platform);
    if (got !== c.expect) {
      throw new Error(`${c.name}: expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(got)}`);
    }
  }
});

/* ------------------------------------------- TikTok Content Posting API ---
 *
 * The compliance workflow's server half. What these assert is the difference
 * between the adapter that was frozen and the one that replaced it: the
 * creator's own choices reach `post_info` instead of a hardcoded SELF_ONLY, a
 * target with no choices fails cleanly instead of inventing them, and "the
 * upload was accepted" is no longer reported as "the video is on TikTok".
 */

/** This suite throws its own errors rather than pulling in an assertion
 *  library; the TikTok cases compare enough small values that one helper earns
 *  its place. Same shape as the one in connection-health/index.deno.ts. */
const assertEquals = (actual: unknown, expected: unknown, message = "values differ") => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

/** The status poll is a real minute in production. Shrink it around one test
 *  and always put it back, so a timeout case costs milliseconds and no other
 *  test inherits the change. */
async function withFastPolling<T>(run: () => Promise<T>, timeoutMs = 30): Promise<T> {
  const original = { ...TIKTOK_STATUS_POLL };
  TIKTOK_STATUS_POLL.intervalMs = 1;
  TIKTOK_STATUS_POLL.timeoutMs = timeoutMs;
  try { return await run(); } finally { Object.assign(TIKTOK_STATUS_POLL, original); }
}

const TIKTOK_OPTIONS = {
  privacy_level: "MUTUAL_FOLLOW_FRIENDS",
  disable_comment: true,
  disable_duet: false,
  disable_stitch: true,
  disclose_commercial: true,
  brand_organic: false,
  brand_content: true,
};

/** Answers init once, then every status poll from `states` in order (the last
 *  entry repeats). Records what was sent so the mapping can be read back. */
function tiktokFetch(states: unknown[], calls: { url: string; body: any }[]) {
  let polls = 0;
  return (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.endsWith("/video/init/")) {
      return Promise.resolve(json({ data: { publish_id: "publish-1" } }));
    }
    if (url.endsWith("/status/fetch/")) {
      const state = states[Math.min(polls++, states.length - 1)];
      return Promise.resolve(json({ data: state }));
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  };
}

Deno.test("TikTok sends the creator's own choices, never a hardcoded privacy level", async () => {
  const calls: { url: string; body: any }[] = [];
  globalThis.fetch = tiktokFetch([{ status: "PROCESSING_UPLOAD" }, { status: "PUBLISH_COMPLETE" }], calls);
  try {
    const result = await withFastPolling(() => ADAPTERS.tiktok.publish({
      text: "Behind the scenes",
      mediaUrl: "https://cdn.example/clip.mp4",
      accessToken: "token",
      connection: { external_id: "creator-1", meta: {} },
      tiktokOptions: TIKTOK_OPTIONS,
    }));
    const info = calls[0].body.post_info;
    assertEquals(info.privacy_level, "MUTUAL_FOLLOW_FRIENDS");
    assertEquals(info.disable_comment, true);
    assertEquals(info.disable_duet, false);
    assertEquals(info.disable_stitch, true);
    assertEquals(info.brand_content_toggle, true);
    assertEquals(info.brand_organic_toggle, false);
    assertEquals(info.title, "Behind the scenes");
    assertEquals(calls[0].body.source_info,
      { source: "PULL_FROM_URL", video_url: "https://cdn.example/clip.mp4" });
    // Not published until TikTok says so: the first poll was still processing.
    assertEquals(calls.map(c => c.url.split("/v2/")[1]),
      ["post/publish/video/init/", "post/publish/status/fetch/", "post/publish/status/fetch/"]);
    assertEquals(calls[1].body, { publish_id: "publish-1" });
    assertEquals(result, { remote_id: "publish-1" });
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("a TikTok target with no usable options fails before any request", async () => {
  let called = false;
  globalThis.fetch = () => { called = true; return Promise.reject(new Error("must not run")); };
  try {
    for (const tiktokOptions of [
      null,
      undefined,
      {},
      "PUBLIC_TO_EVERYONE",
      [{ privacy_level: "PUBLIC_TO_EVERYONE" }],
      { privacy_level: "" },
      { privacy_level: "PUBLIC_TO_ANYONE_AT_ALL" },
      // disclosure with nothing declared, and private branded content: TikTok
      // refuses both, so storing or sending them is never the honest option.
      { privacy_level: "PUBLIC_TO_EVERYONE", disclose_commercial: true },
      { privacy_level: "SELF_ONLY", disclose_commercial: true, brand_content: true },
    ]) {
      await ADAPTERS.tiktok.publish({
        text: "Clip", mediaUrl: "https://cdn.example/clip.mp4", accessToken: "token",
        connection: { external_id: "creator-1", meta: {} }, tiktokOptions,
      }).then(
        () => { throw new Error(`accepted ${JSON.stringify(tiktokOptions)}`); },
        (error) => {
          assertEquals(error.name, "Error",
            "a composer problem is a plain permanent failure, not an ambiguous outcome");
          assertEquals(error.message, TIKTOK_OPTIONS_REQUIRED);
        },
      );
    }
    if (called) throw new Error("no provider request may be made without the creator's choices");
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("TikTok reports a FAILED publish with its own reason and nothing else", async () => {
  const calls: { url: string; body: any }[] = [];
  globalThis.fetch = tiktokFetch(
    [{ status: "FAILED", fail_reason: "video_duration_check_failed" }], calls);
  try {
    await withFastPolling(() => ADAPTERS.tiktok.publish({
      text: "Clip", mediaUrl: "https://cdn.example/clip.mp4", accessToken: "token-SECRET",
      connection: { external_id: "creator-1", meta: {} }, tiktokOptions: TIKTOK_OPTIONS,
    })).then(
      () => { throw new Error("a FAILED status must not resolve"); },
      (error) => {
        assertEquals(error.name, "Error");
        assertEquals(error.message, "TikTok rejected this video (video_duration_check_failed).");
        if (String(error.message).includes("token-SECRET")) {
          throw new Error("a credential must never reach a failure message");
        }
      },
    );
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("a TikTok upload that never finishes is ambiguous, not published", async () => {
  const calls: { url: string; body: any }[] = [];
  globalThis.fetch = tiktokFetch([{ status: "PROCESSING_UPLOAD" }], calls);
  try {
    await withFastPolling(() => ADAPTERS.tiktok.publish({
      text: "Clip", mediaUrl: "https://cdn.example/clip.mp4", accessToken: "token",
      connection: { external_id: "creator-1", meta: {} }, tiktokOptions: TIKTOK_OPTIONS,
    })).then(
      () => { throw new Error("a timeout must not report success"); },
      (error) => {
        if (!(error instanceof PublishOutcomeUnknownError)) {
          throw new Error(`expected an unknown outcome, got ${error.name}: ${error.message}`);
        }
      },
    );
    if (calls.length < 2) throw new Error("the adapter should have polled at least once");
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("the TikTok sandbox gate opens testing only, and only for TikTok", async () => {
  const off = () => undefined;
  const on = (key: string) => (key === "TIKTOK_SANDBOX" ? "1" : undefined);
  // The freeze, unchanged: with no sandbox variable TikTok is exactly as
  // unreachable as every other production-disabled adapter.
  for (const id of ["tiktok", "pinterest", "x", "linkedin"]) {
    assertEquals(platformConnectionEnabled(ADAPTERS[id], off), false, `${id} without the gate`);
  }
  assertEquals(platformConnectionEnabled(ADAPTERS.tiktok, on), true);
  // …and it is TikTok's gate alone. No other frozen provider may ride it.
  for (const id of ["pinterest", "x", "linkedin"]) {
    assertEquals(platformConnectionEnabled(ADAPTERS[id], on), false, `${id} must not ride the gate`);
  }
  // Production adapters are unaffected either way.
  for (const id of ["facebook", "instagram", "youtube"]) {
    assertEquals(platformConnectionEnabled(ADAPTERS[id], off), true, `${id} stays enabled`);
  }
  // The exact string "1", so a stray value cannot open it by accident.
  for (const value of ["", "0", "true", "false", "yes", " 1", "1 "]) {
    assertEquals(platformConnectionEnabled(ADAPTERS.tiktok, () => value), false,
      `TIKTOK_SANDBOX=${JSON.stringify(value)} must not enable TikTok`);
  }
  // productionEnabled is untouched by the gate: this is a testing opening on a
  // non-production deployment, never a production enable.
  assertEquals(ADAPTERS.tiktok.productionEnabled, false);
});

Deno.test("discovery offers TikTok only when the sandbox variable is really set", () => {
  // configuredPlatforms() asks platformConnectionEnabled() with no env
  // argument, so this is the default deployment-variable path — the one
  // oauth-start actually takes.
  const secrets: Record<string, string> = {
    SOCIAL_TOKEN_ENCRYPTION_KEY: "key",
    TIKTOK_CLIENT_KEY: "sandbox-key",
    TIKTOK_CLIENT_SECRET: "sandbox-secret",
  };
  const env = (key: string) => secrets[key];
  const had = Deno.env.get("TIKTOK_SANDBOX");
  try {
    Deno.env.delete("TIKTOK_SANDBOX");
    assertEquals(configuredPlatforms(env), [], "the freeze holds with no sandbox variable");
    Deno.env.set("TIKTOK_SANDBOX", "1");
    assertEquals(configuredPlatforms(env), ["tiktok"]);
  } finally {
    if (had === undefined) Deno.env.delete("TIKTOK_SANDBOX");
    else Deno.env.set("TIKTOK_SANDBOX", had);
  }
});
