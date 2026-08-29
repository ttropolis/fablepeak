-- ADR 0004 (accepted with the 2026-08-29 amendments): public SmartLinks pages.
--
-- This is the whole backend for the feature: the slug namespace, the alias
-- retention rule that keeps a distributed URL from ever being inherited by a
-- different customer, the anonymous read RPC, PII-free click recording, and the
-- member-only aggregate surface.
--
-- Security posture, in one place, because this migration creates FablePeak's
-- first `anon` grants of any kind:
--   * public.get_smartlink(text)          security definer, search_path '', anon + authenticated
--   * public.record_smartlink_click(...)  security definer, search_path '', anon + authenticated
--   * public.set_smartlink_slug(text,text) security definer, search_path '', authenticated only
--   * public.smartlink_slug_is_valid(text) immutable, search_path '', anon + authenticated
--   * no table is directly reachable by anon; every anon path is an exact-match
--     RPC, so there is no enumeration surface.
-- Every reference inside a definer function is schema-qualified because
-- search_path is emptied (only pg_catalog remains implicitly searchable).

-- ---------------------------------------------------------------- slug rules
-- Amended by decision 5: three characters minimum (the body said two),
-- consecutive hyphens rejected, and the reserved list is the union of the
-- body's denylist and the words added by the amendment. Kept as an IMMUTABLE
-- function so the same rule backs a CHECK constraint and the claim RPC — the
-- rule cannot drift between the two.
create or replace function public.smartlink_slug_is_valid(p_slug text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_slug is not null
     -- 3..30 chars, [a-z0-9-], never starting or ending with a hyphen
     and p_slug ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$'
     -- no consecutive hyphens (decision 5)
     and p_slug !~ '--'
     and p_slug <> all (array[
       -- ADR body denylist
       'l', 'api', 'app', 'www', 'admin', 'static', 'assets', 'oauth',
       'privacy', 'terms', 'functions', 'data-deletion',
       -- decision 5 additions ('.well-known' cannot contain a dot under the
       -- character rule above, so the dotless form is what must be reserved)
       'login', 'signup', 'support', 'help', 'legal', 'security', 'status',
       'well-known',
       -- infrastructure names that must never become a customer page
       'mail', 'root', 'fablepeak'
     ])
$$;

-- Granted to authenticated only: it backs the CHECK constraint on brands (which
-- only members ever write) and lets the editor pre-validate a slug before
-- claiming it. The definer RPCs below call it as owner, so anon never needs it.
revoke all on function public.smartlink_slug_is_valid(text) from public;
revoke all on function public.smartlink_slug_is_valid(text) from anon;
grant execute on function public.smartlink_slug_is_valid(text) to authenticated;

-- ------------------------------------------------- slug + publish on brands
-- Slug lives in a column, not inside brands.smartlink, so uniqueness is a real
-- constraint and a collision cannot fail an unrelated save_brand upsert.
alter table public.brands add column if not exists smartlink_slug text;
alter table public.brands
  add column if not exists smartlink_public boolean not null default false;

alter table public.brands drop constraint if exists brands_smartlink_slug_valid;
alter table public.brands add constraint brands_smartlink_slug_valid
  check (smartlink_slug is null or public.smartlink_slug_is_valid(smartlink_slug));

-- Publishing is opt-in and off by default (decision 4); a page cannot be
-- published without a URL to publish it at.
alter table public.brands drop constraint if exists brands_smartlink_public_needs_slug;
alter table public.brands add constraint brands_smartlink_public_needs_slug
  check (not smartlink_public or smartlink_slug is not null);

-- The URL space is global, so the slug namespace is global.
create unique index if not exists brands_smartlink_slug_key
  on public.brands (lower(smartlink_slug));

-- --------------------------------------------------------- slug alias ledger
-- Decision 6 amends the body's "rename releases the old slug immediately".
-- Every slug a brand has ever held is retained here for the brand's lifetime,
-- so links already distributed in the wild can never be taken over by another
-- customer. Rows cascade with the brand: once the brand is gone the alias is
-- gone with it, which is also what makes an alias resolvable only while its
-- owner still exists.
create table if not exists public.smartlink_slug_aliases (
  slug text primary key,
  brand_id text not null references public.brands(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists smartlink_slug_aliases_brand_idx
  on public.smartlink_slug_aliases (brand_id);

alter table public.smartlink_slug_aliases enable row level security;

revoke all on public.smartlink_slug_aliases from public, anon, authenticated;
grant select on public.smartlink_slug_aliases to authenticated;
grant all on public.smartlink_slug_aliases to service_role;

-- Members may read their own brand's slug history; nobody may write directly.
-- Public resolution goes through the definer RPC, which bypasses RLS.
drop policy if exists smartlink_slug_aliases_select on public.smartlink_slug_aliases;
create policy smartlink_slug_aliases_select on public.smartlink_slug_aliases
  for select to authenticated using (public.is_member(brand_id));

-- ----------------------------------------------------- slug change guard
-- brands has a member UPDATE policy, so without this trigger a member could
-- PATCH brands.smartlink_slug straight through PostgREST and bypass the alias
-- protection entirely. Setting a slug is only legal from inside
-- public.set_smartlink_slug(), which announces itself through a local GUC.
-- Clearing a slug back to null stays allowed: the alias ledger keeps the
-- retired name reserved either way.
create or replace function public.brands_guard_smartlink_slug()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.smartlink_slug is not distinct from old.smartlink_slug then
    return new;
  end if;
  if new.smartlink_slug is null then
    return new;
  end if;
  if current_setting('fablepeak.smartlink_slug_change', true)
     is distinct from new.id then
    raise exception 'set brands.smartlink_slug through public.set_smartlink_slug()'
      using errcode = '42501';
  end if;
  return new;
end
$$;

-- A `returns trigger` function cannot be invoked directly, but no client role
-- has any business holding EXECUTE on it either.
revoke all on function public.brands_guard_smartlink_slug() from public;
revoke all on function public.brands_guard_smartlink_slug() from anon, authenticated;

drop trigger if exists brands_guard_smartlink_slug on public.brands;
create trigger brands_guard_smartlink_slug
  before insert or update on public.brands
  for each row execute function public.brands_guard_smartlink_slug();

-- ------------------------------------------------------------ claim / rename
-- Member-authorized. Returns a typed result rather than raising on conflict so
-- the editor can render "that name is taken" instead of an error toast; a
-- genuine authorization failure still raises.
--
-- Alias protection is enforced here, at claim time, in two checks: the slug
-- must not be live on another brand, and it must not appear anywhere in the
-- alias ledger under another brand. Both the outgoing and the incoming slug are
-- recorded, so a name is reserved from the moment a brand first takes it.
create or replace function public.set_smartlink_slug(p_brand_id text, p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_current text;
  v_exists boolean;
begin
  if not public.is_member(p_brand_id) then
    raise exception 'not authorised for this brand' using errcode = '42501';
  end if;

  if not public.smartlink_slug_is_valid(v_slug) then
    return jsonb_build_object('ok', false, 'error', 'invalid_slug');
  end if;

  select true, b.smartlink_slug into v_exists, v_current
    from public.brands b where b.id = p_brand_id;
  if v_exists is not true then
    return jsonb_build_object('ok', false, 'error', 'unknown_brand');
  end if;

  if lower(coalesce(v_current, '')) = v_slug then
    return jsonb_build_object('ok', true, 'slug', v_slug, 'changed', false);
  end if;

  -- live on another brand
  if exists (
    select 1 from public.brands b
     where lower(b.smartlink_slug) = v_slug and b.id <> p_brand_id
  ) then
    return jsonb_build_object('ok', false, 'error', 'slug_taken');
  end if;

  -- ever held by another brand (decision 6: never reassign a retired slug)
  if exists (
    select 1 from public.smartlink_slug_aliases a
     where a.slug = v_slug and a.brand_id <> p_brand_id
  ) then
    return jsonb_build_object('ok', false, 'error', 'slug_taken');
  end if;

  perform set_config('fablepeak.smartlink_slug_change', p_brand_id, true);
  begin
    update public.brands
       set smartlink_slug = v_slug, updated_at = now()
     where id = p_brand_id;
  exception when unique_violation then
    perform set_config('fablepeak.smartlink_slug_change', '', true);
    return jsonb_build_object('ok', false, 'error', 'slug_taken');
  end;
  perform set_config('fablepeak.smartlink_slug_change', '', true);

  -- Retain the outgoing name, then reserve the incoming one.
  if v_current is not null then
    insert into public.smartlink_slug_aliases (slug, brand_id)
    values (lower(v_current), p_brand_id)
    on conflict (slug) do nothing;
  end if;
  insert into public.smartlink_slug_aliases (slug, brand_id)
  values (v_slug, p_brand_id)
  on conflict (slug) do nothing;

  return jsonb_build_object('ok', true, 'slug', v_slug, 'changed', true);
end
$$;

revoke all on function public.set_smartlink_slug(text, text) from public;
revoke all on function public.set_smartlink_slug(text, text) from anon;
grant execute on function public.set_smartlink_slug(text, text) to authenticated;

-- --------------------------------------------------------------- public read
-- Decision 7: exact match, security definer, schema-qualified, restricted
-- search_path, default execution revoked, execute granted only to the intended
-- roles. Not a view: PostgREST would let anyone list every published page with
-- one unfiltered select, and an exact-match RPC has no enumeration surface.
--
-- Returns ONLY presentation fields. Never brand_id — the public page must not
-- learn the key that every RLS policy is written against — and never any other
-- jsonb key the editor happens to have stored (the legacy per-link `clicks`
-- counter included). Returns '{}' for an unknown slug and for a brand whose
-- smartlink_public is false, so unpublishing takes effect immediately and the
-- two cases are indistinguishable to a caller.
--
-- The caps and shape checks below are defence in depth, not the primary
-- defence: the renderer must still build DOM nodes with textContent and
-- re-validate every field (ADR 0004 decision 4).
create or replace function public.get_smartlink(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with wanted as (
    select lower(btrim(coalesce(p_slug, ''))) as slug
  ),
  resolved as (
    select b.id,
           b.smartlink,
           coalesce(lower(b.smartlink_slug), w.slug) as slug
      from public.brands b
      cross join wanted w
     where b.smartlink_public
       and w.slug <> ''
       and (
         lower(b.smartlink_slug) = w.slug
         -- a retired slug still resolves, but only while its owning brand
         -- exists (cascade) and is still published (predicate above)
         or exists (
           select 1 from public.smartlink_slug_aliases a
            where a.brand_id = b.id and a.slug = w.slug
         )
       )
     limit 1
  )
  select coalesce(
    (
      select jsonb_build_object(
        'slug', r.slug,
        'title', left(coalesce(r.smartlink->>'title', ''), 120),
        'bio', left(coalesce(r.smartlink->>'bio', ''), 400),
        'avatar', left(coalesce(r.smartlink->>'avatar', ''), 8),
        'color', case
                   when coalesce(r.smartlink->>'color', '') ~ '^#[0-9a-fA-F]{6}$'
                   then lower(r.smartlink->>'color')
                   else '#22c1dc'
                 end,
        'links', (
          select coalesce(
                   jsonb_agg(
                     jsonb_build_object(
                       'id', left(coalesce(t.l->>'id', ''), 64),
                       'title', left(coalesce(t.l->>'title', ''), 120),
                       'url', left(t.l->>'url', 2000)
                     ) order by t.ord
                   ),
                   '[]'::jsonb
                 )
            from jsonb_array_elements(
                   case when jsonb_typeof(r.smartlink->'links') = 'array'
                        then r.smartlink->'links'
                        else '[]'::jsonb end
                 ) with ordinality as t(l, ord)
           where jsonb_typeof(t.l) = 'object'
             and coalesce(t.l->>'url', '') ~* '^https?://'
             and t.ord <= 50
        )
      )
      from resolved r
    ),
    '{}'::jsonb
  )
$$;

revoke all on function public.get_smartlink(text) from public;
grant execute on function public.get_smartlink(text) to anon, authenticated;

-- ------------------------------------------------------------- click records
-- Deliberately PII-free (decision 9 and privacy.html): no IP address, no user
-- agent, no cookie, no device identifier, no visitor id. The registrable-ish
-- hostname is the coarsest referrer signal that is still useful, and it is the
-- only visitor-derived value stored at all.
--
-- link_id rather than a bare index: reordering or inserting a link would
-- otherwise silently re-attribute every historical row. "position" is a
-- denormalized 1-based order snapshot, for reporting only.
create table if not exists public.smartlink_clicks (
  id bigint generated always as identity primary key,
  brand_id text not null references public.brands(id) on delete cascade,
  slug text not null,
  link_id text not null,
  "position" smallint,
  clicked_at timestamptz not null default now(),
  referrer_host text
);

create index if not exists smartlink_clicks_brand_link_idx
  on public.smartlink_clicks (brand_id, link_id, clicked_at desc);
-- backs the per-slug per-minute ceiling in record_smartlink_click
create index if not exists smartlink_clicks_slug_recent_idx
  on public.smartlink_clicks (slug, clicked_at desc);
-- backs the 90-day retention sweep
create index if not exists smartlink_clicks_clicked_at_idx
  on public.smartlink_clicks (clicked_at);

alter table public.smartlink_clicks enable row level security;

-- No anon policy exists and none may be added: anon writes go exclusively
-- through record_smartlink_click. A direct anon INSERT policy would let anyone
-- write arbitrary brand_id, clicked_at and referrer values.
revoke all on public.smartlink_clicks from public, anon, authenticated;
grant select on public.smartlink_clicks to authenticated;
grant all on public.smartlink_clicks to service_role;

drop policy if exists smartlink_clicks_select on public.smartlink_clicks;
create policy smartlink_clicks_select on public.smartlink_clicks
  for select to authenticated using (public.is_member(brand_id));

-- ----------------------------------------------------------------- click RPC
-- Decision 8: an anon RPC is proportionate at beta scale; move this behind an
-- Edge Function if abuse or a need for sophisticated filtering appears.
--
-- Returns void unconditionally. An unknown slug, an unpublished brand, an
-- unknown link_id and an over-ceiling write are all silently dropped and are
-- indistinguishable from a successful write, so the endpoint cannot be used to
-- probe which slugs exist. The page fires this with fetch(keepalive: true) and
-- navigates regardless — tracking must never delay or block a link.
create or replace function public.record_smartlink_click(
  p_slug text,
  p_link_id text,
  p_referrer text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_link text := btrim(coalesce(p_link_id, ''));
  v_brand text;
  v_store_slug text;
  v_smartlink jsonb;
  v_position smallint;
  v_host text;
  v_recent bigint;
begin
  if v_slug = '' or v_link = '' or length(v_link) > 64 then
    return;
  end if;

  -- resolve through the current slug or a retained alias; unpublished brands
  -- resolve to nothing, so unpublishing stops click collection immediately
  select b.id,
         coalesce(lower(b.smartlink_slug), v_slug),
         b.smartlink
    into v_brand, v_store_slug, v_smartlink
    from public.brands b
   where b.smartlink_public
     and (
       lower(b.smartlink_slug) = v_slug
       or exists (
         select 1 from public.smartlink_slug_aliases a
          where a.brand_id = b.id and a.slug = v_slug
       )
     )
   limit 1;

  if v_brand is null then
    return;
  end if;

  -- refuse a link_id that is not present in that brand's jsonb
  select t.ord::smallint into v_position
    from jsonb_array_elements(
           case when jsonb_typeof(v_smartlink->'links') = 'array'
                then v_smartlink->'links'
                else '[]'::jsonb end
         ) with ordinality as t(l, ord)
   where t.l->>'id' = v_link
   limit 1;

  if v_position is null then
    return;
  end if;

  -- Per-slug per-minute ceiling (decision 9). A plain count, not a token
  -- bucket: our privacy rule forbids IP or fingerprint dedupe, so counts are
  -- approximate by construction and the UI must label them as such.
  select count(*) into v_recent
    from public.smartlink_clicks c
   where c.slug = v_store_slug
     and c.clicked_at > now() - interval '1 minute';
  if v_recent >= 600 then
    return;
  end if;

  -- Reduce the referrer to a bare lowercase hostname. Scheme, userinfo, port,
  -- path, query and fragment are all discarded before anything is stored, and
  -- anything that does not look like a hostname is dropped entirely.
  v_host := lower(btrim(coalesce(p_referrer, '')));
  v_host := regexp_replace(v_host, '^[a-z][a-z0-9+.-]*://', '');
  v_host := split_part(v_host, '/', 1);
  v_host := split_part(v_host, '?', 1);
  v_host := split_part(v_host, '#', 1);
  v_host := regexp_replace(v_host, '^[^@]*@', '');
  v_host := split_part(v_host, ':', 1);
  if length(v_host) > 100
     or v_host !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then
    v_host := null;
  end if;

  insert into public.smartlink_clicks (brand_id, slug, link_id, "position", referrer_host)
  values (v_brand, v_store_slug, v_link, v_position, v_host);
end
$$;

revoke all on function public.record_smartlink_click(text, text, text) from public;
grant execute on function public.record_smartlink_click(text, text, text) to anon, authenticated;

-- --------------------------------------------------------- member aggregates
-- security_invoker so the caller's RLS decides what they see; the is_member
-- predicate is kept as well, matching the existing tenant-scoped views in this
-- schema. The editor reads this and stops treating brands.smartlink.clicks as
-- authoritative (decision 11); demo/local mode keeps its simulated numbers.
-- last_90d equals total in steady state because raw rows are pruned at 90 days
-- — it is stated explicitly so the retention window is legible in the API.
drop view if exists public.smartlink_click_totals;
create view public.smartlink_click_totals
with (security_invoker = true) as
  select c.brand_id,
         c.link_id,
         count(*)::bigint as total,
         count(*) filter (where c.clicked_at > now() - interval '7 days')::bigint as last_7d,
         count(*) filter (where c.clicked_at > now() - interval '90 days')::bigint as last_90d,
         max(c.clicked_at) as last_click_at
    from public.smartlink_clicks c
   where public.is_member(c.brand_id)
   group by c.brand_id, c.link_id;

revoke all on public.smartlink_click_totals from public, anon;
grant select on public.smartlink_click_totals to authenticated;

-- ------------------------------------------------------------- 90-day purge
-- Decision 10, as amended: raw click rows are deleted after 90 days, and
-- aggregates are NOT retained indefinitely — smartlink_clicks and
-- smartlink_slug_aliases both cascade from brands, so deleting a brand deletes
-- its entire click history and slug history with it.
--
-- Folded into the existing retention job rather than adding another one:
-- 'fablepeak-prune-job-runs' (migrations/20260809120000_scheduled_job_health.sql)
-- is this schema's only scheduled data-retention sweep, and cron.schedule
-- replaces a job of the same name. If pg_cron is ever unavailable, the
-- equivalent manual statement is:
--   delete from public.smartlink_clicks where clicked_at < now() - interval '90 days';
select cron.schedule(
  'fablepeak-prune-job-runs',
  '41 20 * * *',
  $job$
    delete from public.scheduled_job_runs where started_at < now() - interval '30 days';
    delete from public.smartlink_clicks where clicked_at < now() - interval '90 days';
  $job$
);
