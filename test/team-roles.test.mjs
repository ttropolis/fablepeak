// ADR 0006 step 1: owner/editor enforcement.
//
// CI rebuilds the whole schema with `supabase db reset --local --no-seed`, so
// anything a running database can prove — that the backfill statement is valid
// SQL, that the trigger fires, that an editor's DELETE matches no row — is
// covered by that rebuild. These assertions cover what a database will not fail
// on: the *order* of the sections, definer hardening, grants, the absence of a
// predicate, and the service-execution marker chosen for the trigger.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const NAME = "20260830100000_owner_role_enforcement.sql";
const MIGRATION = "supabase/migrations/" + NAME;

test("the ownerless backfill runs before every restrictive predicate", async () => {
  const migration = await read(MIGRATION);
  const backfill = migration.indexOf("update public.brand_members m\n   set role = 'owner'");
  assert.ok(backfill > 0, "the migration must promote a member of every ownerless brand");
  // ADR 0006 §6: brands_delete → is_owner makes an ownerless brand permanently
  // undeletable, so the repair cannot ship in a later file, or even a later
  // section of this one.
  for (const later of [
    "create policy members_insert",
    "create policy members_update",
    "create policy members_delete",
    "create policy brands_delete",
    "create or replace function public.brand_members_keep_an_owner",
    "create or replace function public.set_smartlink_slug",
    "create or replace function public.disconnect_account",
    "create or replace function public.select_social_account",
  ]) {
    const at = migration.indexOf(later);
    assert.ok(at > 0, `${later} must be in this migration`);
    assert.ok(backfill < at, `the backfill must precede "${later}"`);
  }
  // A brand with no members at all is unreachable by any client, so it is left
  // alone rather than given an arbitrary owner.
  assert.match(migration, /not exists \(\s*select 1 from public\.brand_members o\s*where o\.brand_id = m\.brand_id and o\.role = 'owner'\)/);
});

test("is_owner mirrors is_member and is hardened the same way", async () => {
  const schema = await read("supabase/schema.sql");
  const migration = await read(MIGRATION);
  // the predicate it mirrors, so a drift in either is visible here
  assert.match(schema,
    /create or replace function public\.is_member\(b text\) returns boolean\s*\nlanguage sql security definer stable set search_path = public/);
  assert.match(migration,
    /create or replace function public\.is_owner\(b text\) returns boolean\s*\nlanguage sql security definer stable set search_path = public/);
  // definer + stable are load-bearing: the brand_members policies below call it,
  // and an invoker-rights predicate would recurse on its own table
  assert.match(migration, /where brand_id = b and user_id = auth\.uid\(\) and role = 'owner'/);
  assert.match(migration, /revoke all on function public\.is_owner\(text\) from public;/);
  assert.match(migration, /revoke all on function public\.is_owner\(text\) from anon;/);
  assert.match(migration,
    /grant execute on function public\.is_owner\(text\) to authenticated, service_role;/);
  assert.doesNotMatch(migration, /grant execute on function public\.is_owner\([^)]*\) to [^;]*anon/);
});

test("a brand can never be left with members and no owner", async () => {
  const migration = await read(MIGRATION);
  assert.match(migration,
    /create or replace function public\.brand_members_keep_an_owner\(\)[\s\S]{0,200}?security definer[\s\S]{0,80}?set search_path = ''/);
  assert.match(migration,
    /create trigger brand_members_keep_an_owner\s+before update or delete on public\.brand_members\s+for each row execute function public\.brand_members_keep_an_owner\(\)/);
  // a promotion is always safe; only removal and demotion can strand a brand
  assert.match(migration, /if tg_op = 'UPDATE' and \(new\.role = 'owner' or old\.role <> 'owner'\) then/);
  // and deleting the brand itself must stay possible: the cascade deletes these
  // rows one at a time, after the parent row is gone
  assert.match(migration, /if exists \(select 1 from public\.brands b where b\.id = v_brand\) then/);
  assert.match(migration, /raise exception\s*\n\s*'this workspace must keep at least one owner/);
  // no client role may call the trigger function directly
  assert.match(migration,
    /revoke all on function public\.brand_members_keep_an_owner\(\) from anon, authenticated;/);
});

test("member management is owner-gated, with self-removal allowed", async () => {
  const migration = await read(MIGRATION);
  assert.match(migration,
    /create policy members_insert on public\.brand_members for insert to authenticated\s*\n\s*with check \(public\.is_owner\(brand_id\)\);/);
  assert.match(migration,
    /create policy members_update on public\.brand_members for update to authenticated\s*\n\s*using \(public\.is_owner\(brand_id\)\) with check \(public\.is_owner\(brand_id\)\);/);
  assert.match(migration,
    /create policy members_delete on public\.brand_members for delete to authenticated\s*\n\s*using \(public\.is_owner\(brand_id\) or user_id = auth\.uid\(\)\);/);
  // the read policy is what lets the app learn its own role — it must not change
  assert.doesNotMatch(migration, /create policy members_select/);
  // editors compose, schedule, reply and upload: these three stay member-level
  for (const policy of ["brands_select", "brands_insert", "brands_update", "posts_all", "inbox_all"]) {
    assert.doesNotMatch(migration, new RegExp(`create policy ${policy}\\b`),
      `${policy} must stay exactly as it is — editors need it`);
  }
});

test("every owner-gated surface names is_owner, and nothing else changes", async () => {
  const migration = await read(MIGRATION);
  assert.match(migration,
    /create policy brands_delete on public\.brands for delete to authenticated\s*\n\s*using \(public\.is_owner\(id\)\);/);
  // the three definer RPCs
  for (const fn of [
    ["public\\.set_smartlink_slug", "if not public\\.is_owner\\(p_brand_id\\)"],
    ["public\\.disconnect_account", "if not public\\.is_owner\\(b\\)"],
    ["public\\.select_social_account", "if not public\\.is_owner\\(b\\)"],
  ]) {
    const body = migration.slice(
      migration.indexOf(`create or replace function ${fn[0].replace(/\\/g, "")}`));
    assert.match(body, new RegExp(fn[1]), `${fn[0]} must check ownership`);
  }
  // …and none of them silently loses its membership-era hardening
  assert.match(migration,
    /create or replace function public\.set_smartlink_slug\(p_brand_id text, p_slug text\)[\s\S]{0,200}?security definer[\s\S]{0,60}?set search_path = ''/);
  assert.match(migration,
    /grant execute on function public\.set_smartlink_slug\(text, text\) to authenticated;/);
  assert.match(migration, /grant execute on function public\.disconnect_account\(uuid\) to authenticated;/);
  assert.match(migration, /grant execute on function public\.select_social_account\(uuid\) to authenticated;/);
  // is_member must survive for everything an editor still does
  assert.doesNotMatch(migration, /drop function[^;]*is_member/);
});

test("SmartLinks publication is a column rule in the trigger, exempting service execution", async () => {
  const migration = await read(MIGRATION);
  const guard = migration.slice(
    migration.indexOf("create or replace function public.brands_guard_smartlink_slug"),
    migration.indexOf("create or replace function public.set_smartlink_slug"));
  assert.ok(guard.length > 0, "the guard trigger must be re-created here");
  assert.match(guard,
    /new\.smartlink_public is distinct from old\.smartlink_public[\s\S]{0,120}?not public\.is_owner\(new\.id\)/);
  // OLD is unassigned in an INSERT trigger, so the column rule is UPDATE-only
  assert.match(guard, /if tg_op = 'UPDATE'\s*\n\s*and new\.smartlink_public/);
  // Service execution: the strongest signal this schema already uses, which is
  // the same one prepare_account_deletion gates on.
  const deletion = await read("supabase/migrations/20260802150000_account_deletion.sql");
  assert.match(deletion, /if auth\.role\(\) <> 'service_role' then/);
  assert.match(guard, /v_role text := coalesce\(auth\.role\(\), ''\);/);
  assert.match(guard, /v_service boolean := v_role = 'service_role'/);
  // a bare `auth.uid() is null` would also wave through an anon-key request
  assert.match(guard, /or \(v_role = '' and auth\.uid\(\) is null\)/);
  // the slug rule it was already carrying is preserved verbatim
  assert.match(guard, /set brands\.smartlink_slug through public\.set_smartlink_slug\(\)/);
});

test("no later migration re-opens a predicate this one closed", async () => {
  const files = (await readdir(new URL("supabase/migrations/", root))).sort();
  assert.ok(files.includes(NAME), "the migration must be on disk");
  const later = files.filter(f => f > NAME);
  for (const file of later) {
    const sql = await read("supabase/migrations/" + file);
    for (const predicate of [
      /create policy brands_delete/,
      /create policy members_(insert|update|delete)/,
      /create or replace function public\.is_owner/,
    ]) {
      assert.doesNotMatch(sql, predicate,
        `${file} sorts after ${NAME}: if it must touch this, it has to keep is_owner`);
    }
  }
});

test("the Edge Functions gate revocation on ownership and nothing else", async () => {
  const db = await read("supabase/functions/_shared/db.ts");
  const health = await read("supabase/functions/connection-health/index.ts");
  const assist = await read("supabase/functions/ai-assist/index.ts");
  const pkg = JSON.parse(await read("package.json"));

  assert.match(db, /export async function isOwner\(brandId: string, userId: string\)/);
  assert.match(db, /role=eq\.owner/);
  // isMember keeps its own query: an editor loses no member capability
  assert.match(db, /export async function isMember\(brandId: string, userId: string\)/);
  assert.doesNotMatch(db, /export async function isMember[\s\S]{0,300}?role=eq/);

  assert.match(health, /if \(action === "revoke"\)[\s\S]{0,200}?dependencies\.isOwner\(brand_id, user\.id\)/);
  assert.match(health, /Only workspace owners can disconnect an account/);
  // verification stays member-level, and so does the whole of ai-assist
  assert.match(health, /dependencies\.isMember\(brand_id, user\.id\)/);
  assert.doesNotMatch(assist, /isOwner/);

  assert.match(pkg.scripts["test:functions"], /connection-health\/index\.deno\.ts/);
  assert.match(pkg.scripts["test:functions"], /_shared\/db\.deno\.ts/);
});

test("the app learns its own role from its own membership row", async () => {
  const adapter = await read("js/remote-store.js");
  const local = await read("js/local-store.js");
  const workspace = await read("js/workspace.js");

  // one primary-key read through the existing members_select policy — no new
  // backend surface, and scoped to the caller's own row
  assert.match(adapter,
    /async myRole\(brandId\)\{[\s\S]{0,300}?from\("brand_members"\)[\s\S]{0,200}?\.eq\("user_id", this\.user\.id\)/);
  assert.match(local, /async myRole\(\)\{ return "owner"; \}/);
  assert.match(workspace, /export function isOwner\(\)/);
  // an unknown role is not "editor": the affordance defaults open, the database
  // does the refusing
  assert.match(workspace, /return role === null \|\| role === "owner";/);
});

test("owner-only controls are gated in all three views", async () => {
  const settings = await read("js/settings.js");
  const connections = await read("js/connections.js");
  const smartlinks = await read("js/smartlinks.js");
  const constants = await read("js/constants.js");

  assert.match(constants, /export const OWNER_ONLY_TITLE = "Only workspace owners can change this\.";/);
  // brand deletion: disabled, and it says why
  assert.match(settings, /data-action="deleteBrand"/);
  assert.match(settings, /db\.brands\.length<2\|\|!owner\?"disabled":""/);
  // disconnect / re-select: hidden for an editor, connect is untouched
  assert.match(connections, /\$\{owner\s*\n?\s*\? `<button class="btn ghost mini" data-action="disconnectReal"/);
  assert.match(connections, /a\.status==="active" && owner/);
  assert.match(connections, /data-action="connectReal"/);
  // publication: both halves of the decision disabled together
  assert.match(smartlinks, /const ownerOnly=owner \? "" : ` disabled title="\$\{attr\(OWNER_ONLY_TITLE\)\}"`;/);
  assert.match(smartlinks, /id="sl_slug"[\s\S]{0,200}?\$\{ownerOnly\}/);
  assert.match(smartlinks, /id="sl_public"[\s\S]{0,120}?\$\{ownerOnly\}/);
  assert.match(smartlinks, /data-action="slClaim"\$\{ownerOnly\}/);
});
