-- ADR 0006 delivery item 2 (accepted 2026-08-30): in-app team invitations.
--
-- An owner writes a `brand_invites` row addressed to an email. Nothing is
-- granted by that row. The invitee claims it only once their OWN address is
-- confirmed and matches, and only by pressing Accept. There is no mail
-- provider, no Supabase auth invite, and no share code (decisions 2, 3 and 4):
-- the owner tells the invitee out of band to sign up, and the confirmed-email
-- match is the identity proof.
--
-- Section map:
--   1. brand_invites                  table, constraints, the live-pending index
--   2. RLS                            owner-only, is_owner(brand_id)
--   3. public.current_confirmed_email() the identity primitive everything below
--                                       authorises against
--   4. public.list_my_invites()       the invitee-facing read — no brand_id
--   5. public.create_invite(...)      owner-only, and the expiry sweep
--   6. public.accept_invite(uuid)     confirmed-email match → brand_members row
--   7. public.decline_invite(uuid)    confirmed-email match → 'declined'
--   8. public.revoke_invite(uuid)     owner-only → 'revoked'
--   9. public.brand_member_list(text) member-gated co-member emails (decision 12)
--
-- Three decisions this file makes, all of them amendments the 2026-08-30
-- answers required to be made exactly once and then held to:
--
--   * REVOKED-INVITE MODEL: `status = 'revoked'`, the row RETAINED. Never
--     `delete`. To keep the two models from ever drifting apart there is
--     deliberately no delete policy and no DELETE grant on this table, so the
--     "delete the row" model is not merely unused — it is unreachable.
--
--   * EXPIRY: a timestamp (`expires_at`, 14 days) is the truth; `'expired'` is
--     the status a stale row is *moved to*. No cron. Every read filters on
--     `expires_at > now()`, so an unswept row can never read as live, and
--     create_invite() sweeps the (brand_id, email) it is about to write before
--     it writes. That sweep is what makes re-invitation after an expiry work
--     under the partial unique index below — the index predicate cannot itself
--     mention now(), because index predicates must be IMMUTABLE.
--
--   * CONFIRMED EMAIL: read server-side from `auth.users`, never from a JWT
--     claim. See §3 for why.
--
-- No Edge Function is added or changed, so supabase/config.toml is untouched:
-- every operation here is a PostgREST RPC, exposed the way get_smartlink and
-- set_smartlink_slug are (definer, emptied search_path, revoke-then-grant).

-- ------------------------------------------------------------ 1. brand_invites
-- brand_id is the key every RLS policy in this schema is written on, so it is
-- stored here and deliberately never returned to an invitee (§4).
create table if not exists public.brand_invites (
  id uuid primary key default gen_random_uuid(),
  brand_id text not null references public.brands(id) on delete cascade,
  -- Normalised at rest, not at read: the partial unique index, the sweep and
  -- the accept-time match are all plain equality, and a case-folded compare in
  -- three places is three places to get it wrong.
  email text not null
    check (email = lower(btrim(email))
           and length(email) <= 254
           and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  role text not null default 'editor' check (role in ('owner','editor')),
  status text not null default 'pending'
    check (status in ('pending','accepted','declined','revoked','expired')),
  invited_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  -- One pair for all three outcomes. (The ADR body sketched accepted_by /
  -- accepted_at, which cannot record a decline or a revocation.)
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz
);

alter table public.brand_invites enable row level security;

-- Supabase's default privileges hand anon and authenticated everything on a new
-- public table, so the grant is stated in full rather than trimmed.
revoke all on public.brand_invites from public;
revoke all on public.brand_invites from anon;
revoke all on public.brand_invites from authenticated;
-- No DELETE: revocation is a status, and the table is an audit trail of who was
-- invited to what.
grant select, insert, update on public.brand_invites to authenticated;
grant all on public.brand_invites to service_role;

-- ONE live pending invite per (brand_id, email). Because the sweep in §5 moves
-- a past-`expires_at` row to 'expired' before the insert, this index blocks a
-- duplicate live invite without ever blocking a re-invite after an expiry, a
-- revocation or a decline (2026-08-30 amendment: "expired invites must not
-- block re-invitation").
create unique index if not exists brand_invites_one_live_pending
  on public.brand_invites (brand_id, email)
  where status = 'pending';

-- Owners open the pending list for their own brand; nobody else touches it.
create index if not exists brand_invites_brand_status
  on public.brand_invites (brand_id, status);
-- The invitee-facing lookup in §4 is by address.
create index if not exists brand_invites_email_pending
  on public.brand_invites (email) where status = 'pending';

-- brand_invites is NOT added to the supabase_realtime publication. The realtime
-- change feed js/remote-store.js subscribes to is schema-wide, and an invitee's
-- address has no business travelling over it.

-- ----------------------------------------------------------------- 2. RLS
-- "Only owners manage invites" (decision 7's neighbour in the answers, and the
-- ADR's own row "Only owners invite and revoke").
--
-- SELECT is is_owner, not the is_member the ADR body wrote. Decision 12 buys
-- exactly one new PII exposure — CO-MEMBERS' addresses to each other, and it
-- must be disclosed. A pending invitee is not a co-member: nothing has been
-- accepted, and the address may belong to someone who never joins. Showing it
-- to an editor would be a second, undisclosed exposure for a card no editor
-- renders. This is strictly tighter than the body and costs the UI nothing.
drop policy if exists invites_select on public.brand_invites;
create policy invites_select on public.brand_invites for select to authenticated
  using (public.is_owner(brand_id));

drop policy if exists invites_insert on public.brand_invites;
create policy invites_insert on public.brand_invites for insert to authenticated
  with check (public.is_owner(brand_id));

drop policy if exists invites_update on public.brand_invites;
create policy invites_update on public.brand_invites for update to authenticated
  using (public.is_owner(brand_id)) with check (public.is_owner(brand_id));

-- Deliberately no invites_delete policy. See the revoked-invite note above.

-- ------------------------------------------- 3. the caller's confirmed address
-- Every authorisation below reduces to "is this caller's own, CONFIRMED address
-- the one the invite names". That question is answered from auth.users, and
-- never from the request JWT, for two reasons:
--
--   * `auth.jwt() -> 'user_metadata' ->> 'email_verified'` is the obvious claim
--     and is NOT trustworthy: user_metadata is raw_user_meta_data, which the
--     client itself writes through supabase.auth.updateUser({ data }). Gating a
--     workspace join on a value the joiner can set is not a gate.
--   * even the `email` claim is a snapshot taken at token issue and can be an
--     hour stale, and it carries no confirmation timestamp at all.
--
-- auth.users.email_confirmed_at is the authoritative record, and reading it is
-- exactly what security definer is for. This also follows this schema's
-- established shape rather than inventing one: auth.uid() plus a definer read
-- of a table the client cannot reach, the way public.is_member and
-- public.is_owner already work.
--
-- Not granted to anyone. Every caller below is a definer function that executes
-- as this function's owner, so no client role ever needs EXECUTE on it.
create or replace function public.current_confirmed_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(btrim(u.email))
    from auth.users u
   where u.id = auth.uid()
     and u.email is not null
     and u.email_confirmed_at is not null
$$;

revoke all on function public.current_confirmed_email() from public;
revoke all on function public.current_confirmed_email() from anon, authenticated;

-- ------------------------------------------------------- 4. list_my_invites()
-- The invitee-facing read, and the only thing an un-accepted user may learn.
--
-- The projection is the whole security argument, so read it as a list of what
-- is ABSENT: no brand_id (the key every policy in this schema is written on, so
-- knowing it is the difference between "a workspace exists" and "here is a
-- handle to try against every table"), no inviter address, no post, no
-- connection, no member roster, no other invite. The brand's display name and
-- the offered role are the minimum a human needs to answer Accept or Decline
-- honestly, and they are all that crosses.
--
-- `i.email = public.current_confirmed_email()` is NULL-safe by construction: an
-- unconfirmed or signed-out caller compares against NULL and matches no row.
-- An already-joined member is filtered out too, so a stale invite never offers
-- someone a workspace they are already in.
create or replace function public.list_my_invites()
returns table (
  invite_id uuid,
  brand_name text,
  invite_role text,
  invited_at timestamptz,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, b.name, i.role, i.created_at, i.expires_at
    from public.brand_invites i
    join public.brands b on b.id = i.brand_id
   where i.status = 'pending'
     and i.expires_at > now()
     and i.email = public.current_confirmed_email()
     and not exists (
       select 1 from public.brand_members m
        where m.brand_id = i.brand_id and m.user_id = auth.uid())
   order by i.created_at
$$;

revoke all on function public.list_my_invites() from public;
revoke all on function public.list_my_invites() from anon;
grant execute on function public.list_my_invites() to authenticated;

-- -------------------------------------------------------- 5. create_invite(…)
-- Owner-only, and the only path that should ever write this table: it
-- normalises the address, runs the expiry sweep the unique index depends on,
-- and refuses the three states a duplicate row would represent.
--
-- Typed jsonb result rather than an exception for the ordinary refusals — the
-- house pattern from set_smartlink_slug: "that name is taken" is a result the
-- UI renders, not a failure. Only a genuine authorisation breach raises.
create or replace function public.create_invite(
  p_brand_id text, p_email text, p_role text default 'editor')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_role  text := lower(btrim(coalesce(p_role, 'editor')));
  v_user  uuid;
  v_id    uuid;
begin
  if not public.is_owner(p_brand_id) then
    raise exception 'only a workspace owner can invite people'
      using errcode = '42501';
  end if;

  if v_role not in ('owner','editor') then
    return jsonb_build_object('ok', false, 'error', 'invalid_role');
  end if;
  if length(v_email) > 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_email');
  end if;
  if v_email = public.current_confirmed_email() then
    return jsonb_build_object('ok', false, 'error', 'self_invite');
  end if;

  -- THE SWEEP. A stale row still reading 'pending' would occupy the partial
  -- unique index slot for this address forever. Retiring it here — rather than
  -- in a cron, which this deployment does not want, or in the index predicate,
  -- which cannot call now() — is what makes re-inviting an expired address work.
  update public.brand_invites
     set status = 'expired', decided_at = now()
   where brand_id = p_brand_id
     and email = v_email
     and status = 'pending'
     and expires_at <= now();

  select u.id into v_user from auth.users u
   where lower(u.email) = v_email limit 1;
  if v_user is not null and exists (
       select 1 from public.brand_members m
        where m.brand_id = p_brand_id and m.user_id = v_user) then
    return jsonb_build_object('ok', false, 'error', 'already_member');
  end if;

  if exists (
       select 1 from public.brand_invites i
        where i.brand_id = p_brand_id and i.email = v_email
          and i.status = 'pending') then
    return jsonb_build_object('ok', false, 'error', 'already_invited');
  end if;

  -- The pending check above is advisory only: two concurrent calls can both
  -- pass it. The partial unique index is the real guard, so let it arbitrate —
  -- the loser gets the same clean 'already_invited' answer, not a raw error.
  insert into public.brand_invites (brand_id, email, role, invited_by)
  values (p_brand_id, v_email, v_role, auth.uid())
  on conflict (brand_id, email) where status = 'pending' do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'already_invited');
  end if;

  return jsonb_build_object('ok', true, 'invite_id', v_id,
                            'email', v_email, 'role', v_role);
end
$$;

revoke all on function public.create_invite(text, text, text) from public;
revoke all on function public.create_invite(text, text, text) from anon;
grant execute on function public.create_invite(text, text, text) to authenticated;

-- -------------------------------------------------------- 6. accept_invite(…)
-- The join. Every precondition is re-checked here even though the UI only ever
-- offers rows that already passed them in §4: the RPC is the boundary, and a
-- caller can send any uuid they like.
--
-- An invite id that is not this caller's is answered identically to one that
-- does not exist ('not_found'), so the function is not an oracle for "does this
-- invite id exist" or "who else was invited".
--
-- On the insert: security definer bypasses RLS but NOT triggers, so it is worth
-- naming which trigger this passes. brand_members_keep_an_owner
-- (20260830100000) is `before update or delete` only — an INSERT never reaches
-- it, and the last-owner invariant has nothing to say about someone joining.
-- The members_insert policy is bypassed here by design: the authorisation for
-- this row is the invite plus the confirmed-email match, not the joiner's
-- ownership of a brand they are not yet in.
create or replace function public.accept_invite(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text := public.current_confirmed_email();
  inv     public.brand_invites%rowtype;
begin
  if v_uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if v_email is null then
    -- Signed in, but the address is unconfirmed. Accepting on an unconfirmed
    -- address would let anyone who can type a stranger's email into signup walk
    -- into that stranger's workspace.
    return jsonb_build_object('ok', false, 'error', 'email_unconfirmed');
  end if;

  select * into inv from public.brand_invites where id = p_invite_id for update;
  if not found or inv.email <> v_email then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if inv.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'not_pending');
  end if;
  if inv.expires_at <= now() then
    update public.brand_invites
       set status = 'expired', decided_at = now() where id = inv.id;
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  insert into public.brand_members (brand_id, user_id, role)
  values (inv.brand_id, v_uid, inv.role)
  on conflict (brand_id, user_id) do nothing;   -- already a member: keep the role they hold

  update public.brand_invites
     set status = 'accepted', decided_at = now(), decided_by = v_uid
   where id = inv.id;

  return jsonb_build_object('ok', true, 'role', inv.role);
end
$$;

revoke all on function public.accept_invite(uuid) from public;
revoke all on function public.accept_invite(uuid) from anon;
grant execute on function public.accept_invite(uuid) to authenticated;

-- ------------------------------------------------------- 7. decline_invite(…)
-- Same authorisation as accept: only the addressee may answer, and declining is
-- a real answer rather than ignoring the row, so the owner's pending list stops
-- showing an invitation nobody is going to take.
create or replace function public.decline_invite(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := public.current_confirmed_email();
  inv     public.brand_invites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if v_email is null then
    return jsonb_build_object('ok', false, 'error', 'email_unconfirmed');
  end if;

  select * into inv from public.brand_invites where id = p_invite_id for update;
  if not found or inv.email <> v_email then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if inv.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'not_pending');
  end if;

  update public.brand_invites
     set status = 'declined', decided_at = now(), decided_by = auth.uid()
   where id = inv.id;
  return jsonb_build_object('ok', true);
end
$$;

revoke all on function public.decline_invite(uuid) from public;
revoke all on function public.decline_invite(uuid) from anon;
grant execute on function public.decline_invite(uuid) to authenticated;

-- -------------------------------------------------------- 8. revoke_invite(…)
-- Owner-only, and the only revocation model in this file: the row is retained
-- as 'revoked'. Immediate by construction, because a pending invite grants
-- nothing — there is no access to withdraw, only an offer to withdraw.
--
-- A non-owner is told 'not_found' rather than 'not authorised', so this is not
-- an oracle for which invite ids exist in other people's workspaces.
create or replace function public.revoke_invite(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.brand_invites%rowtype;
begin
  select * into inv from public.brand_invites where id = p_invite_id for update;
  if not found or not public.is_owner(inv.brand_id) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if inv.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'not_pending');
  end if;

  update public.brand_invites
     set status = 'revoked', decided_at = now(), decided_by = auth.uid()
   where id = inv.id;
  return jsonb_build_object('ok', true);
end
$$;

revoke all on function public.revoke_invite(uuid) from public;
revoke all on function public.revoke_invite(uuid) from anon;
grant execute on function public.revoke_invite(uuid) to authenticated;

-- ----------------------------------------------------- 9. brand_member_list(…)
-- ADR 0006 decision 12, and the ADR's only new PII exposure: co-members see
-- each other's email addresses. It is member-gated, not owner-gated, because an
-- editor rendering a roster of bare UUIDs is the failure this exists to fix —
-- members_select already shows an editor the user_ids, just not the addresses.
--
-- Decision 12's condition is that the visibility is stated in the privacy
-- disclosure before it ships. That is a release gate on privacy.html, not
-- something SQL can assert.
--
-- Scoped to one brand per call, so it is never a directory of the user table.
-- The OUT parameters are named member_* rather than user_id/email/role so that
-- no reference inside the body can be ambiguous between a column and an output.
create or replace function public.brand_member_list(p_brand_id text)
returns table (member_id uuid, member_email text, member_role text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_member(p_brand_id) then
    raise exception 'not authorised for this brand' using errcode = '42501';
  end if;
  return query
    select m.user_id, lower(u.email)::text, m.role
      from public.brand_members m
      join auth.users u on u.id = m.user_id
     where m.brand_id = p_brand_id
     order by (m.role <> 'owner'), lower(u.email);
end
$$;

revoke all on function public.brand_member_list(text) from public;
revoke all on function public.brand_member_list(text) from anon;
grant execute on function public.brand_member_list(text) to authenticated;
