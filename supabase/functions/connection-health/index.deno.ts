// ADR 0006 decision 6: revoking a provider authorization is the provider half
// of Disconnect, so it is owner-gated here exactly as disconnect_account is in
// the database. Verification stays member-accessible — the Connections view
// calls it on every visit, and an editor must still see whether the workspace's
// accounts are healthy.
import { createHandler } from "./index.ts";

const assertEquals = (actual: unknown, expected: unknown, message = "values differ") => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

type Roles = { member?: boolean; owner?: boolean; rows?: unknown[] };

/** The handler with every backend replaced. `roles` decides what the two
 *  membership lookups answer; everything else records what was attempted. */
function harness(roles: Roles = {}, overrides: Record<string, unknown> = {}) {
  const { member = true, owner = true, rows = [] } = roles;
  const revoked: string[][] = [];
  const selected: string[] = [];
  const updated: string[] = [];
  const asked: string[] = [];
  const handler = createHandler({
    env: () => undefined,
    getUser: async () => ({ id: "user-1", email: "editor@example.test" }),
    isMember: async (brandId: string) => { asked.push("member:" + brandId); return member; },
    isOwner: async (brandId: string) => { asked.push("owner:" + brandId); return owner; },
    sbSelect: async (_table: string, query: string) => { selected.push(query); return [...rows]; },
    sbUpdate: async (_table: string, filter: string) => { updated.push(filter); return null; },
    revokeUserAuthorizations: async (connections: any[]) => {
      revoked.push(connections.map(c => String(c.id)));
      return [];
    },
    freshConnectionToken: async () => "token",
    ...overrides,
  });
  return { handler, revoked, selected, updated, asked };
}

/* ---------------------------------------------- ADR 0005 decision 5: probe */

const PAGE_TOKEN = "page-token-SECRET";
const FB_ROWS = [{ id: "conn-1", platform: "facebook", external_id: "1291889143999378" }];
const PROBE = {
  brand_id: "brand-1",
  account_id: "conn-1",
  action: "probe_fb_comment",
  post_remote_id: "1291889143999378_122111105709416585",
};

type Call = { url: string; method: string; body: string };

/** A harness whose `fetch` answers from a queue of responses and records every
 *  request, so a test can read exactly what the probe sent. */
function probeHarness(responses: Response[], roles: Roles = { owner: true, rows: FB_ROWS }) {
  const calls: Call[] = [];
  const queue = [...responses];
  const base = harness(roles, {
    freshConnectionToken: async () => PAGE_TOKEN,
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: String(init?.method ?? "GET"),
        body: init?.body ? String(init.body) : "",
      });
      const next = queue.shift();
      if (!next) throw new Error("no stubbed response left");
      return next;
    },
  });
  return { ...base, calls };
}

const graphOk = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const graphFail = (status: number, error: unknown) =>
  new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });

/** Runs the handler with the console captured, so a test can assert that a
 *  credential reached neither the response nor a log line. */
async function withCapturedConsole<T>(run: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const original = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  const lines: string[] = [];
  const record = (...args: unknown[]) => { lines.push(args.map(a => String(a)).join(" ")); };
  console.log = console.warn = console.error = console.debug = record;
  try {
    return { result: await run(), logged: lines.join("\n") };
  } finally {
    Object.assign(console, original);
  }
}

Deno.test("an editor cannot run the comment capability probe", async () => {
  const { handler, selected, asked, calls } = probeHarness([], { member: true, owner: false });
  const response = await handler(post(PROBE));

  assertEquals(response.status, 403);
  assertEquals(await response.json(),
    { error: "Only workspace owners can run the comment capability probe" });
  // Refused before the credential-bearing row is read and before any provider
  // call: a non-owner can never cause a public comment.
  assertEquals(selected, []);
  assertEquals(calls, []);
  assertEquals(asked, ["member:brand-1", "owner:brand-1"]);
});

Deno.test("the probe refuses a post id that is not <page-id>_<post-id>", async () => {
  for (const post_remote_id of ["", "12345", "me_123", "1_2_3", "abc_def", null]) {
    const { handler, calls } = probeHarness([]);
    const response = await handler(post({ ...PROBE, post_remote_id }));
    assertEquals(response.status, 400, `accepted ${JSON.stringify(post_remote_id)}`);
    assertEquals(await response.json(), { error: "post_remote_id must look like <page-id>_<post-id>" });
    assertEquals(calls, []);
  }

  const missingAccount = probeHarness([]);
  const refused = await missingAccount.handler(post({ ...PROBE, account_id: undefined }));
  assertEquals(refused.status, 400);
  assertEquals(await refused.json(), { error: "account_id is required to probe" });

  // A valid shape is accepted, so the guard is a filter and not a wall.
  const { handler, calls } = probeHarness([graphOk({ id: "c-1" }), graphOk({ success: true })]);
  assertEquals((await handler(post(PROBE))).status, 200);
  assertEquals(calls.length, 2);
});

Deno.test("a successful probe comments on exactly the named post and cleans up", async () => {
  const { handler, calls, selected } = probeHarness([
    graphOk({ id: "1291889143999378_9001" }),
    graphOk({ success: true }),
  ]);
  const response = await handler(post(PROBE));

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    ok: true,
    probe: "created",
    comment_created: true,
    comment_deleted: true,
    comment_id: "1291889143999378_9001",
    error_code: null,
    error_subcode: null,
    error_message: null,
    permission_hint: "held permissions suffice",
  });

  // Exactly the owner-named post, and nothing else.
  assertEquals(selected, ["select=*&brand_id=eq.brand-1&id=eq.conn-1"]);
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].url,
    "https://graph.facebook.com/v25.0/1291889143999378_122111105709416585/comments");
  assertEquals(new URLSearchParams(calls[0].body).get("message"),
    "FablePeak capability probe — will be removed.");
  assertEquals(calls[1].method, "DELETE");
  assertEquals(calls[1].url.startsWith(
    "https://graph.facebook.com/v25.0/1291889143999378_9001?access_token="), true);
});

Deno.test("Graph #200 is reported as a denial that names the missing permission", async () => {
  const { handler, calls } = probeHarness([graphFail(403, {
    message: "(#200) Requires pages_manage_engagement permission",
    type: "OAuthException",
    code: 200,
    error_subcode: 33,
  })]);
  const response = await handler(post(PROBE));

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    ok: false,
    probe: "denied",
    comment_created: false,
    comment_deleted: false,
    comment_id: null,
    error_code: 200,
    error_subcode: 33,
    error_message: "(#200) Requires pages_manage_engagement permission",
    permission_hint: "pages_manage_engagement required",
  });
  // A denial creates nothing, so there is nothing to delete.
  assertEquals(calls.length, 1);
});

Deno.test("an unrecognised provider failure says unknown rather than guessing", async () => {
  const cases: Array<[unknown, string, string]> = [
    [{ message: "Unsupported post request.", type: "GraphMethodException", code: 100, error_subcode: 33 },
      "error", "unknown"],
    // An expired credential answers nothing about the permission question.
    [{ message: "Error validating access token: Session has expired.", type: "OAuthException", code: 190 },
      "error", "unknown"],
    // A refusal we cannot attribute to a named scope is still a refusal.
    [{ message: "You do not have permission to perform this action.", type: "OAuthException", code: 3 },
      "denied", "unknown"],
    [{ message: "Application does not have permission for this action", type: "OAuthException", code: 10 },
      "denied", "pages_manage_engagement required"],
  ];
  for (const [error, probe, hint] of cases) {
    const { handler } = probeHarness([graphFail(400, error)]);
    const body = await (await handler(post(PROBE))).json();
    assertEquals([body.probe, body.permission_hint], [probe, hint],
      `misclassified ${JSON.stringify(error)}`);
    assertEquals(body.ok, false);
    assertEquals(body.comment_created, false);
  }

  // A transport failure is an error, never a capability answer.
  const offline = harness({ owner: true, rows: FB_ROWS }, {
    freshConnectionToken: async () => PAGE_TOKEN,
    fetch: async () => { throw new Error("connection reset"); },
  });
  const body = await (await offline.handler(post(PROBE))).json();
  assertEquals([body.probe, body.permission_hint, body.comment_created],
    ["error", "unknown", false]);
});

Deno.test("a failed cleanup is reported without masking the probe's success", async () => {
  const { handler } = probeHarness([
    graphOk({ id: "c-1" }),
    graphFail(400, { message: "Object does not exist", type: "GraphMethodException", code: 100 }),
  ]);
  const body = await (await handler(post(PROBE))).json();

  // The capability question is answered yes; the leftover comment is surfaced
  // with the id the owner needs to remove it by hand.
  assertEquals(body.ok, true);
  assertEquals(body.probe, "created");
  assertEquals(body.comment_created, true);
  assertEquals(body.comment_deleted, false);
  assertEquals(body.comment_id, "c-1");
  assertEquals(body.permission_hint, "held permissions suffice");
  assertEquals(body.cleanup_error, "Object does not exist");

  // A delete that never returns is treated the same way.
  const lost = probeHarness([graphOk({ id: "c-2" })]);
  const thrown = await (await lost.handler(post(PROBE))).json();
  assertEquals([thrown.ok, thrown.comment_created, thrown.comment_deleted], [true, true, false]);
  assertEquals(typeof thrown.cleanup_error, "string");
});

Deno.test("the probe never returns or logs the Page token", async () => {
  const echo = { message: `Invalid token ${PAGE_TOKEN} for this Page`, type: "OAuthException", code: 190 };
  const responses = [
    [graphOk({ id: "c-1" }), graphOk({ success: true })],
    [graphFail(403, { message: "(#200) permission", type: "OAuthException", code: 200 })],
    // Even if Graph were ever to echo the credential back, it stops here.
    [graphFail(400, echo)],
  ];
  for (const queue of responses) {
    const { handler } = probeHarness(queue);
    const { result, logged } = await withCapturedConsole(async () => await (await handler(post(PROBE))).text());
    assertEquals(result.includes(PAGE_TOKEN), false, `token in response: ${result}`);
    assertEquals(logged.includes(PAGE_TOKEN), false, "token in a log line");
  }
});

Deno.test("the probe refuses a connection that is not a Facebook Page", async () => {
  const { handler, calls } = probeHarness([], {
    owner: true, rows: [{ id: "conn-1", platform: "instagram", external_id: "ig-1" }],
  });
  const body = await (await handler(post(PROBE))).json();
  assertEquals(body.ok, false);
  assertEquals(body.probe, "error");
  assertEquals(body.permission_hint, "unknown");
  assertEquals(calls, []);

  // And a connection id that belongs to no row in this workspace.
  const missing = probeHarness([], { owner: true, rows: [] });
  const absent = await (await missing.handler(post(PROBE))).json();
  assertEquals(absent.ok, false);
  assertEquals(absent.error_message, "That connection is not in this workspace.");
  assertEquals(missing.calls, []);
});

const post = (body: unknown, headers: Record<string, string> = { Authorization: "Bearer jwt" }) =>
  new Request("https://example.test", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const revoke = { brand_id: "brand-1", account_id: "conn-1", action: "revoke" };

Deno.test("an editor cannot revoke a provider authorization", async () => {
  const { handler, revoked, selected, asked } = harness({ member: true, owner: false });
  const response = await handler(post(revoke));

  assertEquals(response.status, 403);
  assertEquals(await response.json(),
    { error: "Only workspace owners can disconnect an account" });
  // Nothing was read and no provider was called: the refusal happens before the
  // connection row (which carries the credentials) is fetched at all.
  assertEquals(selected, []);
  assertEquals(revoked, []);
  assertEquals(asked, ["member:brand-1", "owner:brand-1"]);
});

Deno.test("an owner revokes exactly the named connection", async () => {
  const { handler, revoked, selected } = harness({
    owner: true,
    rows: [{ id: "conn-1", platform: "instagram", external_id: "ig-1" }],
  });
  const response = await handler(post(revoke));

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { results: [] });
  assertEquals(revoked, [["conn-1"]]);
  // one account, not the whole workspace
  assertEquals(selected, ["select=*&brand_id=eq.brand-1&id=eq.conn-1"]);
});

Deno.test("a revoke without an account id is refused, but only after ownership", async () => {
  const { handler, revoked, asked } = harness({ owner: true });
  const response = await handler(post({ brand_id: "brand-1", action: "revoke" }));

  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: "account_id is required to revoke" });
  assertEquals(revoked, []);

  // A non-owner making the same malformed call learns nothing about it.
  const editor = harness({ owner: false });
  const refused = await editor.handler(post({ brand_id: "brand-1", action: "revoke" }));
  assertEquals(refused.status, 403);
  assertEquals(asked, ["member:brand-1", "owner:brand-1"]);
});

Deno.test("verification stays open to every member of the brand", async () => {
  const { handler, asked, selected } = harness({ member: true, owner: false });
  const response = await handler(post({ brand_id: "brand-1" }));

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { results: [] });
  // Ownership is never consulted on the verify path.
  assertEquals(asked, ["member:brand-1"]);
  assertEquals(selected, ["select=*&brand_id=eq.brand-1"]);
});

Deno.test("a caller outside the brand is refused before either branch", async () => {
  const { handler, asked, revoked } = harness({ member: false, owner: true });

  const verifying = await handler(post({ brand_id: "brand-1" }));
  assertEquals(verifying.status, 403);
  assertEquals(await verifying.json(), { error: "You don't have access to that brand" });

  const revoking = await handler(post(revoke));
  assertEquals(revoking.status, 403);
  assertEquals(revoked, []);
  assertEquals(asked, ["member:brand-1", "member:brand-1"]);
});

Deno.test("an anonymous or invalid session never reaches a membership lookup", async () => {
  const { handler, asked } = harness();
  const anonymous = await handler(post(revoke, {}));
  assertEquals(anonymous.status, 401);
  assertEquals(await anonymous.json(), { error: "Not signed in" });

  const invalid = harness({}, { getUser: async () => null });
  assertEquals((await invalid.handler(post(revoke))).status, 401);
  assertEquals(asked, []);
});

Deno.test("the probe refuses a post that is not on the connection's own Page", async () => {
  const { handler, calls } = probeHarness([], {
    owner: true,
    rows: [{ id: "conn-1", platform: "facebook", external_id: "999888777666555" }],
  });
  const response = await handler(post(PROBE));

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.probe, "error");
  assertEquals(body.error_message, "The probe post must belong to this connection's own Page.");
  // No provider call: an owner cannot point their Page token at an arbitrary
  // public post through FablePeak's infrastructure.
  assertEquals(calls, []);
});
