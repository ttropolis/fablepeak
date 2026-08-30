// ADR 0005 publishing depth — hashtag groups (named, reusable tag sets).
//
// CI rebuilds the whole schema with `supabase db reset --local --no-seed`, so
// anything a running database can fail on — the table creating, the CHECK
// compiling and binding, the policy binding to is_member — is covered there.
// These assertions cover what a database will happily accept and nobody would
// notice: an old migration edited in place, an Edge Function or a claim RPC
// quietly learning about a client-only feature, a sync whitelist that silently
// drops a field, and an import path that trusts a file the CHECK would refuse.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const NAME = "20260831130000_hashtag_groups.sql";
const MIGRATION = "supabase/migrations/" + NAME;

test("the table is created in a NEW migration, and never in an old one", async () => {
  const files = (await readdir(new URL("supabase/migrations/", root))).sort();
  assert.ok(files.includes(NAME), "the migration must be on disk");
  assert.ok(files.indexOf(NAME) > files.indexOf("20260831120000_instagram_options.sql"),
    "forward-only: this is the newest migration, so it sorts last");

  const migration = await read(MIGRATION);
  assert.match(migration, /create table if not exists public\.hashtag_groups \(/);

  // The sibling synced tables' exact column conventions: a browser-generated
  // text primary key, a cascading brand_id, the realtime echo filter, and the
  // timestamp every one of them carries.
  assert.match(migration, /^\s+id text primary key,$/m);
  assert.match(migration,
    /brand_id text not null references public\.brands\(id\) on delete cascade/,
    "deleting a brand takes its groups with it — there is no orphan path to police");
  assert.match(migration, /^\s+client_id text,$/m,
    "client_id is what js/remote-store.js filters its own realtime echo on");
  assert.match(migration, /updated_at timestamptz not null default now\(\)/);

  // No earlier migration may be edited to say any of this.
  for (const file of files.filter(f => f < NAME)) {
    assert.doesNotMatch(await read("supabase/migrations/" + file), /hashtag_groups/,
      `${file} predates hashtag groups: a migration whose text has been edited is not the one that ran`);
  }
});

test("the name and the tag array are validated by CHECKs, at the limits the app states", async () => {
  const migration = await read(MIGRATION);

  // A name of 1..60 characters, inline on the column.
  assert.match(migration,
    /name text not null check \(char_length\(name\) >= 1 and char_length\(name\) <= 60\)/);

  /* The same seam posts.variants established and posts.media_urls reused: the
     browser upserts hashtag_groups directly under the policy below, and RLS
     answers "whose group is this?", not "is this array well-formed?". A CHECK
     is declarative, is shown by \d, and cannot be turned off by a
     session_replication_role that disables triggers. It delegates to an
     IMMUTABLE function because a CHECK expression may not contain a subquery
     and the predicate has to iterate the array. */
  assert.match(migration,
    /create or replace function public\.valid_hashtag_group_tags\(v jsonb\)/);
  assert.match(migration, /immutable/, "a CHECK constraint may only call an IMMUTABLE function");
  assert.match(migration, /set search_path = public/);
  assert.match(migration,
    /add constraint hashtag_groups_tags_valid\s+check \(public\.valid_hashtag_group_tags\(tags\)\)/);
  assert.match(migration, /drop constraint if exists hashtag_groups_tags_valid/,
    "re-creating the constraint is what makes the migration re-runnable");
  assert.ok(
    migration.indexOf("create or replace function public.valid_hashtag_group_tags") <
      migration.indexOf("add constraint hashtag_groups_tags_valid"),
    "the function has to exist before the constraint that calls it binds");
  assert.doesNotMatch(migration, /create trigger|returns trigger/,
    "a CHECK needs no trigger, so this migration must not grow one");

  // An *array*, because a group is an ordered list the customer arranged and
  // the order is what gets appended to the post.
  assert.match(migration, /jsonb_typeof\(v\) = 'array'/);
  assert.match(migration, /v is not null/, "there is no such thing as a group with null tags");
  assert.match(migration, /jsonb_array_length\(v\) >= 1/,
    "a group with no tags is not a group");
  assert.match(migration, /jsonb_array_length\(v\) <= 30/);
  // Every entry is a #-prefixed string of 2..100 characters, with no whitespace
  // (which would silently split one tag into two) and no control characters.
  assert.match(migration, /jsonb_typeof\(item\.value\) <> 'string'/);
  assert.match(migration, /left\(item\.value #>> '\{\}', 1\) <> '#'/);
  assert.match(migration, /char_length\(item\.value #>> '\{\}'\) < 2/);
  assert.match(migration, /char_length\(item\.value #>> '\{\}'\) > 100/);
  assert.match(migration, /item\.value #>> '\{\}' ~ '\[\[:space:\]\]'/);
  assert.match(migration, /item\.value #>> '\{\}' ~ '\[\[:cntrl:\]\]'/);
});

test("RLS is on, is_member gates every operation, and the grants match the siblings", async () => {
  const migration = await read(MIGRATION);
  assert.match(migration, /alter table public\.hashtag_groups enable row level security/);

  /* Composing is everyday editor work and a hashtag group is composing
     equipment, so this is is_member — the `inbox_all` / `posts_all` shape —
     rather than the is_owner ADR 0006 reserves for destructive and
     account-shaped acts. */
  assert.match(migration,
    /create policy hashtag_groups_all on public\.hashtag_groups for all to authenticated\s*\n\s*using \(public\.is_member\(brand_id\)\) with check \(public\.is_member\(brand_id\)\)/);
  assert.match(migration, /drop policy if exists hashtag_groups_all/,
    "re-creating the policy is what makes the migration re-runnable");
  assert.doesNotMatch(migration, /public\.is_owner\(/,
    "an editor who may write the post may keep the tag set they write it with");

  // Supabase hands anon and authenticated everything on a new public table, so
  // the grant is stated in full rather than trimmed.
  assert.match(migration, /revoke all on public\.hashtag_groups from anon;/);
  assert.match(migration, /revoke all on public\.hashtag_groups from authenticated;/);
  assert.match(migration,
    /grant select, insert, update, delete on public\.hashtag_groups to authenticated;/,
    "DELETE is granted: a group is composing equipment, not an audit trail");
  assert.match(migration, /grant all on public\.hashtag_groups to service_role;/);
  assert.match(migration, /create index if not exists hashtag_groups_brand_idx/);

  // The realtime feed js/remote-store.js subscribes to is schema-wide, but
  // Supabase only emits for tables in this publication.
  assert.match(migration,
    /alter publication supabase_realtime add table public\.hashtag_groups;/);
  assert.match(migration, /exception when duplicate_object then null/,
    "the publication add is the idempotent form every sibling table uses");
});

test("no Edge Function, claim RPC or status trigger learns about hashtag groups", async () => {
  const migration = await read(MIGRATION);
  /* Hashtags reach a provider as ordinary post text: by the time a post is
     saved its tags are indistinguishable from anything else the customer typed.
     So this is a client + database feature, and nothing in the publish path
     changes. */
  assert.doesNotMatch(migration,
    /create or replace function public\.(claim_due_posts|claim_post_for_retry|claim_post_for_publish)/);
  assert.doesNotMatch(migration, /posts_guard_status_transition|posts_status_check/);
  assert.doesNotMatch(migration, /alter table public\.posts/,
    "a group is not a post column");

  const files = (await readdir(new URL("supabase/functions/", root), { withFileTypes: true }));
  for (const entry of files.filter(f => f.isDirectory())) {
    const dir = await readdir(new URL(`supabase/functions/${entry.name}/`, root));
    for (const file of dir.filter(f => f.endsWith(".ts"))) {
      assert.doesNotMatch(await read(`supabase/functions/${entry.name}/${file}`),
        /hashtag_groups/,
        `${entry.name}/${file}: hashtags reach posts as plain text, so no function reads this table`);
    }
  }

  const later = (await readdir(new URL("supabase/migrations/", root))).sort()
    .filter(f => f > NAME);
  for (const file of later) {
    const sql = await read("supabase/migrations/" + file);
    assert.doesNotMatch(sql,
      /drop constraint if exists hashtag_groups_tags_valid(?![\s\S]{0,400}?add constraint hashtag_groups_tags_valid)/,
      `${file} sorts after ${NAME}: the constraint must not be dropped and left off`);
    assert.doesNotMatch(sql, /drop policy if exists hashtag_groups_all(?![\s\S]{0,400}?create policy hashtag_groups_all)/,
      `${file} sorts after ${NAME}: the policy must not be dropped and left off`);
  }
});

test("hashtag_groups joins the synced tables the way inbox_threads does", async () => {
  const adapter = await read("js/remote-store.js");

  /* An exact list on purpose: a field added to a whitelist is a deliberate
     widening of what the browser may write, and it should have to be stated
     here as well as there. This is the first *table* added to the sync since
     the baseline, so all four points — read, write, snapshot, diff — are pinned
     against the shape inbox_threads already has. */
  assert.match(adapter,
    /hashtagGroups: \["id","brand_id","name","tags"\]/,
    "FIELDS.hashtagGroups decides what is diffed and upserted");

  // load(): read in the same Promise.all, with its error checked like the rest.
  assert.match(adapter, /this\._sb\.from\("hashtag_groups"\)\.select\("\*"\)/);
  assert.match(adapter, /\|\|groupsResult\.error/,
    "a failed read must fall through to the offline cache, not be silently dropped");
  // …and into the diff baseline, so the next persist() does not re-upsert
  // everything it just read.
  assert.match(adapter, /hashtagGroups:groupsResult\.data/);
  assert.match(adapter, /this\._snap = \{ brands:cur\.brands, posts:cur\.posts, inbox:cur\.inbox,\s*\n?\s*hashtagGroups:cur\.hashtagGroups \}/);

  // server rows -> app brand, and app brand -> server rows.
  assert.match(adapter,
    /hashtag_groups: hashtagGroups\.filter\(g => g\.brand_id===b\.id\)/,
    "server row -> app brand");
  assert.match(adapter,
    /for\(const g of b\.hashtag_groups\|\|\[\]\) hashtagGroups\.push\(\{ id:g\.id, brand_id:b\.id,/,
    "app brand -> server row, guarded because a brand created before this feature has none");
  assert.match(adapter, /return \{ brands, posts, inbox, hashtagGroups \};/);

  // persist(): upsert the changed rows and delete the removed ones, exactly as
  // posts and inbox threads are.
  assert.match(adapter, /this\._sb\.from\("hashtag_groups"\)\.upsert\(cg\)/);
  assert.match(adapter, /this\._sb\.from\("hashtag_groups"\)\.delete\(\)\.in\("id", gg\)/);

  // Leaving a workspace must drop its groups from the baseline too, or the next
  // save would ask the server to delete rows that are no longer ours.
  assert.match(adapter,
    /hashtagGroups: \(this\._snap\.hashtagGroups \|\| \[\]\)\.filter\(g => g\.brand_id !== brandId\)/);
});

test("the composer and Settings share one set of limits with the CHECK", async () => {
  const vocabulary = await read("js/hashtags.js");
  const composer = await read("js/planner.js");
  const settings = await read("js/settings.js");

  // The numbers the migration states, stated once on this side too.
  assert.match(vocabulary, /export const GROUP_NAME_MAX = 60;/);
  assert.match(vocabulary, /export const GROUP_TAGS_MIN = 1;/);
  assert.match(vocabulary, /export const GROUP_TAGS_MAX = 30;/);
  assert.match(vocabulary, /export const TAG_MIN = 2;/);
  assert.match(vocabulary, /export const TAG_MAX = 100;/);
  assert.match(vocabulary, /const TAG_CONTROL = \/\[\\u0000-\\u001F\\u007F\]\/;/);

  // Both call sites read the limits from the one module rather than restating
  // them, which is what stops the two copies from drifting.
  assert.match(composer, /from "\.\/hashtags\.js"/);
  assert.match(settings, /from "\.\/hashtags\.js"/);
  assert.doesNotMatch(composer, /GROUP_TAGS_MAX|TAG_MAX/,
    "the composer inserts groups; it does not re-derive what a valid one is");

  // An imported backup is as untrusted as any other input, and the database is
  // the last line rather than the first.
  assert.match(settings,
    /b\.hashtag_groups===undefined \|\| validBackupHashtagGroups\(b\.hashtag_groups\)/);
  assert.match(settings, /Array\.isArray\(v\) && v\.every\(validHashtagGroup\)/);

  // Every rendered string goes through esc(), and every id through attr().
  assert.match(composer, /data-action="insertHashtagGroup" data-arg="\$\{attr\(g\.id\)\}"/);
  assert.match(composer, /<span class="hgroup-name">\$\{esc\(g\.name\)\}<\/span>/);
  assert.match(settings, /<strong>\$\{esc\(g\.name\)\}<\/strong>/);
  assert.match(settings, /<div class="hgroup-tags">\$\{esc\(g\.tags\.join\(" "\)\)\}<\/div>/);
  assert.match(settings, /data-action="deleteHashtagGroup" data-arg="\$\{attr\(g\.id\)\}"/);
});
