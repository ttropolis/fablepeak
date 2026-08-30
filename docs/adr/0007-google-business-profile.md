# ADR 0007: Google Business Profile publishing

- Status: Proposed (2026-08-31)
- Date: 2026-08-31

## Context

Google Business Profile is the last unplanned integration in FablePeak's
network list and the only one of the eight with **no adapter at all**. Every
other frozen platform (X, LinkedIn, TikTok, Pinterest) has a written adapter
held back by `productionEnabled: false`; GBP has an id and a card and nothing
behind them.

What the code actually says today:

- `js/constants.js` lists `{id:"gbp", name:"Google Business", short:"GB",
  color:"#34a853"}` as the eighth network. `index.html` contains **no
  GBP-specific markup** — it contributes only the `.conngrid` / `.conn` /
  `.nico` CSS at lines 249-254; the card is built for every network by
  `renderConnections` in `js/connections.js`.
- `js/connections.js` supplies the copy: `PLATFORM_NOTES.gbp` — "Planned.
  Google API approval, location selection and Business Profile post publishing
  are not implemented yet." — and `PLATFORM_PENDING_STATUS.gbp` — "Not
  implemented". Because `gbp` is never in `connCache.available`, the card
  renders a disabled Connect button titled with that status. The copy is
  accurate, which is the baseline this ADR must not make worse.
- `PLATFORM_SETUP.md` says the same twice: the media matrix row reads
  "Google Business | Disabled | Disabled | Disabled | Disabled | Adapter is not
  implemented", and the deployment note says "TikTok and Google Business
  require more product work before they can be enabled safely."
- `supabase/functions/_shared/platforms.ts` does **not** know the id: the
  `Platform` union (line 7) names seven platforms and `ADAPTERS` (line 1588)
  holds seven adapters. Adding GBP is a ninth `PlatformAdapter` object plus one
  union member — the file's opening comment claims "adding one is a single
  object", and this ADR is the test of that claim.
- The **database already allows it**. `social_connections.platform`
  (`supabase/schema_social.sql:20`) and the `post_targets` platform CHECK
  (`20260731090000_reliable_scheduling.sql:131`) both list `'gbp'`, and
  `posts.variants`' key allowlist includes it deliberately —
  `20260830120000_post_variants.sql` says so in its own words: "The key
  allowlist includes `gbp` deliberately even though no gbp adapter exists: gbp
  is one of the app's eight network ids, and a gbp variant is as inert as a gbp
  base post — the publish loop already skips adapterless platforms with a clean
  'not configured' result. Forward-compatible for the day Google Business
  ships; not a publish-boundary hole today." **This ADR is that day.** No
  migration is needed to store a GBP connection or a GBP variant.
- Inertness is enforced in `supabase/functions/publish/index.ts:113-119`: with
  no adapter, or with `platformConnectionEnabled` false, or with the client id
  absent, the target is marked `skipped / permanent` with "Platform not
  configured on the server". A `gbp` target today is a no-op with a readable
  reason, not an error.
- `js/planner.js:395` already carries a GBP character cap of 1500 from ADR 0005
  decision 3, written before any adapter existed.
- Google is already a configured provider. The YouTube adapter uses
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `accounts.google.com/o/oauth2/v2/
  auth`, PKCE, and `access_type=offline` + `prompt=consent` +
  `include_granted_scopes=true`. `GOOGLE_OAUTH_VERIFICATION.md` describes a
  **submission that is currently in Google's hands** for
  `youtube.readonly` + `youtube.upload`, using "one web OAuth client in Google
  Cloud project `fablepeak`". That review is the governing constraint here in
  exactly the way the Meta submission governs ADR 0005.
- ADR 0001 freezes production scope to Facebook, Instagram and YouTube. GBP is
  outside it and stays outside it until this ADR's gates are met.

### Knowledge-cutoff warning — read before costing any of this

The author's knowledge of Google's APIs ends in **May 2026**, and the Google
Business Profile APIs have been the most actively reorganised surface in
Google's catalogue: the monolithic **My Business v4** API was split into
Business Information, Account Management, Performance, Notifications and other
APIs, and pieces of v4 have been progressively deprecated and shut down. Local
posts (`accounts/*/locations/*/localPosts`) were, at the cutoff, still served
by the legacy v4 surface. **Every endpoint, resource name, field, limit and
quota in this document is a hypothesis to be re-verified against Google's
current documentation before a line is written**, and the verification is
listed as a pre-implementation step in decision 9. Statements carrying
specific cutoff risk are marked **[cutoff]** below. If verification finds that
local post creation is no longer available to third-party applications at all,
this ADR is void and decision 1's fallback (keep the card exactly as it reads
today) is the end state — which is precisely why nothing here proposes storage
or UI that would be stranded.

## Decision

### 1. Do not touch the Google OAuth client while the current review is open

- **Chosen: `https://www.googleapis.com/auth/business.manage` is not added to
  the `fablepeak` OAuth client, and no scope, consent-screen or data-access
  change is made, until the pending YouTube verification concludes** — approved
  or rejected, but concluded. This mirrors ADR 0005 decision 6 for Meta: the
  submission protecting core publishing is not put at risk by a network that
  publishes nothing today.
- `business.manage` is a single broad scope covering read and write across the
  user's Business Profile accounts and locations. It is at least as sensitive
  as the YouTube pair and will need the same treatment: justification text,
  demo video, and a review clock **[cutoff — the exact sensitive/restricted
  tier and whether a security assessment is required should be read off the
  console, not from this document]**.
- Rejected: **adding the scope now, while the review is pending.** Editing the
  requested scopes of an app under verification is the one action that
  reliably restarts the clock, and the app under review is the one that
  onboards YouTube customers today.
- Rejected: **a second Google Cloud project and OAuth client for GBP.** It
  would decouple the review clocks, and that is its only merit. Against it:
  two consent screens, two verification submissions, two brand-verification
  records, two secret pairs in the Edge Function environment, a second entry
  in `PLATFORM_SETUP.md`'s redirect-URI section, and a customer who sees two
  differently-named applications asking for access to one Google account. The
  cost is permanent; the benefit is a one-time scheduling convenience.
- Rejected: **shipping the adapter first and the scope later.** Harmless in
  principle — `productionEnabled: false` keeps it dormant — but it produces
  unverifiable code, which is the mistake ADR 0005's amendment about the
  dormant X comment adapter already named. The adapter merges when it can be
  exercised (decision 8).

### 2. Access reality — two independent approvals, only one of which is OAuth

Adding GBP is not one gate but two, and the expensive one is not engineering:

| Gate | What it is | Who owns it | Clock |
|---|---|---|---|
| **GBP API access application** | A Google **form** requesting access to the Business Profile APIs for a specific Cloud project, plus the quota grant that follows. Business details, use case, and the project number. Not an OAuth artefact at all. | The business, not the codebase | Long, opaque, and historically the slowest step of a GBP integration **[cutoff — the current form, its name and its stated turnaround must be read from Google's docs]** |
| **OAuth verification for `business.manage`** | The same process `GOOGLE_OAUTH_VERIFICATION.md` describes for the YouTube scopes, on the same client, with its own justification text and demo video | Us, on Google's clock | Comparable to the current review |

- Both must complete before one real post is published. Neither is unblocked
  by writing code, and one of them (the application) is unblocked by *nothing*
  we do after filing — which is the argument for filing it early (decision 3).
- Until the application is granted, the APIs return a permission/quota error
  for the project regardless of what the user consented to. A granted scope
  without a granted project is a connection that authorizes and then fails at
  publish — the worst failure shape we could ship, and the reason
  `productionEnabled` stays false until **both** are in hand.
- The application asks for business identity. It should name the same legal
  entity that fronts the other provider applications — the ABN-registered
  parent, not the product brand — because a mismatch between the applicant and
  the verified business is the standard cause of these applications being
  refused. Confirm the exact entity with the release owner before filing
  (decision 3).
- Rejected: **treating the scope review as the whole gate.** That is the
  YouTube-shaped assumption and it is wrong for GBP; a project without the API
  access grant cannot call the API at all.

### 3. File the access application ahead of the scope change

- **Chosen: file the GBP API access application as soon as the release owner
  confirms it does not modify, reopen or otherwise disturb the pending OAuth
  verification** — the two are, at the cutoff, separate tracks (a project-level
  API/quota request versus a client-level consent review), but that separation
  must be confirmed in the console rather than assumed here **[cutoff]**. Its
  clock is the long one and it is the only work item that can run while
  decision 1 holds everything else still.
- If that separation cannot be confirmed, the application waits with everything
  else. The ordering rule is unconditional: **nothing jeopardises the review in
  flight.**
- Rejected: **filing everything at once after the review concludes.** It
  serialises two long external clocks that could overlap, for no benefit beyond
  tidiness.
- Rejected: **filing the application and quietly beginning the scope change in
  parallel.** That is decision 1 with extra steps.

### 4. Product shape — what a "post" on GBP actually is

- A Business Profile post is a **local post** attached to one location: a
  short body, optionally a photo, optionally a call-to-action button, in one of
  three shapes — **What's New**, **Event** and **Offer**. Events and Offers
  carry their own required fields (schedules, titles, coupon codes, terms), so
  they are not the same object with a flag **[cutoff — the topic-type
  vocabulary and required fields must be verified]**.
- **Chosen for v1: What's New only** (`topicType: STANDARD` at the cutoff),
  body text plus at most one photo, no call-to-action button. That is the only
  shape that maps onto FablePeak's existing post — one text, one media URL —
  with no new per-post storage.
- Rejected: **Event and Offer in v1.** Each needs a per-post options object
  (dates, titles, redemption terms), which means a third options column
  alongside `posts.tiktok_options` and `posts.instagram_options`, a composer
  section, client and server validation, and a backup/export change. Those two
  columns exist because TikTok and Instagram *refuse to publish* without the
  choices; GBP publishes a What's New post without any of it.
- Rejected: **the CTA button in v1.** It is one enum plus one URL and is
  genuinely tempting, but a button is a per-post choice, and the moment there
  is one per-post choice there is a `posts.gbp_options` column. Deferred with
  Events and Offers, to be reconsidered together.
- **Local posts expire.** At the cutoff, What's New posts stopped surfacing
  after roughly seven days while Events and Offers ran to their end date
  **[cutoff — Google has changed this behaviour more than once]**. This is a
  product fact the composer should state, not a bug: a customer who schedules
  GBP copy is publishing something transient, unlike every other network in the
  list.
- Media constraints are stricter than the app's current rule: GBP requires a
  publicly fetchable image meeting minimum dimensions and a size ceiling, and
  local posts have historically not accepted video **[cutoff]**. The adapter
  therefore sets `supportsMedia: true`, `requiresMedia: false` (text-only local
  posts are permitted) and rejects non-image media with a readable message
  rather than forwarding it.
- **There is no comments or inbox surface.** GBP has reviews and Q&A, which are
  a different product with a different scope story and a different moderation
  liability. Consequences: GBP never joins ADR 0005's first-comment feature —
  the capability table's "LinkedIn / TikTok / Pinterest / GBP — production
  frozen, out of scope" row becomes "GBP has no comment concept" permanently —
  and GBP contributes nothing to Inbox.

### 5. Location model — one connection row per location, Pinterest's shape

- **Chosen: `identifyAll()` returns every location the authorized Google
  account manages; the adapter sets `requiresExplicitSelection: true` and
  `sharedAuthorizationAcrossAssets: true`; the customer picks the publishing
  location with the existing "Use for publishing" control.** This is exactly
  the Pinterest board model (`platforms.ts:1467-1468`), which exists because
  one authorization discovers many publishable assets and the customer must say
  which one is theirs before anything publishes.
- Storage falls out of the existing schema with no migration:
  `social_connections.external_id` holds the location resource name
  (`locations/{locationId}` at the cutoff), `display_name` holds the location
  title plus a disambiguating hint, `meta` holds the parent account resource
  name and whatever the verify path needs. `unique (brand_id, platform,
  external_id)` already permits many locations per brand, and
  `is_default` already answers "which one publishes".
- Publishing uses the `is_default` row. `requiresExplicitSelection: true`
  matters for a second reason: `publish/index.ts:122-127` deliberately refuses
  the oldest-active-connection fallback for such adapters, so a GBP post can
  never publish to a location the customer did not choose.
- **One publishing location per brand per post in v1.** A brand with five
  locations connects the one it publishes to; connecting the other four is
  allowed (they are rows) but only the default receives posts.
- Rejected: **one connection representing the account, with a per-post location
  picker.** It re-answers a question the product already answers with
  `is_default`, and it requires the per-post options column decision 4 just
  refused.
- Rejected: **fan-out — one FablePeak post publishing to every connected
  location.** `post_targets` is unique on `(post_id, platform)`, so one post
  row cannot carry five outcomes, five remote ids or five retry states without
  redesigning the delivery record that ADR 0005 explicitly declined to split.
  Genuine multi-location publishing is a v2 with its own data model, and it is
  a different product feature (per-location copy) rather than a bigger version
  of this one.
- The card must name the **location**, not just the Google account. Publishing
  to the wrong branch of a multi-location business is publicly visible, looks
  like the business's own mistake, and is exactly the failure the display name
  should make impossible to overlook.

### 6. Adapter fit — the object, field by field

- **OAuth**: the same `authorizeUrl`, `tokenUrl`, `usesPKCE: true`,
  `tokenAuth: "body"`, `clientIdEnv: "GOOGLE_CLIENT_ID"` and
  `clientSecretEnv: "GOOGLE_CLIENT_SECRET"` as the YouTube adapter;
  `scopes: ["https://www.googleapis.com/auth/business.manage"]`;
  `authorizeExtra: { access_type: "offline", prompt: "consent" }`.
- **How two platforms share one Google client**: `oauth-start` writes the
  chosen `platform` into the `oauth_states` row alongside the single-use
  `state` (`oauth-start/index.ts:77-80`), and the callback resolves the adapter
  from that row. The redirect URI is already shared by every provider, and the
  client id being shared changes nothing about that lookup. `configuredPlatforms`
  reports both platforms from the same secret pair without modification, since
  it filters on `env(a.clientIdEnv)`.
- **`include_granted_scopes` is deliberately omitted.** The YouTube adapter
  sets it to `"true"`; the GBP adapter must not. With incremental authorization
  on a shared client, a customer connecting the second Google surface can be
  issued a token carrying *both* scopes in one grant. Two consequences we do
  not want: a GBP connection silently holding YouTube upload rights, and — the
  sharper one — `revoke()` on either connection killing the other, because
  Google's revocation endpoint invalidates the grant, not one scope of it. One
  grant per platform keeps disconnect meaning what the confirm dialog says it
  means.
- **Refresh mirrors YouTube exactly**: no `refreshAccess` override, so
  `refreshPlatformToken` takes the default `grant_type=refresh_token` path.
  `access_type=offline` + `prompt=consent` are what make Google issue the
  refresh token in the first place, which is why they are copied verbatim
  rather than reasoned about again.
- **`revoke()` mirrors YouTube's**: same `https://oauth2.googleapis.com/revoke`
  endpoint, preferring the refresh token — correct only because of the
  `include_granted_scopes` decision above.
- **`identify()` / `identifyAll()`**: list the accounts the token can see, then
  the locations under them, and return one `Identity` per location —
  `external_id` = location resource name, `display_name` = location title
  qualified by the account or address so two branches are distinguishable,
  `meta` = `{ account: "accounts/{id}", title, ... }`. `verify()` re-reads the
  stored location and returns the same shape, so `connection-health` and the
  Connections card keep working with no special case.
- **`publish()`**: create a local post at `connection.external_id` with
  `summary` = the text the loop hands the adapter (already resolved through
  `effectiveText(post, "gbp")`, so a `gbp` variant works from day one), plus
  one photo built from `mediaUrl` when present. The create call is the final
  publish request, so its failure classification uses the existing helpers
  without invention: an explicit 4xx is a `ProviderRequestError`, a 5xx or a
  lost response body goes through `rethrowFinalPublishFailure` into
  `PublishOutcomeUnknownError` with "Google may have accepted this post. Check
  the Business Profile before retrying." A duplicate local post is publicly
  visible on a business listing; the unknown-outcome path exists for exactly
  this.
- **`metrics`: omitted in v1.** `ingest-metrics/index.ts:27` reads
  `if (!adapter?.metrics) continue`, so an adapter without it costs nothing and
  breaks nothing. The GBP Performance API is a separate API with its own
  metric vocabulary, its own multi-metric time-series call shape and its own
  quota **[cutoff]**, and the app's `metrics()` contract wants three cheap
  numbers (`followers`, `impressions`, `engagements`). Views and interaction
  counts do not map onto "followers" at all.
- Rejected: **shipping metrics with the adapter.** It doubles the API surface
  under review, it needs its own verification against a live location, and it
  is the least valuable half. Revisit once publishing is proven and only if
  daily numbers cost one request per location.
- `productionEnabled: false` at merge, with the same comment style the frozen
  adapters use, naming the two gates rather than a date.

### 7. Storage — nothing new on `posts`

- **Chosen: no schema change at all in v1.** The location lives in
  `social_connections.external_id`, the account resource name and title in
  `social_connections.meta` — the same place the Facebook Page token and
  Pinterest's `owner_username` already live. No `posts.gbp_options`.
- Rejected: **a `posts.gbp_options` column in v1**, for the reasons in decision
  4. `tiktok_options` and `instagram_options` are the precedent *against* it,
  not for it: both exist because the provider refuses to publish without a
  choice the customer alone can make. GBP has no such requirement for a What's
  New post.
- One real gap to close deliberately: `valid_post_variants` caps every variant
  at 63206 characters and adds an X-specific 280 clause, but has no GBP clause.
  The composer's 1500 (`js/planner.js:395`) is client-side only, and ADR 0005's
  amendment says the database must not trust a client-authored map. When the
  adapter ships, the CHECK should gain a `gbp` clause mirroring the X one, with
  the limit confirmed against Google's current documentation **[cutoff]** — see
  decision 10 in "Decisions required".

### 8. Sequencing — after the review, after beta GO

Strict order, each step blocked on the one before it:

1. Current Google OAuth verification concludes (decision 1).
2. GBP API access application filed — or filed earlier under decision 3 — and
   granted.
3. `business.manage` added to the client; scope justification and demo video
   written into `GOOGLE_OAUTH_VERIFICATION.md`; verification submitted and
   concluded.
4. Adapter merged with `productionEnabled: false` and offline tests.
5. Live acceptance run against a real location (decision 9).
6. `productionEnabled` flipped, `PLATFORM_SETUP.md` and the card copy updated.

| Component | Size |
|---|---|
| GBP access application + entity confirmation (not engineering) | S, long clock |
| Scope justification, demo video, verification submission | M |
| Adapter: OAuth fields, `identify`/`identifyAll`/`verify`, `revoke` | M |
| Adapter: `publish` (local post + photo, error classification) | M |
| `Platform` union, `ADAPTERS`, `PLATFORM_NOTES`/`PENDING_STATUS` copy | S |
| `valid_post_variants` gbp clause migration | S |
| Deno adapter tests + behaviour test for the card copy | M |
| Live acceptance run and evidence | M |

Engineering is M overall — roughly a week including evidence — and it is not
the schedule. The schedule is two external approvals we do not control.

**Where it sits relative to beta GO: after it.** Recommended, and the
recommendation is not close. GBP is the eighth network; the beta ships with
three production networks under ADR 0001; no acceptance-matrix row, no
release gate and no tester script mentions it; and its critical path runs
through a form on Google's desk. Nothing about beta GO is improved by starting
it sooner, and the current Google review — which *is* on the beta path for
YouTube onboarding — is actively harmed by it. It is a post-GO item.

### 9. Testing and acceptance

- **Offline first, in the existing harness.** `_shared/platforms.deno.ts`
  covers adapters with stubbed fetch: `identifyAll` maps an accounts+locations
  response to one `Identity` per location; `publish` sends the resolved text as
  the summary and attaches a single photo; a `gbp` variant reaches the adapter
  and an empty one inherits (already guaranteed by `effectiveText`, asserted
  anyway); a 500 on the create call raises `PublishOutcomeUnknownError` and a
  400 does not; `revoke` posts to Google's revoke endpoint. `npm run
  check:functions` needs no new entry — `_shared/platforms.ts` is type-checked
  through `publish/index.ts`.
- **Node behaviour**: the Connections card renders the GBP status copy that is
  true at that moment; `production-readiness` confirms no new anon grant and no
  new client-writable table; `settings-backup` is unaffected because nothing
  new is stored on the post.
- **Pre-implementation verification step (the cutoff discharge).** Before the
  adapter is written, one engineer reads Google's current documentation and
  records, in this ADR as an amendment: which API and endpoint creates a local
  post today; whether What's New, Event and Offer are all still available to
  third-party apps; the current body-length limit; the current photo
  constraints; the current post-expiry behaviour; the default quota for post
  creation; and the exact name and current turnaround of the access
  application. Any of these coming back "no longer available" changes the
  decision, not just the code.
- **Live acceptance run** — the release owner needs a real Business Profile
  location they control:
  1. Connect Google Business from Connections; show the location list; select
     one as the publishing location.
  2. Confirm the card names the **location**, not only the account.
  3. Schedule a FablePeak post with GBP selected, text plus one photo; let the
     scheduler publish it.
  4. Show the post on the live Business Profile (and, if it surfaces there,
     on Search/Maps) with the same text and photo.
  5. Confirm `post_targets` holds `published` with the remote id, and the
     delivery panel shows the result.
  6. Disconnect, and confirm the authorization is gone from the Google account's
     third-party access list **and that the YouTube connection still works** —
     the direct test of the `include_granted_scopes` decision.
  7. Re-run acceptance matrix row 6 (tenant isolation) with a GBP connection
     present.
- **What stays dormant until then:** everything. With `productionEnabled:
  false`, `configuredPlatforms` omits `gbp`, so the card's Connect button stays
  disabled, `oauth-start` refuses the platform with the frozen-adapter message,
  and any `gbp` target on a post is marked `skipped / permanent` with "Platform
  not configured on the server" — the same behaviour as today, now with code
  behind it.

### 10. Out of scope for v1

- Reviews: reading, replying, or moderating. Q&A likewise.
- Event and Offer post types, and the call-to-action button.
- Multi-location fan-out and per-location copy.
- Metrics, Analytics and Reports coverage for GBP.
- Video, multiple photos, and carousels — one photo, and ADR 0005's
  `media_urls` carousel stays Instagram-only.
- GBP in Inbox — there is no message surface to connect.
- Any per-post GBP storage.

## Consequences

- **FablePeak gains its first integration gated on an application rather than
  on code or a review submission.** The GBP access application has no
  engineering fallback and no appeal SLA: if it is refused, no amount of
  implementation changes the outcome. Every other blocked network in the list
  is blocked on something we can do.
- **The Google OAuth client becomes a shared asset across two products.** From
  the day `business.manage` is added, every future Google scope decision — a
  YouTube Analytics scope, a broader upload scope — is also a GBP decision,
  because they share a consent screen, a verification record and a revocation
  domain. That is the price of decision 1's rejection of a second client, and
  it is a permanent price.
- **The 2026-08-30 variants migration comment comes true.** `gbp` stops being a
  forward-compatible allowlist entry and becomes a live publish path; the CHECK
  that was inert for it now needs a real length clause (decision 7).
- **The product acquires a transient post type.** Every other network's post
  stays until deleted; a What's New post ages out. The composer and any future
  reporting must not imply otherwise.
- **If the application is refused, nothing is stranded except an unmerged
  adapter.** No column, no UI, no migration and no customer-visible promise is
  created before the approval lands — which is the deliberate shape of this
  proposal, not an accident of scoping. The fallback is the status quo: the
  card stays exactly as honest as it reads today, with the pending-status
  string changed from "Not implemented" to whatever is then true.

## Decisions required

1. Pursue Google Business Profile as the eighth network at all, rather than
   closing the item and changing the card copy from "Planned" to "Not
   planned"? **Recommend yes — it is a genuine Metricool-parity network and the
   only remaining one whose cost is mostly waiting.**
2. Hold `business.manage` — and every consent-screen and data-access change —
   until the current Google OAuth verification concludes, approved or
   rejected? **Recommend yes, unconditionally; this is ADR 0005 decision 6's
   rule applied to Google.**
3. File the GBP API access application ahead of the scope change, under the
   same ABN-registered parent entity used for the other provider applications,
   once it is confirmed in the console that filing does not modify or reopen
   the pending verification? **Recommend yes, conditional on that confirmation
   — its clock is the long one, and it is the only step that can run while
   decision 2 holds.**
4. Reuse the existing `fablepeak` Google Cloud project and OAuth client rather
   than creating a second Google app for GBP? **Recommend yes — one consent
   screen, one verification record, one secret pair.**
5. Omit `include_granted_scopes` from the GBP adapter, so a Google connection
   never widens the other Google connection's grant and a disconnect cannot
   revoke both? **Recommend yes — this is the one place where sharing a client
   is genuinely dangerous.**
6. Location model: one `social_connections` row per location, explicit
   selection required (Pinterest's shape), exactly one publishing location per
   brand in v1, with no fan-out? **Recommend yes.**
7. v1 post types: What's New only — text plus at most one photo, no
   call-to-action button, no Event, no Offer, and therefore no
   `posts.gbp_options` column? **Recommend yes; revisit CTA, Event and Offer
   together as one later decision.**
8. Metrics: ship the adapter with no `metrics()` implementation, revisiting the
   GBP Performance API only after publishing is proven and only if daily
   numbers cost one request per location? **Recommend yes — defer.**
9. Add a `gbp` length clause to `valid_post_variants` (mirroring the existing
   X clause) when the adapter ships, rather than relying on the composer's
   client-side 1500 cap? **Recommend yes, with the limit taken from Google's
   current documentation at that time.**
10. Sequencing: strictly post-beta-GO, merged with `productionEnabled: false`,
    behind ADR 0001's provider freeze until acceptance passes? **Recommend yes
    — it is the eighth network and blocks nothing in the beta.**
11. Make the documented pre-implementation verification pass (decision 9's
    checklist: current local-post endpoint, topic types, limits, photo rules,
    expiry, quota, application name and turnaround) a hard precondition for
    writing the adapter, recorded as an amendment to this ADR? **Recommend yes
    — this document was written against May 2026 knowledge of an API family
    Google has been actively restructuring.**
12. Acceptance evidence for flipping `productionEnabled`: a live What's New
    post published by the scheduler to a real location the release owner
    controls, shown on the public Business Profile, plus a disconnect that
    leaves the YouTube connection intact, plus a re-run of acceptance matrix
    row 6 with a GBP connection present — as a release gate rather than a
    follow-up? **Recommend yes; the disconnect check is what proves decision 5
    was implemented and not merely written down.**
