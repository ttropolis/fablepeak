# ADR 0003: Frontend behavioural test harness before any file split

- Status: accepted with amendments — see "Decisions (2026-08-29)"
- Date: 2026-08-28

## Context

`index.html` is ~2,100 lines: one classic `<script>` (line 277) holding all
application JavaScript in global scope, plus all CSS, plus all markup. State is
a single mutable `db` object; every mutation calls `save(); render()`, and
`render()` rebuilds the whole view with `innerHTML`. There are 50 `onclick`, 14
`onchange`, 4 drag and 4 `onkeydown` inline attributes, and 305 template
interpolations guarded by 45 hand-placed `esc()` calls.

`test/` holds 63 tests across three Node files, overwhelmingly `assert.match`
against source text. The subset that does execute code extracts a function with
a regex anchored on its *neighbouring function name* — for example
`/(function deliveryPanel\(p\)\{[\s\S]*?\n\})\nfunction postVisibleStatus/` —
and runs it under `vm.runInNewContext` with hand-built globals. There is no DOM
harness, no browser automation, no bundler, and deliberately no build step.

The runbook requires human approval before any frontend split. This is that
approval request.

## Current-state risk assessment

**Escaping is correct today but structurally undefendable.** `esc()` (line 969)
does HTML-entity replacement only. It is applied per call site, by hand, 45
times. Three concrete gaps:

1. `renderSmartlinks` interpolates `${sl.color}` unescaped into
   `style="background:${sl.color}"` and `value="${sl.color}"` (lines 1671, 1689).
   The colour picker cannot produce a hostile value; `importData` can.
2. 21 sites interpolate a record id into JavaScript-in-attribute position —
   `onclick="openMsg('${c.id}')"`, `ondragstart="dragPost(event,'${p.id}')"`,
   `onclick="slDel('${l.id}')"`. `esc()` is not applied and would be the wrong
   escaper if it were: this is JS string context, not HTML text context.
3. `importData` (line 2039) assigns `db = d` after checking only that
   `d.brands` is an array. No field is validated. Settings → *Import backup* is
   therefore a first-class untrusted input path feeding 1 and 2, and it reaches
   Supabase on the next `persistNow()`.

`renderInbox`, `renderConnections` and `renderReports` do escape the fields that
matter (`c.from`, message text, `display_name`, `last_error`, `p.text`). The
risk is not that today's code is wrong; it is that correctness rests on a
reviewer noticing a missing `esc()` in a 2,100-line file, and nothing in CI
would catch the omission.

**Which tests break on any refactor.** Every regex-extraction test in
`scheduling.test.mjs` — `tickPublish` (16), `deliveryPanel` (95),
`postVisibleStatus`/`postStatusFromResults` (122), `refreshConnections` (163),
`RemoteAdapter._rowsToDb` (178), `realMetricSeries` (195), `dropPost` (245),
`validatePostForm` (271), `publishNow` (313), the `online` listener (350). Each
anchor names the function that must physically follow it in the file. Reordering
two functions, or moving either into a module, fails the suite without any
behaviour changing. In `production-readiness.test.mjs`, the markup assertions
(235, 251, 349, 386) break on any change to rendered HTML — including the
`data-action` attributes this plan needs to add.

Net: the suite pins *file layout*, not behaviour. It is precisely inverted from
what a split requires.

## Decision

Build a behavioural harness first, prove the 12 flows below, then split. No
product code changes until Phase 1 is green.

### Phase 1 — behavioural test harness

**Stack: Node's built-in test runner plus jsdom as the primary harness, with a
narrow second-tier Playwright job for the four things jsdom cannot honestly
cover.**

jsdom is the right primary because it preserves what matters: `npm test` stays
one command, the existing 5-minute CI `check` job absorbs it with no new
service, and a devDependency is not a build step — nothing is compiled and
`index.html` still ships exactly as authored. Playwright alone would be more
faithful but adds a browser download to every PR and would tempt the suite
toward slow end-to-end tests for logic that is pure string building.

jsdom genuinely cannot cover four things: HTML5 drag-and-drop `DataTransfer`,
the service worker and PWA offline path, real focus/tab-order, and whether the
app loads over `file://`. Those get a separate CI job, not the main one.

**Loading `index.html` without a server.** Read the file from disk and hand it
to jsdom with a `ResourceLoader` subclass that resolves same-origin paths
(`backend-config.js`, `sw.js`) to repo files, so nothing hits the network:

- `new JSDOM(html, { runScripts: "dangerously", resources: repoLoader, url:
  "https://fablepeak.com/", pretendToBeVisual: true, beforeParse })`.
- `beforeParse` installs the stubs jsdom lacks or refuses: `matchMedia`
  (line 231 of the readiness test proves the app depends on it), `confirm`,
  `prompt`, `alert`, `crypto.randomUUID`, `print`, and a `fetch` fake standing
  in for Supabase.
- Demo/local mode reaches no network at all — the two `await import(...)` calls
  to esm.sh (lines 406, 569) are on the cloud path only. Cloud-mode tests inject
  a fake `store` rather than importing the real SDK.
- One `test/helpers/app.mjs` exposes `bootApp({ mode, seed })` returning
  `{ window, document, db, click, type, flush }`. Tests never touch jsdom
  directly.

**The 12 flows to cover.**

1. **Auth gating** — signed-out cloud mode shows the welcome gate with `aside`,
   `main` and `nav` inert *and emptied*; entering demo renders the planner.
2. **Onboarding** — zero brands renders the create-brand form rather than
   throwing inside `render()`.
3. **Compose and schedule** — open the day modal, enter text, pick networks,
   save; the chip appears on the right day with the right status. Invalid media
   URLs (watch page, `http://`, LinkedIn video, Pinterest video) are each
   rejected with their specific toast.
4. **Drag reschedule** — a draft moves to the dropped day; a live published post
   refuses and toasts "can't be rescheduled" (Playwright tier for real DnD, a
   synthetic `DataTransfer` in jsdom).
5. **Delivery panel** — retryable targets offer retry, `unknown` outcomes offer
   verification and no retry button, mixed permanent failures surface as
   `failed` in the planner.
6. **Connect / disconnect rendering** — per-platform cards render correctly for
   connected, needs-reauth, error, available and pending states; action buttons
   call the store with the right account id.
7. **Connection refresh fan-out** — after accounts load or disconnect, the
   connections, planner, analytics and reports views all reflect it.
8. **Inbox** — filter tabs, opening a message clears unread, reply appends to
   the thread, resolve removes it from the default filter.
9. **SmartLinks** — add, rename, reorder, delete a link; click tracking
   increments; the phone preview matches the editor.
10. **Settings backup round-trip** — export then import restores an equivalent
    `db`; a malformed file toasts "Invalid backup file" and leaves `db` intact.
11. **Hostile-input containment** — `"><img src=x onerror=…>` and `');alert(1)//`
    in brand name, post text, inbox sender and body, smartlink
    title/url/colour, and connection `display_name`/`last_error` survive a full
    render with zero script executions, asserted by a counter on the jsdom
    window. This is the test that makes the escaping refactor safe.
12. **Modal keyboard contract** — Escape closes, Tab is trapped, focus returns
    to the opener.

### Phase 2 — split without a bundler

**2a, still one file: eliminate inline handlers and make escaping the default.**

Inline handlers are not a style problem, they are a hard blocker: an inline
`onclick="go('planner')"` resolves against the global scope, and module scope is
not global. The instant `go` moves into a module, all 68 inline attributes break
at once. So they go first, while everything is still in one file and fully
covered by Phase 1.

- One delegated `click`/`change`/`drag` listener per mount root. Elements carry
  `data-action="openPost"` and `data-id`; an action registry maps names to
  functions. Record ids stop entering JavaScript-in-attribute position entirely,
  which retires risk 2 above by construction rather than by discipline.
- An `html` tagged template that escapes every `${}` by default, with explicit
  `raw()` for pre-built fragments, `attr()` for attribute values and `url()` for
  scheme-checked hrefs and image sources. Migrate one renderer at a time; each
  migration is independently verifiable against flow 11.
- Validate `importData` against a schema instead of a single `Array.isArray`.

**2b: move to native ES modules.** `<script type="module" src="./app/main.js">`.
GitHub Pages serves `.js` with the correct MIME type, so no bundler is needed
and HTTP/2 makes ~15 small modules a non-issue. Proposed graph: `core/db.js`,
`core/local-store.js`, `core/remote-store.js`, `core/html.js`, `core/actions.js`,
`ui/{nav,planner,analytics,inbox,smartlinks,reports,connections,settings,modal}.js`,
`main.js`. CSS extracts to `app.css` via `<link>` — that half works everywhere,
`file://` included, and can land independently.

**The `file://` decision belongs to a human.** README promises "double-click
`index.html` — same app, no internet needed". Module scripts are blocked by CORS
on `file://` origins in Chrome, Firefox and Safari, so 2b ends that promise.
Options: retire it and point offline users at the installed PWA (which already
works offline via `sw.js` and covers the case better), or keep it by generating
a concatenated single file — which is a build step, and would end the
"no build step" claim instead. This plan recommends retiring `file://`, but does
not assume the answer.

### Phase 3 — retiring text-assertion tests

**Convert to behavioural.** All ten regex-extraction tests in
`scheduling.test.mjs` become plain `import`s of a module plus real assertions;
their anchors are already the most fragile thing in the repo. In
`production-readiness.test.mjs`, the markup assertions (235, 251, 349) and the
cloud-startup gate (386) become flows 1, 6, 5 and 3. The
`doesNotMatch(html, /<div class="\${cls}" onclick="openPostModal/)` guard at 244
becomes obsolete once delegation lands and should be deleted, not migrated.

**Stay as source-text checks by design.** These assert the *absence* of a change
or *consistency across files* — no runtime state can express them, and their
entire value is failing loudly when someone flips a boolean:

- Provider-freeze gates: `productionEnabled: false` for X, LinkedIn, TikTok and
  Pinterest, and the assertion that ADR 0001's freeze sentence still exists
  (265, 279, 293).
- Deployment configuration parity: `verify_jwt` per function, scope checklist
  vs. `platforms.ts`, CI workflow contents, `package.json` script wiring
  (94, 120, 130, 164, 376).
- Review-surface hygiene: privacy/terms/deletion pages contain no `TODO`, and
  the smoke script sends no `Authorization` header (8, 21, 364).
- PWA release coupling: `APP_VERSION` matches the `sw.js` cache name, SDK pin
  (377, 397).

Every Edge Function and migration assertion is out of scope — server-side code
is untouched by this plan.

Expect roughly 30 source-text checks and 35-40 behavioural tests afterwards. The
test count is not the metric; the 12 flows are.

## Sequencing, effort and rollback

| Phase | Scope | Effort | Rollback |
|---|---|---|---|
| 1a | jsdom harness + 12 flows | M | Delete `test/behaviour/` and the devDependency. No product code touched. |
| 1b | Playwright job: DnD, PWA, focus, `file://` | S | Delete the CI job. |
| 2a | Delegation + `html` templating, single file | L | One revert commit. Phase 1 must be green before and after; this is the only phase where a silent regression is plausible. |
| 2b | Module split + `app.css` | M | Revert. Moves only — no logic changes permitted in this phase. |
| 3 | Test conversion | M | Must land in the same PR as 2b: 2b invalidates every regex anchor at once. |

Phases 1a → 2a → 2b are strictly ordered. 1b and 3 can run in parallel with
their predecessor. Total: roughly four to six weeks of one person, producing no
user-visible change.

## Open questions — human decisions required

1. Add jsdom as this repo's first frontend devDependency, ending the
   zero-dependency `npm test`? **yes / no**
2. Add a second CI job that downloads a Playwright Chromium binary, kept
   separate from the 5-minute `check` job? **yes / no**
3. Retire the README's `file://` double-click promise in favour of the installed
   PWA, accepting that a bare local open will no longer run the app? **yes / no**
4. If no to 3 — accept a concatenation step producing a single-file artifact,
   and therefore the end of the literal "no build step" claim? **yes / no**
5. May Phase 2a change rendered DOM structure (adding `data-action` attributes),
   given the current tests assert exact markup? **yes / no**
6. Freeze feature work on `index.html` for the duration of Phases 2a and 2b to
   avoid merge conflicts across a 2,100-line rewrite? **yes / no**
7. May this work proceed before ADR 0001's Meta App Review gate closes, rather
   than waiting for the beta acceptance evidence to be recorded? **yes / no**
8. Is four to six weeks with no user-visible output an acceptable trade at this
   milestone? **yes / no**

## Deliberately not included

- **No framework (React, Vue, Svelte)** — each needs a build step or ships a
  runtime; solves a problem this app does not have.
- **No frontend TypeScript** — requires compilation; Edge Functions already get
  Deno type-checking where the payoff is real.
- **No bundler or minifier** — reintroduces the build step this ADR avoids.
- **No change to the render model** — full-page `innerHTML` per state change is
  slow but correct; replacing it is a separate decision with its own risks.
- **No CSS framework or preprocessor** — the CSS extracts unaided.
- **No state-management library** — mutable `db` is not the current bottleneck.
- **No visual-regression or screenshot testing** — high maintenance, low signal.
- **No coverage threshold gate** — rewards test count over the 12 named flows.
- **No changes to Edge Functions, migrations, or the Deno suite** — server-side,
  unaffected by a frontend split.

## Consequences

- Until Phase 1 lands, any `index.html` refactor is unverified: the suite
  confirms text has not moved, not that the app still works.
- Phase 2a is the highest-risk phase and the only one where Phase 1 coverage is
  load-bearing rather than convenient.
- Phase 2b forces a product decision about `file://` offline use; it cannot be
  deferred past that point.
- The provider-freeze and configuration assertions from ADR 0001 survive
  unchanged. Nothing here weakens a release gate.

## Decisions (2026-08-29)

Answers to "Open questions — human decisions required", in order. Where an
answer amends the body above, the amendment governs; the body text is left as
written for the record.

1. **Yes.** Add jsdom as a devDependency. The zero-dependency `npm test` ends
   here, deliberately.
2. **Yes.** A separate, narrow Playwright Chromium CI job, kept out of the fast
   unit suite. Its scope is drag-and-drop, PWA/service-worker, keyboard/focus
   and offline behaviour — nothing that jsdom can honestly cover belongs in it.
3. **Yes.** Retire direct `file://` execution, but only after installed-PWA
   offline behaviour has been proven. Replace the README promise with a
   documented, simple local HTTP development path.
4. **Not applicable — no.** Question 4 was conditional on a "no" to 3. There
   will be no concatenation build: `file://` is being retired, and adding build
   machinery to prop up a weak distribution mode is not worth the cost. The
   "no build step" claim survives.
5. **Yes.** Phase 2a may change rendered DOM structure, including `data-action`
   and related markup. Tests protect behaviour and accessibility contracts, not
   incidental HTML structure; markup assertions that only pin structure are
   expected to be rewritten or deleted.
6. **Yes, time-boxed.** The freeze covers `index.html` feature changes only, and
   only while a given 2a/2b migration batch is actually underway. Urgent fixes
   are always allowed. *Amends the sequencing section:* the freeze attaches to
   individual batches, not to the whole of Phases 2a and 2b, precisely to avoid
   one enormous long-lived refactoring branch.
7. **Yes.** This work may proceed before ADR 0001's Meta App Review gate closes.
   It is independent of Meta's human acceptance process.
8. **No as phrased — approved, but not as a single 4–6-week delivery.**
   *Amends "Sequencing, effort and rollback":* the work lands as small verified
   increments with a release point after Phase 2a, in this sequence:
   1. land the behavioural harness;
   2. add the browser-only acceptance tier;
   3. eliminate inline handlers and secure rendering plus import validation;
   4. **pause and release useful product work, including SmartLinks (ADR 0004);**
   5. complete the physical ES-module split and the legacy-test conversion
      afterwards.

   Rationale: tests and production callers cross the same seam, so the safety
   work must come first — but the refactor must not turn into a long beta delay.
   The "roughly four to six weeks of one person, producing no user-visible
   change" line in the sequencing section no longer describes the plan of record.
