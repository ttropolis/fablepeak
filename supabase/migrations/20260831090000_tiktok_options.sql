-- TikTok Content Posting API compliance — the per-post options column.
--
-- TikTok's Direct Post guidelines make the *creator's* choices part of the
-- post, not part of the integration: who may see the video, whether comments,
-- duets and stitches are allowed, and whether the video is commercial content
-- (self-promotion, a paid partnership, or both). None of those has a safe
-- default — the guidelines specifically forbid preselecting a privacy level —
-- so they are stored per post and the adapter refuses a TikTok target that has
-- none rather than inventing one.
--
-- NULLABLE, deliberately. Every post that predates this migration, and every
-- post that does not target TikTok, has no such choices to record; a `not null
-- default '{}'` would have to invent the very defaults the guidelines forbid.
-- The browser writes this column only for posts whose networks include tiktok
-- (js/remote-store.js), and the adapter treats null on a TikTok target as a
-- clean per-target failure.
--
-- SERVER-SIDE VALIDATION SEAM — the same one 20260830120000_post_variants.sql
-- established, for the same reason. Posts are upserted straight from the
-- browser under the `posts_all` RLS policy; RLS answers "whose post is this?",
-- not "is this object well-formed?". A CHECK constraint is the one gate every
-- writer passes: today's browser, a future Edge Function, psql, a replayed
-- backup. The predicate iterates the object's entries and a CHECK expression
-- may not contain a subquery, so it delegates to an IMMUTABLE SQL function.
-- The usual caveat applies and is accepted deliberately: changing the function
-- does not re-validate stored rows, so a stricter rule needs its own migration
-- with a `validate constraint` pass.
--
-- What it enforces, and why each rule is TikTok's rather than ours:
--   * only the seven keys the composer collects — an unknown key is a client
--     that has drifted, not data;
--   * `privacy_level` is required and is one of TikTok's four documented
--     values. Required, because "no preselected default" is only honest if the
--     absence of a choice cannot be stored as if it were one;
--   * the three interaction flags and the three disclosure flags are booleans;
--   * disclosure ON means at least one of `brand_organic` / `brand_content` —
--     TikTok's own form refuses "this is commercial content, in no way";
--   * branded content may not be SELF_ONLY. TikTok disallows private branded
--     content outright, so a row that says otherwise could only ever produce a
--     provider rejection at publish time. The composer says the same thing
--     while the customer is choosing; this is that rule stated where the data
--     lands rather than where the form is.

alter table public.posts
  add column if not exists tiktok_options jsonb;

create or replace function public.valid_post_tiktok_options(v jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select v is null
     or (
          jsonb_typeof(v) = 'object'
      and not exists (
            select 1
              from jsonb_each(v) as entry(key, value)
             where entry.key not in ('privacy_level','disable_comment','disable_duet',
                                     'disable_stitch','disclose_commercial',
                                     'brand_organic','brand_content')
                or (entry.key = 'privacy_level' and (
                      jsonb_typeof(entry.value) <> 'string'
                   or entry.value #>> '{}' not in ('PUBLIC_TO_EVERYONE','MUTUAL_FOLLOW_FRIENDS',
                                                   'FOLLOWER_OF_CREATOR','SELF_ONLY')))
                or (entry.key <> 'privacy_level' and jsonb_typeof(entry.value) <> 'boolean')
          )
      and v ? 'privacy_level'
      and (
            coalesce((v ->> 'disclose_commercial')::boolean, false) is not true
         or coalesce((v ->> 'brand_organic')::boolean, false)
         or coalesce((v ->> 'brand_content')::boolean, false)
          )
      and not (
            coalesce((v ->> 'brand_content')::boolean, false)
        and v ->> 'privacy_level' = 'SELF_ONLY'
          )
        )
$$;

alter table public.posts drop constraint if exists posts_tiktok_options_valid;
alter table public.posts
  add constraint posts_tiktok_options_valid
  check (public.valid_post_tiktok_options(tiktok_options));
