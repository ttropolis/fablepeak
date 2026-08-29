# ADR 0004: Public SmartLinks pages

- Status: accepted with amendments — see "Decisions (2026-08-29)". Backend
  implemented in `supabase/migrations/20260829090000_public_smartlinks.sql`
  (slug columns and alias retention, `set_smartlink_slug`, `get_smartlink`,
  `smartlink_clicks` + `record_smartlink_click`, `smartlink_click_totals`,
  90-day purge); the public renderer and editor UI are still outstanding.
- Date: 2026-08-28

## Context

SmartLinks (`renderSmartlinks`, index.html ~L1660) is a preview-only builder.
The page data lives in `brands.smartlink` jsonb (title, bio, avatar emoji,
color, `links[{id,title,url,clicks}]`). Nothing is reachable by a visitor:
there is no public route, and `slClick()` increments a number in the same
jsonb the editor owns, so "clicks" is a counter the operator moves by hand.

Constraints that shape every option below:

- Hosting is GitHub Pages on the apex `fablepeak.com` (CNAME). Static files
  only: no rewrites, no response headers, no SSR. `404.html` currently
  meta-refreshes everything to `/`.
- The backend is Supabase. `backend-config.js` ships the project URL and a
  publishable anon key to every browser and is loaded as a relative
  `<script src="backend-config.js">`; its absence means local-only mode.
- Every table is RLS-gated behind `is_member(brand_id)` for `authenticated`.
  There is currently no `anon` grant anywhere.
- Edge Functions exist and are routinely deployed with `verify_jwt = false`
  (`data-deletion`, `oauth-start`), using service-role access in `_shared/db.ts`.
- ADR 0001 keeps FablePeak invite-only. A public page is the first surface
  that serves unauthenticated strangers, so it is also the first surface where
  one tenant's authored content is rendered to the public internet.

## Decision

### 1. URL shape — static page at `https://fablepeak.com/l/?b=<slug>`

- **Chosen: a static `l/index.html` on GitHub Pages, slug in the query
  string.** `/l/` resolves to `l/index.html` with a real `200`, works on the
  custom domain, costs nothing per view, and is CDN-cached. The page reads
  `?b=`, calls Supabase, and renders client-side.
- Rejected: `/l/<slug>` via the `404.html` fallback. GitHub Pages serves the
  fallback with an actual `404` status, which social crawlers and uptime checks
  treat as broken, and it would require rewriting `404.html` (which today
  redirects to `/`, destroying any path route).
- Rejected: serving the HTML from an Edge Function. It buys real response
  headers (`Content-Security-Policy`, `frame-ancestors`, per-page OG tags) and
  SSR previews, but the URL is `…supabase.co/functions/v1/…` unless we buy the
  Supabase custom-domain add-on, and every page view becomes a billed
  invocation with a cold start. Not worth it before demand exists.
- Accepted: CSP must be a `<meta http-equiv>` tag, so `frame-ancestors` cannot
  be set, and social previews show generic FablePeak OG tags, not per-brand
  ones. Both are v2 problems.
- Implementation notes: load `/backend-config.js` root-absolute (relative
  resolution from `/l/` would 404); do not import supabase-js — use plain
  `fetch` against PostgREST, matching `_shared/db.ts` reasoning; and scope the
  service worker's navigate fallback so an offline visit to `/l/` does not
  serve the logged-in app shell.

### 2. Data path — a security-definer RPC, not a view, not a function

- **Chosen: `public.get_smartlink(p_slug text) returns jsonb`, security
  definer, `grant execute to anon`,** called as
  `POST /rest/v1/rpc/get_smartlink`. Zero marginal cost, one round trip,
  same anon key already public.
- Rejected: an `anon`-readable `smartlink_public` view (the pattern used by
  `social_accounts_public`). It works, but PostgREST would let anyone list
  *every* published page with one unfiltered `select=*`. An exact-match RPC
  gives the same data with no enumeration surface.
- Rejected: an Edge Function read endpoint. Same data, but a billed invocation
  and a cold start per page view, for no capability the RPC lacks.
- The RPC returns only presentation fields (`slug, title, bio, avatar, color,
  links[{id,title,url}]`) and **not** `brand_id`, so the public page never
  learns the key that RLS is keyed on.
- Slug storage: two new columns on `brands` — `smartlink_slug text` with a
  `unique index on lower(smartlink_slug)`, and `smartlink_public boolean not
  null default false`. Slug lives in a column, not inside the jsonb, so that
  uniqueness is a real constraint and a collision cannot fail the whole
  `save_brand` upsert.
- Slug rules: one slug per brand, globally unique because the URL space is
  global; `^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$`; case-folded on claim; a
  reserved-word denylist (`l, api, app, www, admin, static, assets, oauth,
  privacy, terms, functions, data-deletion`).
- Claiming goes through `claim_smartlink_slug(p_brand, p_slug)`, security
  definer, gated on `is_member(p_brand)`, mapping a unique violation to a
  "that name is taken" result rather than an error toast.
- Rename: the old slug is released immediately and the old URL 404s. No
  redirect table in v1. Click history survives because click rows carry
  `brand_id` as well as the slug that was live at the time.

### 3. Real click tracking

Table, deliberately PII-free (see privacy.html — no IP, no user agent, no
cookie, no device identifier, no visitor id):

```
smartlink_clicks(
  id bigint identity pk,
  brand_id text not null references brands(id) on delete cascade,
  slug text not null,            -- slug live at click time
  link_id text not null,         -- stable jsonb link id
  position smallint,             -- order snapshot, for reporting only
  clicked_at timestamptz not null default now(),
  referrer_host text             -- registrable host only, or null
)
```

`link_id` rather than a bare index: reordering or inserting a link would
silently re-attribute every historical row keyed by index. `position` is kept
alongside as a denormalized snapshot.

- **Write path: `record_smartlink_click(p_slug, p_link_id, p_referrer)`,
  security definer, `grant execute to anon`; `revoke all on smartlink_clicks
  from anon`.** The RPC resolves `brand_id` from the slug, refuses unpublished
  slugs, refuses a `link_id` not present in that brand's jsonb, and reduces the
  referrer to a lowercase hostname (regex-validated, 100 chars max, everything
  else dropped) so no path or query string is ever stored.
- Rejected: a direct `anon` INSERT policy. It would let anyone write arbitrary
  `brand_id`, `clicked_at` and referrer values into the table.
- Rejected: an Edge Function. Its one genuine advantage is rate-limiting on
  request IP without persisting it, but at a billed invocation per click.
  Revisit if abuse actually appears.
- The page fires the RPC with `navigator.sendBeacon` and navigates regardless
  of the result — tracking must never delay or block a link.
- Abuse: the RPC applies a per-slug ceiling (drop inserts once a slug exceeds
  ~600 clicks in the trailing minute) and raw rows are deleted after 90 days by
  a scheduled job, with aggregates retained. Because our privacy rule forbids
  IP or fingerprint dedupe, counts are approximate by construction and must be
  labelled as such in the UI.
- Surfacing back into the editor: RLS on `smartlink_clicks` with a single
  `select to authenticated using (is_member(brand_id))` policy, plus an
  invoker-security view `smartlink_click_totals(brand_id, link_id, total,
  last_7d)`. The editor reads that view and stops rendering the jsonb `clicks`
  field, which becomes a legacy value used only by local/demo mode.

### 4. Privacy and security

- Public once a brand opts in: slug, title, bio, avatar emoji, button color,
  link titles, link URLs and their order. Never public: brand id, member list,
  emails, connections, posts, inbox, metrics. Publishing is opt-in per brand
  and defaults off; existing brands stay private until an owner toggles them.
- XSS is the main risk, and it is cross-tenant: the public page renders text
  authored by one tenant to every visitor. The renderer must build DOM nodes
  with `textContent` — no `innerHTML`, no reuse of the app's template-string
  style — and must not trust the jsonb, which the DB will happily hold in any
  shape the editor never produced: allow only `http:`/`https:` URLs (reject
  `javascript:`, `data:`, `vbscript:`), validate color against
  `^#[0-9a-f]{6}$` before it reaches a style attribute (the in-app preview
  interpolates `sl.color` into `style="background:${sl.color}"` unescaped
  today), cap avatar length, cap link count and field lengths.
- Outbound links get `rel="noopener noreferrer nofollow ugc"` and
  `referrerpolicy="no-referrer"`, so a visitor's SmartLink URL is not leaked
  to the destination site.
- Strict meta CSP: `default-src 'none'; script-src 'self'; style-src
  'unsafe-inline'; img-src 'self' data:; connect-src <project>.supabase.co;
  base-uri 'none'; form-action 'none'`.
- Residual risk to weigh: `/l/` is the same origin as the app, so a DOM-XSS
  hole there could read a signed-in user's Supabase session from
  `localStorage`. A separate `links.fablepeak.com` origin removes that class
  entirely at the cost of a second Pages site. v1 recommendation is same-origin
  with the rendering discipline above; see decision 3.
- privacy.html additions: a "Public SmartLinks pages" section stating that
  publishing is opt-in and operator-controlled, listing exactly what becomes
  world-readable, stating that clicks are counted without IP addresses,
  cookies or device identifiers, that only a coarse referrer hostname is
  stored, that raw click records are deleted after 90 days, that unpublishing
  removes public access, and that link destinations are third-party sites
  governed by their own policies. "Information we collect" also gains
  aggregate SmartLink click counts.

### 5. Out of scope for v1

- Themes, fonts and custom CSS — one hard-coded layout.
- QR codes for a SmartLink page.
- Per-brand custom domains.
- Analytics charts and time series — the editor shows totals and 7-day counts only.
- Per-link scheduling, expiry and A/B variants.
- Per-page OG images and SSR link previews — blocked by the static-hosting choice.
- Email capture, forms or any visitor input on the public page.
- UTM builder and outbound tagging.

### 6. Effort

| Component | Size |
| --- | --- |
| `l/index.html` public renderer (fetch, safe DOM build, CSP, empty/404 states) | M |
| Slug + publish columns, `claim_smartlink_slug`, validation, denylist | S |
| `get_smartlink` RPC and anon grant | S |
| `smartlink_clicks` table, `record_smartlink_click`, rate cap, retention job | M |
| `smartlink_click_totals` view and RLS policy | S |
| Editor UI: slug field, publish toggle, copy-link, real counts replacing jsonb | M |
| privacy.html section, README, sw.js navigate-fallback scoping | S |

Overall: M/L — roughly one focused week including acceptance evidence.

## Consequences

- FablePeak gains its first unauthenticated public surface, so the anon role
  gains its first grants. Every future anon grant must be reviewed against
  this ADR.
- Click counts become real but approximate, and the UI must say so.
- Reported click history is continuous across slug renames but the old URL
  breaks immediately; support will field "my link stopped working" tickets.
- ADR 0001's invite-only posture still holds for accounts; published SmartLink
  pages are readable by anyone who has the URL, by design.

## Decisions required

1. Ship public SmartLinks during the invite-only beta at all? yes/no
2. Canonical URL `https://fablepeak.com/l/?b=<slug>` on GitHub Pages, with no Edge-Function-served HTML? yes/no
3. Same origin as the app for v1, accepting the session-theft blast radius of a DOM-XSS bug, rather than a separate `links.fablepeak.com` Pages site? yes/no
4. Publishing opt-in per brand, defaulting off? yes/no
5. Global slug namespace, one slug per brand, `[a-z0-9-]` 2–30 chars, reserved-word denylist? yes/no
6. Rename releases the old slug immediately with no redirect, so the old URL 404s? yes/no
7. Public reads through a security-definer `get_smartlink(slug)` RPC (exact match, no enumeration) rather than an anon-readable view? yes/no
8. Click writes through an anon `record_smartlink_click` RPC rather than an Edge Function? yes/no
9. Accept approximate counts — no IP, no cookies, no fingerprint, only a per-slug per-minute ceiling? yes/no
10. Raw click rows deleted after 90 days, aggregates retained indefinitely? yes/no
11. Editor shows real aggregates and stops using the jsonb `clicks` field (local/demo mode keeps its fake numbers)? yes/no
12. privacy.html updated and deployed before the first page can be published? yes/no

## Decisions (2026-08-29)

Answers to "Decisions required", in order. Where an answer amends the body
above, the amendment governs; the body text is left as written for the record.

1. **Yes, gated.** Ship public SmartLinks during the invite-only beta, but
   initially only for internal brands or an allowlisted customer. Security tests
   and a controlled publish/unpublish acceptance run are prerequisites.
2. **No — amend.** Keep the static-page architecture with no Edge-Function-served
   HTML, but the canonical URL becomes `https://links.fablepeak.com/?b=<slug>`,
   *not* the authenticated app's origin. *Amends decision 1 of the body*
   (`https://fablepeak.com/l/?b=<slug>`) and its implementation notes, which
   assume a `/l/` path on the app origin. Generic social metadata remains
   acceptable for v1.
3. **No.** Reject same origin. Public pages live on `links.fablepeak.com` from
   the outset. *Amends the "Residual risk to weigh" paragraph in decision 4 of
   the body,* which recommended same-origin for v1: public, anonymously rendered
   content is a natural security boundary, and it is far harder to retrofit than
   to establish now.
4. **Yes.** Publishing is explicit and off by default per brand. Unpublishing
   takes effect immediately.
5. **Yes, with small changes.** One globally unique slug per brand, lowercase
   normalization. *Amends the slug rules in decision 2 of the body:* minimum
   length is **three** characters (not two), consecutive hyphens are rejected,
   and the reserved list is broadened to also include `login`, `signup`,
   `support`, `help`, `legal`, `security`, `status` and `.well-known`.
6. **No.** Never release an old slug immediately — another customer could take
   over links already distributed in the wild. *Amends the "Rename" bullet in
   decision 2 of the body and the corresponding consequence:* an old slug is
   retained as an alias for the brand's lifetime, or at minimum reserved through
   a substantial cooldown and never assigned to another active brand.
7. **Yes.** Public reads go through an exact-match security-definer RPC. Every
   reference inside it is schema-qualified, `search_path` is restricted, default
   execution is revoked, and execute is granted only to the intended roles.
8. **Yes for v1.** An anon `record_smartlink_click` RPC is proportionate at beta
   scale. *Amends the click-firing note in decision 3 of the body:* use
   `fetch(..., { keepalive: true })`, **not** `navigator.sendBeacon` — sendBeacon
   cannot reliably attach Supabase auth headers. Move the write path behind an
   Edge Function if abuse or a need for sophisticated filtering appears.
9. **Yes.** Privacy-first analytics: approximate counts, with no IP addresses,
   cookies, fingerprinting or persistent identifiers. Counts must be labelled as
   approximate in the UI.
10. **No — amend.** 90 days for raw click rows is fine, but aggregates are *not*
    retained indefinitely. *Amends the retention bullet in decision 3 of the
    body:* aggregates are retained while the brand exists, then deleted within a
    documented deletion window.
11. **Yes.** Cloud mode uses real aggregates and stops treating
    `brands.smartlink.clicks` as authoritative. Demo/local mode keeps clearly
    identified simulated data.
12. **Yes.** The privacy notice update is a release prerequisite, landing and
    deploying before the first publish toggle is available.

**Closing note.** The two most important amendments are the separate origin
(decisions 2 and 3) and the slug-retention rule (decision 6). Same-origin XSS
could expose an authenticated user's Supabase session; immediate slug reuse
could let a different customer inherit traffic from links already in the wild.
