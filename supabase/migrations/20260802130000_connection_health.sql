-- Persist token-free evidence of the last successful provider identity check.
alter table public.social_connections
  add column if not exists last_verified_at timestamptz;

create or replace view public.social_accounts_public
with (security_invoker = off, security_barrier = true) as
select c.id, c.brand_id, c.platform, c.external_id, c.display_name,
       c.avatar_url, c.status, c.last_error, c.connected_at,
       c.last_verified_at, c.is_default,
       (c.token_expires_at is not null and c.token_expires_at < now()
        and c.refresh_token is null) as needs_reauth
from public.social_connections c
where public.is_member(c.brand_id);

grant select on public.social_accounts_public to authenticated;
