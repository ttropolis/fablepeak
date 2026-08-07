-- Pinterest exposes boards as selectable publishing destinations but the
-- minimal publishing scopes do not expose a stable user-account identifier.
-- Enforce one Pinterest authorization per workspace and replace its board set
-- atomically so concurrent OAuth callbacks cannot mix credentials.
create or replace function public.replace_shared_social_connections(
  p_brand_id text,
  p_platform text,
  p_rows jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_platform <> 'pinterest' then
    raise exception 'unsupported shared authorization platform';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'at least one connection is required';
  end if;

  -- The transaction-scoped lock serializes replacement for this exact
  -- workspace/platform while allowing unrelated tenants to proceed.
  perform pg_advisory_xact_lock(hashtextextended(p_brand_id || ':' || p_platform, 0));

  delete from public.social_connections
   where brand_id = p_brand_id and platform = p_platform;

  insert into public.social_connections (
    brand_id, user_id, platform, external_id, display_name, avatar_url,
    access_token, refresh_token, token_expires_at, scopes, meta, is_default,
    status, last_error, last_verified_at, updated_at
  )
  select
    row.brand_id, row.user_id, row.platform, row.external_id, row.display_name,
    row.avatar_url, row.access_token, row.refresh_token, row.token_expires_at,
    row.scopes, coalesce(row.meta, '{}'::jsonb), coalesce(row.is_default, false),
    coalesce(row.status, 'active'), row.last_error, row.last_verified_at,
    coalesce(row.updated_at, now())
  from jsonb_to_recordset(p_rows) as row(
    brand_id text,
    user_id uuid,
    platform text,
    external_id text,
    display_name text,
    avatar_url text,
    access_token text,
    refresh_token text,
    token_expires_at timestamptz,
    scopes text,
    meta jsonb,
    is_default boolean,
    status text,
    last_error text,
    last_verified_at timestamptz,
    updated_at timestamptz
  )
  where row.brand_id = p_brand_id and row.platform = p_platform;

  if not found then
    raise exception 'connection rows did not match the requested workspace';
  end if;
end;
$$;

revoke all on function public.replace_shared_social_connections(text, text, jsonb) from public;
grant execute on function public.replace_shared_social_connections(text, text, jsonb) to service_role;
