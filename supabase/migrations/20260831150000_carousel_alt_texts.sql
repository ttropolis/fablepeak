-- ADR 0005 publishing depth — per-item alt text for Instagram carousels.
--
-- The deliberate v1 cut from 20260831120000_instagram_options.sql, now its fast
-- follow. `alt_text` describes one image because Instagram takes the parameter
-- per *container*, and a carousel is N containers — so one description could
-- only ever be right for the cover and wrong for the other nine. The honest
-- shape is one description per item, in the order the items are published, which
-- is what `carousel_alt_texts` is: a jsonb array positionally aligned with
-- `posts.media_urls`.
--
-- No new column. These are still "the choices this customer made about this
-- Instagram post", and 20260831120000 already established the object that
-- carries them; a third column would mean a third nullable jsonb, a third CHECK
-- and a third thing js/remote-store.js has to gate. The one thing it costs is
-- that widening the object means re-stating the whole predicate, which is what
-- this migration is.
--
-- A PURE WIDENING. Every value `valid_post_instagram_options` accepted before
-- this migration it still accepts: the key set only grows, and the
-- `share_to_feed` and `alt_text` rules are character-for-character the ones
-- 20260831120000 installed (test/carousel-alt-texts.test.mjs pins that they are).
-- That is why this is a CREATE OR REPLACE and nothing else: no stored row can
-- have become invalid, so no `validate constraint` pass is owed, and the
-- constraint added by 20260831120000 keeps calling this function by name. The
-- caveat that migration stated still applies in the other direction — a
-- *stricter* rule would need its own migration and its own validation pass.
--
-- What the new key enforces, and why each rule is Instagram's rather than ours:
--   * a jsonb *array*, never an object — these are positions, and a position is
--     only meaningful in something ordered. Entry i describes `media_urls[i]`;
--   * 1..10 entries. Ten is Instagram's carousel maximum, so an eleventh
--     description could not name a picture that exists. One is the minimum
--     because an empty array is "no descriptions", which already has a spelling:
--     the key is absent. The array may be *shorter* than the carousel — the
--     composer trims trailing blanks — and the adapter simply describes the items
--     it has descriptions for;
--   * every entry is a string of at most 1000 characters carrying no control
--     characters — Instagram's own alt-text ceiling and the same containment
--     rule single-image `alt_text` gets, for the same reason: alt text is
--     announced by a screen reader and echoed back into this app's DOM;
--   * an entry may be the empty string, and that is not a wasted row. "" is
--     "this item has no description" said *in position*, which is the only way
--     item three can be described while item two is not.

create or replace function public.valid_post_instagram_options(v jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select v is null
     or (
          jsonb_typeof(v) = 'object'
      and v <> '{}'::jsonb
      and not exists (
            select 1
              from jsonb_each(v) as entry(key, value)
             where entry.key not in ('share_to_feed','alt_text','carousel_alt_texts')
                or (entry.key = 'share_to_feed' and jsonb_typeof(entry.value) <> 'boolean')
                or (entry.key = 'alt_text' and (
                      jsonb_typeof(entry.value) <> 'string'
                   or length(entry.value #>> '{}') > 1000
                   or entry.value #>> '{}' ~ '[[:cntrl:]]'))
                or (entry.key = 'carousel_alt_texts' and (
                      jsonb_typeof(entry.value) <> 'array'
                   or jsonb_array_length(entry.value) < 1
                   or jsonb_array_length(entry.value) > 10
                   or exists (
                        select 1
                          from jsonb_array_elements(entry.value) as item(value)
                         where jsonb_typeof(item.value) <> 'string'
                            or length(item.value #>> '{}') > 1000
                            or item.value #>> '{}' ~ '[[:cntrl:]]')))
          )
        )
$$;
