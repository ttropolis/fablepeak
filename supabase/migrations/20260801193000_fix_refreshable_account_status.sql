-- Expired short-lived access tokens do not require reconnecting when the
-- server can renew them with a stored refresh token.
--
-- The fresh-project baseline contains the latest token-free projection, while
-- this historical migration intentionally rebuilds its earlier column set.
-- PostgreSQL cannot remove or reorder view columns with CREATE OR REPLACE, so
-- drop the projection first. It has no dependent objects and its browser grant
-- is restored immediately below.
drop view if exists public.social_accounts_public;

create or replace view public.social_accounts_public
with (security_invoker = off, security_barrier = true) as
select c.id, c.brand_id, c.platform, c.external_id, c.display_name,
       c.avatar_url, c.status, c.last_error, c.connected_at,
       (c.token_expires_at is not null and c.token_expires_at < now()
        and c.refresh_token is null) as needs_reauth
from public.social_connections c
where public.is_member(c.brand_id);

grant select on public.social_accounts_public to authenticated;
