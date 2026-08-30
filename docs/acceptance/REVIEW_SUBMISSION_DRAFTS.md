# FablePeak review submission drafts (Meta + Google)

Paste-ready copy for runbook tasks **3.4** (Meta App Review) and **4.2 / 4.3**
(Google OAuth verification). Nothing here is submitted automatically — a human
pastes each block into the relevant console after Meta business verification
clears.

**Rules for using this file**

- Every `<PLACEHOLDER>` must be replaced by hand at submission time. Never
  commit real reviewer credentials, tokens or secrets to this repository.
- Claims below are grounded in the deployed code
  (`supabase/functions/_shared/platforms.ts`, `supabase/functions/oauth-start`,
  `supabase/functions/oauth-callback`, `supabase/functions/publish`,
  `supabase/functions/connection-health`, `supabase/functions/delete-account`,
  `index.html` and `js/`) and the published pages (`privacy.html`, `terms.html`,
  `data-deletion.html`).
- Anything that could **not** be verified from the repository is marked
  **NEEDS-HUMAN-CONFIRM** inline. Do not submit a NEEDS-HUMAN-CONFIRM line
  without checking it first.

### Facts this file relies on (verified in code)

| Claim | Where it is proven |
|---|---|
| Facebook permissions requested are exactly `pages_show_list`, `pages_manage_posts`, `pages_read_engagement` | `platforms.ts` `facebook.scopes` |
| Instagram permissions requested are exactly `instagram_business_basic`, `instagram_business_content_publish` | `platforms.ts` `instagram.scopes` |
| Facebook uses **Facebook Login for Business** with a Login configuration: `oauth-start` sends `config_id` and **omits** the `scope` parameter when `META_CONFIG_ID` is set | `oauth-start/index.ts` (`if (configId) p.set("config_id", configId); else p.set("scope", …)`) |
| Instagram uses **Business Login for Instagram** directly (`https://www.instagram.com/oauth/authorize`, `enable_fb_login=0`, `force_authentication=1`), not the Page-linked flow | `platforms.ts` `instagram.authorizeUrl` / `authorizeExtra` |
| Provider tokens are AES-GCM encrypted before database storage (`fp1.<iv>.<ciphertext>`, base64url, 32-byte key from `SOCIAL_TOKEN_ENCRYPTION_KEY`) | `_shared/token-crypto.ts`; `oauth-callback` calls `encryptToken()` on both access and refresh tokens |
| The browser never receives tokens — it reads the token-free `social_accounts_public` view | `supabase/migrations/20260802130000_connection_health.sql` |
| Disconnect deletes the stored credential row outright | `disconnect_account` RPC, `supabase/migrations/20260802120000_social_account_selection.sql` |
| Publishing only happens for networks the user ticked on a post they created | `js/planner.js` `readPostForm()` → `publishNow()` → `publish/index.ts` iterating `post.networks` |
| Instagram/YouTube posts are blocked in the composer without media | `js/planner.js` `validatePostForm()` |

---

# Section A — Meta App Review

- App ID: **1357166765978737** — NEEDS-HUMAN-CONFIRM (this ID does not appear
  anywhere in the repository; confirm it against the Meta dashboard before
  pasting).
- Business portfolio: **2572542696500072** — NEEDS-HUMAN-CONFIRM (same reason).
- App domain / homepage: `https://fablepeak.com` (repo `CNAME`).
- Privacy policy: `https://fablepeak.com/privacy.html`
- Terms of service: `https://fablepeak.com/terms.html`
- User data deletion: `https://fablepeak.com/data-deletion.html`

## A1. Per-permission justifications

Paste each block into the matching "Tell us how you're using this permission"
field. Each is under 300 words.

### `pages_show_list`

FablePeak is a social media planning and publishing tool. A user creates a
workspace, opens the Connections screen, and clicks Connect on the Facebook
Page card. That click starts Facebook Login for Business using our Login
configuration; the user chooses which of their Pages to grant, and Facebook
returns them to our server-side callback.

We use `pages_show_list` at exactly that moment to call
`GET /me/accounts` and read the id, name and picture of the Pages the user just
authorized. Every returned Page is stored as a separate connection row in that
user's workspace and rendered on the Connections screen with its name and
profile picture, so the user can see precisely which Pages FablePeak may publish
to. When more than one Page is returned, the user picks the publishing
destination with the "Use for publishing" control; only that selected Page
receives posts. The same call is used at token rollover to re-acquire the Page
access token for the Page the user already chose, and to detect that a Page is
no longer available to the authorizing user so we can show "Needs reconnecting"
instead of silently failing.

No lesser permission suffices. Without `pages_show_list` we cannot enumerate the
authorized Pages at all, which means we cannot show the user which destination
they connected, cannot let them choose between multiple Pages, and cannot obtain
the Page access token that `pages_manage_posts` requires. We do not use this
permission to build any directory of Pages, we never read Pages the user did not
authorize, and disconnecting a Page in FablePeak deletes its stored credentials.

### `pages_manage_posts`

FablePeak publishes content that the user wrote inside FablePeak to the Facebook
Page they connected and selected. The user opens New post, types the post text,
optionally attaches an image or video, ticks the Facebook checkbox in the
Networks list, and then either clicks "Publish now" (with an explicit "This
posts to the real accounts" confirmation) or schedules it for a chosen date and
time. Nothing is ever posted without that user action.

When the post runs, our server publishes with the Page access token for the
selected Page: text-only posts go to `POST /{page-id}/feed`, image posts to
`POST /{page-id}/photos`, and video posts to `POST /{page-id}/videos`. The
provider's returned post id and link are stored and shown back to the user in
the post's Delivery results panel, so they can open the exact published post.
Failures are recorded per network with the platform's own error message rather
than being retried blindly.

No lesser permission suffices, because `pages_manage_posts` is the only
permission that allows creating a post on a Page the user administers.
`pages_read_engagement` and `pages_show_list` are read-only for our purposes and
cannot publish. We publish only to Pages the user explicitly connected and
explicitly selected as the publishing destination, only with content the user
authored in FablePeak, and only for the workspace that owns the connection.
Access tokens are held server-side and encrypted; the browser never receives
them.

### `pages_read_engagement`

FablePeak uses `pages_read_engagement` for two read-only purposes, both visible
to the user who connected the Page.

First, connection truthfulness. A scheduled health check and an on-demand check
in the Connections screen read the connected Page's `id`, `name` and `picture`
(`GET /{page-id}`) to confirm the stored credential still belongs to the same
Page. If the identity no longer matches, or the call fails, FablePeak marks that
connection "Needs reconnecting" or "Connection check failed" rather than
continuing to appear connected. This prevents scheduled posts from silently
failing and keeps the displayed Page identity accurate.

Second, the Page metric FablePeak shows the user. A daily job reads
`followers_count` / `fan_count` for the connected Page
(`GET /{page-id}?fields=followers_count,fan_count`) and stores one daily number,
which appears in that workspace's Analytics screen as the Followers figure and
follower-growth chart.

No lesser permission suffices. `pages_show_list` returns the Page list at
authorization time but is not sufficient for the ongoing per-Page identity read
and Page-level follower counts we display. We deliberately do not request
`read_insights`, `pages_read_user_content`, `pages_manage_engagement`,
`pages_messaging`, or any Ads, public-content or branded-content permission,
because FablePeak does not read comments, messages, ads or third-party content.
The data is used only inside the workspace that owns the connection, is not sold
or shared for advertising, and is deleted when the user disconnects the Page or
deletes their FablePeak account.

### `instagram_business_basic`

FablePeak uses the Instagram API with Instagram Login. On the Connections
screen, the user clicks Connect on the Instagram card, signs in to their own
Instagram professional (Business or Creator) profile, and approves the two
permissions. No Facebook Page and no Facebook account is involved.

Immediately after the token exchange, FablePeak uses `instagram_business_basic`
to call `GET /me?fields=id,user_id,username,name,profile_picture_url` on
`graph.instagram.com`. The account id is stored as the publishing target; the
username and profile picture are displayed on the Connections screen, so the
user can confirm exactly which professional account FablePeak is connected to
before publishing anything. The same read is repeated by our connection health
check to confirm the stored credential still belongs to the same account, and to
show "Needs reconnecting" when it does not. We also read `followers_count` for
the connected account once per day and display it as that workspace's Instagram
follower figure in Analytics.

No lesser permission suffices: this is the minimum permission of the Instagram
Login product, and without it FablePeak cannot show the user which account they
connected — the user would be publishing to an unverified destination.
`instagram_business_content_publish` alone does not return account identity. We
do not request messaging, comments, insights, mentions or manage-permissions
scopes. The account identity is used only within the connecting user's
workspace, is never sold or shared, and is deleted when the user disconnects the
account or deletes their FablePeak account.

### `instagram_business_content_publish`

FablePeak publishes media the user created, to the Instagram professional
account that same user connected. The user opens New post, writes the caption,
attaches an image or video (Instagram posts are blocked in our composer without
media, because Instagram has no text-only post type), ticks the Instagram
checkbox, and then either confirms "Publish now" against an explicit
"This posts to the real accounts" prompt or schedules it for a chosen time.

At publish time our server performs the standard two-step flow on
`graph.instagram.com`: it creates a media container (`POST /{ig-id}/media` with
`image_url`, or `media_type=REELS` with `video_url`, plus the user's caption),
polls the container until the status is `FINISHED`, then calls
`POST /{ig-id}/media_publish`. The returned media id and permalink are stored
and shown to the user in the post's Delivery results panel so they can open the
published post. Media is uploaded by the user into their own workspace storage
and served from a public HTTPS URL, because Instagram fetches the file itself.

No lesser permission suffices: publishing to Instagram is only possible with
`instagram_business_content_publish`, and `instagram_business_basic` is
read-only. FablePeak publishes only to the account the connecting user
authorized, only content that user composed in FablePeak, and only when that
user asked for it. Credentials are stored server-side and encrypted, are never
returned to the browser, and are deleted when the user disconnects.

## A2. Reviewer instructions (numbered)

Paste into "Provide detailed step-by-step instructions". Replace every
placeholder before submitting; supply credentials only through Meta's own
reviewer-credential fields, never in a public document.

**Reviewer test assets to supply**

- FablePeak account: `<REVIEWER_EMAIL>` / `<REVIEWER_PASSWORD>`
  (this account is pre-confirmed, so no email confirmation step is required —
  NEEDS-HUMAN-CONFIRM that the account is created and email-confirmed before
  submitting).
- Facebook test user: `<REVIEWER_FB_TEST_USER>` / `<REVIEWER_FB_PASSWORD>`,
  administering the Page `<REVIEWER_TEST_PAGE_NAME>`.
- Instagram professional test profile: `<REVIEWER_IG_USERNAME>` /
  `<REVIEWER_IG_PASSWORD>` (set to Business or Creator).
- Sample media (non-sensitive, public HTTPS): `<REVIEWER_SAMPLE_IMAGE_URL>`.

**Steps**

1. Open `https://fablepeak.com` in a desktop browser. The sign-in screen
   appears, with Privacy, Terms and Data deletion links in its footer.
2. On the **Sign in** tab, enter `<REVIEWER_EMAIL>` and `<REVIEWER_PASSWORD>`,
   then click **Sign in**. (Do not click "Explore the demo first" — the demo is
   local sample data with no real connections.)
3. In the left sidebar, confirm the workspace named
   `<REVIEWER_WORKSPACE_NAME>` is selected, then click **🔌 Connections**.
4. **Facebook Page — connect.** On the "Facebook Page" card, click **Connect**.
   A popup opens Facebook Login for Business. Sign in as
   `<REVIEWER_FB_TEST_USER>`, choose **Opt in to all businesses** (or select the
   business that owns `<REVIEWER_TEST_PAGE_NAME>`), select the Page
   `<REVIEWER_TEST_PAGE_NAME>`, keep all listed permissions enabled, and
   continue until Facebook returns you to FablePeak's completion page.
5. Back on the Connections screen, confirm the Facebook Page card now shows the
   Page name and profile picture returned by Facebook. If more than one Page was
   authorized, each Page appears as its own row; click **Use for publishing**
   next to `<REVIEWER_TEST_PAGE_NAME>` so it shows "✓ Publishing account".
6. **Instagram — connect.** On the "Instagram" card, click **Connect**. A popup
   opens Instagram's own login. Sign in as `<REVIEWER_IG_USERNAME>`, approve
   both requested permissions, and continue until you are returned to FablePeak.
7. Confirm the Instagram card now shows `@<REVIEWER_IG_USERNAME>` and that
   profile's picture — this is the `instagram_business_basic` read displayed
   back to the user.
8. **Create a post.** Click **🗓 Planner** in the sidebar, then **+ New post**
   (or click any future day on the calendar).
9. In the Content field, type: `FablePeak review test post <TODAY_DATE>`.
10. In the "Image / video" field, paste `<REVIEWER_SAMPLE_IMAGE_URL>`
    (or click **📱 Choose photo or video** and upload a file — FablePeak stores
    it in the workspace and fills in a public HTTPS URL). A preview appears.
11. Under **Networks**, tick **Facebook Page** and **Instagram**. Networks that
    are not connected are greyed out and cannot be ticked.
12. Set **Date** and **Time** to today's date and a time a few minutes ahead,
    leave **Status** as `scheduled`, and click **Schedule**.
13. **Publish.** Re-open the post from the calendar and click
    **🚀 Publish now**. Confirm the browser prompt ("Publish to Facebook Page,
    Instagram right now? This posts to the real accounts.") by clicking OK.
    (Alternatively, wait for the scheduled time — the scheduler publishes it
    automatically within a minute.)
14. **Verify in FablePeak.** The post re-opens with a **Delivery results** panel
    showing one row per network, each reading "Published — view post" with a
    link to the real post. The post's status becomes `published`.
15. **Verify on the platforms.** Click the Facebook link — it opens the new post
    on `<REVIEWER_TEST_PAGE_NAME>`. Click the Instagram link — it opens the new
    media on `@<REVIEWER_IG_USERNAME>`.
16. **Verify the displayed metric (optional, `pages_read_engagement`).** Click
    **📈 Analytics**. The Followers figure and follower-growth chart are the
    Page/profile follower counts FablePeak reads once per day. If no daily
    ingestion has run yet for this new connection, the screen shows a clearly
    labelled simulated fallback instead.
17. **Disconnect.** Return to **🔌 Connections**, click **Disconnect** on the
    Facebook Page row and confirm the prompt; repeat for the Instagram row. Both
    cards return to "Available to connect". This deletes the stored provider
    credentials from FablePeak and stops all future scheduled delivery to those
    accounts. The same instructions are published at
    `https://fablepeak.com/data-deletion.html`.
18. **Full data deletion (optional).** Click **⚙️ Settings → Delete my
    account**, type `DELETE`, and enter the account password. This removes the
    authentication record, all provider credentials connected by that user, and
    workspaces owned only by that user.

## A3. Screen-recording shot list

Two recordings. Record in English, at 1280×720 or larger, with the **full
browser address bar visible in every shot**, mouse cursor visible, and no other
tabs or personal content on screen. Do not speed up or cut mid-flow; reviewers
reject recordings where the transition between consent and result is not
continuous.

**Never visible in either recording:** passwords being typed in plain text (use
a password manager or blur), the Meta App Secret / Instagram App Secret /
`SOCIAL_TOKEN_ENCRYPTION_KEY` / `CRON_SECRET`, any access token or URL
containing `access_token=` or `code=`, browser devtools/network panel, the
Supabase dashboard, email inboxes, and any real customer's name, handle or
content. Use developer-owned test assets and non-sensitive sample media only.

### Recording 1 — Facebook Page flow (`pages_show_list`, `pages_manage_posts`, `pages_read_engagement`)

| # | On screen | Action | Must be visible | Must never be visible |
|---|---|---|---|---|
| 1 | `https://fablepeak.com` sign-in screen | Hold 3 s | Address bar reading `fablepeak.com`; the Privacy / Terms / Data deletion footer links | The demo mode being entered |
| 2 | Sign-in form | Type `<REVIEWER_EMAIL>`, submit | Email field, "Sign in" button | The typed password characters |
| 3 | Workspace loaded | Hold 2 s | Sidebar with the workspace name; FablePeak branding | Any other brand/workspace with real data |
| 4 | Connections screen | Click **🔌 Connections** | The Facebook Page card reading "Available to connect"; the **Connect** button | — |
| 5 | Facebook Login for Business popup | Click **Connect** | The popup URL on `facebook.com`; the business/Page selection step; the permission list Facebook displays | The App Secret; any `code=`/`access_token=` in the URL bar |
| 6 | Page selection step | Select `<REVIEWER_TEST_PAGE_NAME>`, continue | The Page checkbox being ticked; the permissions screen listing the Page permissions granted | Pages belonging to unrelated real businesses |
| 7 | Return to FablePeak | Popup closes | The FablePeak completion message, then the Connections screen | — |
| 8 | Connections — connected state | Hold 4 s, scroll if needed | **The Page name and profile picture rendered on the card** (this is the `pages_show_list` proof); if several Pages were authorized, all rows; the **Use for publishing** control | — |
| 9 | Page selection in FablePeak | Click **Use for publishing** on `<REVIEWER_TEST_PAGE_NAME>` | The row changing to "✓ Publishing account" | — |
| 10 | Planner | Click **🗓 Planner → + New post** | The empty composer | Existing real posts with customer content |
| 11 | Composer | Type the post text; paste/upload the sample image | The typed text; the media preview thumbnail | Any private image |
| 12 | Composer — Networks | Tick **Facebook Page** only | The Facebook checkbox ticked and other networks unticked/greyed | — |
| 13 | Composer | Click **Schedule**, reopen the post, click **🚀 Publish now** | The confirmation dialog text "This posts to the real accounts" | — |
| 14 | Delivery results | Hold 4 s | **The Delivery results panel with "Published — view post"** (this is the `pages_manage_posts` proof) | — |
| 15 | Facebook | Click the published link | The real post on `<REVIEWER_TEST_PAGE_NAME>` at a `facebook.com` URL, with the same text and image | Unrelated Page content, comments from real users |
| 16 | Analytics | Return to FablePeak, click **📈 Analytics** | **The Followers figure / follower-growth chart** (this is the `pages_read_engagement` proof) | — |
| 17 | Connections — disconnect | Click **Disconnect**, confirm the prompt | The confirm dialog, then the card returning to "Available to connect" | — |

> Shot 16 caveat: the Followers figure is only real once the daily metrics job
> has run for this connection; before that, FablePeak displays a labelled
> simulated fallback. **NEEDS-HUMAN-CONFIRM** — either record shot 16 on a
> connection that already has an ingested metrics row, or trigger an ingestion
> before recording, so the recording does not show simulated data as if it were
> the permission's output.

### Recording 2 — direct Instagram flow (`instagram_business_basic`, `instagram_business_content_publish`)

This expands the 8-step script in `META_APP_REVIEW.md`.

| # | On screen | Action | Must be visible | Must never be visible |
|---|---|---|---|---|
| 1 | `https://fablepeak.com` | Sign in as `<REVIEWER_EMAIL>` | The address bar; the sign-in screen (script step 1) | Typed password characters |
| 2 | Workspace + Connections | Click **🔌 Connections** | The Instagram card and its **Connect** button (script step 2) | — |
| 3 | Instagram login popup | Click **Connect** | The popup URL on `instagram.com/oauth/authorize`; the Instagram-branded login — **not** a Facebook login (this proves Business Login for Instagram) | Any `code=`/`access_token=` value |
| 4 | Instagram consent | Sign in as `<REVIEWER_IG_USERNAME>`, approve | **The permission screen listing both requested permissions** (script step 3); the Allow/Continue action | The password field contents |
| 5 | Return to FablePeak | Popup closes | The completion message, then the Connections screen (script step 4) | — |
| 6 | Connections — connected state | Hold 4 s | **`@<REVIEWER_IG_USERNAME>` and that profile's picture on the Instagram card** (the `instagram_business_basic` proof) | Any other connected account |
| 7 | Composer | **🗓 Planner → + New post**, type the caption | The caption text | — |
| 8 | Composer — media | Paste `<REVIEWER_SAMPLE_IMAGE_URL>` or click **📱 Choose photo or video** | The media preview; the field label noting media is required for Instagram | Private photos in the file picker |
| 9 | Composer — Networks | Tick **Instagram only** | Instagram ticked; Facebook and every other network unticked (script step 5) | — |
| 10 | Publish | **Schedule**, reopen, **🚀 Publish now**, confirm | The "This posts to the real accounts" confirmation | — |
| 11 | Delivery results | Hold 4 s | **"Published — view post" for Instagram** (script step 6; the `instagram_business_content_publish` proof) | — |
| 12 | Instagram | Open the permalink | **The newly published media on `@<REVIEWER_IG_USERNAME>`** with the same caption and image (script step 7) | DMs, other accounts' content, follower lists |
| 13 | Connections — disconnect | Back in FablePeak, click **Disconnect** and confirm | The confirmation prompt and the card returning to "Available to connect" (script step 8) | — |
| 14 | Data deletion page | Open `https://fablepeak.com/data-deletion.html` | The published disconnect and account-deletion instructions | — |

## A4. Data-handling answers

Paste into Meta's data-use / security questions.

**Where are tokens stored?**
Provider access and refresh tokens are exchanged and stored entirely
server-side, by Supabase Edge Functions running in our Supabase project. They
are written to the `social_connections` table in our Postgres database, and each
token value is encrypted at the application layer with AES-256-GCM (random
12-byte IV per value, base64url-encoded, prefixed `fp1.`) using a 32-byte key
held only as a server-side Edge Function secret
(`SOCIAL_TOKEN_ENCRYPTION_KEY`) and never stored in the database or the source
repository. This is in addition to Supabase's own encryption at rest. The
Instagram token is the long-lived token obtained via `ig_exchange_token` and is
renewed automatically by a scheduled server-side job; the Facebook token is a
long-lived user token from which the Page access token is re-derived at
rollover.

**Who can access them?**
Only our server-side Edge Functions (`oauth-callback`, `publish`,
`ingest-metrics`, `connection-health`, `maintain-connections`), which hold the
decryption key. The FablePeak browser application never receives a token: it
reads a separate database view, `social_accounts_public`, that exposes only
platform, account id, display name, avatar URL, status, default flag, last
verification time and last error — the token columns are not part of that view.
Row-level security scopes every read to the workspaces the signed-in user is a
member of, so one customer cannot list, select, publish through, or disconnect
another customer's connections. Tokens are not shared with third parties, not
used for advertising, and not sold.

**How is data deleted?**
Three published paths, all documented at
`https://fablepeak.com/data-deletion.html`:

1. *Disconnect one account* — Connections → **Disconnect**. This runs the
   `disconnect_account` database function, which deletes the connection row
   including its stored access and refresh tokens, and stops all future
   scheduled delivery to that account.
2. *Delete the whole account* — Settings → **Delete my account**, confirmed by
   typing `DELETE` and re-entering the password. This calls our `delete-account`
   Edge Function, which re-authenticates the user, runs a single transactional
   `prepare_account_deletion` routine that removes that user's provider
   credentials and memberships and deletes workspaces they solely own, deletes
   that workspace's uploaded media from storage, and then deletes the
   authentication record itself.
3. *Email request* — from the registered address to the contact published on the
   data-deletion page, for users who cannot sign in. Verified requests are
   normally completed within 30 days.

Users can additionally revoke FablePeak from Facebook's or Instagram's own app
settings at any time; FablePeak's health check then marks the connection
"Needs reconnecting" rather than continuing to appear connected.

**URLs**

- Privacy policy: `https://fablepeak.com/privacy.html`
- Terms of service: `https://fablepeak.com/terms.html`
- User data deletion instructions: `https://fablepeak.com/data-deletion.html`
- Data deletion callback URL: `https://<project-ref>.supabase.co/functions/v1/data-deletion`
  (the `data-deletion` Edge Function; see ADR 0002). It verifies Meta's
  `signed_request` against `META_APP_SECRET`, falling back to
  `INSTAGRAM_APP_SECRET`, and answers with the status URL and confirmation
  code. Both Meta apps may register the same URL. Keep
  `https://fablepeak.com/data-deletion.html` in the "Data Deletion
  Instructions URL" field.

---

# Section B — Google OAuth verification (YouTube)

Requested sensitive scopes, exactly as in `platforms.ts` `youtube.scopes`:

- `https://www.googleapis.com/auth/youtube.upload`
- `https://www.googleapis.com/auth/youtube.readonly`

`https://www.googleapis.com/auth/yt-analytics.readonly` is **not** requested by
the application and must not appear in the console's scope list.

## B1. Scope justifications

`GOOGLE_OAUTH_VERIFICATION.md` already holds a single combined justification
that fits Google's 1,000-character field. The two per-scope blocks below are for
consoles that ask per scope; keep whichever the form requires, and make sure the
wording you submit matches the deployed behaviour.

### `https://www.googleapis.com/auth/youtube.readonly`

FablePeak is a social publishing application. After the user clicks Connect
YouTube on the Connections screen and approves consent, FablePeak calls
`youtube/v3/channels?part=snippet,statistics&mine=true` and uses the result in
two visible ways. First, the channel id, title and thumbnail are stored as that
workspace's connection and displayed on the Connections screen, so the user can
confirm which channel FablePeak will upload to before publishing anything; the
same read is repeated by our connection health check so a revoked or wrong
credential is shown as "Needs reconnecting" instead of appearing connected.
Second, a daily job reads the channel's `subscriberCount` and `viewCount` and
shows them in that workspace's Analytics screen as Followers and Impressions.
This scope is used only for the channel of the user who authorized it, is never
sold or shared, and is deleted when the user disconnects or deletes their
account. A narrower scope is not available: `youtube.upload` returns no channel
identity or statistics, and there is no read-only YouTube scope narrower than
`youtube.readonly` that returns channel identity and totals.

### `https://www.googleapis.com/auth/youtube.upload`

FablePeak uses `youtube.upload` only to publish a video the user created, to the
channel that same user connected. The user opens New post, types a title and
description, supplies a video (uploaded into their workspace or given as a
direct HTTPS video URL — FablePeak rejects YouTube watch/share links because
they are HTML pages, not video files), ticks YouTube in the Networks list, and
then either confirms "Publish now" against an explicit confirmation dialog or
schedules it. At publish time our server starts a resumable upload
(`upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`) with the
user's text as title and description, and `privacyStatus: private`, then streams
the video bytes. The returned video id and `https://youtu.be/<id>` link are shown
back to the user in the post's Delivery results panel. No other channel is ever
written to, no data is sold or shared, and the connection can be disconnected at
any time, which deletes the stored credentials. A narrower scope does not exist:
`youtube.upload` is the minimum scope that can insert a video, and
`youtube.readonly` cannot write.

## B2. Demo video shot list

One unlisted YouTube video, English, full browser address bar visible in every
shot, pasted into Google Cloud → **Data access → Demo video**. This expands the
10-step checklist in `GOOGLE_OAUTH_VERIFICATION.md` and satisfies
`PRODUCTION_ONBOARDING.md` §3 ("FablePeak account → workspace → Connect YouTube
→ complete consent screen in English → verified channel identity → video post →
private upload").

| # | On screen | Action | Must be visible | Must never be visible |
|---|---|---|---|---|
| 1 | Signed out at `https://fablepeak.com` | Hold 3 s | The address bar reading `fablepeak.com`; the sign-in screen and its Privacy / Terms links | Any other tab or personal bookmark |
| 2 | Sign-in | Sign in as `<REVIEWER_EMAIL>` | The email field and Sign in button | Typed password characters |
| 3 | Workspace | Hold 2 s | The workspace name in the sidebar | Real customer workspaces |
| 4 | Connections | Click **🔌 Connections** | The YouTube card and its **Connect** button | — |
| 5 | Google unverified-app screen | Click **Connect** | The "Google hasn't verified this app" screen and the client name; click **Advanced → Go to FablePeak** — Google expects this screen while review is pending | — |
| 6 | Google account chooser | Choose `<REVIEWER_GOOGLE_ACCOUNT>` | The account chooser on `accounts.google.com` | Other Google accounts signed in on the machine |
| 7 | Consent screen | Hold 4 s before approving | **Both requested permissions rendered in English** ("See, edit, and permanently delete your YouTube videos, ratings, comments and captions" / "Manage your YouTube account" wording as Google renders it for these two scopes); the app name and the privacy-policy link | The client secret; any `code=` value |
| 8 | Approve | Click **Continue / Allow** | The approval action, then the return to FablePeak's completion page | — |
| 9 | Connections — connected | Hold 4 s | **The connected channel's name and avatar on the YouTube card** (the `youtube.readonly` proof) | — |
| 10 | Composer | **🗓 Planner → + New post**; type the title/description text | The typed content | Real customer posts |
| 11 | Composer — media | Click **📱 Choose photo or video** and pick the small sample video, or paste a direct HTTPS `.mp4` URL | The upload progress / video preview and the resulting media URL field | Any private video |
| 12 | Composer — Networks | Tick **YouTube only** | YouTube ticked, all other networks unticked | — |
| 13 | Publish | **Schedule**, reopen the post, **🚀 Publish now**, confirm the prompt | The "This posts to the real accounts" confirmation | — |
| 14 | Delivery results | Hold 4 s | **"Published — view post" with the `youtu.be` link** (the `youtube.upload` proof) | — |
| 15 | YouTube Studio | Open `studio.youtube.com` → Content | **The same video on the connected channel with visibility "Private"** | Other videos' analytics, unrelated channel data |
| 16 | Analytics (optional) | Back in FablePeak, click **📈 Analytics** | The Followers/Impressions figures sourced from channel statistics | Simulated data presented as real — see the caveat below |
| 17 | Connections — disconnect | Show the **Disconnect** control | The Disconnect button on the YouTube row; confirm only after the rest of the flow has been captured | — |

> Shot 16 caveat (same as Meta shot 16): Analytics shows a clearly labelled
> simulated fallback until the daily metrics job has ingested a real row for the
> connection. Record it only with real ingested data, or omit the shot.

## B3. Google Cloud console fields the human must fill

| Field | Value | Source |
|---|---|---|
| Google Cloud project | `fablepeak` | `GOOGLE_OAUTH_VERIFICATION.md`, `PLATFORM_SETUP.md` §2 |
| App name | `FablePeak` | Repo branding / `CNAME` |
| App logo | Must match the site's icon — NEEDS-HUMAN-CONFIRM which asset is uploaded (`icon-512.png` is the natural choice) | `icon-512.png` |
| Application home page | `https://fablepeak.com` | `CNAME`, `PRODUCTION_ONBOARDING.md` §2 |
| Application privacy policy link | `https://fablepeak.com/privacy.html` | `privacy.html`, `PRODUCTION_ONBOARDING.md` §2 |
| Application terms of service link | `https://fablepeak.com/terms.html` | `terms.html` |
| Authorized domain | `fablepeak.com` | `CNAME`; ownership verified in Search Console per `PRODUCTION_ONBOARDING.md` §3 |
| User support email | `<SUPPORT_EMAIL>` — the repository publishes `fablepeak@techpolity.com` as the privacy/deletion contact; confirm this is the address you want shown on the consent screen | `privacy.html`, `data-deletion.html` |
| Developer contact email | `<GOOGLE_PROJECT_OWNER_EMAIL>` — NEEDS-HUMAN-CONFIRM (must be an address Google can reach for the review thread) | not in repo |
| OAuth client type | Web application, one client named `FablePeak web` | `PLATFORM_SETUP.md` §2 |
| Authorized redirect URI | `https://lghsvxwuaebvotutyjtt.supabase.co/functions/v1/oauth-callback` | `PLATFORM_SETUP.md`, `PRODUCTION_ONBOARDING.md` §1, `oauth-start/index.ts` |
| Authorized JavaScript origins | `https://fablepeak.com` — NEEDS-HUMAN-CONFIRM (the app never calls Google directly from the browser, so this may legitimately be empty) | `oauth-start` runs server-side |
| Scopes (sensitive) | `.../auth/youtube.upload` and `.../auth/youtube.readonly` only | `platforms.ts` `youtube.scopes` |
| Publishing status | **In production** | `PRODUCTION_ONBOARDING.md` §3 |
| Demo video | `<UNLISTED_DEMO_VIDEO_URL>` | recorded per B2 |
| Scope justification / Additional information | Paste the blocks from `GOOGLE_OAUTH_VERIFICATION.md` (they are already sized for the 1,000-character fields) | that file |
| APIs enabled | YouTube Data API v3. **NEEDS-HUMAN-CONFIRM:** `PLATFORM_SETUP.md` §2 also says YouTube Analytics API was enabled — disable it, or be ready to explain an enabled API with no requested scope | `PLATFORM_SETUP.md` §2 vs `platforms.ts` |

---

# Section C — Submission-day checklist

Run top to bottom. Do not start Meta submission before business verification
shows **Verified** in the Meta dashboard.

## C0. Pre-flight (both consoles)

1. Confirm the production deployment matches `main`: `npm run check` passes, and
   `oauth-start`, `oauth-callback`, `publish`, `connection-health`,
   `ingest-metrics`, `maintain-connections`, `operations-health` and
   `delete-account` were deployed from the same reviewed commit
   (`PRODUCTION_ONBOARDING.md` §1).
2. Load `https://fablepeak.com/privacy.html`, `/terms.html` and
   `/data-deletion.html` in a private window and confirm all three render and
   are reachable from the sign-in screen footer.
3. Create the reviewer FablePeak account, confirm its email, create the
   reviewer workspace, and verify sign-in works in a private window. Record the
   credentials only in the password manager and in the review forms.
4. Confirm `APP_ORIGIN=https://fablepeak.com` and that the callback URL
   `https://lghsvxwuaebvotutyjtt.supabase.co/functions/v1/oauth-callback` is
   registered identically in Meta (Facebook Login for Business config **and**
   Instagram product) and in Google Cloud.
5. Record both Meta videos and the Google video first, review them frame by
   frame against the "must never be visible" columns, and only then start
   filling forms.

## C1. Meta App Review console

1. Open the app **1357166765978737** as the app owner. If a
   "Account confirmation needed" banner is present, clear it first — no OAuth
   or review change can override an account-level API block
   (`META_APP_REVIEW.md`).
2. **Verify portfolio identity before anything else.** The business portfolio
   shown on the app must be **2572542696500072**, and the legal entity /
   portfolio name on the verification record must match the entity that will
   own the integration long term. **NEEDS-HUMAN-CONFIRM:** neither the app ID,
   the portfolio ID, nor any entity name ("Techpolity") appears anywhere in this
   repository; the only related string in the repo is an incidental
   "FablePeak/Shiloh Creek" mention in `PLATFORM_SETUP.md:158`. Confirm which
   entity name is correct, make Meta and the published pages agree, and — if
   `PLATFORM_SETUP.md:158` names the wrong entity — fix it in a separate change
   before submitting.
3. Confirm Tech Provider classification is set as intended. Meta marks this
   irreversible (`META_APP_REVIEW.md`).
4. App settings → Basic: app name, logo, app domain `fablepeak.com`, privacy
   policy URL, terms URL, and **Data Deletion Instructions URL** =
   `https://fablepeak.com/data-deletion.html` (leave the callback field empty —
   see A4).
5. **Check the Facebook Login for Business configuration**, not just the App
   Review request. Because `oauth-start` sends `config_id` and omits `scope`,
   the three Page permissions are carried by the Login configuration
   (`META_CONFIG_ID`). If `pages_show_list`, `pages_manage_posts` and
   `pages_read_engagement` are not all attached to that configuration, the
   reviewer's consent screen will not show them and the submission will fail.
6. Instagram product → confirm **Instagram API with Instagram Login** is the
   configured product and that only `instagram_business_basic` and
   `instagram_business_content_publish` are requested.
7. App Review → Permissions and Features: request Advanced Access for exactly
   the five permissions in Section A1. Remove any other permission from the
   request. Do **not** request messaging, comments, insights, ads,
   public-content or branded-content permissions.
8. Paste each A1 justification into its matching permission. Re-read each one
   against the deployed behaviour — a justification describing something the
   reviewer cannot reproduce is the most common rejection.
9. Paste the A2 reviewer instructions into the app-level instructions field,
   with every placeholder replaced. Enter the reviewer credentials **only** in
   Meta's credential fields.
10. Upload Recording 1 (Facebook) and Recording 2 (Instagram) and label which
    permissions each demonstrates.
11. Answer the data-handling questions from A4.
12. Submit. **Do not toggle the app to Live yet.** Meta's guidance and our own
    launch gate both put Live mode *after* Advanced Access is granted
    (`META_APP_REVIEW.md` "Launch gate"). Flip to Live only once the five
    permissions show Advanced Access approved.
13. After approval and Live-mode switch, run the unrelated-account acceptance
    rows (Business Instagram, Creator Instagram, multi-Page Facebook) and record
    them in `docs/acceptance/EXTERNAL_BETA_EVIDENCE.md`. They are still marked
    Pending.

## C2. Google Cloud OAuth console

1. Open Google Cloud project `fablepeak` → APIs & Services.
2. **Data access → scopes: confirm `yt-analytics.readonly` is not listed.** If
   it is present, remove it before submitting — the app does not call the
   YouTube Analytics API, and Google requires the narrowest scopes used by the
   live app. Removing the scope may require re-consent for existing test users.
3. While there, decide about the **YouTube Analytics API** being enabled in the
   project (`PLATFORM_SETUP.md` §2). Disable it unless there is a reason to keep
   it — an enabled API with no matching scope invites a reviewer question.
4. Branding: fill every field in the B3 table (home page, privacy, terms, logo,
   support email, developer contact email, authorized domain `fablepeak.com`).
5. Confirm domain ownership for `fablepeak.com` is verified in Search Console
   under an account that is an owner/editor of the Cloud project.
6. Credentials: confirm exactly one web OAuth client is in use and that its
   authorized redirect URI is
   `https://lghsvxwuaebvotutyjtt.supabase.co/functions/v1/oauth-callback`,
   character for character.
7. Upload the demo video as **unlisted** to YouTube and paste its URL into the
   Demo video field.
8. Paste the scope justification and additional-information text from
   `GOOGLE_OAUTH_VERIFICATION.md` (already sized for the 1,000-character
   fields), or the per-scope blocks in B1 if the form asks per scope.
9. Set publishing status to **In production** and submit for verification.
10. Separately, plan the YouTube **Audit and Quota Extension** submission: until
    it passes, uploads from this project stay private
    (`PLATFORM_SETUP.md` §2). The demo video deliberately shows the Private
    visibility, so this does not block OAuth verification.
11. After approval, replay the flow with an unrelated account and record the
    YouTube row in `docs/acceptance/EXTERNAL_BETA_EVIDENCE.md`.

## C3. Post-submission

1. Keep the reviewer accounts alive and the connections working until both
   reviews close. Do not disconnect the demonstrated accounts.
2. Keep `SOCIAL_TOKEN_ENCRYPTION_KEY` unchanged during the review window —
   rotating it without a migration makes existing encrypted connections
   unreadable (`PLATFORM_SETUP.md`).
3. Watch `operations-health` and the scheduled GitHub check; a failed publisher
   during review turns a reviewer retry into a rejection.
4. When both reviews are approved, update
   `docs/acceptance/EXTERNAL_BETA_EVIDENCE.md` (rows 3 and 5 of the release
   decision) and only then open the invite-only beta.

---

## NEEDS-HUMAN-CONFIRM summary

| # | Item | Why it could not be verified here |
|---|---|---|
| 1 | Meta app ID `1357166765978737` | Does not appear anywhere in the repository |
| 2 | Meta business portfolio `2572542696500072` | Does not appear anywhere in the repository |
| 3 | Legal entity / portfolio name ("Techpolity" vs "FablePeak" vs "Shiloh Creek") | No entity name is recorded in the repo; the only related string is `PLATFORM_SETUP.md:158` "FablePeak/Shiloh Creek" |
| 4 | Reviewer FablePeak account exists and is email-confirmed | Sign-up requires email confirmation (`js/welcome.js` `wSubmit`); cannot be checked from the repo |
| 5 | Meta "Data Deletion Callback URL" | No deletion *callback* endpoint exists in the codebase; only the published instructions page |
| 6 | Analytics shot showing a **real** follower/impression figure | The UI falls back to labelled simulated data until `ingest-metrics` has written a row for that connection |
| 7 | Facebook Login configuration (`META_CONFIG_ID`) actually carries all three Page permissions | `oauth-start` sends `config_id` and omits `scope`, so the permission set lives in the Meta dashboard, not in code |
| 8 | `/me/accounts` requests `instagram_business_account{id,username,profile_picture_url}` although FablePeak's Instagram connection uses direct Instagram Login and that field is never stored or displayed | `platforms.ts` `metaPages()`; decide whether to drop the field before review to keep the request minimal |
| 9 | YouTube Analytics API still enabled in Cloud project `fablepeak` | `PLATFORM_SETUP.md` §2 says it was enabled; no scope in `platforms.ts` uses it |
| 10 | Google developer contact email, authorized JavaScript origins, uploaded logo asset | Not recorded in the repo |
| 11 | Google/Meta reviewer test-asset accounts (Page, IG professional profile, YouTube channel, sample media URL) | Must be developer-owned and supplied at submission time |
