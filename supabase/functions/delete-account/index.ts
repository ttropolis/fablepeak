// Authenticated FablePeak account deletion. Provider credentials connected by
// this user are removed, sole-owner workspaces are deleted, and shared
// workspaces retain continuity by promoting another member before auth removal.
import { getUser, sbDelete, sbRpc } from "../_shared/db.ts";

const env = (key: string) => Deno.env.get(key);
const CORS = {
  "Access-Control-Allow-Origin": env("APP_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, "Content-Type": "application/json" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const jwt = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!jwt) return json({ error: "Not signed in" }, 401);
    const user = await getUser(jwt);
    if (!user) return json({ error: "Invalid session" }, 401);
    const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY")!;
    const body = await req.json().catch(() => ({}));
    if (body.confirm !== "DELETE") return json({ error: "Confirmation is required" }, 400);
    if (!user.email || typeof body.password !== "string" || !body.password) {
      return json({ error: "Password confirmation is required" }, 400);
    }
    const reauthenticated = await fetch(
      `${env("SUPABASE_URL")}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: serviceKey, "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: body.password }),
      });
    if (!reauthenticated.ok) return json({ error: "Password confirmation failed" }, 401);

    // This RPC performs credential removal, ownership transfer and membership
    // cleanup in one transaction. Its job row makes Storage cleanup resumable.
    const brandIds = await sbRpc("prepare_account_deletion", { target_user: user.id }) as string[];
    for (const brandId of brandIds) await deleteWorkspaceMedia(brandId, serviceKey);
    await sbDelete("account_deletion_jobs", `user_id=eq.${encodeURIComponent(user.id)}`);

    const deleted = await fetch(`${env("SUPABASE_URL")}/auth/v1/admin/users/${user.id}`, {
      method: "DELETE",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (!deleted.ok) throw new Error(`Could not remove authentication record (${deleted.status}).`);

    return json({ deleted: true });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

async function deleteWorkspaceMedia(brandId: string, serviceKey: string) {
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
  const paths: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const listed = await fetch(`${env("SUPABASE_URL")}/storage/v1/object/list/social-media`, {
      method: "POST", headers,
      body: JSON.stringify({ prefix: `${brandId}/`, limit: 1000, offset }),
    });
    if (!listed.ok) throw new Error(`Could not list workspace media (${listed.status}).`);
    const batch = (await listed.json()).map(
      (object: { name: string }) => `${brandId}/${object.name}`);
    paths.push(...batch);
    if (batch.length < 1000) break;
  }
  for (let start = 0; start < paths.length; start += 1000) {
    const removed = await fetch(`${env("SUPABASE_URL")}/storage/v1/object/social-media`, {
      method: "DELETE", headers,
      body: JSON.stringify({ prefixes: paths.slice(start, start + 1000) }),
    });
    if (!removed.ok) throw new Error(`Could not delete workspace media (${removed.status}).`);
  }
}
