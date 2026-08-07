import {
  ADAPTERS,
  exchangeAuthorizationCode,
  PublishOutcomeUnknownError,
  refreshPlatformToken,
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

Deno.test("mixed-network publishing preserves success and reports upload failure", async () => {
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
        throw new Error("linkedin image upload: 500 unavailable");
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
  if (postUpdates.at(-1)?.status !== "published") {
    throw new Error("A successful target should keep the post published");
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
