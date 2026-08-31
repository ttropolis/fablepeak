# ADR 0005: Publishing depth — per-network copy and first comments

- Status: accepted with amendments — see "Decisions (2026-08-30)"
- Date: 2026-08-30

## Context

Runbook item 8.4 is the largest remaining Metricool-parity gap: FablePeak
composes **one** text and **one** media URL and sends the identical string to
every selected network, and it cannot post a first comment at all. Metricool's
customers expect an Instagram hashtag block in a first comment and shorter copy
on X than on LinkedIn.

What the code actually does today:

- `posts` is a real table, not `brands` jsonb — `save_brand` only carries
  `connections` and `smartlink`. The browser syncs posts by direct upsert
  through an explicit column whitelist in `js/remote-store.js` (`FIELDS.posts`,
  `_dbToRows`, `_rowsToDb`): a column the whitelist does not name is invisible
  to the app even when it exists.
- `PublishInput` (`_shared/platforms.ts`) is `{ text, mediaUrl, accessToken,
  connection }` — one text, one media.
- `publishPost` (`functions/publish/index.ts`) loops over `post.networks`, and
  per platform reads the prior `post_targets` row, decides retry eligibility,
  marks `publishing`, calls `adapter.publish({ text: post.text, … })`, records
  the outcome. `post_targets` is unique on `(post_id, platform)` and carries
  `status`, `failure_kind` (`retryable|permanent|unknown`), `next_retry_at`,
  `attempts`.
- All three claim RPCs are `returns setof public.posts` / `returning p.*`, so a
  new posts column reaches `publishPost` with no SQL change.
- ADR 0001 freezes production scope to Facebook, Instagram and YouTube; X,
  LinkedIn, TikTok, Pinterest and GBP are `productionEnabled: false`.
- Meta App Review is imminent. Any new permission restarts that submission.
- 292 tests run today (131 behaviour, 78 node, 83 Deno). Those pinning the post
  shape: `post-validation` (13), `planner-compose` (11), `publish-now` (4),
  `delivery-panel` (6), and the eight `publishPost` call sites in
  `_shared/platforms.deno.ts`, which all build post literals as
  `{ id, brand_id, networks, text, media_url }`.

## Decision

### 1. Data model — a `variants` map on the post, not per-network posts

- **Chosen: `alter table public.posts add column if not exists variants jsonb
  not null default '{}'`**, shaped `{ "<network>": "<text>" }`. An entry
  overrides `posts.text` for that network; an absent or empty entry inherits it.
- Rejected: one post row per network. The calendar chip, composer, delivery
  panel, `claim_post_for_publish` and the retry model are all per-post;
  splitting rows would duplicate date/time/media/status per network, turn one
  calendar entry into five, and thread a new grouping key through
  `claim_due_posts`, realtime and `refreshPostTargets` — buying nothing
  variants do not, since `post_targets` already gives per-network outcome.
- Rejected: post-scoped data in brand jsonb — every post edit becomes a
  whole-brand write.
- Flow: no `save_brand` change. `js/remote-store.js` needs exactly three edits —
  `"variants"` in `FIELDS.posts`, and the field carried in `_dbToRows` and
  `_rowsToDb`. **That file is owned by another workstream this week; sequence
  the change with its owner rather than editing in parallel.**
- Backward compatibility is the acceptance contract: with `variants` absent or
  `{}`, every existing post publishes byte-identically. Resolution is one
  expression, `post.variants?.[platform] ?? post.text`, so the eight existing
  `publishPost` tests and all 13 post-validation tests stay green unedited. A
  regression test asserts exactly that.
- Storage rules: keys must be known network ids; a variant equal to the base or
  empty is deleted rather than stored; variants for networks later deselected
  are retained (re-selecting restores the draft) but are **never sent**; each
  variant is capped at the base text cap. Variants render through `esc()`
  exactly like `text` — no new escaping surface.

### 2. First comment — capability per adapter, verified not assumed

| Network | Endpoint | Scope held today | Verdict |
| --- | --- | --- | --- |
| Facebook Page | `POST /{post_id}/comments` | `pages_show_list`, `pages_manage_posts`, `pages_read_engagement` | **Unproven.** Meta's reference attributes comment *creation* as the Page to `pages_manage_engagement`, which we do not hold. Treat as scope-adding until a live call proves otherwise. |
| Instagram | `POST /{ig-media-id}/comments` | `instagram_business_basic`, `instagram_business_content_publish` | **Needs `instagram_business_manage_comments`** — not requested, App Review-gated, and it also grants comment *reading/moderation*, widening the data-handling statement. |
| X | `POST /2/tweets` with `reply.in_reply_to_tweet_id` | `tweet.write` | Technically free, but X is production-frozen (ADR 0001). Build dormant, ship never until X unfreezes. |
| YouTube | `commentThreads.insert` | `youtube.upload`, `youtube.readonly` | Needs `youtube.force-ssl`, a broad scope that reopens Google OAuth verification. Rejected for v1. |
| LinkedIn / TikTok / Pinterest / GBP | — | — | Production-frozen. Out of scope. |

- **Required pre-decision experiment (minutes, not days):** comment on the
  internal SCH brand's own Page post with the existing Page token. HTTP 200
  means Facebook first comments cost nothing; OAuth error #200 means Meta first
  comments are entirely an App Review question. Do not answer decision 6 first.
- **Chosen data shape: `first_comment jsonb not null default '{}'`, shaped
  `{ "<network>": "<text>" }`** — symmetric with `variants`, no reserved keys.
- Rejected: a single `first_comment text` column. First comments are inherently
  network-specific (IG hashtag block, FB link, X thread opener), so one shared
  string would be wrong somewhere most of the time. A "copy to every network"
  button gives the ergonomics without the data-model compromise.
- **Delivery semantics: the comment can never fail its post.** The comment is
  attempted inside the same per-target loop *after* `post_targets` has been
  marked `published`. New nullable columns: `comment_status`
  (`pending|published|failed|skipped`), `comment_remote_id`,
  `comment_error`, `comment_failure_kind`, `comment_attempts`. The
  partial-outcome state is `status='published' AND comment_status='failed'` —
  no new post-level status, so `posts_status_check` is untouched, and
  `postVisibleStatus` keeps returning `published`.
- Retry: **manual only in v1.** A comment failure never schedules automatic
  work and never touches `claim_due_posts`. A dedicated retry path acts only on
  targets that are `published` with `comment_status='failed'` and
  `comment_failure_kind <> 'unknown'`, and never re-sends the post.

### 3. Composer UX — an off-by-default "Customize per network" disclosure

- **Chosen:** a checkbox under the Content textarea. When on, one native
  `<details>` per *selected* network, each containing a variant textarea whose
  placeholder is the base text, a live character counter, and — for networks
  that support it — a first-comment textarea. Off by default; a post with no
  variants looks exactly as it does today.
- Rejected: tabs per network. Tabs hide the base text, so the customer cannot
  see what a network inherits, and they add an ARIA tab pattern with roving
  tabindex to a modal already covered by `modal-keyboard.test.mjs` and
  `test-browser/focus-order.browser.mjs`. `<details>` is keyboard-accessible for
  free and preserves DOM order.
- Rejected: always-expanded per-network rows. The composer is already tall on a
  phone (content, AI assist, media, uploads, network picker, date/time).
- AI assist synergy: `runAiAssist("rewrite")` is today blocked unless exactly
  one network is selected (`aiNetwork()`) — its most-hit blocker. With variants,
  rewrite targets the network whose section is focused however many are
  selected, and `useAiSuggestion` writes into that variant instead of
  `#pm_text`. A `js/planner.js` change only; `supabase/functions/ai-assist`
  already accepts the `network` field.
- Character counters: X 280, Instagram 2200, Pinterest 500, LinkedIn 3000,
  TikTok 2200, YouTube 5000, GBP 1500, Facebook 63206. Advisory (amber near the
  cap) except X, which the adapter silently truncates today
  (`text.slice(0, 280)`) — v1 refuses to save an over-length X variant rather
  than letting the server quietly discard the customer's words.
- Validation: `validatePostForm` resolves each selected network's effective text
  first, then applies today's rules to it. An empty variant means inherit, never
  "publish nothing". Media rules are unchanged — media stays per-post in v1.

### 4. Publish-function changes

- Variant resolution happens in `publishPost`'s per-target loop, **not** at
  claim time. The claim RPCs are the atomicity-critical SQL and already return
  `p.*`; keeping them shape-agnostic means zero migration to three functions
  that took real effort to get right.
- Ordering per target: mark `publishing` → `adapter.publish` → mark `published`
  → attempt comment → patch `comment_*`. The result object gains
  `comment_status` / `comment_error` so `publishNow` and `deliveryPanel` can
  report "Published — first comment did not post. Retry it."
- `PublishOutcomeUnknownError` interplay, three cases:
  1. **Post outcome unknown** → the comment is never attempted;
     `comment_status='skipped'` with a reason. Attempting it would confirm a
     post we deliberately refuse to confirm.
  2. **Comment outcome unknown** (transport loss or 5xx on the final comment
     request) → `comment_status='failed'`, `comment_failure_kind='unknown'`,
     message "Verify the comment before retrying." Manual retry refuses it,
     exactly as the post path refuses unknown targets: a duplicate comment is
     public duplication too.
  3. **Stale-claim recovery** — today the loop sees `previous.status ===
     'published'` and `continue`s, which would strand the comment forever.
     Amended: on that branch, if a first comment is configured and
     `comment_status is null`, attempt it. The post and the comment are separate
     idempotency domains; a never-attempted comment is safe to attempt.

### 5. Out of scope for v1

- **Carousels** — needs a media *array* plus an N-container Instagram upload
  flow; a larger data-model change than variants, and independent of it.
- **X threads** — X is production-frozen, and an ordered N-post chain is a
  strictly harder idempotency problem than one comment.
- **Stories** — a different, ephemeral container type; neither `post_targets`
  evidence nor `metrics_daily` fits it.
- **Per-network media** — multiplies upload storage and every media rule; one
  `media_url` stays the contract.
- **Per-network scheduling times** — the claim is per-post and timezone-atomic;
  splitting it reopens ADR 0001 acceptance item 2.
- **Automatic comment retry** — manual only, keeping `claim_due_posts` untouched.
- **Backfilling comments onto already-published posts.**

### 6. Effort and sequencing

| Component | Size |
| --- | --- |
| Migration: `posts.variants`, `posts.first_comment`, `post_targets.comment_*` | S |
| `remote-store.js` whitelist + both mappers (coordinate with its owner) | S |
| `publishPost` variant resolution + compatibility test | S |
| Composer disclosure panel, counters, per-variant validation | L |
| AI rewrite retargeted to the focused variant | S |
| `platforms.ts` `comment()` capability, Facebook + Instagram + dormant X | M |
| `publishPost` comment step, unknown-outcome and recovery interplay | M |
| `deliveryPanel` comment outcomes + manual comment retry path | M |

Overall M/L — roughly a week and a half including acceptance evidence.

**Sequencing, and the release-shaping point: split the ship.** Variants need no
provider permission at all and can land during App Review. First comments are
blocked on a Meta permission answer. Order: migration → `publishPost` variant
resolution → composer → AI rewrite retarget → *(gate: decision 6)* → adapter
`comment()` → publish comment step → delivery panel and retry.

### 7. Test plan

- `platforms.deno.ts` `publishPost`: absent `variants` sends `post.text`
  (compatibility); a variant is sent to exactly its platform; a variant for an
  unselected network is never sent; a comment failure leaves the target
  `published`; an unknown post outcome skips the comment; a recovered target
  attempts a null comment but never a failed-unknown one. New adapter tests:
  Facebook comment hits `/{post_id}/comments`; Instagram comment is refused
  readably while the scope is absent; X reply carries `in_reply_to_tweet_id`.
- `post-validation`: over-cap X variant refused, empty variant inherits, the 13
  existing cases unchanged. `planner-compose`: panel off by default, a variant
  round-trips through save and reopen. `delivery-panel`:
  published-with-failed-comment renders as published and offers only a comment
  retry. `modal-keyboard` + `focus-order.browser`: the expanded panel keeps
  focus order. `hostile-input`: both maps escape like `text`. `ai-assist`:
  rewrite lands in the focused variant. `production-readiness`: new columns
  declared, RLS unchanged, no new anon grant. `settings-backup`: export/import
  carries both maps.

## Consequences

- The post shape gains its first per-network dimension. Every future field must
  now answer "is this per-post or per-network?", and export/backup
  (`settings-backup.test.mjs`) must carry both maps.
- A published post can now be partially successful in a way that is not a
  failure. The UI must say "published, comment did not post" without the alarm
  language reserved for delivery failure.
- If decision 6 is yes, Meta App Review timing moves. That is a release-owner
  call, not an engineering one.
- ADR 0001's frozen provider scope still holds: X reply-to-self ships dormant.

## Decisions required

1. Ship publishing depth as the next feature after SmartLinks at all? yes/no
2. Per-network text as a `variants` jsonb map on `posts`, not per-network post rows? yes/no
3. Absent/empty variant inherits the base text, and existing posts publish byte-identically (enforced by test)? yes/no
4. First comment stored as a per-network `first_comment` map with no single shared string? yes/no
5. Run the Facebook `pages_manage_engagement` probe on the internal brand before answering 6? yes/no
6. **Add `instagram_business_manage_comments` (and, if the probe says so, `pages_manage_engagement`) to the imminent Meta App Review submission — accepting the delay — rather than deferring first comments to a second submission?** yes/no
7. Split the release: ship variants during App Review, ship first comments after the permission answer? yes/no
8. Comment failure never fails the target — `status='published'` plus `comment_status='failed'` as the partial-outcome state? yes/no
9. Comment retry is manual only in v1, and refuses unknown comment outcomes? yes/no
10. On stale-claim recovery, attempt a never-attempted comment on an already-published target? yes/no
11. Composer uses an off-by-default "Customize per network" disclosure rather than tabs? yes/no
12. Refuse to save an over-280-character X variant instead of letting the adapter silently truncate? yes/no
13. AI "Rewrite for network" retargets to the focused variant, dropping the one-network-selected restriction? yes/no
14. Accept the v1 cuts — no carousels, no X threads, no stories, no per-network media or scheduling? yes/no

## Decisions (2026-08-30)

Answers to "Decisions required", in order. All fourteen are accepted as
recommended, with the nuances and amendments recorded below. Where an answer
amends the body above, the amendment governs; the body text is left as written
for the record.

1. **Yes, conditionally.** Publishing depth is the next feature after
   SmartLinks, but it does not jump ahead of ADR 0001's release gates —
   reliability and monitoring, Meta acceptance, and accessibility. Those gates
   keep their priority; this work fills the capacity around them.
2. **Yes.** Per-network text is a `variants` jsonb map on `posts`. Per-network
   post rows are rejected for the reasons given in the body.
3. **Yes, with an amendment to the resolver.** Existing posts must publish
   byte-identically, enforced by test. *Amends the resolution expression in
   decisions 1 and 4 of the body:* `post.variants?.[platform] ?? post.text` is
   **insufficient**. The effective-text resolver must treat a **missing, empty
   and whitespace-only** variant alike as inheritance of the base text. `??`
   only catches null/undefined, so a variant of `""` or `"   "` would publish
   an empty or blank post to that network.
4. **Yes.** First comments are stored as a per-network `first_comment` map. No
   single shared string; a "copy to every network" control supplies the
   ergonomics.
5. **Yes.** Run the Facebook `pages_manage_engagement` probe on the internal
   brand before acting on decision 6. It costs minutes and it decides whether
   Facebook first comments are a permission question at all.
6. **No — do not add comment permissions to the imminent submission.** If
   adding `instagram_business_manage_comments` (or
   `pages_manage_engagement`) could delay approval of core publishing, it does
   not go into the current Meta App Review submission. Instagram first comments
   move to a **later, separate submission**. *Amends the framing of decision 2
   and the third consequence:* Meta App Review timing is not moved by this
   work. **Conditional exception:** if the decision-5 probe succeeds on
   permissions the app **already holds**, Facebook first comments may ship
   **without another Meta review**; Instagram stays deferred either way.
7. **Yes — split the release, variants first.** Variants need no provider
   permission and land during App Review. First comments follow the permission
   answer, per decision 6. The sequencing in decision 6 of the body stands.
8. **Yes.** A comment failure never fails its target. `status='published'` with
   `comment_status='failed'` is the partial-outcome state; `posts_status_check`
   and `postVisibleStatus` are untouched.
9. **Yes.** Comment retry is manual only in v1 and refuses unknown comment
   outcomes. A duplicate public comment is a real harm, not a cosmetic one.
10. **Yes.** On stale-claim recovery, a never-attempted comment
    (`comment_status is null`) on an already-published target is attempted. The
    post and the comment are separate idempotency domains.
11. **Yes.** An off-by-default "Customize per network" disclosure, not tabs. A
    post with no variants looks exactly as it does today.
12. **Yes.** An over-280-character X variant is refused at save time rather
    than silently truncated by the adapter.
13. **Yes.** AI "Rewrite for network" retargets to the focused variant and the
    one-network-selected restriction is dropped.
14. **Yes.** The v1 cuts stand — no carousels, no X threads, no stories, no
    per-network media, no per-network scheduling.

### Amendments carried by these answers

- **Inheritance rule (see 3).** Missing, empty and whitespace-only variants all
  mean "inherit the base text". *Amends decision 1's backward-compatibility
  paragraph and decision 4's resolution note in the body.*
- **Server-side validation.** Network keys, value types and length limits are
  validated **server-side**, not only in the composer. *Amends the storage
  rules in decision 1 and the validation note in decision 3,* which describe
  those limits as composer-side behaviour: the database and publish path must
  not trust a client-authored `variants` or `first_comment` map.
- **No dormant X comment adapter.** Do **not** build a dormant X comment
  adapter while X is production-frozen. *Amends the X row of decision 2's
  capability table ("Build dormant, ship never until X unfreezes"), the
  `platforms.ts` line in decision 6's effort table, the X reply assertion in
  decision 7's test plan, and the fourth consequence ("X reply-to-self ships
  dormant").* Unshippable code is unverifiable code; build it when X unfreezes.
- **Probe result (2026-08-30): DENIED.** The live probe against the internal
  brand's own Page (post `…_122111105709416585`, via the owner-gated
  `probe_fb_comment` action) returned Graph error `(#200) You do not have
  sufficient permissions to perform this action` — `pages_manage_engagement`
  is required. Held permissions do not suffice, so the conditional release
  below never triggers: Facebook first comments join Instagram's in the later
  Meta permission submission (delivery item 6), and the current submission is
  unaffected.
- **Facebook may ship on held permissions (see 6) — clarified 2026-08-30.**
  A successful live probe using permissions **already granted to and approved
  for the app**, with no additional scopes requested, releases Facebook first
  comments for **controlled internal use only**. This must not delay or alter
  the current Meta submission in any way. External-beta release of the feature
  remains gated on the relevant Meta approval and acceptance testing.
  Instagram first comments remain deferred.

- **Carousels are delivered after v1 (2026-08-31).** *Amends decision 14 and the
  first bullet of "Out of scope for v1"* — which cut carousels because they need
  "a media *array* plus an N-container Instagram upload flow". Both are now
  built, and neither costs a Meta permission: `instagram_business_content_publish`
  already covers a CAROUSEL container, so this ships alongside variants without
  touching the submission that decision 6 exists to protect.
  - Storage is `posts.media_urls jsonb` (nullable), an ordered array of 2..10
    https URLs, validated by `posts_media_urls_valid` — the same
    CHECK-via-IMMUTABLE-function seam `posts.variants` established and
    `posts.tiktok_options` reused.
  - **`posts.media_url` is untouched and stays the contract for every other
    network**, so the "per-network media" cut in the same list still stands: the
    carousel is `[media_url, ...extras]`, one post, one cover, and the other
    seven networks publish the first item exactly as they do today. The composer
    says so where the items are added.
  - A carousel is all-or-nothing. One rejected item container means no CAROUSEL
    container is created and `media_publish` is never called, so the
    partial-outcome state this ADR introduced for comments has no analogue here:
    a carousel either publishes whole or fails whole, and the failure names the
    item by number and the provider by status without forwarding its body.

- **Hashtag groups are delivered (2026-08-31).** Named, reusable tag sets per
  brand — the last publishing-depth item that needed no Meta permission and no
  Edge Function, and a Metricool-parity gap. Client and database only:
  **hashtags reach a post as ordinary text**, so `supabase/functions/*`, the
  three claim RPCs and `posts_guard_status_transition` are all untouched, and
  nothing here goes near the submission decision 6 exists to protect.
  - Storage is a new table, `public.hashtag_groups`, not brand jsonb. A group is
    an independent per-brand record created, renamed and deleted one at a time,
    exactly like a post or an inbox thread; brand jsonb would make every group
    edit a whole-brand write and would route it through `save_brand`.
  - `tags` is validated by `hashtag_groups_tags_valid` — the same
    CHECK-via-IMMUTABLE-function seam `posts.variants` established and
    `posts.media_urls` reused: 1..30 `#`-prefixed strings of 2..100 characters,
    no whitespace inside a tag and no control characters.
  - RLS is `is_member(brand_id)` for all operations, the `posts_all` / `inbox_all`
    shape. ADR 0006 reserves `is_owner` for destructive and account-shaped acts;
    composing is everyday editor work and a hashtag group is composing equipment.
  - The composer offers a closed `<details>` beside the AI **Hashtags** button
    that appends a group's tags to `#pm_text` after a blank line, skipping any
    tag the post already carries. Unlike the AI row it is not gated on live mode:
    a group is local data, so local and demo workspaces get the whole feature.

- **X threads are delivered, dormant (2026-08-31).** *Amends decision 14 and the
  second bullet of "Out of scope for v1"* — which cut X threads because "X is
  production-frozen, and an ordered N-post chain is a strictly harder
  idempotency problem than one comment". The second half was the real objection
  and it is answered below; the first half is unchanged and stays unchanged.
  **X remains `productionEnabled: false`.** Nothing here lifts the freeze, no
  environment variable opens it (there is deliberately no analogue of TikTok's
  sandbox gate for X), discovery is untouched, and the feature is proven by
  tests alone because X cannot be exercised live. This is the TikTok compliance
  workflow's pattern: build the completed behaviour behind the freeze, so that
  a beta GO is a decision rather than a project.
  - *Also amends decision 12.* Over-length X copy was a **refusal** — correct
    when the only alternative was the adapter's silent `text.slice(0, 280)`,
    which published a post the customer never wrote. It is now a **thread**,
    which is the thing they meant. The refusal that remains is the one no split
    can rescue: a single word wider than a tweet.
  - The rule is one pure function, `splitXThread(text)`, written twice — Deno in
    `platforms.ts`, browser in the new leaf module `js/x-thread.js` — and bound
    by `test/fixtures/x-thread-cases.json`, which **both** suites assert. That
    is exactly the mechanism `effective-text-cases.json` established for
    `effectiveText`, and for the same reason: one implementation draws the
    preview that promises three tweets and the other decides what X is sent.
  - Text at or under 280 is one tweet, byte for byte, in the request body this
    adapter has always sent. Over it, the text is broken at **paragraph**
    boundaries first, then **sentence**, then **word**, never mid-word, and
    every tweet carries a ` (n/m)` suffix — only when `m > 1`, because a lone
    `(1/1)` is numbering that says nothing. Width is counted in **code points**,
    so an emoji is one character and a surrogate pair can never be counted apart
    or split. The suffix is reserved for *before* the count is known, which is
    why the splitter re-splits when the first pass produced more tweets than the
    reservation covered — the alternative is a 281-character tweet X rejects.
  - **Idempotency, the objection that cut this in the first place.** The chain
    is posted head first, each tweet replying to the id the previous request
    returned, and media rides the first tweet only. Any failure *after* the
    first tweet has already put public content on the profile, so the outcome of
    the post is ambiguous **even when the provider's answer was not**: a clean
    400 on tweet three still leaves tweets one and two live. Every such failure
    is therefore a `PublishOutcomeUnknownError`, which the publish loop
    classifies `unknown` — the one classification refused by the automatic path,
    by the manual path (`["retryable","permanent"]` does not include it) and by
    the stale-claim guard. A partially posted thread can never be re-posted from
    tweet one. A `ProviderRequestError` would be `permanent`, which a customer's
    manual retry *is* allowed to re-run, and that would duplicate the thread.
    This is the opposite of the carousel, where every failure precedes
    `media_publish` and rebuilding the provider's status is safe precisely
    because no post exists yet.
  - The composer replaces the refusal with a preview in the per-network area —
    "Will post as an X thread of N tweets", plus the first line of each — drawn
    from the text X actually receives, so the base copy when X inherits it and
    the `variants.x` copy when it does not. `HARD_TEXT_CAPS.x` stays 280 and no
    other network's cap moves; what changed is that X's cap now gates a split
    rather than a save.
  - **Threads store nothing.** The chain is derived from the post's own text at
    publish time, so there is no thread table, no per-tweet row, no ordering
    column, and no change to any of the three claim RPCs. The one migration this
    needed is a *relaxation*: `posts_variants_valid` capped an `x` variant at 280
    because decision 12 refused one, and a database that still refused what the
    composer had just previewed as three tweets would be the "worse liar" the
    original migration named. `x` rejoins every other network under the 63206
    ceiling, which is unchanged and still stops unbounded jsonb.

**Closing rationale.** The governing constraint is protecting the current Meta
submission. Nothing in this ADR may put core publishing approval at risk, so
scope that needs a new Meta permission is deferred to a later submission, and
scope that needs none — variants first — ships in the meantime.
