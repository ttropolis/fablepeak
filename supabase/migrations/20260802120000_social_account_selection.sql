-- Let customers authorize several provider assets and explicitly choose the
-- account used for publishing in each workspace.
alter table public.social_connections
  add column if not exists is_default boolean not null default false;

-- Preserve existing behavior by selecting the oldest active connection for
-- every brand/platform that does not already have a selection.
with ranked as (
  select id, row_number() over (
    partition by brand_id, platform order by connected_at, id
  ) as position
  from public.social_connections
  where status = 'active'
), missing as (
  select r.id
  from ranked r
  join public.social_connections c on c.id = r.id
  where r.position = 1
    and not exists (
      select 1 from public.social_connections selected
      where selected.brand_id = c.brand_id
        and selected.platform = c.platform
        and selected.is_default
    )
)
update public.social_connections c set is_default = true
where c.id in (select id from missing);

create unique index if not exists idx_conn_one_default
  on public.social_connections (brand_id, platform) where is_default;

create or replace view public.social_accounts_public
with (security_invoker = off, security_barrier = true) as
select c.id, c.brand_id, c.platform, c.external_id, c.display_name,
       c.avatar_url, c.status, c.last_error, c.connected_at,
       (c.token_expires_at is not null and c.token_expires_at < now()
        and c.refresh_token is null) as needs_reauth,
       c.is_default
from public.social_connections c
where public.is_member(c.brand_id);

grant select on public.social_accounts_public to authenticated;

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
