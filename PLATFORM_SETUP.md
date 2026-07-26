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
| **Instagram** | ✅ Yes | ✅ **Yes, fully** — your own account | Needs Business/Creator account. Every post needs an image. |
| **YouTube** | ✅ Yes | ✅ Yes, with caveats | Uploads stay **private** until Google audits the project. Test tokens expire every 7 days. |
| **LinkedIn** | ✅ Yes | ✅ Yes — personal profile only | Company Pages need LinkedIn partner review (hard). |
| **TikTok** | ✅ Yes | ⚠️ Partly | Until TikTok audits the app, posts are **private-only**, max 5 users/24h. |
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

## Before you start

Every platform needs the same redirect/callback URL. Paste this exactly:

```
https://lghsvxwuaebvotutyjtt.supabase.co/functions/v1/oauth-callback
```

Secrets go in **Supabase dashboard → Edge Functions → Secrets** (never in the
repo — the browser never sees them).

---

## 1. Facebook Page + Instagram (one Meta app covers both)

Both use the same Meta app, so this is one setup for two platforms.

**You need:** a Facebook Page you administer. For Instagram, an Instagram
account set to **Business** or **Creator** and linked to that Page.

1. Go to <https://developers.facebook.com/apps> → **Create app** → type
   **Business**.
2. In the app, add the **Facebook Login** product. Under its Settings, add the
   callback URL above to **Valid OAuth Redirect URIs**.
3. Leave the app in **Development mode** (top toggle). This is the important
   part: in Development mode the app can post to any Page/Instagram account
   whose owner has a **role** on the app — no App Review, no business
   verification, works indefinitely.
4. **App roles → Add people** → add yourself (and your other two users) as
   Administrator, Developer, or Instagram Tester. Each person accepts the
   invite (Instagram invites are accepted in Instagram → Settings → Website
   permissions).
5. Copy **App ID** and **App Secret** from Settings → Basic.

Add to Supabase Edge Function secrets:
```
META_APP_ID=<your app id>
META_APP_SECRET=<your app secret>
```

**Gotchas**
- Instagram cannot post text-only — every Instagram post needs an image or
  video URL. FablePeak enforces this in the composer.
- The image/video must be at a **public URL** (Instagram fetches it itself).
- Going beyond accounts with an app role — i.e. letting strangers connect —
  needs App Review + business verification. Not needed for your 3 users.

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
  community posts, so FablePeak requires a video URL for YouTube.

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

## 4. TikTok (optional)

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
APP_ORIGIN=https://fablepeak.com         # locks CORS to your own site
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase
automatically — don't add them by hand.

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

## Scheduled publishing

Once connections work, posts publish automatically at their scheduled time.
Enable it by scheduling the publisher (Supabase SQL editor, once):

```sql
select cron.schedule('fablepeak-publish-due', '* * * * *', $$
  select net.http_post(
    url := 'https://lghsvxwuaebvotutyjtt.supabase.co/functions/v1/publish',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<YOUR CRON_SECRET>'),
    body := jsonb_build_object('due', true)
  ) $$);

select cron.schedule('fablepeak-metrics', '17 3 * * *', $$
  select net.http_post(
    url := 'https://lghsvxwuaebvotutyjtt.supabase.co/functions/v1/ingest-metrics',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<YOUR CRON_SECRET>'),
    body := '{}'::jsonb
  ) $$);
```

(Requires the `pg_net` extension — enable it under Database → Extensions.)

Once `ingest-metrics` has run at least once, the Analytics page starts showing
real platform numbers instead of the simulated ones.
