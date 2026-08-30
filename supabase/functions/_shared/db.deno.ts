// ADR 0006 decision 6: isOwner is the Edge-Function mirror of public.is_owner.
// Everything in db.ts runs with the service role and therefore bypasses RLS, so
// the *query* is the authorization — which makes the exact filter set worth
// asserting rather than assuming.
//
// db.ts reads its configuration at module scope, so the environment is set
// before the module is imported.
Deno.env.set("SUPABASE_URL", "https://db.example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");
const { isMember, isOwner } = await import("./db.ts");

const assertEquals = (actual: unknown, expected: unknown, message = "values differ") => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

/** Capture the PostgREST requests one call makes, and answer with `rows`. */
async function record(rows: unknown[], run: () => Promise<boolean>) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input: any, init: any) => {
    seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify(rows), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  try {
    return { answer: await run(), seen };
  } finally {
    globalThis.fetch = real;
  }
}

Deno.test("isOwner asks for the caller's own row and requires role = owner", async () => {
  const { answer, seen } = await record(
    [{ role: "owner" }], () => isOwner("brand-1", "user-1"));

  assertEquals(answer, true);
  assertEquals(seen.length, 1);
  assertEquals(
    seen[0].url,
    "https://db.example.test/rest/v1/brand_members" +
      "?select=role&brand_id=eq.brand-1&user_id=eq.user-1&role=eq.owner&limit=1",
  );
  // service role, never the caller's JWT: the filter is the authorization
  assertEquals(seen[0].headers.Authorization, "Bearer service-key");
});

Deno.test("isOwner is false when the row exists but is not an owner", async () => {
  // PostgREST answers the role=eq.owner filter with no rows for an editor.
  const { answer } = await record([], () => isOwner("brand-1", "user-2"));
  assertEquals(answer, false);
});

Deno.test("isMember stays role-blind, so an editor keeps every member capability", async () => {
  const { answer, seen } = await record(
    [{ brand_id: "brand-1" }], () => isMember("brand-1", "user-2"));

  assertEquals(answer, true);
  assert(!seen[0].url.includes("role="), "isMember must not filter on role");
  assertEquals(
    seen[0].url,
    "https://db.example.test/rest/v1/brand_members" +
      "?select=brand_id&brand_id=eq.brand-1&user_id=eq.user-2&limit=1",
  );
});

Deno.test("a brand id is escaped into the filter, never interpolated raw", async () => {
  const { seen } = await record([], () => isOwner("brand/1&role=eq.owner", "user-1"));
  assert(
    seen[0].url.includes("brand_id=eq.brand%2F1%26role%3Deq.owner"),
    "the brand id must be percent-encoded: " + seen[0].url,
  );
});
