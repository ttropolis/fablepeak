-- ADR 0005 publishing depth — the per-post Instagram options column.
--
-- Two choices Instagram lets the *customer* make about a single post, and which
-- FablePeak has so far made for them by omission:
--
--   * `share_to_feed` — a Reel appears both on the Reels tab and on the profile
--     grid, or on the Reels tab only. FablePeak forces every Instagram video to
--     `media_type=REELS`, so today every video silently takes whatever Instagram
--     defaults to. Absent here still means exactly that: the parameter is not
--     sent and Instagram's own default stands, which is why an existing post
--     publishes byte-identically.
--   * `alt_text` — the description a screen reader announces for a single image.
--     Instagram generates one automatically when none is supplied; a customer
--     who writes their own is describing their own picture better than a model
--     can, and accessibility is one of ADR 0001's release gates.
--
-- NULLABLE, deliberately — the same reasoning 20260831090000_tiktok_options.sql
-- and 20260831110000_carousel_media.sql used. Every post that predates this
-- migration, and every post that does not target Instagram, records no such
-- choices. A `not null default '{}'` would make "no choices" and "an empty
-- object" the same value, and an empty object is refused below precisely so that
-- "this post carries Instagram options" always means it carries at least one.
-- The browser writes this column only for posts whose networks include instagram
-- *and* that actually hold an option (js/remote-store.js), and clears it with the
-- target the way tiktok_options and media_urls are cleared.
--
-- SERVER-SIDE VALIDATION SEAM — the same one 20260830120000_post_variants.sql
-- established and the two migrations above reused, for the same reason. Posts are
-- upserted straight from the browser under the `posts_all` RLS policy; RLS
-- answers "whose post is this?", not "is this object well-formed?". A CHECK
-- constraint is the one gate every writer passes: today's browser, a future Edge
-- Function, psql, a replayed backup. The predicate iterates the object's entries
-- and a CHECK expression may not contain a subquery, so it delegates to an
-- IMMUTABLE SQL function. The usual caveat applies and is accepted deliberately:
-- changing the function does not re-validate stored rows, so a stricter rule
-- needs its own migration with a `validate constraint` pass.
--
-- What it enforces, and why each rule is Instagram's rather than ours:
--   * only the two keys the composer collects — an unknown key is a client that
--     has drifted, not data;
--   * an object with no keys at all is refused. "No Instagram options" is
--     already spelled NULL, and a second spelling of it would let a post claim
--     to carry choices nobody made;
--   * `share_to_feed` is a boolean. It is a two-way choice with a *third*
--     meaning — absent — and a string or a number could only ever be one of
--     those three said ambiguously;
--   * `alt_text` is a string of at most 1000 characters, Instagram's own alt-text
--     ceiling, and it carries no control characters. Alt text is announced by a
--     screen reader and echoed back into this app's DOM, so a stray C0 character
--     is never content: it is either a client bug or an attempt to smuggle
--     structure into a description.

alter table public.posts
  add column if not exists instagram_options jsonb;

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
             where entry.key not in ('share_to_feed','alt_text')
                or (entry.key = 'share_to_feed' and jsonb_typeof(entry.value) <> 'boolean')
                or (entry.key = 'alt_text' and (
                      jsonb_typeof(entry.value) <> 'string'
                   or length(entry.value #>> '{}') > 1000
                   or entry.value #>> '{}' ~ '[[:cntrl:]]'))
          )
        )
$$;

alter table public.posts drop constraint if exists posts_instagram_options_valid;
alter table public.posts
  add constraint posts_instagram_options_valid
  check (public.valid_post_instagram_options(instagram_options));
