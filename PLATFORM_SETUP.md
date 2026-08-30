# Connecting FablePeak to real social platforms

This is the one-time setup that turns FablePeak from a demo into something that
posts to real accounts. Each platform needs a developer app registered once;
after that, connecting an account is two clicks inside FablePeak.

**Verified against each platform's own developer docs, August 2026.** These APIs
change often — if something below doesn't match what you see, the platform's
docs win.

---

## The headline: what can you actually test, and for free?

| Platform | Post for free? | Testable **without** app review? | Reality check |
|---|---|---|---|
| **Facebook Page** | ✅ Yes | ✅ **Yes, fully** — your own Page | Easiest. Start here. |
| **Instagram** | ✅ Yes | ✅ **Yes, fully** — your own account | Direct Instagram Login; needs Business/Creator. No Facebook Page required. |
| **YouTube** | ✅ Yes | ✅ Yes, with caveats | Uploads stay **private** until Google audits the project. Test tokens expire every 7 days. |
| **LinkedIn** | ✅ Yes | ✅ Yes — personal profile only | Company Pages need LinkedIn partner review (hard). Tokens last 60 days and cannot be refreshed; reconnecting is the renewal. |
| **Pinterest** | ✅ Yes | Trial access required | Implemented but gated until credentials and a real-account acceptance test are complete. |
| **TikTok** | In review | Sandbox only | App review submitted 2026-08-30; sandbox posting proven. |
| **X / Twitter** | ❌ **No** | N/A — no review, but no free tier | **~US$0.015 per post, ~US$0.20 if it contains a link.** See below. |

**Recommendation: set up Facebook + Instagram first.** They are the only two
that publish real, publicly-visible posts, for free, with zero review, today.
That's the cleanest proof the whole pipeline works.

### Publishing media matrix

| Platform | Text only | Image | GIF | Video | Current constraint |
|---|---:|---:|---:|---:|---|
| Facebook Page | ✅ | ✅ | ✅ | ✅ | Publishes to the selected administered Page. |
| Instagram | ❌ | ✅ | ✅ | ✅ Reels | Requires a Business or Creator profile and public media URL. |
| YouTube | ❌ | ❌ | ❌ | ✅ | Uploads a direct video file; new projects are private until audited. |
| X / Twitter | ✅ | ✅ | ✅ | ✅ | Requires paid API credits and production credentials. |
| LinkedIn profile | ✅ | ✅ | ✅ | ❌ | One image per post; video is rejected explicitly. |
| TikTok | ❌ | ❌ | ❌ | Sandbox | Compliance workflow built; production waits on TikTok's app review. |
| Pinterest | ❌ | ✅ | ✅ | ❌ | Image Pins are implemented but production-disabled pending acceptance. |
| Google Business | Disabled | Disabled | Disabled | Disabled | Adapter is not implemented. |

FablePeak fetches X and LinkedIn attachments from the supplied public HTTPS
URL, uploads them to the provider, and only then creates the post. An attachment
upload failure is recorded for that target and does not silently become a
text-only post.

### About X / Twitter — read before enabling
X removed its free tier for new developers (Feb 2026). It is now pay-per-use:
roughly **$0.015 per post, $0.20 per post containing a link**, plus per-read
charges for analytics. There is no approval gate — you can start immediately —
but it is the only platform here that breaks FablePeak's $0/month running cost.
Skip it unless you specifically want X, and know it's billed per action.

---

## Already done for you (verified live)

- Database tables, row-level security, and the token-free account view.
- All four Edge Functions deployed and responding: `oauth-start`,
  `oauth-callback`, `publish`, `ingest-metrics`.
- `CRON_SECRET` and `APP_ORIGIN` server secrets set.
- Scheduled jobs live: publish-due every minute, metrics daily at 03:17.
  Verified: the scheduler calls the publisher and gets HTTP 200.
- FablePeak reaches the functions from fablepeak.com (CORS locked to it).

**Production OAuth discovery currently reports Facebook, Instagram and
YouTube.** Their client credentials and the shared token-encryption key are
stored as Supabase Edge Function secrets. This proves server configuration,
not provider approval or customer-account acceptance.

**YouTube is fully configured and verified** (2026-07-26):
Google Cloud project `fablepeak`, YouTube Data API v3 + YouTube Analytics API
enabled, OAuth consent screen in Testing with `tcltv987@gmail.com` as test
user, Web OAuth client `FablePeak web` pointing at the callback below, and
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` stored in Supabase.
Verified: Google's consent screen loads for our client and redirect URI with no
error, and current discovery includes `youtube`.

To connect it: sign in to fablepeak.com → Connections → Connect on YouTube.

**Current function deployment** (2026-08-02): `publish` and
`ingest-metrics` were redeployed from immutable Git commit
`cd09c1eae2dad8102b85be6a55b208d7547f5ccb`. The protected metrics smoke test
returned HTTP 200 with one successful YouTube ingestion, and the next scheduled
publisher heartbeat returned HTTP 200 with no due posts. A future CLI deploy
from the repository can replace these pinned dashboard bundles normally.

Meta credentials are already deployed; Meta's remaining work is the acceptance
and review gate described below. LinkedIn and X still need developer apps and
credentials. Pinterest needs a developer app, credentials, and a real-account
acceptance test. TikTok and Google Business require more product work before
they can be enabled safely.

## Before you start

Every platform needs the same redirect/callback URL. Paste this exactly:

```
https://lghsvxwuaebvotutyjtt.supabase.co/functions/v1/oauth-callback
```

Secrets go in **Supabase dashboard → Edge Functions → Secrets** (never in the
repo — the browser never sees them).

All providers also require one FablePeak-owned encryption key. Generate 32
random bytes, encode them as base64/base64url, and store the result as:

```
SOCIAL_TOKEN_ENCRYPTION_KEY=<base64url-encoded 32-byte random key>
```

Back this value up in the project's password manager. Rotating or losing it
without a migration makes encrypted connections unreadable. Existing legacy
plaintext tokens remain readable and are encrypted on reconnect or refresh.

---

## 1. Facebook Page + Instagram

FablePeak owns one Meta developer app, but the customer connections are
separate: Facebook Pages use Facebook Login for Business and Instagram uses
Business Login for Instagram directly.

**Test assets:** a Facebook Page you administer and an Instagram account set to
**Business** or **Creator**. The Instagram profile does not need a linked Page.

1. Go to <https://developers.facebook.com/apps> → **Create app** → type
   **Business**.
2. Add **Facebook Login for Business**. Create a configuration that permits Page
   discovery and publishing, then add the callback URL to its valid OAuth redirects.
3. Add **Instagram** using **Instagram API with Instagram Login**. Add the same
   callback URL to its valid OAuth redirects and request only
   `instagram_business_basic` and `instagram_business_content_publish`.
4. Leave the app in **Development mode** while testing. This is the important
   part: in Development mode the app can post to any Page/Instagram account
   whose owner has a **role** on the app — no App Review, no business
   verification, works indefinitely.
5. **App roles → Add people** → add internal testers as
   Administrator, Developer, or Instagram Tester. Each person accepts the
   invite (Instagram invites are accepted in Instagram → Settings → Website
   permissions).
6. Copy the Facebook App ID/secret, Facebook Login configuration ID, and the
   Instagram App ID/secret shown by the Instagram product.

Add to Supabase Edge Function secrets:
```
META_APP_ID=<your app id>
META_APP_SECRET=<your app secret>
META_CONFIG_ID=<facebook login for business configuration id>
INSTAGRAM_APP_ID=<instagram product app id>
INSTAGRAM_APP_SECRET=<instagram product app secret>
```

**Gotchas**
- Instagram cannot post text-only — every Instagram post needs an image or
  video URL. FablePeak enforces this in the composer.
- Customers sign into their own Instagram profile directly. They do not use a
  FablePeak/Shiloh Creek account and do not need a Facebook Page.
- The image/video must be at a **public URL** (Instagram fetches it itself).
- General customer onboarding requires Meta App Review, Advanced Access for
  the requested permissions, any verification Meta requests, and Live mode.
  Development mode is only for app-role/test accounts.

---

## 2. YouTube (Google)

**You need:** a Google account with a YouTube channel.

1. <https://console.cloud.google.com> → create a project.
2. **APIs & Services → Library** → enable **YouTube Data API v3** and
   **YouTube Analytics API**.
3. **OAuth consent screen** → External. Leave publishing status on **Testing**,
   and add each person who will connect as a **Test user** (up to 100).
4. **Credentials → Create credentials → OAuth client ID → Web application.**
   Add the callback URL above to **Authorised redirect URIs**.
5. Copy the client ID and secret.

```
GOOGLE_CLIENT_ID=<...>
GOOGLE_CLIENT_SECRET=<...>
```

**Gotchas — these are real and will surprise you**
- Any API project created after July 2020 has uploads **forced to private**
  until it passes YouTube's separate *Audit and Quota Extension* review. You can
  upload and verify the pipeline end-to-end; the video just won't be public
  until audited.
- While the consent screen is in **Testing**, refresh tokens expire after
  **7 days** — expect to reconnect weekly until you publish the consent screen.
- YouTube publishing = uploading a video. There's no public API for text-only
  community posts, so FablePeak requires a public, direct HTTPS video-file
  URL. A YouTube watch/share link is an HTML page, not a video source, and is
  rejected before publishing.

---

## 3. LinkedIn (personal profile)

1. <https://www.linkedin.com/developers/apps> → **Create app** (needs an
   associated Company Page, but posting will go to your personal profile).
2. **Products** tab → add **Share on LinkedIn** and **Sign In with LinkedIn
   using OpenID Connect**. Both are self-serve — no review.
3. **Auth** tab → add the callback URL above to **Authorized redirect URLs**.
4. Copy client ID and secret.

The current adapter publishes text-only posts or one JPG, PNG or GIF image.
It initializes the Images API upload, sends the image bytes, then attaches the
returned Image URN to the Posts API request. Video is rejected before any
LinkedIn post is created.

```
LINKEDIN_CLIENT_ID=<...>
LINKEDIN_CLIENT_SECRET=<...>
LINKEDIN_VERSION=202601        # optional; bump when LinkedIn sunsets it
```

**Token lifecycle — reconnect is the only renewal.** LinkedIn access tokens
last **60 days**. Refresh tokens are issued only to apps approved for
LinkedIn's partner program, and the self-serve scopes above never receive one,
so there is no automatic renewal and none should be assumed: adding a refresh
scope to the adapter without that approval changes nothing.

FablePeak therefore treats the end of those 60 days as a scheduled reconnect
rather than a surprise. The nightly `maintain-connections` job marks a LinkedIn
connection **`expired`** once it comes within seven days of its expiry, so the
account shows "⚠️ Needs reconnecting" with a **Reconnect** button while the
current token still publishes. Reconnecting through the normal Connect flow
issues a fresh 60-day token and returns the connection to `active`.

**Analytics — not available on these scopes.** The daily `ingest-metrics` job
has no LinkedIn adapter, deliberately. `openid`/`profile` buy `/v2/userinfo`,
which is identity only; connection counts need `r_1st_connections_size` and
follower or share statistics need the Community Management / Marketing partner
APIs, all of which are review-gated. Rather than record a fabricated or empty
figure, FablePeak reports nothing for LinkedIn and Analytics keeps its labelled
simulated fallback for that platform until partner scopes are granted.

**Gotcha:** posting to a **Company Page** needs the Community Management API,
which LinkedIn only grants to registered legal businesses after a two-stage
review, and there's no sandbox to test it first. Personal-profile posting has
none of that friction.

---

## 4. Pinterest (implemented, production-gated)

1. Create a Pinterest business account, register an app, and request Trial access.
2. Register the shared callback URL above.
3. Request only `boards:read`, `boards:write`, `pins:read`, and `pins:write`.
4. Store the app ID and secret as Edge Function secrets:

```
PINTEREST_CLIENT_ID=<app ID>
PINTEREST_CLIENT_SECRET=<app secret>
```

The adapter exchanges and continuously refreshes OAuth tokens, discovers every
public board, and requires the user to choose a publishing board explicitly.
It creates image Pins from public HTTPS image URLs and records the returned Pin
ID and URL. Video Pins are rejected before creation until their separate media
upload lifecycle is implemented. Each workspace supports one Pinterest login;
reconnecting safely replaces and refreshes that account's available boards.

**Analytics.** Once a board is connected, the daily `ingest-metrics` job reads
that board's cumulative `follower_count` from `GET /v5/boards/{board_id}`,
which the `boards:read` scope above already covers. Account-level reach
(`monthly_views` on `/v5/user_account`) needs `user_accounts:read`, which
FablePeak does not request, so no impression figure is recorded.

`productionEnabled` must remain `false` until the credentials are deployed and
an external-account test has connected, selected a board, published one image
Pin, and verified that exact Pin on Pinterest. Adding secrets alone does not
make Pinterest appear in production discovery.

---

## 5. TikTok (sandbox testing only — production still deferred)

TikTok is intentionally not part of the current release. Leave
`TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` unset. FablePeak also blocks the
adapter in OAuth discovery and publishing, so adding secrets alone cannot
accidentally expose an incomplete integration. The steps below are retained
only for a future phase.

**The compliance UX now exists** (composer panel + adapter + `creator_info`
proxy), which is what the demo video below was waiting on. What has *not*
changed is the production freeze: the adapter is still `productionEnabled:
false`, and TikTok has not approved this app for Direct Post.

To exercise the workflow against **TikTok's Sandbox** on a non-production
deployment, set one extra Edge Function secret alongside the sandbox client
credentials:

```
TIKTOK_SANDBOX=1
```

Read exactly, as the string `1`. It makes `oauth-start` offer TikTok in
discovery and lets the publish loop reach the adapter; it does **not** flip
`productionEnabled`, and it must never be set on the production project. With
it unset — the default, and every CI run — TikTok stays exactly as unreachable
as it has always been.

What the workflow does, end to end: the composer queries `creator_info` through
the member-gated `tiktok_creator_info` action on `connection-health`, shows the
destination nickname, offers only that account's privacy levels with **nothing
preselected**, disables the comment/duet/stitch toggles the account disables,
collects the commercial-content disclosure (with branded content barred from a
private audience), probes the video's duration against
`max_video_post_duration_sec`, and renders TikTok's consent line beside Save.
The adapter maps those choices into `post_info`, calls `video/init/`, then
polls `status/fetch/` for up to 60 seconds and reports success **only** on
`PUBLISH_COMPLETE`.

1. <https://developers.tiktok.com> → create an app.
2. Add the **Content Posting API** product, request `video.publish`.
3. Add the callback URL above as a redirect URI.

**Registration state (2026-08-30).** The developer app exists: **FablePeak**,
app id `7679509465791776776`, Individual ownership under the ttropolis@gmail.com
developer account (a Gmail primary was chosen deliberately for account
recovery; TikTok allows transferring the app to an organization later).
Configured in the draft: category Productivity, description, Web platform with
`https://fablepeak.com`, terms/privacy URLs, Login Kit with the standard
callback redirect URI, Content Posting API with **Direct Post enabled**, scopes
`user.info.basic` + `video.publish` + `video.upload`, and the app-review
product/scope explanation text. Domain verification for `fablepeak.com` is a
DNS TXT record at Hostinger
(`tiktok-developers-site-verification=ZNKudTrEO1iJqk3Cx1tu3g0LPmX0rmVP`, added
2026-08-30); TikTok's verify re-check clears the three "URL is not verified"
errors once their resolvers see it.

**Submitted for app review 2026-08-30** ("First submission: Login Kit and
Content Posting API (Direct Post)"), with a demo video recorded from a real
end-to-end Sandbox run: sandbox **FablePeak Demo** (id `7679670342440257544`,
its own `sbaw…` client key/secret, target user shilohcreekpod — set to a
private account, because unaudited apps may only post to private accounts).
The video shows the consent screen, the creator-info compliance panel,
scheduling, and a genuine PUBLISH_COMPLETE. `fablepeak.com` is domain-verified
on both the production app and the sandbox (two TXT records at Hostinger).
While the audit runs, sandbox testing uses `TIKTOK_SANDBOX=1` with the sandbox
credentials in the secrets below; after approval, swap in the production
credentials, remove `TIKTOK_SANDBOX`, and enable production behind the
provider-freeze gate. If the portal form is ever blanked again, re-entering
the fields above takes minutes; app id and credentials persist server-side.

```
TIKTOK_CLIENT_KEY=<...>
TIKTOK_CLIENT_SECRET=<...>
```

The export-screen requirements — query current creator info, display the
destination account and allowed privacy/interaction settings, collect explicit
user consent, validate video duration, and track the final publish status — are
implemented. What remains before production is TikTok's own audit: unaudited
clients are limited to private posts and a small daily active-user cap, so
`productionEnabled` stays `false` until that clears.

---

## 6. X / Twitter (optional, paid)

1. <https://console.x.com> → create a project and app.
2. Enable **OAuth 2.0**, type **Web App**, with **Read and write** permissions.
3. Add the callback URL above.

```
X_CLIENT_ID=<...>
X_CLIENT_SECRET=<...>
```

Billing is per action — see the warning at the top.

**Analytics.** The daily `ingest-metrics` job reads the cumulative
`followers_count` from `GET /2/users/me?user.fields=public_metrics`, covered by
the `users.read` and `tweet.read` scopes the adapter already requests. X exposes
impressions only through per-post organic metrics on scopes FablePeak does not
hold, so no impression figure is recorded.

---

## 7. Server secrets FablePeak needs regardless

```
CRON_SECRET=<any long random string>     # protects the scheduled publish/metrics jobs
SOCIAL_TOKEN_ENCRYPTION_KEY=<32 random bytes encoded as base64url>
APP_ORIGIN=https://fablepeak.com         # locks CORS to your own site
APP_TIMEZONE=Australia/Perth             # IANA timezone for scheduled post times
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase
automatically — don't add them by hand.

If you change `APP_TIMEZONE`, change `scheduleTimezone` in `backend-config.js`
to match: that is the zone the composer names on its Time field, so a mismatch
would show signed-in users the wrong publishing time.

### Reproducing the scheduled jobs

The Edge Function secret and database scheduler cannot read each other's
secret stores. Add these three entries in **Supabase Vault**:

```sql
select vault.create_secret('https://lghsvxwuaebvotutyjtt.supabase.co', 'project_url');
select vault.create_secret('<the public anon key>', 'anon_key');
select vault.create_secret('<the same value as CRON_SECRET>', 'cron_secret');
```

Then apply
`supabase/migrations/20260731090000_reliable_scheduling.sql`. It removes the
legacy job that only changed a database status, installs atomic post-claiming,
and recreates the publishing and metrics jobs without embedding credentials in
the job definitions.

---

## 8. AI writing assist (optional)

The `ai-assist` Edge Function writes caption options, suggests hashtags, and
rewrites a post for one network's conventions. It is entirely optional: leave
the secrets unset and the endpoint answers `503 AI assist is not configured on
the server`, and nothing else in FablePeak changes.

### Capability tiers

A request names a **capability tier**, never a provider. Which company answers
is an operator decision, so it can change without anything customer-facing
changing — no error message, plan name or button in FablePeak names a vendor.

| Tier | Live today? | Served by | Secrets |
| --- | --- | --- | --- |
| `standard` | **Yes** — the only tier any plan includes | Cloudflare Workers AI | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_TOKEN` |
| `enhanced` | No — built, dormant | OpenAI chat completions | `OPENAI_API_KEY` |
| `advanced` | No — built, dormant | Anthropic Messages API | `ANTHROPIC_API_KEY` |

Only the standard tier is reachable. Entitlement is decided server-side by
`entitlementsFor()` in `supabase/functions/ai-assist/index.ts`, which today
returns the same constant for everyone; asking for another tier is answered
`403 That AI tier isn't available on your plan yet.` The paid tiers are the
seam a subscription lookup drops into later — **there is no billing code in
this function.**

So a working install needs exactly two secrets:

```
CLOUDFLARE_ACCOUNT_ID=...           # dash.cloudflare.com → the account ID in the URL
CLOUDFLARE_AI_TOKEN=...             # → My Profile → API Tokens, "Workers AI" template
```

Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` only when you are about to open one
of the paid tiers; until entitlement grants them, they are dead weight. A key
is only ever read inside the Edge Function. The browser calls
`/functions/v1/ai-assist` with the signed-in customer's own Supabase session;
the function checks that session, checks workspace membership, and never
returns the provider's raw response.

### Operator overrides

Two optional secrets exist to move the live tier without a deploy. Neither is
visible to customers, and neither changes what anyone is entitled to.

```
AI_PROVIDER=cloudflare|openai|anthropic   # re-points the STANDARD tier only
AI_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast   # model for whichever of
                                          # cloudflare/openai serves a request
```

`AI_PROVIDER` is the escape hatch for a provider outage or a pricing change: set
it and the standard tier is served by a different adapter with no code change.
It is ignored by the paid tiers, which are a promise about which model answers.
An unrecognised value is logged and ignored. `AI_MODEL` overrides the default
model (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` on Cloudflare, `gpt-4o-mini`
on OpenAI); the advanced tier's model is pinned and ignores it.

### Rate limit

Each signed-in user gets **20 assist requests an hour**, counted in
`ai_assist_requests` (see
`supabase/migrations/20260829120000_ai_assist_requests.sql`, which also folds a
30-day sweep into the existing `fablepeak-prune-job-runs` job, and
`supabase/migrations/20260830090000_ai_assist_tiers.sql`, which adds the `tier`
column). The count is per user across every tier — one person's hour of assist
is one budget however it was served — while each row records the tier it spent,
so a per-tier ceiling later is a query change rather than a schema change. Over
the ceiling the endpoint returns a 429 asking the customer to try again later.
To change the ceiling, edit `HOURLY_LIMIT` (or, per tier, the `hourlyLimit`
returned by `entitlementsFor`) in `supabase/functions/ai-assist/index.ts` and
redeploy.

### Cost

**Standard.** Workers AI is billed in *neurons*, not tokens, and the Cloudflare
free allocation is 10,000 neurons a day — enough that ordinary composer use
costs nothing. Beyond it, Workers AI is a fraction of a cent per assist
request. This is why the standard tier can be offered on every plan; watch the
Workers AI dashboard for neuron burn if usage grows.

**Advanced (when enabled).** Requests use `claude-opus-5` at $5 per million
input tokens and $25 per million output tokens, capped at 1024 output tokens
each. A typical assist request is around a thousand tokens all in — roughly a
cent. At the default ceiling, one very heavy user costs about 20c an hour; a
hundred customers doing a handful of requests a day is a few dollars a month.
Watch actual spend in the Anthropic console and set a billing limit there if
you want a hard stop. This is the tier a paid plan is expected to pay for,
which is exactly why it is entitlement-gated rather than open.

**Composer UI.** The buttons that call this endpoint ship in the composer
(`js/planner.js`). There is no tier picker: the browser sends `tier:"standard"`
explicitly, because that is the only tier a plan includes today.

---

## Testing it end to end

1. In FablePeak → **Connections**, the platforms you configured become
   connectable. Click **Connect**, approve in the popup — you should come back
   to a real account name and avatar.
2. Create a post. Add an image URL if Instagram/TikTok/YouTube is selected.
3. Open the post → **🚀 Publish now**.
4. Check the real account. FablePeak records exactly what happened per platform
   (including the remote post URL, or the platform's own error message).

**Suggested first test:** a Facebook Page text post. It's free, needs no review,
publishes publicly, and is easy to delete afterwards.

---

## Scheduled publishing — already running

Posts publish automatically at their scheduled time; no setup needed. Four
`pg_cron` jobs are live:

| Job | Schedule | What it does |
|---|---|---|
| `fablepeak-publish-due` | every minute | publishes posts whose time has arrived |
| `fablepeak-maintain-connections` | hourly at :17 | proactively renews every eligible authorization, including non-default assets |
| `fablepeak-metrics` | 03:17 Perth daily | pulls real follower/impression numbers |
| `fablepeak-prune-job-runs` | 04:41 Perth daily | removes operational run records older than 30 days |

Check they're healthy any time (SQL editor):

```sql
select id, status_code, left(content,120) as response, created
from net._http_response order by created desc limit 5;
```

A healthy publisher returns `200` with
`{"published":0,"timezone":"Australia/Perth","out":[]}` when nothing is due.
`ingest-metrics` stores real daily measurements. Analytics and Reports
automatically use those rows when available and retain a labelled simulated
fallback before the first successful metrics run.

Every publisher, metrics and connection-maintenance invocation writes a
terminal row to `scheduled_job_runs`. The protected `operations-health` Edge
Function returns HTTP 503 when publishing is older than five minutes,
connection maintenance is older than two hours, metrics is older than 26
hours, or the latest run failed. The GitHub workflow authenticates with a
short-lived OIDC token restricted to this repository, workflow and `main`
branch; no shared production credential is stored in GitHub. For an optional
local operator check, configure `OPERATIONS_HEALTH_SECRET` in the Edge Function
and pass the same value locally:

```sh
FABLEPEAK_OPERATIONS_HEALTH_SECRET='<secret>' npm run smoke:cron
```

The scheduled GitHub workflow runs this authenticated check daily. CI fails if
GitHub cannot issue its OIDC identity; a missing monitor must never appear healthy.
