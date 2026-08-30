-- ADR 0005 publishing depth — Instagram carousels (container children).
--
-- ADR 0005 decision 14 cut carousels from v1 for one stated reason: they need a
-- media *array* plus an N-container Instagram upload flow. This migration is
-- that array, and nothing else. `posts.media_url` is untouched and stays the
-- cover/first-media path for every network: Facebook still posts one photo,
-- LinkedIn still posts one image, YouTube still uploads one video. Only the
-- Instagram adapter reads this column, and only when it holds two or more items.
--
-- NULLABLE, deliberately — the same reasoning 20260831090000_tiktok_options.sql
-- used. Every post that predates this migration, every post that does not target
-- Instagram, and every Instagram post with a single image has no carousel to
-- record. A `not null default '[]'` would make "no carousel" and "an empty
-- carousel" the same value, and an empty carousel is not a thing Instagram will
-- accept. The browser writes this column only for posts whose networks include
-- instagram *and* that carry more than one item (js/remote-store.js), and clears
-- it with the target the way tiktok_options is cleared.
--
-- SERVER-SIDE VALIDATION SEAM — the same one 20260830120000_post_variants.sql
-- established and 20260831090000_tiktok_options.sql reused, for the same reason.
-- Posts are upserted straight from the browser under the `posts_all` RLS policy;
-- RLS answers "whose post is this?", not "is this array well-formed?". A CHECK
-- constraint is the one gate every writer passes: today's browser, a future Edge
-- Function, psql, a replayed backup. The predicate iterates the array's elements
-- and a CHECK expression may not contain a subquery, so it delegates to an
-- IMMUTABLE SQL function. The usual caveat applies and is accepted deliberately:
-- changing the function does not re-validate stored rows, so a stricter rule
-- needs its own migration with a `validate constraint` pass.
--
-- What it enforces, and why each limit is Instagram's rather than ours:
--   * a jsonb *array*, never an object — the order of a carousel is the order
--     the customer arranged, so the shape that carries it has to be ordered;
--   * 2..10 entries. Instagram's carousel minimum is 2 (one item is an ordinary
--     post, and this column must not become a second way to say the same thing)
--     and its maximum is 10. A row outside that range could only ever produce a
--     provider rejection at publish time, so it is refused where it lands;
--   * every entry is a string beginning `https://`. The adapter re-validates
--     each URL through publicMediaUrl() before it reaches Meta — this is the
--     coarse gate that stops a non-string, an http:// URL or a javascript: URL
--     from ever being stored, not a replacement for that check;
--   * every entry is at most 2048 characters, the ceiling that stops a client
--     from parking unbounded jsonb on a post row.

alter table public.posts
  add column if not exists media_urls jsonb;

create or replace function public.valid_post_media_urls(v jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select v is null
     or (
          jsonb_typeof(v) = 'array'
      and jsonb_array_length(v) >= 2
      and jsonb_array_length(v) <= 10
      and not exists (
            select 1
              from jsonb_array_elements(v) as item(value)
             where jsonb_typeof(item.value) <> 'string'
                or left(item.value #>> '{}', 8) <> 'https://'
                or length(item.value #>> '{}') > 2048
          )
        )
$$;

alter table public.posts drop constraint if exists posts_media_urls_valid;
alter table public.posts
  add constraint posts_media_urls_valid
  check (public.valid_post_media_urls(media_urls));
