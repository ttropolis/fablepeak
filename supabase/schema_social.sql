-- FablePeak — REAL social platform integration (phase 2)
-- Run in Supabase SQL editor AFTER schema.sql.
--
-- Security model: `social_connections` holds OAuth access/refresh tokens.
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
  status text not null default 'active' check (status in ('active','expired','revoked','error')),
  last_error text,
  connected_at timestamptz not null default now(),
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
       c.avatar_url, c.status, c.last_error, c.connected_at,
       (c.token_expires_at is not null and c.token_expires_at < now()) as needs_reauth
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
-- real metrics pulled daily from platform APIs
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
declare b text;
begin
  select brand_id into b from public.social_connections where id = account_id;
  if b is null then return false; end if;
  if not public.is_member(b) then raise exception 'not authorised'; end if;
  delete from public.social_connections where id = account_id;
  return true;
end $$;
revoke all on function public.disconnect_account(uuid) from public;
grant execute on function public.disconnect_account(uuid) to authenticated;

-- ------------------------------------------------------------------- indexes
create index if not exists idx_targets_pending on public.post_targets (status)
  where status in ('pending','publishing');
create index if not exists idx_conn_brand on public.social_connections (brand_id);
create index if not exists idx_metrics_brand_date on public.metrics_daily (brand_id, date desc);
