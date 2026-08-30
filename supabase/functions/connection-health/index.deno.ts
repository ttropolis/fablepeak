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
