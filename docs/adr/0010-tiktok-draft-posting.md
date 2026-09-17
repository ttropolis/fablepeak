# ADR 0010: A second TikTok posting mode — draft to the creator's inbox

- Status: Accepted
- Date: 2026-09-17

## Context

FablePeak's TikTok integration publishes with the Direct Post API: the composer
collects the creator's privacy level, interaction and commercial-disclosure
settings (ADR 0005, the compliance UX), the adapter maps them into `post_info`,
calls `video/init/`, and polls `status/fetch/` until `PUBLISH_COMPLETE`. The
video lands on the profile, and `post_targets` records a normal delivery with a
`remote_url`.

Direct Post cannot use TikTok's commercial music library: a video posted through
the API carries only the audio the uploader supplies. The only route that gives
a creator access to platform music is TikTok's **inbox draft** flow
(`post/publish/inbox/video/init/`): FablePeak hands TikTok a URL to pull from,
TikTok drops the result into the creator's inbox as an unfinished draft, and the
creator opens the TikTok app to add music, edit and post it themselves. This is
a materially different product — FablePeak never publishes the video, there is
no public URL, and TikTok emits no later signal when the creator finally posts —
but it is the same customer, the same connection, and largely the same pipeline.

The question this ADR settles is how to represent "delivered as a draft" without
destabilising the delivery pipeline that a dozen suites, a cron, a resend guard
and the browser's offline mirror all depend on.

## Decision

Add a **second posting mode** to the existing TikTok integration rather than a
second integration or a new terminal delivery state. A post carries
`posts.tiktok_mode in ('direct','draft')`; `direct` (and NULL, for every post
that predates the column) is today's Direct Post, unchanged byte-for-byte. The
draft branch is entered before any Direct Post option handling, because a draft
has nothing to collect.

### Additive columns, not a new terminal state

A delivered draft keeps `post_targets.status = 'published'`. It is marked only by
a new additive, nullable column `post_targets.delivered_as in ('post','draft')`
(NULL = an ordinary delivery, which is every existing row and every Direct Post).
`posts.tiktok_options` stays NULL for a draft, exactly as it already does for any
post that does not target TikTok, so `valid_post_tiktok_options` already covers
it. NULL on both new columns means "legacy/direct", so **no backfill** is needed.

The rejected alternative was a new terminal status such as
`post_targets.status = 'draft_delivered'`. A draft **is** a successful delivery:
TikTok accepted and stored the upload, and the delivery attempt worked. The
status column answers "did delivery succeed?", not "what was delivered?". Adding
a fourth terminal state to answer the second question would have forced an edit
to every consumer that reasons about terminal success — the **resend guard**
(which must never re-upload an already-delivered target), the post-level
**status rollup** (`postStatusFromResults`), the **publish cron**'s claim/commit
loop, and the browser's **client mirror** (`js/remote-store.js`, which upserts
posts but never `post_targets`). Every one of those is a place where forgetting
the new state would re-publish a video or mislabel a post. Concretely, a resend
guard that did not learn the new terminal state would treat a delivered draft as
not-yet-delivered and upload it again — the exact **duplicate-post** failure the
delivery pipeline was hardened against. Keeping `status = 'published'` and adding
an orthogonal attribute means the resend guard, the rollup and the cron are
correct with no change, because a draft already satisfies "this target is done".

### Truthful surfaces without a new state

Two display surfaces would otherwise call a draft "Published":

- the **per-target delivery panel** now renders `delivered_as === 'draft'` as
  "Sent to TikTok drafts" with no permalink (`remote_url` is NULL, so a "view
  post" link would 404); and
- the **post-level chip** (`postVisibleStatus`) returns a display-only `drafted`
  ("Sent to drafts") when the only delivered targets are drafts, so a draft-only
  post is not chipped "Published". A mixed post with a genuinely published target
  keeps "Published"; `drafted` is display-only and is never written to the DB or
  offered as a composer status option.

### Scope handling — sandbox-only until portal approval

The inbox init requires the `video.upload` scope, which is a different grant from
Direct Post's `video.publish`. Adding an unapproved scope to the authorize
request breaks the **whole** TikTok login (Direct Post included), so
`video.upload` is requested **only under the `TIKTOK_SANDBOX=1` gate**
(`authorizeScopes()` in `_shared/platforms.ts`). Production keeps exactly the
two scopes it logs in with today. The draft publish branch is additionally **gated on the stored connection
scopes**: a connection made before drafts existed will not carry `video.upload`,
so the branch fails with a permanent, self-fixable reconnect instruction
(`TIKTOK_DRAFT_SCOPE_REQUIRED`) — never a raw provider scope error, and never a
retry, since no retry can add a scope. `productionEnabled` stays `false`; this
ADR does not flip it.

## Consequences

- A draft is savable with no privacy/disclosure options; the composer hides the
  Direct Post panel for a draft and does not apply the Direct Post client
  refusal. Direct Post is the default and is unchanged.
- `tiktok_mode` round-trips through the client mirror under the same three-edit
  rule as `tiktok_options` and is cleared when a post stops targeting TikTok.
  Backup import holds it to `direct`/`draft`/NULL (this file rejects an invalid
  file rather than normalising a field, consistent with `tiktok_options`).
- Because TikTok emits no signal when the creator eventually posts the draft,
  FablePeak's record of a draft is terminal at "sent to inbox". There is no
  later reconciliation to build, and none should be implied to the customer.

## Owner-verify

- **Sandbox scope grant.** The `TIKTOK_SANDBOX=1` gate assumes TikTok's sandbox
  credentials grant `video.upload`. This is stated as fact in the Scope
  handling section above but has not been confirmed against a real sandbox
  app; it must be verified before the draft branch is relied on in sandbox.
- **`SEND_TO_USER_INBOX` terminal enum.** The draft poll treats
  `SEND_TO_USER_INBOX` as the terminal success (the draft equivalent of
  `PUBLISH_COMPLETE`). This is marked `TODO(owner-verify)` in the adapter and
  must be confirmed against TikTok's status enum with a real sandbox run before
  the flow is relied on. If the real terminal differs, only that constant and
  the two tests pinning it change.
- **Production scope approval.** Shipping `video.upload` on the production
  authorize path (removing the sandbox gate in `authorizeScopes()`) is an owner
  step that happens **only after TikTok approves the scope in the developer
  portal**. Until then, drafts are reachable in sandbox only.
