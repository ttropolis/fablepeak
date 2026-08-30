-- ADR 0006 step 1 (accepted): brand_members.role stops being decorative.
--
-- Until now every policy and every security-definer RPC asked only
-- `is_member(brand_id)`, so an editor could delete the brand, disconnect a
-- customer's Facebook Page and publish a SmartLinks page. This migration adds
-- the owner predicate, repairs any workspace that could be stranded by it, and
-- gates the four surfaces the owner named: brand deletion, SmartLinks
-- publication, account disconnect and account re-selection.
--
-- Section map. The order is load-bearing, not cosmetic:
--   1. public.is_owner(text)             pure addition, mirrors public.is_member
--   2. ownerless-brand backfill          MUST precede every restrictive
--                                        predicate below (ADR 0006 §6)
--   3. final-owner trigger               keeps the invariant §2 establishes
--   4. brand_members write policies      additive: RLS denies every client
--                                        write to this table today
--   5. brands_delete  is_member → is_owner          (first restrictive change)
--   6. brands_guard_smartlink_slug       smartlink_public becomes owner-only
--   7. set_smartlink_slug                is_member → is_owner
--   8. disconnect_account / select_social_account   is_member → is_owner
--
-- Deliberately NOT here, and still open ADR 0006 work: brand_invites and the
-- accept/decline flow, brand_member_list, the pending_approval status and its
-- posts trigger, and the Settings → Team card. Nothing below depends on them.

-- ------------------------------------------------------------------ 1. is_owner
-- Mirrors public.is_member(text) exactly: same argument shape, same
-- `security definer stable set search_path = public`. Definer rights are not a
-- style choice here — the brand_members policies in §4 call this function, and
-- an invoker-rights predicate that reads brand_members from a brand_members
-- policy recurses forever.
create or replace function public.is_owner(b text) returns boolean
language sql security definer stable set search_path = public as
$$ select exists (select 1 from public.brand_members
                   where brand_id = b and user_id = auth.uid() and role = 'owner') $$;

-- is_member predates any grant discipline in this schema and is executable by
-- everyone. is_owner is new, so it starts narrow: the roles that actually
-- evaluate it are `authenticated` (RLS predicates run as the querying role) and
-- service_role. The definer functions and triggers below call it as their own
-- owner and are unaffected by these grants.
revoke all on function public.is_owner(text) from public;
revoke all on function public.is_owner(text) from anon;
grant execute on function public.is_owner(text) to authenticated, service_role;

-- ------------------------------------------------------- 2. ownerless backfill
-- Log note: on a healthy database this statement updates ZERO rows.
-- `add_owner_membership` (schema.sql) and `save_brand` (schema_social.sql) have
-- always written 'owner' for the creator, so an ownerless brand can only exist
-- if a row was hand-edited in the dashboard — which README § "Multi-user / cloud
-- sync" tells the operator to do. It runs anyway, and it runs *first*, because
-- from §5 onward an ownerless brand would be permanently undeletable, its
-- accounts permanently un-disconnectable, and its page permanently
-- unpublishable, with no in-product way to repair it.
--
-- Brands with no members at all are left exactly as they are: no client can
-- reach them (every policy in this schema is written on membership), so there
-- is nobody to promote and nothing a promotion would fix.
--
-- brand_members has no created_at, so "the earliest member" is not recorded
-- anywhere. The promotion therefore picks the lowest user_id: deterministic,
-- re-runnable, and the same tie-break public.prepare_account_deletion already
-- uses when it hands ownership on (20260802150000_account_deletion.sql).
update public.brand_members m
   set role = 'owner'
 where m.role <> 'owner'
   and not exists (
     select 1 from public.brand_members o
      where o.brand_id = m.brand_id and o.role = 'owner')
   and m.user_id = (
     select x.user_id from public.brand_members x
      where x.brand_id = m.brand_id
      order by x.user_id
      limit 1);

-- -------------------------------------------------- 3. final-owner protection
-- A trigger, not a policy: only a trigger sees OLD, and the rule is about the
-- rows that would remain after the write, which RLS cannot express.
--
-- Service-role writes bypass RLS but NOT triggers, so this fires for the Edge
-- Functions too. That is intended and safe: prepare_account_deletion already
-- promotes a replacement owner before it deletes the departing user's rows, so
-- it never trips the invariant.
create or replace function public.brand_members_keep_an_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_brand text := old.brand_id;
  v_other_owners int;
  v_other_members int;
begin
  -- Promotions, and any update that leaves this row an owner, cannot strand a
  -- workspace. Only removal and demotion can.
  if tg_op = 'UPDATE' and (new.role = 'owner' or old.role <> 'owner') then
    return new;
  end if;

  -- The brand itself is being deleted: `delete from public.brands` cascades
  -- into this table one row at a time, and the parent row is already gone by
  -- the time the cascade runs. Without this check, deleting a two-member brand
  -- would raise the moment the cascade reached its owner row, making an
  -- owner-deleted brand undeletable — the exact failure this migration exists
  -- to prevent. `delete from auth.users` cascades the same way.
  if exists (select 1 from public.brands b where b.id = v_brand) then
    select count(*) filter (where m.role = 'owner'), count(*)
      into v_other_owners, v_other_members
      from public.brand_members m
     where m.brand_id = v_brand and m.user_id <> old.user_id;

    -- DELETE of the last member of all is allowed: it leaves a memberless
    -- brand, which is unreachable rather than stranded, and §2 explains why
    -- those are left alone. Everything else must leave an owner behind.
    if v_other_owners = 0 and (tg_op = 'UPDATE' or v_other_members > 0) then
      raise exception
        'this workspace must keep at least one owner — promote another member first'
        using errcode = '23514';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

-- A `returns trigger` function cannot be invoked directly, but no client role
-- has any business holding EXECUTE on it either.
revoke all on function public.brand_members_keep_an_owner() from public;
revoke all on function public.brand_members_keep_an_owner() from anon, authenticated;

drop trigger if exists brand_members_keep_an_owner on public.brand_members;
create trigger brand_members_keep_an_owner
  before update or delete on public.brand_members
  for each row execute function public.brand_members_keep_an_owner();

-- ------------------------------------------- 4. brand_members write policies
-- There are no write policies on brand_members today, so RLS denies every
-- client INSERT/UPDATE/DELETE to it outright. These three add the capability
-- together with its guard rather than tightening an existing hole — the table
-- is strictly less permissive after this migration than the day it gains an
-- invite flow, and strictly no more permissive than it is today for anyone who
-- is not an owner.
--
-- members_select (schema.sql) is deliberately untouched: every member must keep
-- reading their own membership row, which is how the app learns its own role.
grant select, insert, update, delete on public.brand_members to authenticated;

drop policy if exists members_insert on public.brand_members;
create policy members_insert on public.brand_members for insert to authenticated
  with check (public.is_owner(brand_id));

drop policy if exists members_update on public.brand_members;
create policy members_update on public.brand_members for update to authenticated
  using (public.is_owner(brand_id)) with check (public.is_owner(brand_id));

-- Owners manage anyone; anyone may remove themselves (leave a workspace). The
-- final-owner trigger above is what stops the sole owner from leaving.
drop policy if exists members_delete on public.brand_members;
create policy members_delete on public.brand_members for delete to authenticated
  using (public.is_owner(brand_id) or user_id = auth.uid());

-- --------------------------------------------------- 5. owner-only brand delete
-- The one predicate this migration tightens. brands_select, brands_insert and
-- brands_update stay on is_member: editors compose, schedule, reply and upload,
-- and all three are load-bearing for that.
drop policy if exists brands_delete on public.brands;
create policy brands_delete on public.brands for delete to authenticated
  using (public.is_owner(id));

-- ------------------------------------------ 6. owner-only SmartLinks publishing
-- RLS is row-level and cannot express a column rule, so publication is gated in
-- the trigger that already guards this table's other SmartLinks column. The
-- slug rule below is unchanged from 20260829090000_public_smartlinks.sql and is
-- restated in full because `create or replace function` replaces a whole body.
--
-- Service-execution marker, strongest signal available in this schema first:
--
--   auth.role() = 'service_role'
--     The Edge Functions all call PostgREST with SUPABASE_SERVICE_ROLE_KEY, so
--     the request JWT carries that role. It is the same check
--     public.prepare_account_deletion (20260802150000_account_deletion.sql)
--     uses as its ONLY authorisation gate, which makes it this schema's
--     established service marker rather than a new invention.
--
--   no request context at all (auth.role() is null AND auth.uid() is null)
--     psql, a migration, pg_cron. These execute as a database superuser and are
--     already trusted with far more than a boolean column.
--
-- `auth.uid() is null` on its own is deliberately NOT the marker: it is also
-- true for an anonymous PostgREST request carrying the anon key, which is a
-- browser, not a server. Anon cannot update brands today — no policy admits it
-- — but a trigger that would wave one through if a policy ever changed is a
-- trap, and the stronger check costs nothing.
create or replace function public.brands_guard_smartlink_slug()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce(auth.role(), '');
  v_service boolean := v_role = 'service_role'
                    or (v_role = '' and auth.uid() is null);
begin
  -- Publication is owner-only (ADR 0006 decision 6). UPDATE only: an INSERT
  -- cannot publish anything, because brands_smartlink_public_needs_slug refuses
  -- a published brand without a slug and the slug rule below refuses a slug set
  -- outside set_smartlink_slug(). Checking OLD on INSERT would also raise.
  if tg_op = 'UPDATE'
     and new.smartlink_public is distinct from old.smartlink_public
     and not v_service
     and not public.is_owner(new.id) then
    raise exception 'only a workspace owner can publish or unpublish this page'
      using errcode = '42501';
  end if;

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

revoke all on function public.brands_guard_smartlink_slug() from public;
revoke all on function public.brands_guard_smartlink_slug() from anon, authenticated;

-- The trigger itself is unchanged and still bound to this function by name
-- (brands_guard_smartlink_slug, before insert or update on public.brands), so
-- replacing the body is the whole deployment.

-- --------------------------------------------- 7. owner-only slug claim/rename
-- Re-created from 20260829090000_public_smartlinks.sql with one line changed:
-- the internal is_member check becomes is_owner. Everything else — the emptied
-- search_path, every schema-qualified reference, the typed jsonb results, the
-- alias ledger writes and the grants — is preserved verbatim, because the slug
-- is half of the same publication decision the trigger above now gates.
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
  if not public.is_owner(p_brand_id) then
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

  -- ever held by another brand (ADR 0004 decision 6: never reassign a retired slug)
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

-- ------------------------------------- 8. owner-only disconnect / re-selection
-- social_connections has RLS enabled and no policies at all, so these two
-- definer RPCs *are* the authorization boundary for a customer's provider
-- credentials. Both are re-created from 20260802120000_social_account_selection
-- with the internal is_member check replaced by is_owner; the bodies are
-- otherwise unchanged, including the "promote the next active connection to
-- default" repair that keeps a workspace publishable after a disconnect.
create or replace function public.disconnect_account(account_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare b text; p text; was_default boolean;
begin
  select brand_id, platform, is_default into b, p, was_default
    from public.social_connections where id = account_id;
  if b is null then return false; end if;
  if not public.is_owner(b) then raise exception 'not authorised'; end if;
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

create or replace function public.select_social_account(account_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare b text; p text;
begin
  select brand_id, platform into b, p from public.social_connections where id = account_id;
  if b is null then return false; end if;
  if not public.is_owner(b) then raise exception 'not authorised'; end if;
  update public.social_connections set is_default = false
    where brand_id = b and platform = p and is_default;
  update public.social_connections set is_default = true where id = account_id;
  return true;
end $$;
revoke all on function public.select_social_account(uuid) from public;
grant execute on function public.select_social_account(uuid) to authenticated;
