# ADR 0006: Team collaboration — invites, role enforcement, post approval

- Status: proposed — decisions required (runbook item 8.8)
- Date: 2026-08-30

## Context

`brand_members(brand_id, user_id, role)` already carries `owner`/`editor`
(`supabase/schema.sql`), and `add_owner_membership` makes the creator an owner.
**No code anywhere reads `role`.** Every policy and every security-definer RPC
asks only `is_member(brand_id)`, so an editor can today delete the brand,
disconnect a customer's Facebook Page and publish a SmartLinks page. The column
is documentation, not a permission.

There is also no way to add a teammate from inside the product: README §
"Multi-user / cloud sync" tells the operator to add a row in the Supabase
dashboard. Signup (`js/welcome.js` → `RemoteAdapter.signUp`) requires email
confirmation before a session exists — the one identity fact this ADR leans on.

Post status is `draft / scheduled / publishing / published / failed`
(`20260809110000_delivery_recovery.sql`). `claim_due_posts` claims
`status = 'scheduled'` by exact match; only the publish Edge Function may write
`published`.

## Decision

### 1. Invite mechanism — in-app invite records claimed at sign-in

- **Chosen: a `brand_invites` row an owner creates by email, claimed by the
  invitee once their own confirmed email matches.** No SMTP, no templating, no
  deliverability surface, and the confirmed-email match is real identity proof
  rather than a self-asserted string.
- Rejected: Supabase auth invite links (`admin.inviteUserByEmail`). Needs
  service-role, so a new Edge Function; Supabase's built-in SMTP is rate-limited
  and not for production, so it also needs a mail provider; it creates an auth
  user before that person consents; and it cannot carry `brand_id` + `role`, so
  it is *this* design plus an email dependency.
- Rejected: a share code. A bearer secret pasted into a Slack channel admits
  everyone who reads it, cannot be revoked per person, and cannot prove which
  human accepted. It fails tenant isolation by construction.
- **Nothing leaks pre-acceptance.** `brand_invites` is member-readable only. The
  invitee reads `list_my_invites()` — security definer, matching the caller's
  confirmed email — returning `(invite_id, brand_name, role, inviter_email)` and
  deliberately **not** `brand_id`, the key every RLS policy is written on.
- Acceptance is an explicit Accept/Decline, not silent auto-join: typing an
  address must not make a stranger hold your workspace's content. Revocation is
  deleting the pending row, immediate because nothing is granted until
  acceptance. Invites expire after 14 days.
- Accepted cost: the owner tells the invitee out of band to sign up. Fine while
  ADR 0001 keeps the beta invite-only and hand-onboarded.

### 2. Role model — keep `owner`/`editor`, start enforcing

No third role. A `viewer` has no asked-for use case (every current user
composes), and an `approver` doubles the policy matrix for a workflow that has
not run once. Add `public.is_owner(b text)` mirroring `is_member` exactly —
`security definer stable set search_path = public` — so there is one auditable
predicate and no RLS recursion on `brand_members`.

| Guarantee | Enforcement point | Layer |
|---|---|---|
| Only owners add/remove/re-role members | new `members_insert/update/delete` policies on `brand_members`, `is_owner(brand_id)` | RLS |
| A member may remove themselves (leave) | same delete policy: `is_owner(brand_id) or user_id = auth.uid()` | RLS |
| A brand always keeps one owner | `brand_members` BEFORE UPDATE/DELETE trigger refusing last-owner demotion or removal | trigger |
| Only owners invite and revoke | `brand_invites` write policies, `is_owner(brand_id)` | RLS |
| Only owners delete the brand | `brands_delete` predicate `is_member(id)` → `is_owner(id)` | RLS |
| Only owners disconnect / re-select social accounts | `disconnect_account`, `select_social_account`: internal `is_member` → `is_owner` (`social_connections` has no policies at all) | security-definer check |
| Only owners change SmartLinks publishing | `set_smartlink_slug` internal check → `is_owner`; `smartlink_public` and `approval_required` added to the existing `brands_guard_smartlink_slug` BEFORE UPDATE trigger | trigger — RLS is row-level and cannot express a column rule |
| Editors compose, schedule, reply, upload | `posts_all`, `inbox_all`, `workspace_media_*` unchanged | RLS (unchanged) |
| Editors cannot approve | posts status-transition trigger (§3) | trigger |
| Owner-only controls are hidden in Settings/Connections | render gates on `myRole(brandId)` | **UI only — not a guarantee.** Every row above holds without it |

### 3. Approval workflow — one new status, opt-in per brand

New status `pending_approval` between `draft` and `scheduled`, gated by
`brands.approval_required boolean not null default false`. Off, behaviour is
byte-identical to today, so no existing brand regresses and the trigger's blast
radius is limited to brands that opted in. A `posts` BEFORE UPDATE trigger owns
transitions — a trigger, not a policy, because only a trigger sees OLD and NEW:

- Editor (flag on): `draft → pending_approval` (submit), `pending_approval →
  draft` (withdraw). An editor cannot reach `scheduled` any other way.
- Owner: everything an owner can do today, plus `pending_approval → scheduled`
  (approve) and `pending_approval → draft` (reject, note required).
- Nobody with an `auth.uid()` may write `publishing` or `published`, closing a
  hole that has always existed: `schema.sql`'s closing comment asserts it,
  nothing enforced it. The planner already refuses those options in cloud mode
  (`openPostModal`'s `statusOptions`), so the trigger only makes the UI rule
  real. Local/demo mode still sets `published` client-side, never reaching
  Postgres.
- **The publish cron needs no change, and that is the point.**
  `claim_due_posts` selects `p.status = 'scheduled'` by exact match, so
  `pending_approval` is unclaimable by construction rather than by a negation
  someone could later widen. `claim_post_for_retry`'s candidate list
  (`status in ('draft','scheduled','published','failed')`) must **not** gain
  `pending_approval`. Both are asserted by test, not by memory.
- Rejection is one `approval_note text` column, overwritten per decision, shown
  in the composer. **No comment thread in v1** — that is a new table, new RLS, a
  new realtime channel and a notification expectation we cannot meet without the
  mail provider decision 1 avoided.
- Calendar: a new amber `.post.pending_approval` chip class, flowing through
  `postVisibleStatus` unchanged (a pending post has no targets, so the failure
  override cannot fire).

### 4. Schema changes — one migration

```
brand_invites(
  id uuid pk default gen_random_uuid(),
  brand_id text not null references brands(id) on delete cascade,
  email text not null check (email = lower(btrim(email))),
  role text not null default 'editor' check (role in ('owner','editor')),
  invited_by uuid not null references auth.users(id),
  status text not null default 'pending'
    check (status in ('pending','accepted','revoked','expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_by uuid references auth.users(id), accepted_at timestamptz)
unique index on (brand_id, email) where status = 'pending'
```

RLS: `select to authenticated using (is_member(brand_id))`;
`insert/update/delete using/with check (is_owner(brand_id))`. Functions:
`accept_invite(uuid)` (requires `auth.uid()`, a case-folded match against the
JWT email, a confirmed address, status `pending`, not expired — then inserts
`brand_members`), `decline_invite(uuid)`, `list_my_invites()`, and
`brand_member_list(text)` returning `(user_id, email, role)` gated on
`is_member` — `auth.users` is not client-readable, so without it the UI shows
bare UUIDs. That last one is the only new PII exposure, bounded to co-members.

Policies that change: **`brands_delete` only** (`is_member` → `is_owner`), plus
the three additive `brand_members` write policies. There are no `brand_members`
write policies today, so RLS denies every client write to it — these add a
capability *with* its guard rather than tighten an existing hole.
`brands_select`, `brands_insert`, `brands_update`, `posts_all`, `inbox_all`,
`members_select`, `targets_select`, `metrics_select`, `smartlink_clicks_select`,
`smartlink_slug_aliases_select` and `workspace_media_*` are **unchanged** —
editors need every one.

Posts: drop and re-add `posts_status_check` with six statuses; add
`approval_note`, `submitted_by`, `submitted_at`, `decided_by`, `decided_at`; add
`brands.approval_required`. Widening a CHECK is backward-compatible — every
existing row already satisfies it, so no data migration and no downtime.

`test/scheduling.test.mjs:60` and `:93` assert the literal text of two *earlier*
migration files. Those are never edited, so both keep passing — precisely why
the constraint is widened in a new migration rather than by rewriting
`20260809110000`. The frontend copies of the vocabulary must all gain the value:
`js/settings.js`'s `POST_STATUSES` (or backup import rejects any workspace
holding one), `openPostModal`'s `statusOptions`, and the chip CSS in
`index.html`.

### 5. UI surface

- **Settings → Team card**, cloud mode and signed in only. Member list (email,
  role, "you"), role picker and remove per row for owners; invite email + role +
  Invite; pending invites with Revoke. Editors see the list read-only. Invitees
  get an Accept/Decline card above it plus a one-time toast after sign-in, fed
  by `list_my_invites()`.
- **Approval queue: no new view.** The planner gets the amber chip, an
  All / Needs approval filter, and a Planner-nav count badge for owners while
  `approval_required` is on. The composer shows Submit for approval (editor,
  draft) or Approve / Request changes + note (owner, pending).
- **Demo mode** seeds two simulated members and one pending invite, labelled
  "Simulated — team features need a cloud account", every control toasting
  instead of mutating and reaching no network (per ADR 0004 decision 11).

### 6. Blast radius

- **Highest risk: the posts status trigger.** Service-role writes bypass RLS but
  **not** triggers, so it must explicitly permit `auth.uid() is null` and the
  definer claim path, or scheduled publishing stops. The one change that can
  break delivery.
- `brands_delete` → `is_owner` makes a brand with no owner row permanently
  undeletable. Backfill first: promote the earliest member of every such brand.
- `brands_update` is defined three times (`schema.sql`, `schema_social.sql`,
  `20260731090000`); the new migration must be the last writer, verified by CI's
  `supabase db reset --local --no-seed` (`.github/workflows/ci.yml:56`).
- `is_owner` must be `security definer stable` exactly like `is_member`, or
  policies on `brand_members` recurse. Owner-gated disconnect could strand an
  ownerless workspace — prevented by the last-owner trigger.

Guarded by acceptance matrix row 6, "Tenant A cannot read/select/disconnect/
publish through Tenant B assets" (`docs/acceptance/EXTERNAL_BETA_EVIDENCE.md`),
which must be **re-run and extended with an owner-vs-editor axis**;
`test/scheduling.test.mjs`; `test/behaviour/{auth-gate,planner-compose,
publish-now,settings-backup,post-validation,hostile-input}.test.mjs`; the CI
migration rebuild.

New tests: (1) the constraint lists six statuses and neither claim function
mentions `pending_approval`; (2) every rewritten predicate names `is_owner`, and
`is_owner` is `security definer stable set search_path`; (3) the status trigger
has its service-role escape hatch; (4) `test/behaviour/team.test.mjs` — owner
sees the Team card, editor does not, invite validates, demo mode is labelled and
offline; (5) `test/behaviour/approval.test.mjs` — editor gets Submit not
Schedule, owner gets Approve/Request changes, chip and filter render; (6) a
`pending_approval` post round-trips through export/import; (7) the note is
escaped where rendered.

### 7. Out of scope for v1

- Activity / audit log of who changed what.
- Per-post assignment or reviewer routing.
- Notifications of any kind — email, push, digest.
- Granular permissions (per network, per view, per SmartLink).
- Any third role, role customisation, and comment threads on posts.
- Bulk or CSV invites; SSO and email-domain auto-join.
- Approval for inbox replies or SmartLinks edits — posts only; and transferring
  brand ownership between accounts.

### 8. Effort and sequencing

| Component | Size |
|---|---|
| `brand_invites` + RLS + accept/decline/`list_my_invites` | M |
| `is_owner`, member write policies, last-owner trigger, owner backfill | M |
| Owner gating in the three definer RPCs + extended brands trigger | S |
| `brand_member_list` definer function | S |
| `pending_approval` status, columns, transition trigger, `approval_required` | M |
| Settings Team card, invite/accept UI, role picker, remove | M |
| Planner chip, filter, badge, submit/approve composer controls | M |
| Frontend status vocabulary + demo-mode simulated team | S |
| Two behaviour suites, migration assertions, acceptance row 6 re-run | M |

Overall M/L — roughly one and a half to two focused weeks including evidence.
Sequence, each step deployable alone: (1) `is_owner` + backfill + last-owner
trigger, no predicate changes — pure addition. (2) member write policies +
`brand_member_list` + a read-only Team card. (3) invites end to end. (4) owner
gating of the four existing surfaces and `brands_delete` — the first restrictive
step; re-run acceptance row 6 here. (5) approval status, trigger and planner UI
behind `approval_required` default false. (6) enable the flag on one internal
brand, then decide on wider rollout.

## Consequences

- The `role` column stops being decorative: an editor loses brand deletion,
  account disconnect and SmartLinks publishing the day step 4 ships. A visible
  capability removal, so it needs a release note.
- FablePeak gains its first in-product identity flow that is not signup, and its
  first function returning another user's email address.
- Approval ships off, so no current workspace changes until an owner opts in.
- Adding a role later means revisiting every predicate written here — the price
  of the two-role choice.

## Decisions required

1. Ship team collaboration during the invite-only beta at all? yes/no
2. In-app `brand_invites` claimed at sign-in, rather than Supabase auth invite
   emails or a share code? yes/no
3. Accept that the owner must tell the invitee out of band to sign up, i.e. no
   mail provider in v1? yes/no
4. Acceptance is an explicit Accept/Decline, never a silent auto-join? yes/no
5. Keep exactly two roles — no `viewer`, no `approver`? yes/no
6. Start enforcing: editors lose brand deletion, social disconnect/re-select and
   SmartLinks publishing? yes/no
7. Add member-management write policies to `brand_members`, gated on `is_owner`,
   with self-removal allowed? yes/no
8. Add a last-owner trigger and backfill ownerless brands before any predicate
   changes? yes/no
9. Add `pending_approval`, opt-in per brand via `approval_required` defaulting
   off? yes/no
10. Enforce status transitions in a `posts` trigger, including forbidding
    client-written `publishing`/`published`, accepting that a trigger bug breaks
    scheduled publishing? yes/no
11. Rejection is one overwritten note field, with no comment thread in v1? yes/no
12. Add `brand_member_list`, exposing co-members' email addresses to each other?
    yes/no
13. Approval surfaces in the existing planner (chip, filter, badge) rather than
    a new view? yes/no
14. Re-run acceptance row 6 with an owner-vs-editor axis as a release gate for
    step 4? yes/no
