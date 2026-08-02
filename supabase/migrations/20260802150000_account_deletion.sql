-- Make application-data deletion one database transaction and retain the
-- workspace paths long enough for resumable Storage cleanup.
create table if not exists public.account_deletion_jobs (
  user_id uuid primary key,
  brand_ids text[] not null default '{}',
  created_at timestamptz not null default now()
);

revoke all on public.account_deletion_jobs from public, anon, authenticated;
grant all on public.account_deletion_jobs to service_role;

create or replace function public.prepare_account_deletion(target_user uuid)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  pending text[];
  sole_owned text[];
  owned record;
  removed record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorised';
  end if;

  select brand_ids into pending
    from public.account_deletion_jobs where user_id = target_user;
  if pending is not null then return pending; end if;

  select coalesce(array_agg(m.brand_id), '{}'::text[]) into sole_owned
    from public.brand_members m
   where m.user_id = target_user and m.role = 'owner'
     and not exists (
       select 1 from public.brand_members other
        where other.brand_id = m.brand_id and other.user_id <> target_user
     );

  insert into public.account_deletion_jobs(user_id, brand_ids)
  values (target_user, sole_owned);

  delete from public.oauth_states where user_id = target_user;

  for removed in
    delete from public.social_connections where user_id = target_user
    returning brand_id, platform, is_default
  loop
    if removed.is_default then
      update public.social_connections set is_default = true
       where id = (
         select id from public.social_connections
          where brand_id = removed.brand_id and platform = removed.platform
            and status = 'active'
          order by connected_at, id limit 1
       );
    end if;
  end loop;

  for owned in
    select brand_id from public.brand_members
     where user_id = target_user and role = 'owner'
  loop
    if owned.brand_id = any(sole_owned) then
      delete from public.brands where id = owned.brand_id;
    elsif not exists (
      select 1 from public.brand_members
       where brand_id = owned.brand_id and user_id <> target_user and role = 'owner'
    ) then
      update public.brand_members set role = 'owner'
       where brand_id = owned.brand_id and user_id = (
         select user_id from public.brand_members
          where brand_id = owned.brand_id and user_id <> target_user
          order by user_id limit 1
       );
    end if;
  end loop;

  delete from public.brand_members where user_id = target_user;
  return sole_owned;
end;
$$;

revoke all on function public.prepare_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.prepare_account_deletion(uuid) to service_role;
