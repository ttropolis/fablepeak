-- ADR 0005 delivery item 3 — per-network copy variants.
--
-- Decision 2: per-network text is a `variants` jsonb map on `posts`, shaped
-- { "<network>": "<text>" }. An entry overrides `posts.text` for that network.
-- The column defaults to '{}' and is `not null`, so every existing row keeps
-- publishing byte-identically (decision 3): the resolver treats a missing,
-- empty or whitespace-only entry alike as "inherit the base text".
--
-- All three claim RPCs are `returns setof public.posts` / `returning p.*`, so
-- this column reaches the publish Edge Function with no change to them.
--
-- The key allowlist includes `gbp` deliberately even though no gbp adapter
-- exists: gbp is one of the app's eight network ids, and a gbp variant is as
-- inert as a gbp base post — the publish loop already skips adapterless
-- platforms with a clean "not configured" result. Forward-compatible for the
-- day Google Business ships; not a publish-boundary hole today.
--
-- SERVER-SIDE VALIDATION SEAM (amendment to decision 1's storage rules).
-- Posts are written by the browser, which upserts `public.posts` directly under
-- the `posts_all` RLS policy — there is no post-write Edge Function to validate
-- in. RLS answers "may this user write this brand's post?", not "is this map
-- well-formed?". So the map is validated by a CHECK constraint on the table:
-- the one place every writer — today's browser upsert, a future Edge Function,
-- a psql session, a replayed backup — has to pass through. A trigger could do
-- the same job, but a CHECK is declarative, is shown by \d, and cannot be
-- bypassed by a `session_replication_role` that disables triggers.
--
-- The predicate needs to iterate the map's entries, and a CHECK expression may
-- not contain a subquery, so it delegates to an IMMUTABLE SQL function. The
-- usual caveat applies and is accepted deliberately: changing the function does
-- not re-validate rows already stored, so a stricter rule needs its own
-- migration with a `validate constraint` pass.
--
-- What it enforces, and why those limits are the honest ones:
--   * keys must be platform ids this application actually publishes to — the
--     same closed set `social_connections.platform` already checks;
--   * values must be jsonb strings — never numbers, objects or nulls;
--   * every value is capped at 63206 characters, Facebook's real post limit and
--     the largest cap any supported network has. This is the ceiling that stops
--     a client from parking megabytes of jsonb on a post row; it is deliberately
--     not each network's own advisory cap, because the composer only *warns*
--     about those and a database that refused what the composer allowed would
--     be a worse liar than one that allows what the provider will reject;
--   * `x` is capped at 280, which is not advisory: decision 12 refuses an
--     over-length X variant at save time instead of letting the adapter
--     silently truncate it, and this is the same rule stated where the data
--     lands rather than where the form is.

alter table public.posts
  add column if not exists variants jsonb not null default '{}';

create or replace function public.valid_post_variants(v jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select v is not null
     and jsonb_typeof(v) = 'object'
     and not exists (
       select 1
         from jsonb_each(v) as entry(key, value)
        where entry.key not in ('youtube','x','instagram','facebook',
                                'linkedin','tiktok','pinterest','gbp')
           or jsonb_typeof(entry.value) <> 'string'
           or length(entry.value #>> '{}') > 63206
           or (entry.key = 'x' and length(entry.value #>> '{}') > 280)
     )
$$;

alter table public.posts drop constraint if exists posts_variants_valid;
alter table public.posts
  add constraint posts_variants_valid check (public.valid_post_variants(variants));
