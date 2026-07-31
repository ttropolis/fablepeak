// Minimal, dependency-free Supabase access for Edge Functions.
//
// Why not @supabase/supabase-js? Functions deployed through the Management API
// are not dependency-bundled, so ANY remote import fails to boot. PostgREST and
// GoTrue are plain HTTP, so we call them directly — no imports, faster cold start.
//
// Everything here uses the service_role key and therefore bypasses RLS.
// Authorisation is enforced explicitly by each caller.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const headers = (extra: Record<string, string> = {}) => ({
  apikey: SRK,
  Authorization: `Bearer ${SRK}`,
  "Content-Type": "application/json",
  ...extra,
});

async function req(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, init);
  const text = await r.text();
  if (!r.ok) throw new Error(`db ${init.method ?? "GET"} ${path}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** SELECT. `query` is a PostgREST query string, e.g. `select=*&id=eq.123`. */
export async function sbSelect(table: string, query: string): Promise<any[]> {
  return (await req(`${table}?${query}`, { headers: headers() })) ?? [];
}

/** SELECT returning one row or null. */
export async function sbOne(table: string, query: string): Promise<any | null> {
  const rows = await sbSelect(table, `${query}&limit=1`);
  return rows[0] ?? null;
}

export async function sbInsert(table: string, row: unknown) {
  return req(table, { method: "POST", headers: headers({ Prefer: "return=minimal" }), body: JSON.stringify(row) });
}

/** UPSERT. `onConflict` must name the unique constraint's columns. */
export async function sbUpsert(table: string, rows: unknown, onConflict: string) {
  return req(`${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: "POST",
    headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
  });
}

/** UPDATE rows matching a PostgREST filter, e.g. `id=eq.123`. */
export async function sbUpdate(table: string, filter: string, patch: unknown) {
  return req(`${table}?${filter}`, {
    method: "PATCH", headers: headers({ Prefer: "return=minimal" }), body: JSON.stringify(patch),
  });
}

export async function sbDelete(table: string, filter: string) {
  return req(`${table}?${filter}`, { method: "DELETE", headers: headers({ Prefer: "return=minimal" }) });
}

/** Call a Postgres RPC through PostgREST using the service role. */
export async function sbRpc(name: string, args: Record<string, unknown> = {}) {
  return req(`rpc/${name}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(args),
  });
}

/** COUNT only — uses PostgREST's exact count header. */
export async function sbCount(table: string, query: string): Promise<number> {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${query}&select=id`, {
    method: "HEAD", headers: headers({ Prefer: "count=exact" }),
  });
  const range = r.headers.get("content-range") ?? "";
  const n = Number(range.split("/")[1]);
  return Number.isFinite(n) ? n : 0;
}

/** Resolve a end-user JWT to their auth user, or null. */
export async function getUser(jwt: string): Promise<{ id: string; email?: string } | null> {
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SRK, Authorization: `Bearer ${jwt}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id ? u : null;
}

/** True when the user is a member of the brand. */
export async function isMember(brandId: string, userId: string): Promise<boolean> {
  const row = await sbOne("brand_members",
    `select=brand_id&brand_id=eq.${encodeURIComponent(brandId)}&user_id=eq.${userId}`);
  return !!row;
}
