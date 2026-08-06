-- Fresh-environment baseline. The production project predates migration
-- tracking, so the canonical base schemas are included in the first tracked
-- migration. Existing linked projects already record this migration as
-- applied; a fresh `supabase db reset` creates the complete schema before
-- the incremental scheduling and hardening statements below.

-- FablePeak shared backend schema (BACKEND_SPEC.md §3)
-- Run in Supabase SQL editor. Idempotent-ish: drops nothing; safe on fresh project.

create table if not exists public.brands (
  id text primary key,
  name text not null,
  seed int not null default 0,
  connections jsonb not null default '{}',
  smartlink jsonb not null default '{}',
  client_id text,
  updated_at timestamptz not null default now()
);

create table if not exists public.posts (
  id text primary key,
  brand_id text not null references public.brands(id) on delete cascade,
  date date not null,
  time text not null default '10:00',
  text text not null,
  networks jsonb not null default '[]',
  status text not null default 'draft' check (status in ('draft','scheduled','published')),
  client_id text,
  updated_at timestamptz not null default now()
);

create table if not exists public.inbox_threads (
  id text primary key,
  brand_id text not null references public.brands(id) on delete cascade,
  net text not null,
  sender text not null,
  resolved boolean not null default false,
  unread boolean not null default true,
  msgs jsonb not null default '[]',
  client_id text,
  updated_at timestamptz not null default now()
);

create table if not exists public.brand_members (
  brand_id text not null references public.brands(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('owner','editor')),
  primary key (brand_id, user_id)
);

-- membership check without RLS recursion
create or replace function public.is_member(b text) returns boolean
language sql security definer stable set search_path = public as
$$ select exists (select 1 from public.brand_members where brand_id = b and user_id = auth.uid()) $$;

-- creator automatically becomes owner
create or replace function public.add_owner_membership() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.brand_members (brand_id, user_id, role)
  values (new.id, auth.uid(), 'owner')
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists brands_add_owner on public.brands;
create trigger brands_add_owner after insert on public.brands
for each row execute function public.add_owner_membership();

alter table public.brands enable row level security;
alter table public.posts enable row level security;
alter table public.inbox_threads enable row level security;
alter table public.brand_members enable row level security;

drop policy if exists brands_select on public.brands;
create policy brands_select on public.brands for select to authenticated using (public.is_member(id));
drop policy if exists brands_insert on public.brands;
create policy brands_insert on public.brands for insert to authenticated with check (true);
drop policy if exists brands_update on public.brands;
create policy brands_update on public.brands for update to authenticated using (public.is_member(id));
drop policy if exists brands_delete on public.brands;
create policy brands_delete on public.brands for delete to authenticated using (public.is_member(id));

drop policy if exists posts_all on public.posts;
create policy posts_all on public.posts for all to authenticated
  using (public.is_member(brand_id)) with check (public.is_member(brand_id));

drop policy if exists inbox_all on public.inbox_threads;
create policy inbox_all on public.inbox_threads for all to authenticated
  using (public.is_member(brand_id)) with check (public.is_member(brand_id));

drop policy if exists members_select on public.brand_members;
create policy members_select on public.brand_members for select to authenticated
  using (user_id = auth.uid() or public.is_member(brand_id));

-- realtime change feed
do $$ begin
  alter publication supabase_realtime add table public.brands;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.posts;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.inbox_threads;
exception when duplicate_object then null; end $$;

-- Real scheduled publishing is installed by
-- migrations/20260731090000_reliable_scheduling.sql after schema_social.sql.
-- Never mark a live post "published" from SQL alone: only the publish Edge
-- Function may do that after at least one platform confirms delivery.

-- FablePeak — REAL social platform integration (phase 2)
-- Run in Supabase SQL editor AFTER schema.sql.
--
-- Security model: `social_connections` holds application-encrypted OAuth
-- access/refresh tokens (legacy rows may remain plaintext until refreshed).
-- It has RLS enabled and *no* policies, so the anon/authenticated client
-- keys can never read it. Only Edge Functions (service_role, which bypasses
-- RLS) touch tokens. The browser reads the token-free `social_accounts_public`
-- view instead.

-- posts gain a media URL — Instagram, TikTok and YouTube cannot publish without one
alter table public.posts add column if not exists media_url text;

-- ---------------------------------------------------------------- connections
create table if not exists public.social_connections (
  id uuid primary key default gen_random_uuid(),
  brand_id text not null references public.brands(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in
    ('youtube','x','instagram','facebook','linkedin','tiktok','pinterest','gbp')),
  -- identity on the remote platform
  external_id text,                     -- channel id / page id / ig user id
  display_name text,                    -- "@handle" or channel title
  avatar_url text,
  -- secrets: service_role only
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  scopes text,
  meta jsonb not null default '{}',     -- platform extras (page tokens, ig business id…)
  is_default boolean not null default false, -- selected publishing account for this platform
  status text not null default 'active' check (status in ('active','expired','revoked','error')),
  last_error text,
  connected_at timestamptz not null default now(),
  last_verified_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (brand_id, platform, external_id)
);

alter table public.social_connections enable row level security;
-- deliberately NO policies: clients get zero rows; Edge Functions use service_role.

-- Token-free projection the browser is allowed to read. This view must run as
-- its privileged owner because social_connections intentionally has no client
-- RLS policies. The membership predicate is the row-level authorization gate.
create or replace view public.social_accounts_public
with (security_invoker = off, security_barrier = true) as
select c.id, c.brand_id, c.platform, c.external_id, c.display_name,
       c.avatar_url, c.status, c.last_error, c.connected_at, c.last_verified_at, c.is_default,
       (c.token_expires_at is not null and c.token_expires_at < now()
        and c.refresh_token is null) as needs_reauth
from public.social_connections c
where public.is_member(c.brand_id);

grant select on public.social_accounts_public to authenticated;

-- --------------------------------------------------------------- oauth states
-- short-lived CSRF/PKCE state for the OAuth handshake (service_role only)
create table if not exists public.oauth_states (
  state text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  brand_id text not null references public.brands(id) on delete cascade,
  platform text not null,
  code_verifier text,
  redirect_to text,
  created_at timestamptz not null default now()
);
alter table public.oauth_states enable row level security;

-- ---------------------------------------------------------------- publishing
-- one row per (post, platform) delivery attempt — the real publish record
create table if not exists public.post_targets (
  id uuid primary key default gen_random_uuid(),
  post_id text not null references public.posts(id) on delete cascade,
  brand_id text not null references public.brands(id) on delete cascade,
  platform text not null,
  connection_id uuid references public.social_connections(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending','publishing','published','failed','skipped')),
  remote_id text,                        -- tweet id / video id / ig media id
  remote_url text,
  error text,
  attempts int not null default 0,
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (post_id, platform)
);
alter table public.post_targets enable row level security;
drop policy if exists targets_select on public.post_targets;
create policy targets_select on public.post_targets for select to authenticated
  using (public.is_member(brand_id));

-- ------------------------------------------------------------------ metrics
-- cumulative platform snapshots pulled daily; the frontend derives daily
-- impression/engagement deltas and carries follower totals forward
create table if not exists public.metrics_daily (
  brand_id text not null references public.brands(id) on delete cascade,
  platform text not null,
  date date not null,
  followers bigint,
  impressions bigint,
  engagements bigint,
  posts int,
  raw jsonb not null default '{}',
  fetched_at timestamptz not null default now(),
  primary key (brand_id, platform, date)
);
alter table public.metrics_daily enable row level security;
drop policy if exists metrics_select on public.metrics_daily;
create policy metrics_select on public.metrics_daily for select to authenticated
  using (public.is_member(brand_id));

-- realtime so the UI updates the moment a publish lands
do $$ begin alter publication supabase_realtime add table public.post_targets;
exception when duplicate_object then null; end $$;

-- --------------------------------------------------- brand create/update RPC
-- Creating a brand is an RLS chicken-and-egg: the policies require you to own
-- the brand, but ownership only exists once the row is created. A client-side
-- upsert also trips Postgres's ON CONFLICT + RLS interaction ("new row violates
-- row-level security policy"). Doing both steps atomically server-side avoids
-- the whole problem. The client calls this instead of upserting `brands`.
create or replace function public.save_brand(
  p_id text, p_name text, p_seed int,
  p_connections jsonb default '{}', p_smartlink jsonb default '{}'
) returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not authenticated'; end if;

  if exists (select 1 from public.brands where id = p_id) then
    if not public.is_member(p_id) then raise exception 'not authorised for this brand'; end if;
    update public.brands set name = p_name, seed = coalesce(p_seed, seed),
           connections = coalesce(p_connections,'{}'), smartlink = coalesce(p_smartlink,'{}'),
           updated_at = now()
     where id = p_id;
  else
    insert into public.brands (id,name,seed,connections,smartlink)
      values (p_id,p_name,coalesce(p_seed,0),coalesce(p_connections,'{}'),coalesce(p_smartlink,'{}'));
  end if;

  insert into public.brand_members (brand_id, user_id, role)
    values (p_id, me, 'owner') on conflict do nothing;
end $$;
revoke all on function public.save_brand(text,text,int,jsonb,jsonb) from public;
grant execute on function public.save_brand(text,text,int,jsonb,jsonb) to authenticated;

-- UPDATE policies need an explicit WITH CHECK; absent, Postgres reuses USING,
-- which breaks upserts. USING still controls which rows may be updated.
drop policy if exists brands_update on public.brands;
create policy brands_update on public.brands for update to authenticated
  using (public.is_member(id)) with check (true);

-- ------------------------------------------------------- disconnect (no RLS)
-- social_connections has no client policies, so removal goes through this
-- security-definer RPC, which checks brand membership and never returns tokens.
create or replace function public.disconnect_account(account_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare b text; p text; was_default boolean;
begin
  select brand_id, platform, is_default into b, p, was_default
    from public.social_connections where id = account_id;
  if b is null then return false; end if;
  if not public.is_member(b) then raise exception 'not authorised'; end if;
  delete from public.social_connections where id = account_id;
  if was_default then
    update public.social_connections set is_default = true
     where id = (select id from public.social_connections
                  where brand_id = b and platform = p and status = 'active'
                  order by connected_at limit 1);
  end if;
  return true;
end $$;
revoke all on function public.disconnect_account(uuid) from public;
grant execute on function public.disconnect_account(uuid) to authenticated;

-- Select which authorized account receives posts for a platform. Keeping this
-- server-side makes the switch atomic and enforces workspace membership.
create or replace function public.select_social_account(account_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare b text; p text;
begin
  select brand_id, platform into b, p from public.social_connections where id = account_id;
  if b is null then return false; end if;
  if not public.is_member(b) then raise exception 'not authorised'; end if;
  update public.social_connections set is_default = false
    where brand_id = b and platform = p and is_default;
  update public.social_connections set is_default = true where id = account_id;
  return true;
end $$;
revoke all on function public.select_social_account(uuid) from public;
grant execute on function public.select_social_account(uuid) to authenticated;

-- ------------------------------------------------------------------- indexes
create index if not exists idx_targets_pending on public.post_targets (status)
  where status in ('pending','publishing');
create index if not exists idx_conn_brand on public.social_connections (brand_id);
create unique index if not exists idx_conn_one_default
  on public.social_connections (brand_id, platform) where is_default;
create index if not exists idx_metrics_brand_date on public.metrics_daily (brand_id, date desc);

-- Reliable server-side scheduling for real social publishing.
--
-- Required Vault secrets (set once in Supabase Vault before relying on cron):
--   project_url  = https://<project-ref>.supabase.co
--   anon_key     = the project's public anon key
--   cron_secret  = the same value as the Edge Function CRON_SECRET

alter table public.posts add column if not exists publish_claimed_at timestamptz;

alter table public.posts drop constraint if exists posts_status_check;
alter table public.posts add constraint posts_status_check
  check (status in ('draft', 'scheduled', 'publishing', 'published'));

-- Claim due posts in one transaction. The wall-clock date/time is interpreted
-- in the configured IANA timezone, including daylight-saving transitions.
create or replace function public.claim_due_posts(
  p_timezone text default 'Australia/Perth',
  p_limit int default 25
) returns setof public.posts
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Force PostgreSQL to validate the supplied IANA timezone even if no rows
  -- are currently due.
  perform now() at time zone p_timezone;

  return query
  with candidates as (
    select p.id
    from public.posts p
    where p.status = 'scheduled'
      and (p.date + coalesce(nullif(p.time, ''), '10:00')::time)
          <= (now() at time zone p_timezone)
    order by p.date, p.time, p.id
    for update skip locked
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
  )
  update public.posts p
     set status = 'publishing',
         publish_claimed_at = now(),
         updated_at = now()
    from candidates c
   where p.id = c.id
  returning p.*;
end
$$;

-- Manual "Publish now" uses the same single-claim rule as cron. Published or
-- already-publishing posts cannot accidentally be delivered again.
create or replace function public.claim_post_for_publish(p_post_id text)
returns setof public.posts
language sql
security definer
set search_path = public
as $$
  update public.posts
     set status = 'publishing',
         publish_claimed_at = now(),
         updated_at = now()
   where id = p_post_id
     and status in ('draft', 'scheduled')
  returning *
$$;

revoke all on function public.claim_due_posts(text, int) from public;
revoke all on function public.claim_due_posts(text, int) from anon, authenticated;
grant execute on function public.claim_due_posts(text, int) to service_role;

revoke all on function public.claim_post_for_publish(text) from public;
revoke all on function public.claim_post_for_publish(text) from anon, authenticated;
grant execute on function public.claim_post_for_publish(text) to service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Remove the legacy job that merely changed status to "published" without
-- calling a social platform, plus older copies of the real jobs.
do $$
declare existing_job record;
begin
  for existing_job in
    select jobid
      from cron.job
     where jobname in (
       'fablepeak-auto-publish',
       'fablepeak-publish-due',
       'fablepeak-metrics'
     )
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end
$$;

select cron.schedule(
  'fablepeak-publish-due',
  '* * * * *',
  $job$
    select net.http_post(
      url := (
        select decrypted_secret
          from vault.decrypted_secrets
         where name = 'project_url'
         limit 1
      ) || '/functions/v1/publish',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
            from vault.decrypted_secrets
           where name = 'anon_key'
           limit 1
        ),
        'apikey', (
          select decrypted_secret
            from vault.decrypted_secrets
           where name = 'anon_key'
           limit 1
        ),
        'x-cron-secret', (
          select decrypted_secret
            from vault.decrypted_secrets
           where name = 'cron_secret'
           limit 1
        )
      ),
      body := '{"due":true}'::jsonb,
      timeout_milliseconds := 120000
    );
  $job$
);

-- pg_cron runs in UTC. 19:17 UTC is 03:17 the next day in Perth.
select cron.schedule(
  'fablepeak-metrics',
  '17 19 * * *',
  $job$
    select net.http_post(
      url := (
        select decrypted_secret
          from vault.decrypted_secrets
         where name = 'project_url'
         limit 1
      ) || '/functions/v1/ingest-metrics',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
            from vault.decrypted_secrets
           where name = 'anon_key'
           limit 1
        ),
        'apikey', (
          select decrypted_secret
            from vault.decrypted_secrets
           where name = 'anon_key'
           limit 1
        ),
        'x-cron-secret', (
          select decrypted_secret
            from vault.decrypted_secrets
           where name = 'cron_secret'
           limit 1
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $job$
);
