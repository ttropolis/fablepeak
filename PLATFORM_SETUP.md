# Connecting FablePeak to real social platforms

This is the one-time setup that turns FablePeak from a demo into something that
posts to real accounts. Each platform needs a developer app registered once;
after that, connecting an account is two clicks inside FablePeak.

**Verified against each platform's own developer docs, July 2026.** These APIs
change often — if something below doesn't match what you see, the platform's
docs win.

---

## The headline: what can you actually test, and for free?

| Platform | Post for free? | Testable **without** app review? | Reality check |
|---|---|---|---|
| **Facebook Page** | ✅ Yes | ✅ **Yes, fully** — your own Page | Easiest. Start here. |
| **Instagram** | ✅ Yes | ✅ **Yes, fully** — your own account | Direct Instagram Login; needs Business/Creator. No Facebook Page required. |
| **YouTube** | ✅ Yes | ✅ Yes, with caveats | Uploads stay **private** until Google audits the project. Test tokens expire every 7 days. |
| **LinkedIn** | ✅ Yes | ✅ Yes — personal profile only | Company Pages need LinkedIn partner review (hard). |
| **TikTok** | Deferred | — | Intentionally left unconfigured for the current release. |
| **X / Twitter** | ❌ **No** | N/A — no review, but no free tier | **~US$0.015 per post, ~US$0.20 if it contains a link.** See below. |

**Recommendation: set up Facebook + Instagram first.** They are the only two
that publish real, publicly-visible posts, for free, with zero review, today.
That's the cleanest proof the whole pipeline works.

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

**YouTube is fully configured and verified** (2026-07-26):
Google Cloud project `fablepeak`, YouTube Data API v3 + YouTube Analytics API
enabled, OAuth consent screen in Testing with `tcltv987@gmail.com` as test
user, Web OAuth client `FablePeak web` pointing at the callback below, and
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` stored in Supabase.
Verified: `oauth-start` reports `{"platforms":["youtube"]}`, and Google's
consent screen loads for our client and redirect URI with no error.

To connect it: sign in to fablepeak.com → Connections → Connect on YouTube.

**Current function deployment** (2026-08-02): `publish` and
`ingest-metrics` were redeployed from immutable Git commit
`cd09c1eae2dad8102b85be6a55b208d7547f5ccb`. The protected metrics smoke test
returned HTTP 200 with one successful YouTube ingestion, and the next scheduled
publisher heartbeat returned HTTP 200 with no due posts. A future CLI deploy
from the repository can replace these pinned dashboard bundles normally.

Remaining platforms follow the step-by-step below — each needs a developer
app registered and two credentials pasted.

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

```
LINKEDIN_CLIENT_ID=<...>
LINKEDIN_CLIENT_SECRET=<...>
LINKEDIN_VERSION=202601        # optional; bump when LinkedIn sunsets it
```

**Gotcha:** posting to a **Company Page** needs the Community Management API,
which LinkedIn only grants to registered legal businesses after a two-stage
review, and there's no sandbox to test it first. Personal-profile posting has
none of that friction.

---

## 4. TikTok (deferred)

TikTok is intentionally not part of the current release. Leave
`TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` unset; FablePeak will keep the
connection disabled. The steps below are retained only for a future phase.

1. <https://developers.tiktok.com> → create an app.
2. Add the **Content Posting API** product, request `video.publish`.
3. Add the callback URL above as a redirect URI.

```
TIKTOK_CLIENT_KEY=<...>
TIKTOK_CLIENT_SECRET=<...>
```

**Gotcha:** until TikTok audits the app, everything you post is visible **only
to you** (`SELF_ONLY`), capped at 5 posting users per 24h. Fine for proving the
pipeline; not for real publishing.

---

## 5. X / Twitter (optional, paid)

1. <https://console.x.com> → create a project and app.
2. Enable **OAuth 2.0**, type **Web App**, with **Read and write** permissions.
3. Add the callback URL above.

```
X_CLIENT_ID=<...>
X_CLIENT_SECRET=<...>
```

Billing is per action — see the warning at the top.

---

## 6. Server secrets FablePeak needs regardless

```
CRON_SECRET=<any long random string>     # protects the scheduled publish/metrics jobs
SOCIAL_TOKEN_ENCRYPTION_KEY=<32 random bytes encoded as base64url>
APP_ORIGIN=https://fablepeak.com         # locks CORS to your own site
APP_TIMEZONE=Australia/Perth             # IANA timezone for scheduled post times
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase
automatically — don't add them by hand.

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

Posts publish automatically at their scheduled time; no setup needed. Two
`pg_cron` jobs are live:

| Job | Schedule | What it does |
|---|---|---|
| `fablepeak-publish-due` | every minute | publishes posts whose time has arrived |
| `fablepeak-metrics` | 03:17 Perth daily | pulls real follower/impression numbers |

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
