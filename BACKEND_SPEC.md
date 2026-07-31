# FablePeak shared-backend spec

Implementation brief for turning FablePeak (static single-file app at
fablepeak.com, repo `ttropolis/fablepeak`) into a 3-user shared-data app.
The frontend seam is already built — **you only implement `RemoteAdapter`
plus the backend it talks to.** Do not restructure the UI.

## 1. Context and hard constraints

- App: `index.html`, vanilla JS, no build step. Keep it that way.
- Hosting: GitHub Pages (static only). The backend must be an external
  hosted service (Supabase recommended; InsForge/Firebase acceptable).
- Users: exactly 3 trusted teammates for now. No public signup — accounts
  are provisioned manually in the provider dashboard. Design so more users
  later is config, not code.
- Data model already exists client-side (see §3). Keep the client the
  source of shape truth; the server stores and syncs it.
- Local mode must keep working forever: `backend-config.js` absent →
  `LocalAdapter` (already implemented). Never break offline/local.
- Social "connections" stay simulated — real platform OAuth is explicitly
  out of scope for this phase.
- **Zero recurring cost (hard constraint):** this phase must run at $0/mo.
  Everything fits Supabase free tier + GitHub Pages. Do not introduce any
  paid service or any additional vendor. The only recurring project cost
  stays the yearly domain renewal (already owned).

## 2. What's already in place (index.html)

- `store` — all persistence flows through one object chosen at boot:
  `window.FABLEPEAK_BACKEND ? RemoteAdapter : LocalAdapter`.
- `RemoteAdapter` — stub with frozen signatures (§4). Fill in the bodies.
- `save()` — debounced (200ms); calls `store.persist(db)`, shows a retry
  toast on failure. `load()` handles init failures gracefully.
- `store.onRemoteChange(cb)` — hook for server-push updates; calling
  `cb(freshDb)` rerenders. Wire realtime/polling into this.
- Settings → "Cloud sync & team accounts" card — shows mode/user, calls
  `cloudSignIn()` (prompt-based; replace with a proper modal if you like,
  keep the function name).
- `backend-config.sample.js` — activation mechanism (copy to
  `backend-config.js` with real keys). `backend-config.js` is the switch.

## 3. Data model (client `db` object)

```js
{
  brands: [{
    id, name, seed,                       // seed: number, drives demo metrics
    connections: {instagram: "@handle", ...},   // subset of 8 network ids
    posts:  [{id, date:"YYYY-MM-DD", time:"HH:MM", text, networks:[...], status:"draft|scheduled|publishing|published"}],
    inbox:  [{id, net, from, resolved, unread, msgs:[{who:"them|me", text}]}],
    smartlink: {title, bio, avatar, color, links:[{id, title, url, clicks}]}
  }],
  activeBrand: "<brand id>"               // per-device preference — do NOT sync
}
```

Suggested normalized schema (Postgres/Supabase):

```sql
create table brands (
  id text primary key,          -- client-generated uid
  name text not null,
  seed int not null,
  connections jsonb not null default '{}',
  smartlink jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create table posts (
  id text primary key,
  brand_id text not null references brands(id) on delete cascade,
  date date not null, time text not null,
  text text not null, networks jsonb not null,
  status text not null check (status in ('draft','scheduled','publishing','published')),
  updated_at timestamptz not null default now()
);
create table inbox_threads (
  id text primary key,
  brand_id text not null references brands(id) on delete cascade,
  net text not null, sender text not null,
  resolved bool not null default false, unread bool not null default true,
  msgs jsonb not null default '[]',
  updated_at timestamptz not null default now()
);
create table brand_members (         -- who can see which brand
  brand_id text references brands(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('owner','editor')),
  primary key (brand_id, user_id)
);
```

RLS: enable on all tables; a user may select/insert/update/delete rows
whose `brand_id` is in their `brand_members`. Creating a brand inserts an
`owner` membership for the creator in the same transaction (use a
`security definer` function or a trigger).

## 4. RemoteAdapter contract (frozen — implement exactly)

```js
RemoteAdapter = {
  name: "cloud",
  user,                          // null | {id, email, name}; set by init (restored session) or signIn
  async init(),                  // create client from window.FABLEPEAK_BACKEND, restore session.
                                 // Resolve even when logged out (load() then returns null → seed/local UX).
  async load(),                  // -> db object (§3) assembled from the user's brands, or null if
                                 // logged out / no brands. Preserve activeBrand from localStorage.
  async persist(db),             // upsert everything changed. Simplest correct approach: diff against
                                 // last-loaded snapshot per entity id; delete server rows missing locally.
                                 // Last-write-wins by updated_at is fine for 3 trusted users.
  async signIn(email, password), // set this.user; reject with useful message.
  async signOut(),               // clear session; app falls back to local seed on next load.
  onRemoteChange(cb),            // subscribe (supabase realtime / 30s poll). On change, rebuild db and cb(db).
                                 // MUST ignore echoes of this client's own writes (track a client id).
}
```

Implementation notes:
- Client SDK via CDN `<script>` in `backend-config.js`-adjacent tag or
  dynamic `import()` inside `init()` — do not add a build step.
- Debounce is client-side already; `persist` may still be called often.
  Batch upserts (one request per table, not per row).
- `activeBrand` stays in localStorage (`fablepeak_pref_activeBrand`).
- Keep localStorage as offline cache in cloud mode: write-through on
  `persist`, serve cached data from `load()` when offline, and reconcile
  (LWW) when back online.

## 5. Migration path for existing local data

On first cloud sign-in, if localStorage `fablepeak_v1` exists and the
user owns zero brands: offer (confirm dialog) to upload local brands to
the server, then keep localStorage as cache. Reuse existing client ids.

## 6. Provisioning (document for the owner in README)

1. Create Supabase project (free tier) → run §3 SQL in the SQL editor.
2. Auth → disable public signups; create the 3 users manually.
3. Copy `backend-config.sample.js` → `backend-config.js`, fill URL +
   anon key, `git push`.
4. Each user signs in from Settings; owner creates brands and adds
   teammates via `brand_members` (a small "share brand" UI is a
   nice-to-have, not required — dashboard inserts are acceptable at n=3).

## 7. Stack decisions (reviewed & locked)

An external architecture report proposed Supabase + Next.js/Vercel +
Upstash QStash + Cloudflare R2. Reviewed 2026-07-12; decisions:

- **Supabase only — one vendor.** Auth, Postgres, RLS, realtime, storage,
  Edge Functions, pg_cron all come with the free tier. Rejected: Next.js
  API routes (forces a build step + rehosting a frontend that is
  deliberately a static file on GitHub Pages) and QStash (a per-minute
  `pg_cron` job polling `posts` for due items replaces the whole vendor
  at this scale). R2 unnecessary until real media uploads exist.
- **Server-side auto-publish:** a pg_cron job calls the `publish` Edge Function
  each minute. PostgreSQL atomically claims due `scheduled` posts as
  `publishing`, using the configured IANA timezone, before the function calls
  platform APIs. Only a confirmed platform delivery may change the post to
  `published`. The client ticker is simulation-only and must never advance a
  signed-in cloud post.
- **Real social posting is a later, separately-priced phase.** Two
  corrections to the report: (1) Supabase social *login* does NOT provide
  publishing-scoped tokens — each platform requires its own developer app,
  publishing scopes, app review, and custom token storage/refresh
  (Supabase does not persist provider tokens). (2) X's API is not free
  (~$200/mo for meaningful posting). When that phase comes, default to a
  posting aggregator (Ayrshare-class, ~$25–150/mo) instead of DIY OAuth
  across platforms — it converts months of integration and review risk
  into a subscription. Any recurring spend is the owner's explicit
  decision, never assumed.
- **Free-tier pause caveat:** Supabase free projects pause after ~7 days
  with zero activity. 3 active users normally prevents this; add a weekly
  keepalive ping via GitHub Actions cron (also free) as insurance.

## 8. Acceptance criteria

- [ ] `backend-config.js` absent → app identical to today (local mode).
- [ ] 3 users sign in; each sees only brands they're members of.
- [ ] Edit on device A (post/inbox/smartlink) appears on device B ≤30s without reload.
- [ ] Offline in cloud mode: app loads from cache, edits queue, sync on reconnect.
- [ ] Existing local data migrates on first sign-in without id changes.
- [ ] No secrets in the repo; only the anon/public key ships.
- [ ] `python3 -m http.server` + `backend-config.js` works (no build step introduced).
