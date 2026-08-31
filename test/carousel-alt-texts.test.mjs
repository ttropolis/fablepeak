// ADR 0005 publishing depth — per-item alt text for Instagram carousels.
//
// The v1 cut from 20260831120000_instagram_options.sql, shipped as its fast
// follow. `alt_text` is a per-container parameter, so a carousel is described
// one item at a time; `carousel_alt_texts` is that list, positionally aligned
// with `posts.media_urls`.
//
// CI rebuilds the whole schema with `supabase db reset --local --no-seed`, so
// anything a running database can fail on — the function replacing, the existing
// CHECK re-binding — is covered there. These assertions cover what a database
// will happily accept and nobody would notice: an old migration edited in place,
// a *narrowing* that would strand rows already stored, a sync whitelist that
// silently drops the key, and an adapter that describes the wrong picture.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

globalThis.FABLEPEAK_BACKEND = { url: "https://project.supabase.invalid", anonKey: "test-anon-key" };
const { validBackupInstagramOptions } = await import("../js/settings.js");

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const NAME = "20260831150000_carousel_alt_texts.sql";
const MIGRATION = "supabase/migrations/" + NAME;
const OPTIONS_NAME = "20260831120000_instagram_options.sql";

/* The two rules that already existed, copied out of the migration that installed
   them. They must survive the widening as the same characters, because a rule
   that was re-typed is a rule that could have been re-typed differently. */
const SHARE_TO_FEED_RULE =
  "or (entry.key = 'share_to_feed' and jsonb_typeof(entry.value) <> 'boolean')";
const ALT_TEXT_RULE =
  `or (entry.key = 'alt_text' and (
                      jsonb_typeof(entry.value) <> 'string'
                   or length(entry.value #>> '{}') > 1000
                   or entry.value #>> '{}' ~ '[[:cntrl:]]'))`;

test("the widening is a NEW migration that edits none of the old ones", async () => {
  const files = (await readdir(new URL("supabase/migrations/", root))).sort();
  assert.ok(files.includes(NAME), "the migration must be on disk");
  assert.ok(files.indexOf(NAME) > files.indexOf(OPTIONS_NAME),
    "forward-only: the function it replaces has to exist before it is replaced");

  for (const file of files.filter(f => f < NAME)) {
    assert.doesNotMatch(await read("supabase/migrations/" + file), /carousel_alt_texts/,
      `${file} predates this key: a migration whose text has been edited is not the one that ran`);
  }
});

test("it replaces the predicate and nothing else — no column, no constraint churn", async () => {
  const migration = await read(MIGRATION);

  assert.match(migration,
    /create or replace function public\.valid_post_instagram_options\(v jsonb\)/);
  assert.match(migration, /immutable/, "a CHECK constraint may only call an IMMUTABLE function");
  assert.match(migration, /set search_path = public/);

  // The descriptions ride in the object 20260831120000 already added, so there is
  // no third nullable jsonb column, no third CHECK, and nothing for
  // js/remote-store.js to start gating.
  assert.doesNotMatch(migration, /alter table/,
    "a widened key set is a new predicate, not a new column");
  assert.doesNotMatch(migration, /drop constraint|add constraint/,
    "the constraint added by the options migration keeps calling this function by name");
  // `validate constraint` may be *discussed* — the widening is exactly the case
  // that does not owe one — but never run.
  assert.deepEqual(
    migration.split("\n").filter(line => /validate constraint/.test(line))
      .filter(line => !line.trimStart().startsWith("--")), [],
    "a pure widening strands no stored row, so no validation pass is owed");
  assert.doesNotMatch(migration, /create trigger|returns trigger|service_role/);
  assert.match(migration, /pure widening/i, "and the migration says so where it is doing it");
});

test("it is a widening: the key set only grows and the old rules are unchanged", async () => {
  const previous = await read("supabase/migrations/" + OPTIONS_NAME);
  const migration = await read(MIGRATION);

  assert.match(previous, /entry\.key not in \('share_to_feed','alt_text'\)/);
  assert.match(migration,
    /entry\.key not in \('share_to_feed','alt_text','carousel_alt_texts'\)/,
    "the two keys that were valid stay valid, and exactly one key joins them");

  for (const rule of [SHARE_TO_FEED_RULE, ALT_TEXT_RULE]) {
    assert.ok(previous.includes(rule), "this is the rule the earlier migration installed");
    assert.ok(migration.includes(rule),
      `share_to_feed and alt_text must be re-stated character for character:\n${rule}`);
  }
});

test("the new key is an ordered 1..10 list of contained strings", async () => {
  const migration = await read(MIGRATION);

  // An array, because these are *positions*: entry i describes media_urls[i].
  assert.match(migration,
    /entry\.key = 'carousel_alt_texts' and \(\s*\n\s*jsonb_typeof\(entry\.value\) <> 'array'/);
  // Ten is Instagram's carousel maximum, so an eleventh description could not
  // name a picture that exists. Zero is "no descriptions", spelled by absence.
  assert.match(migration, /jsonb_array_length\(entry\.value\) < 1/);
  assert.match(migration, /jsonb_array_length\(entry\.value\) > 10/);
  // Every entry gets the containment single-image alt text gets, for the same
  // reason: it is announced by a screen reader and echoed back into this app.
  assert.match(migration, /jsonb_array_elements\(entry\.value\) as item\(value\)/);
  assert.match(migration, /jsonb_typeof\(item\.value\) <> 'string'/);
  assert.match(migration, /length\(item\.value #>> '\{\}'\) > 1000/);
  assert.match(migration, /item\.value #>> '\{\}' ~ '\[\[:cntrl:\]\]'/);
});

test("every value the backup boundary accepted before it still accepts", () => {
  /* The fixture as it stood before this feature. A widening that fails any of
     these is not a widening, whatever the migration comment claims — and this is
     the copy of the predicate an untrusted file actually meets. */
  for (const options of [{ share_to_feed: false }, { share_to_feed: true },
                         { alt_text: "A cat" }, { alt_text: "" },
                         { alt_text: "x".repeat(1000) },
                         { share_to_feed: true, alt_text: "A cat" }]) {
    assert.equal(validBackupInstagramOptions(options), true,
      `the widening rejected a value that was already valid: ${JSON.stringify(options)}`);
  }
  for (const options of [null, {}, [{ share_to_feed: true }], { boomerang: true },
                         { share_to_feed: "true" }, { alt_text: 42 },
                         { alt_text: "x".repeat(1001) }, { alt_text: "one\ntwo" }]) {
    assert.equal(validBackupInstagramOptions(options), false,
      `the widening accepted a value that was already refused: ${JSON.stringify(options)}`);
  }
});

test("the backup boundary mirrors the new key, limit for limit", () => {
  for (const carousel_alt_texts of [[""], ["A cat"], ["", "A dog", ""],
                                    Array(10).fill("A cat"),
                                    ["x".repeat(1000)]]) {
    assert.equal(validBackupInstagramOptions({ carousel_alt_texts }), true,
      `refused ${JSON.stringify(carousel_alt_texts)}`);
  }
  assert.equal(validBackupInstagramOptions(
    { share_to_feed: true, carousel_alt_texts: ["A cat"] }), true,
    "a Reel placement and a carousel's descriptions can be recorded together");

  for (const carousel_alt_texts of [
    [],                                  // "no descriptions" is spelled by absence
    Array(11).fill("A cat"),             // past Instagram's ten items
    ["x".repeat(1001)],                  // past Instagram's alt-text ceiling
    ["line one\nline two"],              // a control character in a spoken string
    ["A cat", 42], [null], [["A cat"]],  // an entry that is not a string
    "A cat", { 0: "A cat" },             // not an array at all
  ]) {
    assert.equal(validBackupInstagramOptions({ carousel_alt_texts }), false,
      `accepted ${JSON.stringify(carousel_alt_texts)}`);
  }
});

test("the adapter describes child i with entry i, and tolerates a list that does not fit", async () => {
  const platforms = await read("supabase/functions/_shared/platforms.ts");
  const carousel = platforms.slice(
    platforms.indexOf("async function createInstagramCarousel"),
    platforms.indexOf("/** Why the carousel failed"));

  // By index, and appended — so a child with no description of its own sends the
  // exact body it sent before this feature existed.
  assert.match(carousel, /const alt = altTexts\?\.\[index\]\?\.trim\(\);/);
  assert.match(carousel, /if \(alt\) params\.alt_text = alt;/);
  // The caption still belongs to the CAROUSEL container alone, once.
  assert.doesNotMatch(carousel.slice(carousel.indexOf("media_type: \"CAROUSEL\"")), /alt_text/,
    "the CAROUSEL container names its children; it does not describe them");

  // Read positionally, and an entry that cannot be sent becomes "" rather than
  // vanishing: dropping it would shift every later description onto the wrong
  // picture. The composer keeps the two arrays aligned; the server stays tolerant.
  assert.match(platforms, /carousel_alt_texts\?: string\[\];/);
  assert.match(platforms, /if \(Array\.isArray\(raw\.carousel_alt_texts\)\)/);
  assert.match(platforms, /options\?\.carousel_alt_texts/,
    "the publish path hands the carousel builder what the post recorded");
});

test("the descriptions ride in instagram_options, so the sync whitelist is unchanged", async () => {
  const adapter = await read("js/remote-store.js");
  // No new column means no new name in FIELDS.posts and no new gate: the object
  // that already rides is the object that now carries one more key.
  assert.doesNotMatch(adapter, /carousel_alt_texts/,
    "a per-item description is an Instagram option, not a column of its own");
  assert.match(adapter,
    /posts:\s+\["id","brand_id","date","time","text","networks","status","media_url","media_urls","variants","approval_note","tiktok_options","instagram_options"\]/);
});
