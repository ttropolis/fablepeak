import { createHandler, parseSuggestions } from "./index.ts";
import type { Entitlements, Tier } from "./index.ts";

const assertEquals = (actual: unknown, expected: unknown, message = "values differ") => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

type ModelCall = { url: string; headers: Record<string, string>; body: any };

/** Every secret a fully configured server would hold. Which one a request
 * reaches is decided by the tier and the registry, never by which keys exist. */
const ENV: Record<string, string> = {
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  CLOUDFLARE_AI_TOKEN: "cf-token",
  ANTHROPIC_API_KEY: "test-key",
  OPENAI_API_KEY: "openai-key",
  APP_ORIGIN: "https://fablepeak.com",
};

/** A provider reply shaped the way Workers AI shapes one (the standard tier). */
const cloudflareReply = (text: string) =>
  new Response(JSON.stringify({ success: true, result: { response: text }, errors: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** A provider reply shaped the way the Messages API shapes one (advanced). */
const anthropicReply = (text: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({
    id: "msg_test",
    model: "claude-opus-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    ...extra,
  }), { status: 200, headers: { "Content-Type": "application/json" } });

/** A provider reply shaped the way chat completions shape one (enhanced). */
const openaiReply = (text: string, finish = "stop") =>
  new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: text }, finish_reason: finish }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

/** Entitlement that unlocks every tier — the shape a paid plan will return.
 * Only tests that deliberately exercise a paid tier pass this. */
const everyTier = async (): Promise<Entitlements> => ({
  tiers: new Set<Tier>(["standard", "enhanced", "advanced"]),
  hourlyLimit: { standard: 20, enhanced: 20, advanced: 20 },
});

type HarnessOptions = { env?: Record<string, string>; reply?: () => Response };

function harness(overrides: Record<string, unknown> = {}, options: HarnessOptions = {}) {
  const env = options.env ?? ENV;
  const reply = options.reply ?? (() => cloudflareReply('["one","two","three"]'));
  const calls: ModelCall[] = [];
  const recorded: Array<{ table: string; row: any }> = [];
  const counted: string[] = [];
  const handler = createHandler({
    env: key => env[key],
    authenticate: async () => ({ id: "user-1", email: "owner@example.test" }),
    isMember: async () => true,
    countRecentRequests: async (_table: string, query: string) => {
      counted.push(query);
      return 0;
    },
    recordRequest: async (table: string, row: any) => {
      recorded.push({ table, row });
      return null;
    },
    fetchModel: async (input: any, init: any) => {
      calls.push({
        url: String(input),
        headers: init?.headers ?? {},
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return reply();
    },
    now: () => new Date("2026-08-29T12:00:00.000Z"),
    ...overrides,
  });
  return { handler, calls, recorded, counted };
}

/** The advanced tier, entitled and answering like Claude. Nothing else about
 * the harness changes: the tier is the only difference a caller makes. */
const advanced = (overrides: Record<string, unknown> = {}, options: HarnessOptions = {}) =>
  harness({ entitlements: everyTier, ...overrides }, {
    reply: () => anthropicReply('["one","two","three"]'),
    ...options,
  });

const post = (body: unknown, headers: Record<string, string> = { Authorization: "Bearer jwt" }) =>
  new Request("https://example.test", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const caption = { action: "caption", brand_id: "brand-1", topic: "our new winter menu" };

const CLOUDFLARE_URL =
  "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

Deno.test("an anonymous request never reaches the provider", async () => {
  const { handler, calls, recorded } = harness();
  const response = await handler(post(caption, {}));

  assertEquals(response.status, 401);
  assertEquals(await response.json(), { error: "Not signed in" });
  assertEquals(calls, []);
  assertEquals(recorded, []);

  const invalidSession = harness({ authenticate: async () => null });
  const rejected = await invalidSession.handler(post(caption));
  assertEquals(rejected.status, 401);
  assertEquals(invalidSession.calls, []);
});

Deno.test("a signed-in caller outside the brand is refused before any spend", async () => {
  const { handler, calls, recorded } = harness({ isMember: async () => false });
  const response = await handler(post(caption));

  assertEquals(response.status, 403);
  assertEquals(await response.json(), { error: "You don't have access to that brand" });
  assertEquals(calls, []);
  assertEquals(recorded, []);

  // A missing brand_id is the same refusal — membership is never assumed.
  const { handler: noBrand } = harness();
  assertEquals((await noBrand(post({ ...caption, brand_id: "" }))).status, 403);
});

/* ---------- capability tiers ---------- */

Deno.test("a tier no plan includes is refused without calling or metering anything", async () => {
  for (const tier of ["enhanced", "advanced"]) {
    const { handler, calls, recorded } = harness();
    const response = await handler(post({ ...caption, tier }));

    assertEquals(response.status, 403, `${tier} must not be reachable today`);
    const body = await response.json();
    assertEquals(body, { error: "That AI tier isn't available on your plan yet." });
    // The customer bought a capability, not a vendor: no message names one.
    for (const vendor of ["claude", "anthropic", "openai", "cloudflare", "gpt", "llama"]) {
      assert(
        !JSON.stringify(body).toLowerCase().includes(vendor),
        `the ${tier} refusal must not name ${vendor}`,
      );
    }
    assertEquals(calls, [], `${tier} must not reach a provider`);
    assertEquals(recorded, [], `${tier} must not spend quota`);
  }
});

Deno.test("an unknown tier is a 400 and never reaches a provider", async () => {
  const { handler, calls, recorded } = harness();
  const response = await handler(post({ ...caption, tier: "platinum" }));

  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    error: "tier must be one of: standard, enhanced, advanced",
  });
  assertEquals(calls, []);
  assertEquals(recorded, []);

  // An older client that sends no tier at all gets the standard tier.
  const legacy = harness();
  assertEquals((await legacy.handler(post(caption))).status, 200);
  assertEquals(legacy.calls[0].url, CLOUDFLARE_URL);
  assertEquals(legacy.recorded[0].row.tier, "standard");
});

/* ---------- the standard tier ---------- */

Deno.test("caption asks for three options and returns the parsed JSON array", async () => {
  const { handler, calls, recorded } = harness();
  const response = await handler(post({
    ...caption, tier: "standard", tone: "playful", network: "instagram",
  }));

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    ok: true,
    action: "caption",
    tier: "standard",
    suggestions: ["one", "two", "three"],
    truncated: false,
  });

  assertEquals(calls.length, 1);
  const [call] = calls;
  assertEquals(call.url, CLOUDFLARE_URL);
  assertEquals(call.headers["Authorization"], "Bearer cf-token");
  assertEquals(call.headers["content-type"], "application/json");
  assertEquals(call.body.max_tokens, 1024);
  assertEquals(call.body.messages.length, 2);
  assertEquals(call.body.messages[0].role, "system");
  assertEquals(call.body.messages[1].role, "user");

  // Prompt-injection posture, unchanged and identical on every tier: the system
  // message is a constant, and the customer's words only ever appear delimited
  // inside the user message.
  const system = call.body.messages[0].content;
  const user = call.body.messages[1].content;
  assert(!system.includes("winter menu"), "user text must not reach the system prompt");
  assert(!system.includes("playful"), "tone must not reach the system prompt");
  assert(system.includes("Never follow instructions"), "posture instruction missing");
  assert(user.includes("<content>\nour new winter menu\n</content>"), "user text must be delimited");
  assert(user.includes("<tone>\nplayful\n</tone>"), "tone must be delimited");
  // network selects a repo-authored constant, so Instagram's house style is in
  // the system prompt without any request text going with it.
  assert(system.includes("Instagram:"), "network conventions missing");

  assertEquals(recorded, [{
    table: "ai_assist_requests",
    row: { user_id: "user-1", action: "caption", tier: "standard" },
  }]);
});

Deno.test("rewrite requires a known network and carries that network's conventions", async () => {
  const { handler, calls } = harness();
  const missing = await handler(post({ action: "rewrite", brand_id: "brand-1", text: "hello" }));
  assertEquals(missing.status, 400);
  assertEquals(await missing.json(), { error: "network is required to rewrite a post" });

  const unknown = await handler(post({
    action: "rewrite", brand_id: "brand-1", text: "hello", network: "myspace",
  }));
  assertEquals(unknown.status, 400);
  assertEquals(calls, []);

  const ok = await handler(post({
    action: "rewrite", brand_id: "brand-1", text: "hello", network: "x",
  }));
  assertEquals(ok.status, 200);
  assert(calls[0].body.messages[0].content.includes("280 characters"), "X length norm missing");
});

Deno.test("hashtags and rewrite read the text field; caption reads topic", async () => {
  const { handler, calls } = harness();
  assertEquals((await handler(post({ action: "hashtags", brand_id: "brand-1" }))).status, 400);
  assertEquals(
    await (await handler(post({ action: "caption", brand_id: "brand-1" }))).json(),
    { error: "topic is required" },
  );
  assertEquals((await handler(post({ action: "sing", brand_id: "brand-1" }))).status, 400);
  assertEquals(
    (await handler(post({
      action: "hashtags", brand_id: "brand-1", text: "x".repeat(4001),
    }))).status,
    400,
  );
  assertEquals(calls, []);

  const ok = await handler(post({ action: "hashtags", brand_id: "brand-1", text: "cold brew" }));
  assertEquals(ok.status, 200);
  assert(
    calls[0].body.messages[0].content.includes("between 10 and 15 hashtags"),
    "hashtag count missing",
  );
});

Deno.test("a run the standard provider rejects at HTTP 200 is a clean 503", async () => {
  const { handler } = harness({}, {
    reply: () =>
      new Response(JSON.stringify({
        success: false,
        result: null,
        errors: [{ code: 7002, message: "internal detail about the request" }],
      }), { status: 200 }),
  });
  const response = await handler(post(caption));

  assertEquals(response.status, 503);
  const body = await response.json();
  assertEquals(body, { error: "AI assist is temporarily unavailable. Try again shortly." });
  assert(!JSON.stringify(body).includes("internal detail"), "provider body must not leak");
});

Deno.test("provider failures map onto answers a composer can show", async () => {
  const cases: Array<[number, number]> = [[401, 503], [429, 429], [400, 500], [529, 503], [500, 503]];
  for (const [providerStatus, expected] of cases) {
    const { handler } = harness({}, {
      reply: () =>
        new Response(
          JSON.stringify({ success: false, errors: [{ code: 10000, message: "internal detail" }] }),
          { status: providerStatus },
        ),
    });
    const response = await handler(post(caption));
    assertEquals(response.status, expected, `provider ${providerStatus}`);
    const body = await response.json();
    assert(!JSON.stringify(body).includes("internal detail"), "provider body must not leak");
  }
});

Deno.test("a network failure reaching the provider is a 503, not a stack trace", async () => {
  const { handler } = harness({
    fetchModel: async () => {
      throw new TypeError("error sending request for url (https://api.cloudflare.com/…)");
    },
  });
  const response = await handler(post(caption));

  assertEquals(response.status, 503);
  assertEquals(await response.json(), {
    error: "AI assist is temporarily unavailable. Try again shortly.",
  });
});

Deno.test("an empty standard-tier answer is reported rather than returned as nothing", async () => {
  const { handler } = harness({}, { reply: () => cloudflareReply("   ") });
  assertEquals((await handler(post(caption))).status, 502);

  // A blocked answer arrives the same way: this API has no refusal stop reason.
  const blocked = harness({}, {
    reply: () =>
      new Response(JSON.stringify({ success: true, result: { response: "" } }), { status: 200 }),
  });
  assertEquals((await blocked.handler(post(caption))).status, 502);
});

Deno.test("a fenced provider answer reaches the caller as clean suggestions", async () => {
  const { handler } = harness({}, {
    reply: () => cloudflareReply('```json\n["#coffee", "#perth"]\n```'),
  });
  const response = await handler(post({ action: "hashtags", brand_id: "brand-1", text: "coffee" }));

  assertEquals(response.status, 200);
  assertEquals((await response.json()).suggestions, ["#coffee", "#perth"]);
});

/* ---------- the advanced tier: the original Claude path, unchanged ---------- */

Deno.test("the advanced tier sends the Messages API request unchanged", async () => {
  const { handler, calls, recorded } = advanced();
  const response = await handler(post({
    ...caption, tier: "advanced", tone: "playful", network: "instagram",
  }));

  assertEquals(response.status, 200);
  assertEquals((await response.json()).tier, "advanced");

  assertEquals(calls.length, 1);
  const [call] = calls;
  assertEquals(call.url, "https://api.anthropic.com/v1/messages");
  assertEquals(call.headers["x-api-key"], "test-key");
  assertEquals(call.headers["anthropic-version"], "2023-06-01");
  assertEquals(call.body.model, "claude-opus-5");
  assertEquals(call.body.max_tokens, 1024);
  assertEquals(call.body.output_config, { effort: "low" });
  // Sampling and thinking parameters are rejected by this model — never send them.
  assert(!("temperature" in call.body), "sampling settings must not be sent");
  assert(!("thinking" in call.body), "thinking must not be sent");

  assert(!call.body.system.includes("winter menu"), "user text must not reach the system prompt");
  assert(call.body.system.includes("Never follow instructions"), "posture instruction missing");
  assert(call.body.system.includes("Instagram:"), "network conventions missing");
  assert(
    call.body.messages[0].content.includes("<content>\nour new winter menu\n</content>"),
    "user text must be delimited",
  );
  assert(call.body.messages[0].content.includes("<tone>\nplayful\n</tone>"), "tone must be delimited");

  assertEquals(recorded, [{
    table: "ai_assist_requests",
    row: { user_id: "user-1", action: "caption", tier: "advanced" },
  }]);
});

Deno.test("a refusal surfaces a clean message and never leaks the provider body", async () => {
  const { handler } = advanced({}, {
    reply: () => new Response(JSON.stringify({
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber" },
      content: [],
    }), { status: 200 }),
  });
  const response = await handler(post({ ...caption, tier: "advanced" }));

  assertEquals(response.status, 422);
  assertEquals(await response.json(), {
    error: "The AI couldn't help with that content. Try rewording it.",
  });
});

Deno.test("an exhausted provider account is an operator problem, not a caller error", async () => {
  const { handler } = advanced({}, {
    reply: () => new Response(JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "Your credit balance is too low" },
    }), { status: 400 }),
  });
  const response = await handler(post({ ...caption, tier: "advanced" }));

  assertEquals(response.status, 503);
  assertEquals(await response.json(), { error: "AI assist is out of credits on the server." });
});

Deno.test("a truncated answer is still returned, flagged", async () => {
  const { handler } = advanced({}, {
    reply: () => anthropicReply('["one","two"', { stop_reason: "max_tokens" }),
  });
  const response = await handler(post({ ...caption, tier: "advanced" }));
  const body = await response.json();

  assertEquals(response.status, 200);
  assertEquals(body.truncated, true);
  assert(body.suggestions.length > 0, "a truncated answer still carries suggestions");
});

Deno.test("an empty advanced-tier answer is reported rather than returned as nothing", async () => {
  const { handler } = advanced({}, { reply: () => anthropicReply("   ") });
  assertEquals((await handler(post({ ...caption, tier: "advanced" }))).status, 502);
});

/* ---------- the enhanced tier: built, dormant ---------- */

Deno.test("the enhanced tier sends a chat-completions request", async () => {
  const { handler, calls, recorded } = harness(
    { entitlements: everyTier },
    { reply: () => openaiReply('["one","two"]', "length") },
  );
  const response = await handler(post({ ...caption, tier: "enhanced" }));
  const body = await response.json();

  assertEquals(response.status, 200);
  assertEquals(body.suggestions, ["one", "two"]);
  assertEquals(body.truncated, true, "a length finish reason is a truncated answer");

  const [call] = calls;
  assertEquals(call.url, "https://api.openai.com/v1/chat/completions");
  assertEquals(call.headers["Authorization"], "Bearer openai-key");
  assertEquals(call.body.model, "gpt-4o-mini");
  assertEquals(call.body.max_tokens, 1024);
  assertEquals(call.body.messages[0].role, "system");
  assertEquals(call.body.messages[1].role, "user");
  assert(
    call.body.messages[1].content.includes("<content>\nour new winter menu\n</content>"),
    "user text must be delimited on every tier",
  );
  assertEquals(recorded[0].row.tier, "enhanced");
});

Deno.test("an entitled tier whose secret is unset is a clean 503, not a crash", async () => {
  const { handler, calls, recorded } = harness(
    { entitlements: everyTier },
    { env: { ...ENV, OPENAI_API_KEY: "" } },
  );
  const response = await handler(post({ ...caption, tier: "enhanced" }));

  assertEquals(response.status, 503);
  assertEquals(await response.json(), { error: "AI assist is not configured on the server." });
  assertEquals(calls, []);
  assertEquals(recorded, [], "an unconfigured tier must not spend quota");
});

/* ---------- the registry ---------- */

Deno.test("AI_PROVIDER re-points the standard tier and nothing else", async () => {
  // The escape hatch: the tier everyone is on can be moved to another adapter
  // by setting one secret, with nothing customer-facing changing.
  const moved = harness({}, {
    env: { ...ENV, AI_PROVIDER: "anthropic" },
    reply: () => anthropicReply('["one"]'),
  });
  assertEquals((await moved.handler(post(caption))).status, 200);
  assertEquals(moved.calls[0].url, "https://api.anthropic.com/v1/messages");
  assertEquals(moved.recorded[0].row.tier, "standard", "the tier is what the customer asked for");

  // A paid tier is a promise about which model answers, so it ignores the hatch.
  const paid = advanced({}, { env: { ...ENV, AI_PROVIDER: "cloudflare" } });
  assertEquals((await paid.handler(post({ ...caption, tier: "advanced" }))).status, 200);
  assertEquals(paid.calls[0].url, "https://api.anthropic.com/v1/messages");

  // An unusable value falls back to the tier's own adapter rather than failing.
  const nonsense = harness({}, { env: { ...ENV, AI_PROVIDER: "hal9000" } });
  assertEquals((await nonsense.handler(post(caption))).status, 200);
  assertEquals(nonsense.calls[0].url, CLOUDFLARE_URL);
});

Deno.test("AI_MODEL chooses the standard tier's model", async () => {
  const { handler, calls } = harness({}, { env: { ...ENV, AI_MODEL: "@cf/qwen/qwen3-30b-a3b-fp8" } });
  assertEquals((await handler(post(caption))).status, 200);
  assertEquals(
    calls[0].url,
    "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/qwen/qwen3-30b-a3b-fp8",
  );
});

/* ---------- metering ---------- */

Deno.test("the hourly ceiling is enforced before the provider is called", async () => {
  const { handler, calls, recorded } = harness({ countRecentRequests: async () => 20 });
  const response = await handler(post(caption));

  assertEquals(response.status, 429);
  assertEquals(await response.json(), {
    error: "AI assist is limited to 20 requests an hour. Try again later.",
    retry_after_seconds: 3600,
  });
  assertEquals(calls, []);
  assertEquals(recorded, []);
});

Deno.test("the ceiling is the entitlement's ceiling for the requested tier", async () => {
  const tightAdvanced = async (): Promise<Entitlements> => ({
    tiers: new Set<Tier>(["standard", "advanced"]),
    hourlyLimit: { standard: 20, enhanced: 20, advanced: 3 },
  });
  const { handler, calls } = harness(
    { entitlements: tightAdvanced, countRecentRequests: async () => 3 },
    { reply: () => anthropicReply('["one"]') },
  );
  const response = await handler(post({ ...caption, tier: "advanced" }));

  assertEquals(response.status, 429);
  assertEquals(await response.json(), {
    error: "AI assist is limited to 3 requests an hour. Try again later.",
    retry_after_seconds: 3600,
  });
  assertEquals(calls, []);
});

Deno.test("the ceiling counts only this user's last rolling hour", async () => {
  const { handler, counted } = harness();
  await handler(post(caption));

  // Every tier a user spends counts against the same hour: the filter names the
  // user and the window, never a tier.
  assertEquals(counted, [
    "user_id=eq.user-1&created_at=gte.2026-08-29T11%3A00%3A00.000Z",
  ]);
});

Deno.test("an unset provider key is a clean 503 and spends no quota", async () => {
  const unconfigured = createHandler({
    env: () => undefined,
    authenticate: async () => ({ id: "user-1" }),
    isMember: async () => true,
    countRecentRequests: async () => 0,
    recordRequest: async () => {
      throw new Error("an unconfigured server must not meter the request");
    },
    fetchModel: async () => {
      throw new Error("the provider must not be called without a key");
    },
  });
  const response = await unconfigured(post(caption));

  assertEquals(response.status, 503);
  assertEquals(await response.json(), {
    error: "AI assist is not configured on the server.",
  });
});

/* ---------- parsing, shared by every adapter ---------- */

Deno.test("fenced, prefixed and plain-list model output all parse to clean strings", () => {
  assertEquals(parseSuggestions('```json\n["a", "b"]\n```'), ["a", "b"]);
  assertEquals(parseSuggestions('Here you go:\n```\n["a", "b"]\n```'), ["a", "b"]);
  assertEquals(parseSuggestions('Sure! ["a", "b"] — hope that helps'), ["a", "b"]);
  assertEquals(parseSuggestions("- #one\n- #two\n"), ["#one", "#two"]);
  assertEquals(parseSuggestions('1. "first option"\n2. "second option"'), [
    "first option",
    "second option",
  ]);
  // Not JSON despite the brackets: the line-splitting fallback still answers.
  assertEquals(parseSuggestions("[not really json"), ["[not really json"]);
  // Non-string array members are dropped rather than stringified.
  assertEquals(parseSuggestions('["a", 7, null, "b"]'), ["a", "b"]);
});

Deno.test("only POST is answered, and preflight is allowed from the app origin", async () => {
  const { handler } = harness();
  assertEquals((await handler(new Request("https://example.test", { method: "GET" }))).status, 405);

  const preflight = await handler(new Request("https://example.test", { method: "OPTIONS" }));
  assertEquals(preflight.status, 200);
  assertEquals(
    preflight.headers.get("Access-Control-Allow-Origin"),
    "https://fablepeak.com",
  );
});
