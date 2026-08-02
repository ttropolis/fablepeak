// Authenticated FablePeak account deletion. Provider credentials connected by
// this user are removed, sole-owner workspaces are deleted, and shared
// workspaces retain continuity by promoting another member before auth removal.
import { getUser, sbDelete, sbSelect, sbUpdate } from "../_shared/db.ts";

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

    const owned = await sbSelect("brand_members",
      `select=brand_id&user_id=eq.${encodeURIComponent(user.id)}&role=eq.owner`);
    const userConnections = await sbSelect("social_connections",
      `select=id,brand_id,platform,is_default&user_id=eq.${encodeURIComponent(user.id)}`);

    await sbDelete("oauth_states", `user_id=eq.${encodeURIComponent(user.id)}`);
    await sbDelete("social_connections", `user_id=eq.${encodeURIComponent(user.id)}`);

    // If one of the removed credentials was selected, select a surviving
    // account for the same workspace/platform so scheduled posts remain sane.
    for (const removed of userConnections.filter((connection) => connection.is_default)) {
      const surviving = await sbSelect("social_connections",
        `select=id&brand_id=eq.${encodeURIComponent(removed.brand_id)}` +
        `&platform=eq.${encodeURIComponent(removed.platform)}` +
        `&status=eq.active&order=connected_at.asc&limit=1`);
      if (surviving[0]) await sbUpdate("social_connections",
        `id=eq.${encodeURIComponent(surviving[0].id)}`, { is_default: true });
    }

    for (const membership of owned) {
      const others = await sbSelect("brand_members",
        `select=user_id,role&brand_id=eq.${encodeURIComponent(membership.brand_id)}` +
        `&user_id=neq.${encodeURIComponent(user.id)}&order=user_id.asc`);
      if (!others.length) {
        await deleteWorkspaceMedia(membership.brand_id, serviceKey);
        await sbDelete("brands", `id=eq.${encodeURIComponent(membership.brand_id)}`);
      } else if (!others.some((member) => member.role === "owner")) {
        await sbUpdate("brand_members",
          `brand_id=eq.${encodeURIComponent(membership.brand_id)}` +
          `&user_id=eq.${encodeURIComponent(others[0].user_id)}`,
          { role: "owner" });
      }
    }

    await sbDelete("brand_members", `user_id=eq.${encodeURIComponent(user.id)}`);

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
  const listed = await fetch(`${env("SUPABASE_URL")}/storage/v1/object/list/social-media`, {
    method: "POST", headers,
    body: JSON.stringify({ prefix: `${brandId}/`, limit: 1000, offset: 0 }),
  });
  if (!listed.ok) throw new Error(`Could not list workspace media (${listed.status}).`);
  const paths = (await listed.json()).map((object: { name: string }) => `${brandId}/${object.name}`);
  if (!paths.length) return;
  const removed = await fetch(`${env("SUPABASE_URL")}/storage/v1/object/social-media`, {
    method: "DELETE", headers, body: JSON.stringify({ prefixes: paths }),
  });
  if (!removed.ok) throw new Error(`Could not delete workspace media (${removed.status}).`);
}
