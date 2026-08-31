// ADR 0005 publishing depth — the per-post Instagram options column.
//
// CI rebuilds the whole schema with `supabase db reset --local --no-seed`, so
// anything a running database can fail on — the column addition, the CHECK
// compiling and binding — is covered there. These assertions cover what a
// database will happily accept and nobody would notice: an old migration edited
// in place, a claim RPC or the posts status trigger quietly learning the new
// column, a sync whitelist that silently drops it, and an adapter that stops
// sending today's request when a post carries no options at all.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const NAME = "20260831120000_instagram_options.sql";
const MIGRATION = "supabase/migrations/" + NAME;

test("the options column is added in a NEW migration, nullable, and never in an old one", async () => {
  const files = (await readdir(new URL("supabase/migrations/", root))).sort();
  assert.ok(files.includes(NAME), "the migration must be on disk");
  assert.ok(files.indexOf(NAME) > files.indexOf("20260831110000_carousel_media.sql"),
    "forward-only: this is the newest post-shape migration, so it sorts last");

  const migration = await read(MIGRATION);
  // Nullable, for the reason tiktok_options and media_urls are: "this post
  // records no Instagram choices" is nearly every post, and an empty object is
  // refused below so that it cannot become a second spelling of the same thing.
  assert.match(migration,
    /alter table public\.posts\s+add column if not exists instagram_options jsonb;/);
  assert.doesNotMatch(migration, /instagram_options jsonb not null/);

  // Nothing about the existing post shape moves.
  assert.doesNotMatch(migration, /drop column|alter column media_url|rename column/,
    "these are two new optional choices, not a change to what a post already is");

  // No earlier migration may be edited to say any of this.
  for (const file of files.filter(f => f < NAME)) {
    assert.doesNotMatch(await read("supabase/migrations/" + file), /instagram_options/,
      `${file} predates this column: a migration whose text has been edited is not the one that ran`);
  }
});

test("the options are validated where posts are actually written, by a CHECK", async () => {
  const migration = await read(MIGRATION);

  // The same seam posts.variants established and the two migrations before this
  // one reused: the browser upserts posts directly under the posts_all RLS
  // policy, and RLS answers "whose post is this?", not "is this object
  // well-formed?". A CHECK is declarative, is shown by \d, and cannot be turned
  // off by a session_replication_role that disables triggers.
  assert.match(migration,
    /create or replace function public\.valid_post_instagram_options\(v jsonb\)/);
  assert.match(migration, /immutable/, "a CHECK constraint may only call an IMMUTABLE function");
  assert.match(migration, /set search_path = public/);
  assert.match(migration,
    /add constraint posts_instagram_options_valid\s+check \(public\.valid_post_instagram_options\(instagram_options\)\)/);
  assert.match(migration, /drop constraint if exists posts_instagram_options_valid/,
    "re-creating the constraint is what makes the migration re-runnable");
  assert.doesNotMatch(migration, /create trigger|returns trigger|service_role/,
    "a CHECK needs no service-execution marker, so this migration must not grow one");

  assert.match(migration, /jsonb_typeof\(v\) = 'object'/);
  assert.match(migration, /v is null/,
    "null is a post that records no Instagram choices, which is most of them");
  // "No options" already has a spelling, and it is NULL. An object with no keys
  // would be a post claiming to carry choices nobody made.
  assert.match(migration, /v <> '\{\}'::jsonb/);

  // A closed key set: an unknown key is a client that has drifted, not data.
  assert.match(migration, /entry\.key not in \('share_to_feed','alt_text'\)/);
  assert.match(migration,
    /entry\.key = 'share_to_feed' and jsonb_typeof\(entry\.value\) <> 'boolean'/,
    "share_to_feed is a two-way choice with a third meaning — absent — so it is a boolean or nothing");
  assert.match(migration, /entry\.key = 'alt_text'/);
  assert.match(migration, /jsonb_typeof\(entry\.value\) <> 'string'/);
  assert.match(migration, /length\(entry\.value #>> '\{\}'\) > 1000/,
    "Instagram's own alt-text ceiling, stated where the data lands");
  assert.match(migration, /entry\.value #>> '\{\}' ~ '\[\[:cntrl:\]\]'/,
    "alt text is announced by a screen reader and rendered back into the app");
});

test("no claim RPC and no status trigger learns the options column", async () => {
  const migration = await read(MIGRATION);
  // The claim RPCs are `returns setof public.posts` / `returning p.*`, so the
  // column reaches publishPost with no SQL change — which is the point.
  assert.doesNotMatch(migration,
    /create or replace function public\.(claim_due_posts|claim_post_for_retry|claim_post_for_publish)/,
    "the publish cron needs no change, and that is why the column is free");
  assert.doesNotMatch(migration, /posts_guard_status_transition|posts_status_check/,
    "a Reel's placement is not a post's status");

  const files = (await readdir(new URL("supabase/migrations/", root))).sort();
  for (const file of files.filter(f => f > NAME)) {
    const sql = await read("supabase/migrations/" + file);
    assert.doesNotMatch(sql,
      /drop constraint if exists posts_instagram_options_valid(?![\s\S]{0,400}?add constraint posts_instagram_options_valid)/,
      `${file} sorts after ${NAME}: the constraint must not be dropped and left off`);
  }
});

test("a column the sync whitelist does not name is invisible, so instagram_options is named three times", async () => {
  const adapter = await read("js/remote-store.js");
  /* An exact list on purpose: a column added to the whitelist is a deliberate
     widening of what the browser may write, and it should have to be stated
     here as well as there. `instagram_options` is the fourth such widening,
     after `variants`, `tiktok_options` and `media_urls`. */
  assert.match(adapter,
    /posts:\s+\["id","brand_id","date","time","text","networks","status","media_url","media_urls","variants","approval_note","tiktok_options","instagram_options"\]/,
    "FIELDS.posts decides what is diffed and upserted");
  assert.match(adapter, /instagram_options: p\.instagram_options \|\| null,/,
    "server row -> app post");
  assert.match(adapter,
    /instagram_options:\(p\.networks \|\| \[\]\)\.includes\("instagram"\)\s*\n?\s*&& p\.instagram_options && Object\.keys\(p\.instagram_options\)\.length\s*\n?\s*\? p\.instagram_options : null/,
    "app post -> server row, and only for a post that targets Instagram and records a choice");
});

test("an imported backup cannot smuggle options the column would refuse", async () => {
  const settings = await read("js/settings.js");
  // The same closed shape the CHECK enforces, restated where an untrusted file
  // lands — the database is the last line, not the first.
  assert.match(settings, /const ALT_TEXT_MAX = 1000;/);
  assert.match(settings, /const CONTROL_CHARS = \/\[\\u0000-\\u001F\\u007F\]\//);
  // The key set is closed, and widened only where a migration widened it —
  // 20260831150000_carousel_alt_texts.sql, whose own test pins this list too.
  assert.match(settings,
    /Object\.keys\(o\)\.every\(k =>\s*\n?\s*k==="share_to_feed" \|\| k==="alt_text" \|\| k==="carousel_alt_texts"\)/);
  assert.match(settings, /isPlainObject\(o\) && Object\.keys\(o\)\.length > 0/,
    "an empty object is refused here too — 'no options' is spelled null");
  assert.match(settings,
    /p\.instagram_options===undefined \|\| p\.instagram_options===null\s*\n?\s*\|\| validBackupInstagramOptions\(p\.instagram_options\)/,
    "absent and null both mean 'this post records no Instagram choices'");
});

test("the options reach the adapter the way variants, TikTok options and the carousel do", async () => {
  const publish = await read("supabase/functions/publish/index.ts");
  const platforms = await read("supabase/functions/_shared/platforms.ts");

  // Resolved in the per-target loop from the claimed post row, never at claim time.
  assert.match(publish, /instagramOptions: post\.instagram_options \?\? null/);

  assert.match(platforms, /export const INSTAGRAM_ALT_TEXT_MAX = 1000;/);
  assert.match(platforms, /export function readInstagramOptions\(value: unknown\)/);
  // share_to_feed is three-state: true, false, and absent. Absent is not false.
  assert.match(platforms,
    /createParams\.share_to_feed = options\.share_to_feed \? "true" : "false";/);
  assert.match(platforms,
    /if \(video && options\?\.share_to_feed !== undefined\)/,
    "no choice recorded means no parameter sent, which is today's behaviour");
  assert.match(platforms,
    /if \(!video && options\?\.alt_text\) createParams\.alt_text = options\.alt_text;/);

  // The v1 cut is gone: the carousel describes its children one at a time now.
  // What that looks like is pinned in test/carousel-alt-texts.test.mjs.
  assert.doesNotMatch(platforms, /v1 deliberately sends NO alt text on carousel children/,
    "the cut shipped its fast follow — the comment must not outlive it");

  // No other adapter learned the field.
  const nonInstagram = platforms.split("readInstagramOptions(instagramOptions)")[1] ?? "";
  assert.doesNotMatch(nonInstagram, /instagramOptions/,
    "only the Instagram adapter reads it; every other adapter ignores it");
});
