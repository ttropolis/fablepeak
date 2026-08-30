-- ADR 0006 delivery item 5 — the post-approval workflow, shipped DORMANT.
--
-- Decision 9 (accepted, and reinforced by decision 1's split phases): approval
-- is opt-in per brand via `brands.approval_required`, defaulting FALSE, and is
-- enabled only after roles and invitations have been proven internally. Nothing
-- in this migration changes any behaviour of any existing workspace until an
-- owner turns that flag on: every rule below is either inside
-- `if v_required then …` or is decision 10's publish lock, which forbids only a
-- transition no client path performs today (see "WHAT CLIENTS DO TODAY").
--
-- Section map:
--   1. brands.approval_required                 the opt-in flag, owner-only
--   2. posts.approval_note / approved_by / approved_at
--   3. posts_status_check widened to six statuses  — in THIS file, never by
--      editing 20260809110000_delivery_recovery.sql (test/scheduling.test.mjs
--      asserts that file's literal text)
--   4. brands_guard_smartlink_slug extended       approval_required joins
--                                                 smartlink_public as an
--                                                 owner-only column
--   5. posts_guard_status_transition              the transition trigger
--   6. the claim RPCs, deliberately untouched
--
-- NOT here, and deliberately: `claim_due_posts`, `claim_post_for_retry`,
-- `claim_post_for_publish` and supabase/functions/publish/index.ts are not
-- edited by one character. `claim_due_posts` selects `p.status = 'scheduled'`
-- by exact match, so `pending_approval` is unclaimable BY CONSTRUCTION rather
-- than by a negation somebody could later widen, and `claim_post_for_retry`'s
-- candidate list must never gain the new status. test/post-approval.test.mjs
-- pins both facts against this file and against theirs.

-- ------------------------------------------------------- 1. the opt-in flag
-- `not null default false` so every existing brand reads "approval off" without
-- a data migration, and so the trigger in §5 can branch on a boolean rather
-- than on a nullable it would have to coalesce at every call site.
alter table public.brands
  add column if not exists approval_required boolean not null default false;

comment on column public.brands.approval_required is
  'ADR 0006 decision 9: when true, posts in this brand must pass an owner''s '
  'approval before they can reach status=scheduled. Owner-only to change '
  '(brands_guard_smartlink_slug). Off by default; off is byte-identical to the '
  'behaviour that predates this column.';

-- ------------------------------------------------------------ 2. post columns
-- Decision 11: rejection is ONE overwritten note, not a comment thread. A
-- thread is a new table, new RLS, a new realtime channel and a notification
-- expectation this release cannot meet, so the whole feedback channel is this
-- single column, rewritten by each decision and cleared by each submission.
--
-- approved_by / approved_at record who decided and when. The ADR body names
-- four columns (submitted_by/at, decided_by/at); the two below are the half
-- that has a reader — the composer shows the note, and an approval that nobody
-- can attribute is worse than one that costs eight bytes to attribute. Both are
-- written ONLY by the trigger in §5, from auth.uid() and now(): they are
-- deliberately absent from js/remote-store.js's FIELDS.posts, so no client
-- payload can name them and no client can forge or clear them.
alter table public.posts
  add column if not exists approval_note text,
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz;

-- ------------------------------------------------- 3. the widened status CHECK
-- Widening a CHECK is backward-compatible: every existing row already satisfies
-- the larger set, so there is no data migration, no rewrite and no downtime.
--
-- The constraint is re-created HERE rather than by editing
-- 20260809110000_delivery_recovery.sql because test/scheduling.test.mjs asserts
-- that file's literal text (both the five-status list and the retry claim), and
-- an old migration whose text has been edited is no longer the migration that
-- ran on production.
alter table public.posts drop constraint if exists posts_status_check;
alter table public.posts add constraint posts_status_check
  check (status in ('draft', 'pending_approval', 'scheduled',
                    'publishing', 'published', 'failed'));

-- ------------------------------- 4. approval_required is an owner-only column
-- RLS is row-level and cannot express a column rule, so this joins
-- smartlink_public inside the trigger that already guards this table's
-- columns. `create or replace function` replaces a whole body, so the
-- SmartLinks rules from 20260830100000_owner_role_enforcement.sql are restated
-- verbatim below; the only new text is the approval_required branch.
--
-- SERVICE-EXECUTION MARKER — identical to the one that migration established,
-- and identical for the same reasons (ADR 0006 decision 10's amendment):
--
--   auth.role() = 'service_role'
--     the Edge Functions call PostgREST with SUPABASE_SERVICE_ROLE_KEY, so the
--     request JWT carries that role. public.prepare_account_deletion uses the
--     same check as its only authorisation gate.
--
--   no request context at all (auth.role() is null/'' AND auth.uid() is null)
--     psql, a migration, pg_cron — database superusers already trusted with
--     more than a boolean column.
--
-- `auth.uid() is null` ALONE is never the marker. It is also true of an
-- anonymous PostgREST request carrying the anon key, which is a browser and not
-- a server. Decision 10's amendment says exactly this, and says it about the
-- posts trigger in §5 as well.
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

  -- Approval is owner-only for the same structural reason (ADR 0006 decision
  -- 9). UPDATE only, and for the same INSERT argument: a brand is created by
  -- its own owner through save_brand, and the column defaults to false, so
  -- there is no INSERT that could switch approval on for somebody else. An
  -- editor who could flip this could turn their own workspace's review
  -- requirement off and then schedule freely, which would make §5 decorative.
  if tg_op = 'UPDATE'
     and new.approval_required is distinct from old.approval_required
     and not v_service
     and not public.is_owner(new.id) then
    raise exception 'only a workspace owner can change whether posts need approval'
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

-- ------------------------------------------ 5. the status-transition trigger
-- A trigger, not a policy: only a trigger sees OLD and NEW, and every rule here
-- is about the MOVE a write makes rather than the row it lands on.
--
-- ADR 0006 §6 names this "the one change that can break delivery". Three
-- structural choices keep that blast radius as small as it can be made:
--
--   (a) A status that does not move is never examined. The first statement is
--       an early `return new` for any UPDATE where `new.status is not distinct
--       from old.status`, which is every ordinary edit the product performs —
--       text, date, time, networks, media, variants, the approval note — and
--       also every stale echo a client writes after the publisher has already
--       moved a row. Those cost one comparison and never reach a rule.
--   (b) Service execution bypasses everything, immediately after (a). Service
--       writes bypass RLS but NOT triggers, so without this branch the publish
--       cron stops the moment this migration lands.
--   (c) With `approval_required` false the function returns before any approval
--       rule is read. The ONLY rule that applies to an approval-off brand is
--       the publish lock, and the enumeration below is why that lock cannot
--       change today's behaviour.
--
-- WHAT CLIENTS DO TODAY (enumerated from js/planner.js savePost / publishNow /
-- retryPost / dupPost / dropPost, js/settings.js importData and
-- js/workspace.js tickPublish, all of which write through the single
-- `posts_all` upsert in js/remote-store.js persist()). Every one of these must
-- still be permitted with approval off, and every one of them is:
--
--   INSERT  draft                    savePost (new), dupPost
--   INSERT  scheduled                savePost (new, live mode offers exactly
--                                    draft and scheduled)
--   INSERT  any of the six           Settings → Import backup, and the
--                                    "upload this device's data" path on a
--                                    first sign-in with an empty cloud
--                                    workspace. INSERT is deliberately NOT
--                                    subject to the publish lock: an inserted
--                                    row cannot forge a delivery (post_targets
--                                    carries those) and cannot be claimed, and
--                                    refusing it would break restoring a
--                                    backup that contains published history.
--   UPDATE  draft ⇄ scheduled        savePost (edit)
--   UPDATE  failed → draft|scheduled savePost on a failed post — the composer's
--                                    select has no `failed` option, so a save
--                                    always moves it
--   UPDATE  draft|scheduled → failed publishNow / retryPost writing
--                                    postStatusFromResults() after a delivery
--                                    that did not fully succeed
--   UPDATE  → scheduled              the same two paths when a retryable target
--                                    remains
--   UPDATE  published → draft|sched. a client whose snapshot predates the
--                                    publisher, e.g. an offline edit synced
--                                    afterwards. Permitted today, permitted
--                                    here: it is a de-escalation, and realtime
--                                    corrects it.
--   UPDATE  x → x                    the echo publishNow writes when it sets
--                                    p.status from the publish results: the
--                                    Edge Function has ALREADY written that
--                                    same status to this row before responding
--                                    (supabase/functions/publish/index.ts
--                                    updates `posts` at the end of publishPost),
--                                    so by the time the browser's debounced
--                                    save arrives the value is unchanged and
--                                    branch (a) returns before the lock is
--                                    reached. This is precisely why the lock is
--                                    written as a rule about MOVEMENT and not
--                                    about the value: "no client may write
--                                    'published'" would break Publish now for
--                                    every workspace on the day it shipped.
--
-- Local and demo workspaces set 'published' client-side (js/workspace.js
-- tickPublish) and are NOT affected by any of this: tickPublish returns early
-- for a signed-in cloud user, LocalAdapter never opens a connection at all, and
-- demo mode short-circuits RemoteAdapter.persist() on `if(!this.user) return`
-- after writing localStorage. No demo write reaches Postgres, so the trigger
-- never sees one.
create or replace function public.posts_guard_status_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce(auth.role(), '');
  v_service boolean := v_role = 'service_role'
                    or (v_role = '' and auth.uid() is null);
  v_required boolean;
  v_owner boolean;
begin
  -- (a) a status that does not move is not a transition
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;

  -- (b) the publish cron, the publish Edge Function, psql, a migration
  if v_service then
    return new;
  end if;

  -- (c) decision 10's hard rule, in every brand, flag or no flag: a client may
  -- never MOVE a post into a delivery state. Only the publisher does that, and
  -- it does it through the claim RPCs, which run as service_role and returned
  -- at (b). schema.sql's closing comment has asserted this since the beginning
  -- and nothing has ever enforced it.
  if tg_op = 'UPDATE' and new.status in ('publishing', 'published') then
    raise exception
      'only FablePeak''s publisher can move a post to %; schedule it instead', new.status
      using errcode = '42501';
  end if;

  select b.approval_required into v_required
    from public.brands b where b.id = new.brand_id;

  -- (d) approval off → exactly the behaviour that predates this migration
  if coalesce(v_required, false) is not true then
    return new;
  end if;

  v_owner := public.is_owner(new.brand_id);

  -- INSERT into an approval-required brand. Gated, because an ungated INSERT
  -- would retire the whole feature: an editor refused `draft → scheduled` could
  -- otherwise delete the post and insert an identical one already scheduled.
  -- An editor's restore of a backup containing scheduled or published posts
  -- into an approval-required brand is refused by this branch, which is the
  -- same rule stated about the same act.
  if tg_op = 'INSERT' then
    if not v_owner and new.status not in ('draft', 'pending_approval') then
      raise exception
        'posts in this workspace need an owner''s approval before they can be scheduled'
        using errcode = '42501';
    end if;
    if new.status = 'pending_approval' then new.approval_note := null; end if;
    return new;
  end if;

  -- Submit (draft → pending_approval) and recall-for-review from any other
  -- non-delivery state. Open to editors and owners alike: asking for review is
  -- not a privilege. A fresh submission carries no decision, so the note from
  -- the previous round is cleared here rather than left to look like feedback
  -- on copy nobody has read yet.
  if new.status = 'pending_approval' then
    new.approval_note := null;
    return new;
  end if;

  -- Approve, or schedule directly. Owner-only while the flag is on: this is the
  -- single escalation the feature exists to gate, and ADR 0006 §3 says an
  -- editor cannot reach `scheduled` any other way.
  if new.status = 'scheduled' then
    if not v_owner then
      raise exception
        'only a workspace owner can schedule a post here — submit it for approval instead'
        using errcode = '42501';
    end if;
    if old.status = 'pending_approval' then
      new.approval_note := null;                  -- approved: the note is spent
      new.approved_by := auth.uid();
      new.approved_at := now();
    end if;
    return new;
  end if;

  -- Reject (owner, pending_approval → draft). The note is the entire feedback
  -- channel decision 11 allows, so a rejection without one is a post that comes
  -- back to its author saying nothing.
  if new.status = 'draft' and old.status = 'pending_approval' and v_owner then
    if new.approval_note is null or btrim(new.approval_note) = '' then
      raise exception
        'say what needs changing: a post sent back for changes must carry a note'
        using errcode = '23514';
    end if;
    new.approved_by := auth.uid();
    new.approved_at := now();
    return new;
  end if;

  -- Everything left is a de-escalation or a delivery result, and none of it is
  -- an escalation past an owner: an editor's withdraw (pending_approval →
  -- draft), scheduled → draft, and → failed written by publishNow/retryPost.
  return new;
end
$$;

-- A `returns trigger` function cannot be invoked directly, but no client role
-- has any business holding EXECUTE on it either.
revoke all on function public.posts_guard_status_transition() from public;
revoke all on function public.posts_guard_status_transition() from anon, authenticated;

drop trigger if exists posts_guard_status_transition on public.posts;
create trigger posts_guard_status_transition
  before insert or update on public.posts
  for each row execute function public.posts_guard_status_transition();

-- --------------------------------------------- 6. the claim RPCs, untouched
-- Restated as a comment because the absence of a change is the load-bearing
-- fact, and test/post-approval.test.mjs asserts it against this file:
--
--   claim_due_posts        `where p.status = 'scheduled'` — an exact match, so
--                          a pending_approval post is unclaimable without this
--                          migration saying anything about it.
--   claim_post_for_retry   `status in ('draft','scheduled','published','failed')`
--                          — must NOT gain 'pending_approval'. A post awaiting
--                          review is not a delivery to be retried.
--   claim_post_for_publish `status in ('draft','scheduled')` — unchanged, and
--                          the one residual gap in this release: Publish now is
--                          service-executed, so it bypasses this trigger. The
--                          planner withdraws the button from an editor in an
--                          approval-required brand (js/planner.js), which is an
--                          affordance and not a guarantee. Closing it properly
--                          means a check inside supabase/functions/publish,
--                          which delivery item 5 deliberately does not touch.
