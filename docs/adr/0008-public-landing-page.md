# ADR 0008: A public landing page at "/"

- Status: Accepted
- Date: 2026-09-11

## Context

TikTok App Review has rejected FablePeak twice. The latest reason is explicit:

> Your externally facing website must be fully developed and cannot be a
> landing or login page.

What a reviewer actually saw at `https://fablepeak.com/` is the signed-out
welcome gate built by `showWelcome()` in `js/welcome.js`: a two-column layout
with a short hero and five feature bullets on the left, and a sign-in /
create-account card, with the email field autofocused, front and centre on the
right. Read cold, by someone who has no invite and no account, that is a login
page with marketing decoration. Nothing behind it is reachable, and nothing on
the page explains what the product does beyond five one-line bullets.

Meta's app review and Google's OAuth verification ask a similar question in a
different voice ("a homepage that describes your app"), so this is not a
TikTok-only problem. It is also, independently, what a public invite-only beta
needs: `fablepeak.com` is the only URL we give to a prospective customer, to a
provider's "Website URL" field, and to the policy pages.

The obvious fix — move the app to `/app/` and put a static marketing page at
`/` — is more expensive than it looks. `/` is load-bearing in several places
that are already registered with third parties or shipped to users' devices:

- `manifest.json` has `start_url: "./"` and three shortcuts rooted at `./`;
  installed PWAs keep the old start URL until the manifest is re-fetched.
- `sw.js` is served from the root and therefore has root scope; moving the app
  under a subdirectory changes what it controls and what its precache means.
- The production smoke test, the OAuth redirect (`oauth-complete.html`), the
  recovery link (`#type=recovery` handled by `js/main.js` at the root), the
  SmartLinks public pages and every provider's configured "Website URL" and
  redirect origin all assume the app answers at the root.

None of that is impossible to migrate, but all of it is risk taken on for a
problem that lives entirely in one function's output.

## Decision

Keep the app at `/`. Change only what a **signed-out** visitor is served: the
root becomes a complete marketing page, and the authentication form is not
rendered at all until the visitor asks for it.

### 1. No relocation

The app, the service worker scope, `start_url`, the OAuth and recovery
round trips, SmartLinks and every provider setting stay exactly as they are.
This ADR changes no URL.

### 2. The signed-out root renders a landing page

`showWelcome()` now fills `#welcome` with a full marketing page, in this order:

1. a nav bar — brand mark, "Sign in", "Get started";
2. a hero — headline, one-paragraph value proposition, primary CTA
   "Get started", secondary "Explore the demo", and the line "Invite-only beta";
3. "What you can do" — an eight-card feature grid (planner, multi-network
   publishing to Facebook Pages / Instagram / YouTube / TikTok, hashtag groups
   and per-network variants, approvals, one inbox, analytics, SmartLinks,
   PWA install and offline);
4. "How it works" — three steps: connect accounts, plan and compose, publish
   or schedule with per-network delivery results;
5. "Built for small brands and teams" — owner/editor roles and the approval
   workflow;
6. "Privacy by design" — least-privilege scopes, tokens encrypted server-side
   and never exposed to the browser, disconnect or delete at any time, with
   links to `privacy.html`, `terms.html` and `data-deletion.html`;
7. "Join the invite-only beta" — a Get started CTA and
   `fablepeak@techpolity.com`;
8. a footer — brand, © Techpolity, policy links.

The copy is true as written. FablePeak is in invite-only beta, so there are no
prices, no testimonials, no customer logos and no usage numbers on the page:
we have none that are real, and a review team that catches an invented one
costs us more than the third rejection would.

### 3. The auth card is revealed, not rendered

The existing `.wcard` markup is unchanged apart from a close button. It is
produced by `authPanel()`, which returns the empty string unless the
module-local `authOpen` flag is set, and is shown as a modal-style overlay over
the landing page. `showAuth(mode)` sets the flag and the tab; `closeAuth()`
clears it; `hideWelcome()` clears it too, so leaving the gate never leaves the
panel latched open. Consequently `#w_email`, `#w_pw`, `#w_err` and
`button.wsubmit` **do not exist in the signed-out DOM** until a click, and the
email field is autofocused only when the panel is open on a wide viewport.

### 4. Everything else about the gate is untouched

`wTab`, `wSubmit`, `requestPasswordReset`, `showPasswordReset`,
`completePasswordReset`, `togglePassword` (the `.pwwrap` reveal), `enterDemo`
and `exitDemo` keep their existing behaviour and their existing ids. The
password-recovery screen still replaces `#welcome` wholesale with its own
`.wwrap` / `.wcard`, so a recovery link never lands on the marketing page.
Signed-in users and demo mode see exactly what they saw before.

### 5. No new assets, no new stylesheet

The page reuses the existing `:root` tokens, `.btn` / `.btn.ghost` and the
`.wlogo-mark` CSS-background brand mark. It adds no `<img>` element (the app
DOM is asserted to contain none, `test/behaviour/hostile-input.test.mjs`), no
font, no script and no network request — the gate must still make zero requests
when signed out. Styles live in the same inline `<style>` block in
`index.html`; the old `.whero` / `.wfeat` / `.wwrap` hero rules are replaced,
with `.wwrap` and `.wsmall` kept for the recovery screen that still uses them.

### 6. Semantics and metadata

`#welcome` renders `<header>`, `<section>` elements with real `<h1>`/`<h2>`/
`<h3>` headings, and `<footer>`. It deliberately does not render a second
`<main>`: the app's own `<main id="main">` is still in the document (emptied
and `inert`) behind the gate, and two `main` elements would be invalid.
`<meta name="description">` and `og:description` in `index.html` are rewritten
to describe the product a reviewer will now actually see.

### 7. Version bump

`APP_VERSION` in `js/constants.js` and `CACHE` in `sw.js` go to `1.6.5`
together, per the house rule for any precached `js/` or `index.html` change.

## Consequences

- A reviewer, a prospective customer or a crawler landing on `fablepeak.com`
  gets a page that describes the product, with the sign-in form one deliberate
  click away. That is the thing TikTok asked for, and it is what Meta and
  Google ask for in their own words.
- One extra click stands between a returning user and the sign-in form. This
  is the real cost of the decision. It is mitigated by two entry points in the
  nav, a third in the hero, a fourth in the beta section, and by the fact that
  a returning signed-in user never sees the gate at all — the session restores
  and `hideWelcome()` runs.
- The signed-out DOM no longer contains the auth form. Any test, bookmarklet
  or automation that filled `#w_email` on load must click "Sign in" first;
  `test-harness/app.mjs` now does this in its `signIn()` helper, which is the
  single place every cloud-mode behavioural test goes through.
- The page is markup in a template literal, not a static HTML file, so it is
  invisible to a crawler that does not run JavaScript. Acceptable for now:
  app review teams and modern crawlers render. If SEO or a stricter reviewer
  demands it, the same copy can be pre-rendered into `index.html` and hidden
  once the app boots, without changing any decision above.
- No URL, redirect, scope or provider setting changed, so nothing has to be
  re-verified with Meta, Google or TikTok beyond resubmitting the review.

## Decisions (2026-09-11)

1. Do not relocate the app; change only the signed-out rendering. (§1)
2. Render the full marketing page from `showWelcome()`. (§2)
3. Hide the auth card behind an explicit reveal. (§3)
4. Preserve every existing welcome, demo and recovery flow and id. (§4)
5. Reuse the existing design tokens and add no external asset or `<img>`. (§5)
6. Use real semantic sectioning without a second `<main>`; refresh the
   description and Open Graph metadata. (§6)
7. Bump `APP_VERSION` and the service-worker `CACHE` to `1.6.5`. (§7)
