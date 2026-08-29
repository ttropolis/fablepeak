# FablePeak — social media manager

Live at **[fablepeak.com](https://fablepeak.com)** · static web app (native ES
modules, no bundler) + installable PWA · optional Supabase accounts and cloud
sync · no build step. Signed-out demo data stays on the device.

Inspired by [Metricool](https://metricool.com).

## Use it

- **Web:** open [fablepeak.com](https://fablepeak.com)
- **Phone or desktop (app):** open the site, then *Add to Home Screen* / *Install app* (Safari share menu on iPhone, the browser menu in Chrome). Launches fullscreen and **works offline** — the installed PWA is the offline story.
- **Run it locally:** serve this directory over http and open the URL it prints. Any static server will do:

  ```sh
  npx serve .            # → http://localhost:3000
  python3 -m http.server # → http://localhost:8000
  ```

  Opening `index.html` straight off disk (`file://`) does **not** work: the app
  is native ES modules, and browsers refuse module scripts on a `file://`
  origin. There is still no build step — these are the same static files
  GitHub Pages serves. See
  [ADR 0003](docs/adr/0003-frontend-test-harness-and-split-plan.md), decision 3.

## Mobile release

FablePeak is mobile-first through its installable PWA, so Android and iOS users
can plan content without moving files to a laptop. In **New post**, signed-in
users can choose from Photos/Gallery, take a photo, or record a video. iPhone
HEIC/HEIF photos are converted to JPEG in the browser before upload. Videos over
6 MB use resumable 6 MB chunks so a brief mobile-network interruption does not
restart the whole transfer. The current Supabase Free storage limit is 50 MB per
file, so longer phone videos must be trimmed or recorded at a lower quality.

The PWA is the deployable Android/iOS experience for this release. Publishing in
the Apple App Store or Google Play would be a separate follow-up: wrap this web
app with a native shell (for example, Capacitor), add store signing/assets and
test native permissions/background behaviour. The web app remains the shared UI
and backend rather than creating a second product.

## Features

| View | What it does |
|------|--------------|
| **Planner** | Monthly content calendar. Compose posts per network, upload media (50 MB) or use a direct URL, and choose date/time/status. Cloud schedules publish server-side, retain per-network delivery outcomes, and safely retry definitive failures; local/demo schedules simulate publishing in the browser. |
| **Analytics** | Real follower totals and day-over-day impression/engagement changes when platform data exists, with a clearly-labelled simulated fallback for new workspaces. |
| **Inbox** | Unified messages across networks. Reply, resolve, filter. |
| **SmartLinks** | Link-in-bio page builder with live phone preview and click tracking. |
| **Reports** | 30-day per-network report + post log. Print / save as PDF. |
| **Connections** | Customer-owned OAuth connections in cloud mode, including direct Instagram Login and explicit Facebook Page selection; simulated profiles in local/demo mode. |
| **Settings** | Multiple brands, JSON export/import backups, demo reset. |

## Managing it yourself

- **Data** lives in your browser's localStorage, auto-saved on every change. Different browser/device = separate data.
- **Backups:** Settings → *Export backup* (JSON file). *Import backup* restores. Export before clearing browser data.
- **Work on it locally:** serve the directory (`npx serve .` or `python3 -m http.server`) and reload after an edit — there is nothing to compile or watch. `file://` will not run the app; use the local server, or install the PWA if you need it offline.
- **Verify an update:** run `npm run check`. It runs the jsdom behavioural suite and the unit/source-text tests plus Deno type-checking for every Edge Function; CI also rebuilds the database from migrations. `npm run test:browser` is the separate Playwright tier (drag-and-drop, service worker/offline, focus order, module loading).
- **Add a module:** put it in `js/`, import it from wherever it is used, and add it to the `ASSETS` list in `sw.js` — the test suite fails if `js/` and the precache list disagree, because a module missing from the cache is a blank page offline.
- **Deploy an update:** apply migrations and deploy the reviewed Edge Functions before merging frontend changes that depend on them. GitHub Pages redeploys `main` automatically; run `npm run smoke:production` and authenticated `npm run smoke:cron` once production has updated.
- **Rebuild locally:** with the local Supabase database running, `supabase db reset --local --no-seed` replays the complete schema from the first migration onward; it does not require an existing production database or seed file.
- **Start over:** Settings → *Reset to demo*.

## Hosting setup (already done)

- Repo: `ttropolis/fablepeak` on GitHub, Pages enabled from `main` branch root.
- Domain: `fablepeak.com` via `CNAME` file + 4 GitHub Pages A records (185.199.108–111.153) at Hostinger DNS. `www` CNAMEs to the root domain.
- HTTPS: certificate auto-issued by GitHub; enforced once available.

## Customizing

Plain HTML/CSS/JS, no framework and no build step. `index.html` holds the markup
and all the CSS; the application code is native ES modules in `js/`, loaded
through the single entry `js/main.js`:

| Where | What |
|---|---|
| `index.html` | markup, `:root { ... }` theme variables, all CSS |
| `js/constants.js` | the `NETWORKS` and `VIEWS` arrays, `APP_VERSION` (shown in the sidebar) |
| `js/workspace.js` | `seedDemo()` and the load/save lifecycle |
| `js/state.js` | every value the app mutates at runtime |
| `js/escape.js` | the escapers every rendered `${}` goes through |
| `js/actions.js` | the `ACTIONS` table behind `data-action` (there are no inline handlers) |
| `js/planner.js`, `js/analytics.js`, `js/inbox.js`, `js/smartlinks.js`, `js/reports.js`, `js/connections.js`, `js/settings.js` | one view each |
| `js/local-store.js`, `js/remote-store.js`, `js/store.js` | the storage adapters |
| `sw.js` | the PWA cache — its version must match `APP_VERSION` |

Icons are generated by a small PIL script (see git history) — swap the PNGs to rebrand.

## Multi-user / cloud sync (LIVE)

Implemented per [BACKEND_SPEC.md](BACKEND_SPEC.md) on Supabase (free tier, $0/mo):
Postgres + row-level security, email/password login, realtime cross-device
sync, offline cache, and server-side publishing via pg_cron. The scheduler uses
`APP_TIMEZONE` (`Australia/Perth` by default).

- **Sign in:** Settings → Cloud sync → Sign in. Signed-out visitors get a
  private local demo — nothing shared leaks.
- **Add teammates:** Supabase dashboard → Authentication → Add user. To give
  someone access to an existing brand, add a row in `brand_members`
  (dashboard → Table Editor). Brand creators get access automatically.
- **First sign-in migration:** if the cloud is empty, the app offers to
  upload the device's existing local data.
- **Kill switch:** delete `backend-config.js` and push — app returns to
  100% local mode. Schema lives in `supabase/schema.sql`.

## Current limits

- FablePeak is an internal tool being hardened for a small invite-only external
  beta. Provider expansion is frozen: production scope remains Facebook,
  Instagram and YouTube until reliability monitoring, controlled Meta
  acceptance and the unrelated-customer acceptance matrix pass.
  The current technical and human gates are tracked in
  [the external-beta evidence record](docs/acceptance/EXTERNAL_BETA_EVIDENCE.md).

- Production OAuth discovery currently exposes YouTube, Facebook and direct
  Instagram, and all three have their required server secrets. YouTube has been
  verified end to end. Facebook and Instagram still need app-role/test-account
  acceptance tests, then Meta App Review and Live mode before unrelated
  customers can connect.
- LinkedIn's personal-profile adapter supports text and one image; video and
  Company Page publishing remain deferred. X supports text, images, GIFs and
  video, but its production credentials are not configured and it requires
  paid API credits.
- TikTok is intentionally disabled in both discovery and publishing, even if
  secrets are added, until its mandatory creator-info, consent and final-status
  workflow is implemented and audited.
- Pinterest OAuth, refresh, board discovery/selection, and image Pin publishing
  are implemented but deliberately disabled until production credentials and a
  real-account acceptance test are complete. Video Pins are explicitly rejected;
  reconnecting refreshes the single Pinterest login allowed per workspace.
- YouTube publishing requires a public, direct HTTPS video-file URL. A
  `youtube.com/watch` or `youtu.be` page identifies an existing video but
  cannot be used as an upload source.
- Analytics and Reports use daily platform data once ingestion has produced
  rows. Until then they display a clearly-labelled simulated fallback.
- Daily ingestion reads real follower totals for Facebook, Instagram, YouTube,
  X and Pinterest, plus YouTube channel views as impressions. X and Pinterest
  are still production-frozen, so those two only start producing rows on the day
  they are enabled and an account connects. LinkedIn reports nothing: follower
  and connection counts need LinkedIn partner scopes FablePeak does not hold,
  so its Analytics stay on the labelled simulated fallback.
- Inbox conversations and replies are simulated; real messaging permissions
  are a separate platform-review project.
- Google Business remains a visible, explicitly disabled roadmap card without
  OAuth or a publishing adapter.
- Cloud media uploads are capped at 50 MB per file by the current Supabase Free
  project configuration.
