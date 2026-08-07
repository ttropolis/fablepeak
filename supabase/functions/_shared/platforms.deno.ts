import {
  ADAPTERS,
  PublishOutcomeUnknownError,
} from "./platforms.ts";

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
