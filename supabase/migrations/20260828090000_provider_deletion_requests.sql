-- Durable record of provider-initiated data-deletion callbacks. Meta requires
-- a confirmation code the customer can quote, so the code must survive the
-- request that issued it. Only the Edge Function (service_role) touches this
-- table; it holds a provider-scoped identifier, never a FablePeak identity.
create table if not exists public.provider_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  provider_user_id text not null,
  platform text not null,
  status text not null default 'received'
    check (status in ('received', 'completed', 'no_matching_connection')),
  confirmation_code text not null unique,
  created_at timestamptz not null default now()
);

alter table public.provider_deletion_requests enable row level security;
-- deliberately NO policies: clients get zero rows; the Edge Function uses
-- service_role, which bypasses RLS.

revoke all on public.provider_deletion_requests from public, anon, authenticated;
grant all on public.provider_deletion_requests to service_role;

create index if not exists idx_provider_deletion_identity
  on public.provider_deletion_requests (platform, provider_user_id);
create index if not exists idx_provider_deletion_created
  on public.provider_deletion_requests (created_at desc);
