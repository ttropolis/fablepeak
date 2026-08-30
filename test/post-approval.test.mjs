// ADR 0006 delivery item 5 — the post-approval workflow, shipped dormant.
//
// CI rebuilds the whole schema with `supabase db reset --local --no-seed`, so
// anything a running database can fail on — the column additions, the widened
// CHECK, the trigger compiling and binding — is covered there. These assertions
// cover what a database will happily accept and nobody would notice: an old
// migration edited in place, a claim RPC that quietly learned the new status, a
// service-execution bypass weakened to `auth.uid() is null`, and a replaced
// trigger body that dropped a rule it was only supposed to extend.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const NAME = "20260830130000_post_approval.sql";
const MIGRATION = "supabase/migrations/" + NAME;
const RECOVERY = "supabase/migrations/20260809110000_delivery_recovery.sql";

test("the new status is widened into a NEW migration, never into the old one", async () => {
  const files = (await readdir(new URL("supabase/migrations/", root))).sort();
  assert.ok(files.includes(NAME), "the migration must be on disk");
  // it depends on is_owner and on the brands trigger the role migration wrote
  assert.ok(files.indexOf(NAME) > files.indexOf("20260830100000_owner_role_enforcement.sql"),
    "approval depends on is_owner, so it must sort after the role migration");

  const migration = await read(MIGRATION);
  assert.match(migration,
    /add constraint posts_status_check\s*\n\s*check \(status in \('draft', 'pending_approval', 'scheduled',\s*\n\s*'publishing', 'published', 'failed'\)\);/,
    "the six-status CHECK belongs in this file");
  assert.match(migration, /drop constraint if exists posts_status_check/);
  assert.match(migration,
    /add column if not exists approval_note text,\s*\n\s*add column if not exists approved_by uuid[\s\S]{0,80}?add column if not exists approved_at timestamptz;/);

  // The two earlier files whose literal text test/scheduling.test.mjs asserts
  // are the reason the constraint is re-created rather than rewritten. If a
  // later hand edits them, this fails before that suite does.
  const recovery = await read(RECOVERY);
  assert.match(recovery,
    /check \(status in \('draft', 'scheduled', 'publishing', 'published', 'failed'\)\)/,
    "20260809110000 must keep the five statuses it shipped with");
  assert.doesNotMatch(recovery, /pending_approval/,
    "an old migration whose text has been edited is not the migration that ran");
});

test("the opt-in flag defaults off and is owner-only to change", async () => {
  const migration = await read(MIGRATION);
  assert.match(migration,
    /alter table public\.brands\s*\n\s*add column if not exists approval_required boolean not null default false;/,
    "off by default is what makes this release dormant");

  // The column rule joins smartlink_public inside the trigger that already
  // guards this table, because RLS is row-level and cannot express it.
  assert.match(migration,
    /create or replace function public\.brands_guard_smartlink_slug\(\)[\s\S]{0,200}?security definer[\s\S]{0,60}?set search_path = ''/);
  assert.match(migration,
    /if tg_op = 'UPDATE'\s*\n\s*and new\.approval_required is distinct from old\.approval_required\s*\n\s*and not v_service\s*\n\s*and not public\.is_owner\(new\.id\) then/,
    "an editor who could flip this could turn their own review requirement off");
  assert.match(migration, /only a workspace owner can change whether posts need approval/);

  // `create or replace function` replaces a whole body, so the rules this
  // migration only meant to extend have to be restated — and still be there.
  assert.match(migration,
    /new\.smartlink_public is distinct from old\.smartlink_public[\s\S]{0,120}?not public\.is_owner\(new\.id\)/,
    "the SmartLinks publication gate must survive the replacement");
  assert.match(migration,
    /set brands\.smartlink_slug through public\.set_smartlink_slug\(\)/,
    "so must the slug rule");
  assert.match(migration,
    /revoke all on function public\.brands_guard_smartlink_slug\(\) from anon, authenticated;/);
});

test("both triggers verify real service execution, never a bare null uid", async () => {
  const migration = await read(MIGRATION);
  // ADR 0006 decision 10's amendment, and the pattern 20260830100000 set: an
  // anonymous PostgREST request also has no auth.uid(), and it is a browser.
  const marker = /v_role text := coalesce\(auth\.role\(\), ''\);\s*\n\s*v_service boolean := v_role = 'service_role'\s*\n\s*or \(v_role = '' and auth\.uid\(\) is null\);/g;
  assert.equal((migration.match(marker) || []).length, 2,
    "the brands trigger and the posts trigger must use the same marker");
  assert.doesNotMatch(migration, /v_service boolean := auth\.uid\(\) is null/,
    "`auth.uid() is null` alone must never be the bypass condition");
  assert.doesNotMatch(migration, /if auth\.uid\(\) is null then\s*\n\s*return new/);
});

test("the posts trigger is a rule about movement, and lets service execution through", async () => {
  const migration = await read(MIGRATION);
  assert.match(migration,
    /create or replace function public\.posts_guard_status_transition\(\)[\s\S]{0,200}?security definer[\s\S]{0,60}?set search_path = ''/);
  assert.match(migration,
    /create trigger posts_guard_status_transition\s*\n\s*before insert or update on public\.posts\s*\n\s*for each row execute function public\.posts_guard_status_transition\(\)/);
  assert.match(migration,
    /revoke all on function public\.posts_guard_status_transition\(\) from anon, authenticated;/);

  const body = migration.slice(
    migration.indexOf("create or replace function public.posts_guard_status_transition"));
  // (a) an unchanged status is not a transition — every ordinary edit and every
  //     echo of a status the publisher already wrote exits here
  const fast = body.indexOf("if tg_op = 'UPDATE' and new.status is not distinct from old.status then");
  assert.ok(fast > 0, "the unchanged-status fast path must exist");
  // (b) the escape hatch, before any rule — ADR 0006 §6: service writes bypass
  //     RLS but NOT triggers, so without this scheduled publishing stops
  const bypass = body.indexOf("if v_service then");
  assert.ok(bypass > fast, "service execution must be cleared before any rule runs");
  // (c) decision 10: a client may never MOVE a post into a delivery state…
  const lock = body.indexOf("if tg_op = 'UPDATE' and new.status in ('publishing', 'published') then");
  assert.ok(lock > bypass, "the publish lock comes after the service bypass");
  //     …and it is written about UPDATE only, so restoring a backup that holds
  //     published history still works
  assert.doesNotMatch(body, /if tg_op = 'INSERT' and new\.status in \('publishing', 'published'\)/);
  // (d) with the flag off, the function returns before an approval rule is read
  const off = body.indexOf("if coalesce(v_required, false) is not true then");
  assert.ok(off > lock, "approval-off must return before any approval rule");
  assert.ok(off < body.indexOf("v_owner := public.is_owner(new.brand_id);"),
    "the role is not even looked up for a brand that has not opted in");
});

test("only an owner escalates, and a rejection carries the note it owes the author", async () => {
  const migration = await read(MIGRATION);
  const body = migration.slice(
    migration.indexOf("create or replace function public.posts_guard_status_transition"));
  // submit / recall: open to editors, and a fresh submission carries no decision
  assert.match(body,
    /if new\.status = 'pending_approval' then\s*\n\s*new\.approval_note := null;\s*\n\s*return new;/);
  // approve or schedule: the one escalation the flag exists to gate
  assert.match(body,
    /if new\.status = 'scheduled' then\s*\n\s*if not v_owner then\s*\n\s*raise exception/);
  assert.match(body, /only a workspace owner can schedule a post here/);
  assert.match(body,
    /if old\.status = 'pending_approval' then\s*\n\s*new\.approval_note := null;[\s\S]{0,120}?new\.approved_by := auth\.uid\(\);\s*\n\s*new\.approved_at := now\(\);/,
    "approval clears the spent note and records who decided");
  // reject: decision 11's single note is the whole feedback channel
  assert.match(body,
    /if new\.status = 'draft' and old\.status = 'pending_approval' and v_owner then\s*\n\s*if new\.approval_note is null or btrim\(new\.approval_note\) = '' then\s*\n\s*raise exception/);
  // an ungated INSERT would retire the feature: delete, re-insert as scheduled
  assert.match(body,
    /if tg_op = 'INSERT' then\s*\n\s*if not v_owner and new\.status not in \('draft', 'pending_approval'\) then/);
});

test("no claim RPC learns the new status, and the publish function is untouched", async () => {
  const migration = await read(MIGRATION);
  // This is the fact ADR 0006 §3 asks to be asserted rather than remembered.
  assert.doesNotMatch(migration,
    /create or replace function public\.(claim_due_posts|claim_post_for_retry|claim_post_for_publish)/,
    "the publish cron needs no change, and that is the point");

  const recovery = await read(RECOVERY);
  // claim_due_posts: an exact match, so pending_approval is unclaimable BY
  // CONSTRUCTION rather than by a negation somebody could later widen
  assert.match(recovery, /where p\.status = 'scheduled'/);
  // claim_post_for_retry: the candidate list must never gain the new status
  assert.match(recovery,
    /and p\.status in \('draft', 'scheduled', 'published', 'failed'\)/);

  const scheduling = await read("supabase/migrations/20260731090000_reliable_scheduling.sql");
  assert.match(scheduling, /and status in \('draft', 'scheduled'\)/,
    "claim_post_for_publish keeps its own two-status list");

  // …and nothing that sorts after this migration may reopen any of it
  const files = (await readdir(new URL("supabase/migrations/", root))).sort();
  for (const file of files.filter(f => f > NAME)) {
    const sql = await read("supabase/migrations/" + file);
    assert.doesNotMatch(sql, /pending_approval[\s\S]{0,400}?claim_/,
      `${file} sorts after ${NAME}: a claim RPC must not learn pending_approval`);
    assert.doesNotMatch(sql, /drop trigger[^;]*posts_guard_status_transition/,
      `${file} must not drop the transition trigger`);
  }

  for (const fn of ["publish/index.ts", "_shared/platforms.ts"]) {
    const source = await read("supabase/functions/" + fn);
    assert.doesNotMatch(source, /pending_approval|approval_required|approval_note/,
      `supabase/functions/${fn} must not know this feature exists`);
  }
});

test("the frontend vocabulary gains the status, and nothing it must not write", async () => {
  const settings = await read("js/settings.js");
  const adapter = await read("js/remote-store.js");

  // Settings → Import backup rejects any status it does not list, so a
  // workspace holding a pending post must be able to restore its own backup.
  assert.match(settings,
    /const POST_STATUSES = \["draft","pending_approval","scheduled","publishing","published","failed"\]/);

  // A column FIELDS.posts does not name is invisible to the app, which is how
  // the note reaches the server and how the attribution stays out of reach.
  assert.match(adapter,
    /posts:\s+\["id","brand_id","date","time","text","networks","status","media_url","variants","approval_note"\]/);
  // approved_by/at are written by the trigger from auth.uid() and now(); the
  // row builder must not learn them, or a client could clear the attribution.
  const rowBuilder = adapter.slice(adapter.indexOf("_dbToRows(data){"),
                                   adapter.indexOf("async load(){"));
  assert.ok(rowBuilder.length > 200, "the row builder should be findable");
  assert.doesNotMatch(rowBuilder, /approved_by|approved_at|approval_required/,
    "no client payload may name a column only the database may write");
  assert.match(adapter, /approval_note: p\.approval_note \|\| ""/, "server row -> app post");
  assert.match(adapter, /approval_note:p\.approval_note \|\| null/, "app post -> server row");
  // the flag is read from the brand row and written only through the owner-gated
  // update — never as part of an ordinary brand save
  assert.match(adapter, /approval_required: !!b\.approval_required/);
  assert.match(adapter,
    /async setApprovalRequired\(brandId, isRequired\)\{[\s\S]{0,200}?update\(\{ approval_required: !!isRequired \}\)/);
  assert.doesNotMatch(adapter,
    /brands: \["id","name","seed","connections","smartlink","approval_required"\]/,
    "a brand save must never carry the owner-gated column");
});
