// ADR 0005 publishing depth — Instagram carousels (container children).
//
// CI rebuilds the whole schema with `supabase db reset --local --no-seed`, so
// anything a running database can fail on — the column addition, the CHECK
// compiling and binding — is covered there. These assertions cover what a
// database will happily accept and nobody would notice: an old migration edited
// in place, a claim RPC or the posts status trigger quietly learning the new
// column, a sync whitelist that silently drops it, and a publish path that
// forwards the provider's body when a carousel child is rejected.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const NAME = "20260831110000_carousel_media.sql";
const MIGRATION = "supabase/migrations/" + NAME;

test("the carousel column is added in a NEW migration, nullable, and never in an old one", async () => {
  const files = (await readdir(new URL("supabase/migrations/", root))).sort();
  assert.ok(files.includes(NAME), "the migration must be on disk");
  assert.ok(files.indexOf(NAME) > files.indexOf("20260831090000_tiktok_options.sql"),
    "forward-only: this is the newest post-shape migration, so it sorts last");

  const migration = await read(MIGRATION);
  // Nullable, for the reason tiktok_options is: "this post has no carousel" is
  // nearly every post, and an empty array is not a carousel Instagram accepts.
  assert.match(migration,
    /alter table public\.posts\s+add column if not exists media_urls jsonb;/);
  assert.doesNotMatch(migration, /media_urls jsonb not null/);

  // posts.media_url is untouched, and stays the cover every other network posts.
  assert.doesNotMatch(migration, /drop column|alter column media_url|rename column/,
    "the single media URL is the contract for seven networks and does not move");

  // No earlier migration may be edited to say any of this.
  for (const file of files.filter(f => f < NAME)) {
    assert.doesNotMatch(await read("supabase/migrations/" + file), /media_urls/,
      `${file} predates carousels: a migration whose text has been edited is not the one that ran`);
  }
});

test("the carousel is validated where posts are actually written, by a CHECK", async () => {
  const migration = await read(MIGRATION);

  // The same seam posts.variants established and tiktok_options reused: the
  // browser upserts posts directly under the posts_all RLS policy, and RLS
  // answers "whose post is this?", not "is this array well-formed?". A CHECK is
  // declarative, is shown by \d, and cannot be turned off by a
  // session_replication_role that disables triggers.
  assert.match(migration, /create or replace function public\.valid_post_media_urls\(v jsonb\)/);
  assert.match(migration, /immutable/, "a CHECK constraint may only call an IMMUTABLE function");
  assert.match(migration, /set search_path = public/);
  assert.match(migration,
    /add constraint posts_media_urls_valid\s+check \(public\.valid_post_media_urls\(media_urls\)\)/);
  assert.match(migration, /drop constraint if exists posts_media_urls_valid/,
    "re-creating the constraint is what makes the migration re-runnable");
  assert.doesNotMatch(migration, /create trigger|returns trigger|service_role/,
    "a CHECK needs no service-execution marker, so this migration must not grow one");

  // An *array*, because the order of a carousel is the order the customer
  // arranged — an object could not carry it.
  assert.match(migration, /jsonb_typeof\(v\) = 'array'/);
  assert.match(migration, /v is null/, "null is a post with no carousel, which is most of them");
  // Instagram's own two numbers, stated where the data lands.
  assert.match(migration, /jsonb_array_length\(v\) >= 2/,
    "one item is an ordinary post, so it is not a carousel");
  assert.match(migration, /jsonb_array_length\(v\) <= 10/);
  // Every entry is an https string this app is willing to hand to Meta.
  assert.match(migration, /jsonb_typeof\(item\.value\) <> 'string'/);
  assert.match(migration, /left\(item\.value #>> '\{\}', 8\) <> 'https:\/\/'/);
  assert.match(migration, /length\(item\.value #>> '\{\}'\) > 2048/);
});

test("no claim RPC and no status trigger learns the carousel column", async () => {
  const migration = await read(MIGRATION);
  // The claim RPCs are `returns setof public.posts` / `returning p.*`, so the
  // column reaches publishPost with no SQL change — which is the point.
  assert.doesNotMatch(migration,
    /create or replace function public\.(claim_due_posts|claim_post_for_retry|claim_post_for_publish)/,
    "the publish cron needs no change, and that is why the column is free");
  assert.doesNotMatch(migration, /posts_guard_status_transition|posts_status_check/,
    "carousels are about media, not about a post's status");

  const scheduling = await read("supabase/migrations/20260731090000_reliable_scheduling.sql");
  assert.match(scheduling, /returns setof public\.posts/);

  const files = (await readdir(new URL("supabase/migrations/", root))).sort();
  for (const file of files.filter(f => f > NAME)) {
    const sql = await read("supabase/migrations/" + file);
    assert.doesNotMatch(sql, /drop constraint if exists posts_media_urls_valid(?![\s\S]{0,400}?add constraint posts_media_urls_valid)/,
      `${file} sorts after ${NAME}: the constraint must not be dropped and left off`);
  }
});

test("a column the sync whitelist does not name is invisible, so media_urls is named three times", async () => {
  const adapter = await read("js/remote-store.js");
  /* An exact list on purpose: a column added to the whitelist is a deliberate
     widening of what the browser may write, and it should have to be stated
     here as well as there. `media_urls` is the third such widening, after
     `variants` and `tiktok_options`. */
  assert.match(adapter,
    /posts:\s+\["id","brand_id","date","time","text","networks","status","media_url","media_urls","variants","approval_note","tiktok_options","instagram_options"\]/,
    "FIELDS.posts decides what is diffed and upserted");
  assert.match(adapter,
    /media_urls: Array\.isArray\(p\.media_urls\) && p\.media_urls\.length > 1\s*\n?\s*\? p\.media_urls : null/,
    "server row -> app post");
  assert.match(adapter,
    /media_urls:\(p\.networks \|\| \[\]\)\.includes\("instagram"\)\s*\n?\s*&& Array\.isArray\(p\.media_urls\) && p\.media_urls\.length > 1\s*\n?\s*\? p\.media_urls : null/,
    "app post -> server row, and only for a post that actually targets Instagram with extras");
  // posts.media_url is still written for every post, carousel or not.
  assert.match(adapter, /media_url: p\.media_url \|\| ""/);
  assert.match(adapter, /media_url:p\.media_url \|\| null/);
});

test("an imported backup cannot smuggle a carousel Instagram would refuse", async () => {
  const settings = await read("js/settings.js");
  // The same three limits the CHECK enforces, restated where an untrusted file
  // lands — the database is the last line, not the first.
  assert.match(settings, /const CAROUSEL_MIN = 2, CAROUSEL_MAX = 10;/);
  assert.match(settings,
    /const isCarouselItem = v => isText\(v\) && v\.length <= 2048 && v\.startsWith\("https:\/\/"\);/);
  assert.match(settings,
    /Array\.isArray\(v\) && v\.length >= CAROUSEL_MIN && v\.length <= CAROUSEL_MAX\s*\n?\s*&& v\.every\(isCarouselItem\)/);
  assert.match(settings,
    /p\.media_urls===undefined \|\| p\.media_urls===null \|\| validBackupMediaUrls\(p\.media_urls\)/,
    "absent and null both mean 'this post has no carousel', which is not an error");
});

test("the carousel reaches the adapter the way variants and TikTok options do", async () => {
  const publish = await read("supabase/functions/publish/index.ts");
  const platforms = await read("supabase/functions/_shared/platforms.ts");

  // Resolved in the per-target loop from the claimed post row, never at claim time.
  assert.match(publish, /mediaUrls: post\.media_urls \?\? null/);
  assert.match(publish, /mediaUrl: post\.media_url \?\? null/,
    "every other adapter still publishes the single cover, unchanged");

  // Instagram's three-stage flow, and the two numbers stated once each.
  assert.match(platforms, /export const INSTAGRAM_CAROUSEL_MIN = 2;/);
  assert.match(platforms, /export const INSTAGRAM_CAROUSEL_MAX = 10;/);
  assert.match(platforms, /is_carousel_item: "true"/);
  assert.match(platforms, /media_type: "CAROUSEL", children: children\.join\(","\)/);
  assert.match(platforms, /media_type: "VIDEO", video_url: safeItemUrl/,
    "a video child is VIDEO; REELS is a standalone format Meta rejects as a child");
  assert.match(platforms, /await waitForInstagramContainer\(String\(child\.id\), accessToken\)/,
    "a child that is not FINISHED cannot be named by a carousel");
  assert.match(platforms, /publicMediaUrl\(item, "Instagram"\)/,
    "every item is re-validated against the SSRF gate, not trusted from the row");

  // A rejected child is reported by status, never by forwarding Graph's body,
  // and it can never leave a half-published carousel behind.
  const failure = platforms.slice(platforms.indexOf("function instagramCarouselItemFailure"));
  assert.match(failure,
    /if \(error instanceof ProviderRequestError\) return new ProviderRequestError\(where, error\.status\);/);
  assert.doesNotMatch(platforms, /children: \[\]/);
  const carousel = platforms.slice(
    platforms.indexOf("async function createInstagramCarousel"),
    platforms.indexOf("/** Why the carousel failed"));
  assert.doesNotMatch(carousel, /media_publish/,
    "no publish request exists inside the item loop, so a child cannot half-publish a post");
});
