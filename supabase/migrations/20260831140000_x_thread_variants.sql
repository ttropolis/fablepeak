-- ADR 0005 publishing depth — X threads. The one line of SQL the feature needs,
-- and it is a relaxation, not a new column.
--
-- Threads themselves store nothing. splitXThread() derives the chain from the
-- post's own text at publish time, so there is no thread table, no per-tweet
-- row, no ordering column and no change to any of the three claim RPCs. A post
-- that becomes five tweets is stored exactly as the one string the customer
-- typed, which is also what makes editing it before it goes out work at all.
--
-- What does have to change is a rule stated here that is no longer true.
-- 20260830120000_post_variants.sql capped an `x` variant at 280 characters,
-- because ADR 0005 decision 12 refused over-length X copy at save time and this
-- was "the same rule stated where the data lands rather than where the form
-- is". The 2026-08-31 amendment replaced that refusal with a thread: the
-- composer now previews the split and saves, and the adapter posts the chain.
-- Leaving the CHECK in place would make the database refuse, with a bare 23514,
-- exactly the post the composer just told the customer was fine — the "database
-- that refused what the composer allowed" the original migration named as the
-- worse kind of liar.
--
-- So `x` rejoins every other network under the 63206-character ceiling. That
-- ceiling is unchanged and is still doing its real job: stopping a client from
-- parking megabytes of jsonb on a post row. The key allowlist and the
-- jsonb-string type check are unchanged too.
--
-- Loosening a CHECK needs no `validate constraint` pass and cannot invalidate a
-- stored row: every `variants` map that satisfied the old predicate satisfies
-- this one. The constraint is still dropped and re-added so that the table's
-- definition names the current function rather than a cached older plan.

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
     )
$$;

alter table public.posts drop constraint if exists posts_variants_valid;
alter table public.posts
  add constraint posts_variants_valid check (public.valid_post_variants(variants));
