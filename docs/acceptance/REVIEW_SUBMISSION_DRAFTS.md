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

The table above covers Sections A–C only. Section D keeps its own list in **D6**.

---

# Section D — Later submission: first-comment permissions (DO NOT submit with the core review)

> ## ⛔ STOP — this is a **separate, later** Meta submission
>
> **Nothing in Section D goes into the submission drafted in Sections A–C.**
> This section is prepared in advance for a **second** Meta App Review round
> that may only be opened **after** the core publishing permissions
> (`pages_show_list`, `pages_manage_posts`, `pages_read_engagement`,
> `instagram_business_basic`, `instagram_business_content_publish`) show
> **Advanced Access approved** and the app is **Live**.
>
> Adding `pages_manage_engagement` or `instagram_business_manage_comments` to
> the current request would put core publishing approval at risk — a broader
> permission set invites a broader review and a rejection of the whole request,
> not just the new permission. **ADR 0005 decision 6** ("No — do not add comment
> permissions to the imminent submission") and its closing rationale
> ("Nothing in this ADR may put core publishing approval at risk") govern this
> section and cannot be overridden without a new ADR amendment.
>
> Also do not submit Section D **early** in the other direction: the feature it
> describes **is not built yet** (see D3). Submitting reviewer instructions for
> UI that does not exist is an automatic rejection.

**Preconditions, all of which must be true before any of D is pasted anywhere**

1. The Section A permissions are approved for Advanced Access and the app is Live.
2. The unrelated-account acceptance rows from `C1.13` are recorded in
   `docs/acceptance/EXTERNAL_BETA_EVIDENCE.md`.
3. The first-comment feature is built, deployed to production, and recordable
   end to end (D3's "not built yet" list is empty).
4. A release owner has explicitly decided to reopen Meta review. This is a
   release decision, not an engineering one (ADR 0005 Consequences).

## D1. Permissions requested in this round

| Permission | Network | Graph call FablePeak makes with it | Why the current round cannot carry it |
|---|---|---|---|
| `pages_manage_engagement` | Facebook Page | `POST /{page-post-id}/comments`, once, immediately after the customer's own post publishes | Scope-adding; the live probe proved held permissions do not suffice (ADR 0005, "Probe result (2026-08-30): DENIED") |
| `instagram_business_manage_comments` | Instagram professional account | `POST /{ig-media-id}/comments`, once, immediately after the customer's own media publishes | Scope-adding, App Review-gated, and it widens the data-handling statement (ADR 0005 decision 2 table) |

Nothing else is added in this round. Do **not** take the opportunity to request
`read_insights`, `pages_read_user_content`, `pages_messaging`, Ads,
public-content or branded-content permissions.

**The probe evidence this round rests on.** On **2026-08-30** the owner-gated
`probe_fb_comment` action in `supabase/functions/connection-health/index.ts`
posted a real comment on the internal brand's **own** Page post
(`…_122111105709416585`) using only the permissions the app holds today. Graph
refused with `(#200) You do not have sufficient permissions to perform this
action`. The probe's own classifier treats Graph `#200`/`#10` on that call as
`permission_hint: "pages_manage_engagement required"` and treats every other
outcome as `"unknown"`, so the verdict is Graph's, not ours
(`connection-health/index.ts` `classify()`). This is the "no narrower
permission exists" evidence cited in D2.

## D2. Per-permission justifications

Paste each block into the matching "Tell us how you're using this permission"
field. Each is under 300 words, in the same form as Section A1.

### `pages_manage_engagement`

FablePeak is a social media planning and publishing tool. Its customers write a
post inside FablePeak, choose the Facebook Page they connected, and publish or
schedule it. This permission is used for exactly one added step: an optional
"first comment" the customer types into the composer alongside the post itself,
on the same screen, before that post is published.

When the customer's post publishes to their own Page, FablePeak makes one call,
`POST /{page-post-id}/comments`, carrying the text that customer wrote, using
the Page access token for the Page that same customer connected and selected as
their publishing destination. The comment is created as the Page, on the Page's
own post that FablePeak just created, once. If the comment call fails, the post
is left published and the customer is shown "Published — first comment did not
post"; retrying is a manual action they take. Customers use this for the hashtag
block, link or disclosure they prefer to keep out of the post body.

FablePeak does not read, list, display, moderate, hide, delete or reply to
comments written by anyone. We understand `pages_manage_engagement` also grants
those abilities. Our product has no comment inbox and no moderation screen, and
the single comment creation above is the only Graph call we make with this
permission. We store only the returned comment id, with that post's delivery
record.

No narrower permission exists, and we tested that before asking. On 2026-08-30
we attempted a live comment creation on our own Page's own post while holding
only `pages_show_list`, `pages_manage_posts` and `pages_read_engagement`. Graph
refused with `(#200) You do not have sufficient permissions to perform this
action`. Creating a comment as the Page requires this permission and no lesser
one.

### `instagram_business_manage_comments`

FablePeak publishes content its customers compose, to the Instagram
professional account each customer connected through Instagram Login. This
permission is used for exactly one added step: an optional "first comment" the
customer types in the composer, next to the caption, before the post is
published or scheduled.

When that customer's media publishes to their own professional account,
FablePeak makes one call, `POST /{ig-media-id}/comments`, carrying the text that
customer wrote, on the media FablePeak has just created for them, using the
token that same customer authorized. The comment is created once, on their own
new post. It is the customer's hashtag block or credit line, kept out of the
caption. If the comment fails, the media stays published and FablePeak reports
"Published — first comment did not post"; any retry is a manual action by the
customer.

FablePeak does not read comments, does not list or display comments written by
other users, does not moderate, hide or delete comments, and does not reply to
them. We are aware `instagram_business_manage_comments` also grants comment
reading and moderation. Our product contains no comment inbox, no moderation
surface and no comment reading of any kind; the single call above is the entire
use of this permission, and the only comment data we retain is the returned
comment id, stored with that post's delivery record.

No narrower permission exists. `instagram_business_basic` is read-only account
identity, and `instagram_business_content_publish` covers only creating and
publishing a media container — neither can create a comment. The Instagram API
with Instagram Login exposes comment creation only under
`instagram_business_manage_comments`.

## D3. Reviewer instructions and recordings — and what must be built first

### D3.0 What does not exist yet (build and deploy before recording)

The first-comment feature is **gated on this approval and is therefore not
built**. Everything in this list must exist in production before the reviewer
instructions below are truthful. Verified absent in the repository at the time
of writing:

| Missing piece | Where it will live | Evidence it is absent today |
|---|---|---|
| `posts.first_comment jsonb not null default '{}'` | migration | no `first_comment` in `supabase/migrations/` |
| `post_targets.comment_status` / `comment_remote_id` / `comment_error` / `comment_failure_kind` / `comment_attempts` | same migration | as above |
| `"first_comment"` in the posts column whitelist and both row mappers | `js/remote-store.js` (`FIELDS.posts`, `_dbToRows`, `_rowsToDb`) — **owned by another workstream; sequence with its owner** | no `first_comment` in `js/` |
| A first-comment textarea inside each per-network `<details>` section, plus a "copy to every network" control | `js/planner.js` `variantSection()` — today that section contains the **variant** textarea and character counter only | `variantSection()` renders `#pm_var_<net>` and nothing else |
| Adapter `comment()` for Facebook and Instagram | `supabase/functions/_shared/platforms.ts` | no comment method on either adapter |
| The comment step in the per-target publish loop, with the unknown-outcome and stale-claim rules | `supabase/functions/publish/index.ts` | not present |
| "Published — first comment did not post" plus the manual comment retry | delivery panel | not present |
| The two new scopes actually requested at authorization | `platforms.ts` `instagram.scopes` for Instagram; for Facebook the **Login for Business configuration** (`META_CONFIG_ID`), because `oauth-start` sends `config_id` and omits `scope` | `facebook.scopes` / `instagram.scopes` hold the five Section A permissions only |

Note the shipped part: the **"Customize per network" disclosure and per-network
variant copy already exist** (ADR 0005 decision 7 split the release). The
reviewer flow below therefore extends a real screen; only the first-comment
field inside it is new.

**Re-consent warning.** Existing connections were authorized without these
permissions. The reviewer must connect (or reconnect) the test Page and test
Instagram profile **after** the new permissions are attached, or the consent
screen will not list them and the comment call will fail with the same `(#200)`
the probe recorded.

### D3.1 Reviewer instructions (numbered)

Paste into "Provide detailed step-by-step instructions". Reviewer test assets
are the same ones listed in A2; supply credentials only in Meta's own reviewer
credential fields.

1. Open `https://fablepeak.com` and sign in as `<REVIEWER_EMAIL>` /
   `<REVIEWER_PASSWORD>`, then select the workspace `<REVIEWER_WORKSPACE_NAME>`.
2. Click **🔌 Connections**. If the Facebook Page or Instagram row is already
   connected, click **Disconnect** on it first — the connection must be made
   again so the new permission appears on the consent screen.
3. **Connect the Facebook Page.** Click **Connect** on the Facebook Page card,
   sign in as `<REVIEWER_FB_TEST_USER>`, select `<REVIEWER_TEST_PAGE_NAME>`,
   keep every listed permission enabled — the list now includes the ability to
   create comments as the Page — and continue until you return to FablePeak.
   Click **Use for publishing** on that Page row.
4. **Connect Instagram.** Click **Connect** on the Instagram card, sign in as
   `<REVIEWER_IG_USERNAME>`, and approve all requested permissions, which now
   include managing comments on that account. Confirm the card shows
   `@<REVIEWER_IG_USERNAME>`.
5. Click **🗓 Planner → + New post**.
6. In **Content**, type: `FablePeak first-comment review test <TODAY_DATE>`.
7. In **Image / video**, paste `<REVIEWER_SAMPLE_IMAGE_URL>` (Instagram posts
   require media). A preview appears.
8. Under **Networks**, tick **Facebook Page** and **Instagram**.
9. Tick **Customize per network**. One expandable section appears per selected
   network.
10. Expand the **Facebook Page** section and type into its **First comment**
    field: `First comment posted by FablePeak — Facebook <TODAY_DATE>`.
11. Expand the **Instagram** section and type into its **First comment** field:
    `#fablepeak #reviewtest — first comment <TODAY_DATE>`. (These are separate
    fields on purpose: the same text is rarely right on both networks. The
    "copy to every network" control fills the others from the focused one.)
12. Set **Date** and **Time** a few minutes ahead, leave **Status** as
    `scheduled`, and click **Schedule**.
13. Re-open the post from the calendar and click **🚀 Publish now**, confirming
    the prompt "This posts to the real accounts". (Or wait — the scheduler
    publishes within a minute.)
14. **Verify in FablePeak.** The **Delivery results** panel shows, per network,
    "Published — view post" **and** a first-comment line reading
    "First comment posted". A failed comment would instead read
    "Published — first comment did not post" with a **Retry comment** control;
    the post itself is never marked failed because of a comment.
15. **Verify on Facebook.** Open the Facebook link. The new post appears on
    `<REVIEWER_TEST_PAGE_NAME>` with the comment from step 10 underneath it,
    authored by the Page.
16. **Verify on Instagram.** Open the Instagram link. The new media appears on
    `@<REVIEWER_IG_USERNAME>` with the comment from step 11 underneath it.
17. **Confirm the limits of the feature.** There is no comment inbox, no
    moderation view and no reply control anywhere in FablePeak: the composer's
    first-comment field is the only place comments appear in the product, and
    FablePeak never reads comments written by anyone else.
18. **Disconnect.** Return to **🔌 Connections** and click **Disconnect** on
    both rows. This deletes the stored credentials; the same instructions are
    published at `https://fablepeak.com/data-deletion.html`.

### D3.2 Screen-recording shot list

Two more recordings, numbered to continue from A3 (which holds Recordings 1 and
2). Same rules as A3: English, 1280×720 or larger, full browser address bar
visible in every shot, no cuts between consent and result, and the same
"never visible" list — passwords in plain text, app secrets,
`SOCIAL_TOKEN_ENCRYPTION_KEY`, `CRON_SECRET`, any `access_token=` or `code=`
value, devtools, the Supabase dashboard, inboxes, and any real customer data.

The **Status** column says whether the UI in that shot exists today. Every
`TO BUILD` row must become `exists` before recording; that is the checklist
D3.0 exists to serve.

#### Recording 3 — Facebook Page first comment (`pages_manage_engagement`)

| # | On screen | Action | Must be visible | Must never be visible | Status |
|---|---|---|---|---|---|
| 1 | `https://fablepeak.com` sign-in | Sign in as `<REVIEWER_EMAIL>` | The address bar; the sign-in screen | Typed password characters | exists |
| 2 | Connections | Click **🔌 Connections**, then **Disconnect** on any existing Facebook row | The row returning to "Available to connect" | — | exists |
| 3 | Facebook Login for Business popup | Click **Connect** | The popup on `facebook.com`; **the permission list now including comment management as the Page** — this is the consent proof for the new permission | Any `code=` / `access_token=`; unrelated real Pages | exists (permission text depends on the updated Login configuration) |
| 4 | Connections — connected | Hold 4 s | The Page name, picture and **✓ Publishing account** | — | exists |
| 5 | Composer | **🗓 Planner → + New post**; type the post text; attach the sample media | The typed text; the media preview | Real customer posts | exists |
| 6 | Composer — Networks | Tick **Facebook Page** only | Facebook ticked, all others unticked | — | exists |
| 7 | Composer — per-network panel | Tick **Customize per network**; expand the Facebook section | The Facebook section opening | — | exists |
| 8 | Composer — first comment | Type the first-comment text into the Facebook **First comment** field | **The field, its label, and the typed comment text** — this shows the customer authoring the comment before publishing | — | **TO BUILD** |
| 9 | Publish | **Schedule**, reopen, **🚀 Publish now**, confirm | The "This posts to the real accounts" confirmation | — | exists |
| 10 | Delivery results | Hold 4 s | "Published — view post" **and** "First comment posted" for Facebook | — | **TO BUILD** |
| 11 | Facebook | Click the published link | **The real post on `<REVIEWER_TEST_PAGE_NAME>` with the comment beneath it, authored by the Page** — the `pages_manage_engagement` proof | Comments from real users; unrelated Page content | exists (the comment itself is the new part) |
| 12 | Back in FablePeak | Scroll the composer and the sidebar slowly | **That no comment inbox, moderation view or reply control exists anywhere** — supports the data-minimization claim in D2 | — | exists |
| 13 | Connections — disconnect | Click **Disconnect**, confirm | The card returning to "Available to connect" | — | exists |

#### Recording 4 — Instagram first comment (`instagram_business_manage_comments`)

| # | On screen | Action | Must be visible | Must never be visible | Status |
|---|---|---|---|---|---|
| 1 | `https://fablepeak.com` | Sign in, open **🔌 Connections**, disconnect any existing Instagram row | The Instagram card returning to "Available to connect" | Typed password characters | exists |
| 2 | Instagram login popup | Click **Connect** | The popup URL on `instagram.com/oauth/authorize`; the Instagram-branded login, **not** a Facebook login | Any `code=` / `access_token=` | exists |
| 3 | Instagram consent | Sign in as `<REVIEWER_IG_USERNAME>`, approve | **The permission screen listing all three permissions**, including comment management — the consent proof for the new permission | The password field contents | exists (list depends on the updated scope request) |
| 4 | Connections — connected | Hold 4 s | `@<REVIEWER_IG_USERNAME>` and that profile's picture | Any other connected account | exists |
| 5 | Composer | **+ New post**; type the caption; attach the sample media | The caption and the media preview | Private photos in the picker | exists |
| 6 | Composer — Networks | Tick **Instagram** only | Instagram ticked, all others unticked | — | exists |
| 7 | Composer — per-network panel | Tick **Customize per network**; expand the Instagram section | The Instagram section opening | — | exists |
| 8 | Composer — first comment | Type the hashtag block into the Instagram **First comment** field | **The field, its label, and the typed hashtag block** | — | **TO BUILD** |
| 9 | Publish | **Schedule**, reopen, **🚀 Publish now**, confirm | The confirmation dialog | — | exists |
| 10 | Delivery results | Hold 4 s | "Published — view post" **and** "First comment posted" for Instagram | — | **TO BUILD** |
| 11 | Instagram | Open the permalink | **The new media on `@<REVIEWER_IG_USERNAME>` with the hashtag comment beneath it** — the `instagram_business_manage_comments` proof | DMs, other accounts' content, follower lists | exists (the comment itself is the new part) |
| 12 | Back in FablePeak | Scroll the product slowly | **That there is no comment inbox, moderation or reply surface** | — | exists |
| 13 | Connections — disconnect | Click **Disconnect**, confirm | The card returning to "Available to connect" | — | exists |
| 14 | Data deletion page | Open `https://fablepeak.com/data-deletion.html` | The published disconnect and deletion instructions | — | exists |

## D4. Data-handling addendum

Section A4 stands unchanged and should be re-submitted as written. This round
adds one paragraph and **no new data category**.

**First comment text.** The first comment is text the customer types in
FablePeak's composer, in the same dialog as the post itself. It is stored the
same way the post text is stored: in the `posts` row in our Postgres database,
inside the customer's own workspace, protected by the same row-level security
that scopes every read to the workspaces the signed-in user belongs to. It is
not a new category of data — it is post content, authored by the customer,
destined for the customer's own account.

**What comes back from Meta.** Only the created comment's id, stored on that
post's delivery record next to the post id we already store, so the customer can
see the comment posted and so a failed comment can be retried without
duplicating a successful one. FablePeak reads no other comment, from Meta or
anyone, and stores no comment authored by any other user.

**Deletion.** Exactly the deletion paths already described in A4, with no new
step: disconnecting an account deletes that connection's stored credentials and
stops all future delivery; deleting the FablePeak account runs
`prepare_account_deletion`, which removes the user's posts along with their
provider credentials, memberships and solely-owned workspaces. Because the first
comment lives on the post row, deleting the post or the account deletes it with
everything else. There is no separate comment store and therefore no separate
retention period.

**Not used for.** The comment text and comment id are not sold, not shared for
advertising, not used to build any profile, and not used outside the workspace
that authored them.

## D5. Submission-day checklist for this later round

Run only after every precondition at the top of Section D is true.

1. **Re-verify the app is Live and unaffected.** Open the Meta dashboard as the
   app owner and confirm: the app is **Live** (not back in Development), the
   five Section A permissions all still show **Advanced Access approved**,
   business verification and access verification still show **Verified**, and
   there is no "Account confirmation needed" banner. If any of those has
   regressed, stop — fix that first. Nothing in this round is worth touching a
   healthy Live app.
2. **Confirm production is healthy before adding scope.** `npm run check`
   passes, `operations-health` is green, and the scheduled publish/connection/
   metrics jobs are running (the same evidence C0.1 and C3.3 require).
3. **Confirm the feature is real.** Every row of D3.0 is built and deployed from
   the reviewed commit, and D3.2 has no `TO BUILD` row left.
4. **Facebook: update the Login for Business configuration**, not just the
   review request. Because `oauth-start` sends `config_id` and omits `scope`,
   `pages_manage_engagement` must be attached to the Login configuration
   (`META_CONFIG_ID`) or the reviewer's consent screen will never show it. Do
   not remove or reorder the three permissions already on that configuration.
5. **Instagram: update the use case's permission list.** In the Instagram
   product / use case, add `instagram_business_manage_comments` to the requested
   permissions alongside `instagram_business_basic` and
   `instagram_business_content_publish`, and add the same scope to
   `instagram.scopes` in `platforms.ts` so the authorize URL actually requests
   it. The console list and the code must match exactly — a permission approved
   but not requested is dead, and a permission requested but not approved fails
   at consent.
6. **Do not disturb the approved permissions.** Request Advanced Access for the
   two new permissions **only**. Do not withdraw, resubmit or re-justify the
   five that are already approved; do not add any other permission to the
   request "while we are in here".
7. **Reconcile the A1 wording.** The approved `pages_read_engagement`
   justification states that FablePeak deliberately does **not** request
   `pages_manage_engagement`. That sentence was true when submitted and is now
   superseded. If the console lets you edit it, update it to say FablePeak
   requests `pages_manage_engagement` solely to create a first comment on the
   customer's own post and still requests none of the other permissions listed
   there; if it does not, say so explicitly in this round's justification and
   notes so the reviewer is not reading a contradiction. **Update Section A1 of
   this file in the same change** — do not leave the two rounds disagreeing.
8. **Record Recordings 3 and 4** (D3.2), review them frame by frame against the
   "must never be visible" column, and only then fill in the forms.
9. **Paste D2** into each permission's justification field, and **D3.1** into
   the reviewer-instructions field with every placeholder replaced. Reviewer
   credentials go only in Meta's credential fields.
10. **Answer data handling with A4 plus the D4 addendum.** Do not silently
    re-submit A4 alone: the comment id is new stored provider data, small as it
    is, and an unexplained new field is a rejection risk.
11. **Submit, then leave production alone.** Keep the reviewer accounts and
    connections alive, keep `SOCIAL_TOKEN_ENCRYPTION_KEY` unchanged, and do not
    ship connection or publish changes during the review window.
12. **Plan the re-consent rollout.** Approval alone does not grant the new
    permission to connections authorized earlier. Before releasing first
    comments to customers, decide how existing connections are re-consented
    (prompt to reconnect, or a health-check state), and make the composer's
    first-comment field unavailable — with a readable reason — on a connection
    that has not re-consented. The publish path must refuse rather than fail
    publicly.
13. **After approval**, record the outcome in
    `docs/acceptance/EXTERNAL_BETA_EVIDENCE.md` and run first-comment acceptance
    on an unrelated Business account and an unrelated Creator account, as
    `META_APP_REVIEW.md`'s launch gate requires for any new capability.

## D6. NEEDS-HUMAN-CONFIRM for Section D

Separate from the Sections A–C table above.

| # | Item | Why it could not be verified here |
|---|---|---|
| D1 | The core submission is approved and the app is Live | Console state; cannot be read from the repository. This is the gate on the whole section |
| D2 | The exact permission name Meta's console shows for Instagram comment creation | The repository never requests it; `instagram_business_manage_comments` is taken from ADR 0005's capability table, not from a console screenshot |
| D3 | Whether Meta's current review UI attaches these to a **use case** rather than a bare permission list, and what that use case is called | Console state; D5.5 assumes the Instagram use case owns the permission list |
| D4 | Whether `pages_manage_engagement` can be added to the existing Login for Business configuration in place, and whether that forces re-consent for already-connected Pages | The permission set lives in the Meta dashboard, not in code (`oauth-start` sends `config_id` and omits `scope`) — same reason as item 7 of the A–C table |
| D5 | Whether the A1 `pages_read_engagement` justification can still be edited after approval | Console behaviour; D5.7 gives both branches |
| D6 | That the probe's raw Graph response is retained somewhere durable | The `(#200)` verdict is recorded in ADR 0005 and reproduced by `connection-health/index.deno.ts`'s fixtures, but the live response body itself is not stored in the repository. Capture it before submitting if the reviewer thread may need it |
| D7 | The first comment's exact composer wording and control names used in D3.1 and D3.2 ("First comment", "copy to every network", "First comment posted", "Retry comment") | The UI does not exist yet; these names are taken from ADR 0005 and **must be reconciled with what is actually built** before submission |
| D8 | Reviewer test assets for this round (Page, Instagram professional profile, sample media) | Must be developer-owned and supplied at submission time; the A2 assets may have been disconnected after the first round |
