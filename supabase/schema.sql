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
