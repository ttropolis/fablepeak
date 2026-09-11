# GBP verification contingency — Techpolity profile

- Date: 2026-09-11
- Owner: release owner (the release owner's Google account (the one that owns the Techpolity profile))
- Governs: ADR 0007 decision 3 — "Application for Basic API Access" needs a
  **verified** Business Profile, owned by the applying organisation, at least
  60 days old. Nothing in ADR 0007's accepted decisions changes here.

## State of play

| Fact | Value |
|---|---|
| Profile | Techpolity, location id `01090885182245385978` |
| Created | 2026-09-01 (60-day clock matures ~2026-10-31) |
| Account | the release owner's Google account (the one that owns the Techpolity profile) |
| Type | Online / service-area business, service area Australia |
| Website | techpolity.com |
| Address | Registered address is residential; **no public address on the profile** |
| Verification | **Failed twice** — video verification, Google emails 2026-09-04 and 2026-09-11 |
| Methods offered | **"Submit a Business Video" only** — no live call, no postcard, no phone |
| Other profile | "TTropolis", id `14656449094685243305`, same Google account, **Verified** |

Google's two failed items, verbatim in substance:

1. **No view of surrounding area** — "show street signs, neighboring
   businesses or recognizable landmarks".
2. **Business name not shown on legitimate assets** — "show it printed on a
   business card, branded vehicle or business license".

The **authorisation item passed** both times. So attempt 3 must not re-litigate
authorisation; it must add *location evidence* and *name-on-asset evidence*
while keeping the authorisation proof that already worked.

## (i) Attempt 3 — re-shoot plan, mapped to the rubric

Constraints: one continuous take, **live capture only** (no photos, no screen
recording, no edited/stitched footage — recording a previously shot file is the
most common silent rejection), phone camera, 1–2 minutes, landscape, daylight,
audio on is fine but not required. Do not narrate anything untrue.

| # | Shot | Duration | Rubric item it answers |
|---|---|---|---|
| 1 | Start at the nearest **street sign / intersection**. Hold the sign legible for ~5s, then pan slowly across a **recognisable landmark** or neighbouring premises. | 15s | Failed item 1 — surrounding area |
| 2 | **Walk from that sign to the door in the same unbroken take.** Do not cut. The continuity is the evidence that the street sign and the door are the same place. | 20-30s | Failed item 1 — proves proximity, not just existence |
| 3 | Hold the **house/unit number** legible for ~5s at the entrance. | 5s | Failed item 1 |
| 4 | Enter, and on a clear surface show a **printed item bearing "Techpolity" together with the address**: an **ABN registration extract printout**, a utility bill, a bank statement, or letterhead/business card if it carries both. Hold each still and in focus for ~8s. Two items is better than one. | 20-30s | Failed item 2 — name on a legitimate asset |
| 5 | Show the working space (desk, equipment) briefly — an online business's "premises". | 10s | Supports item 1 for service-area businesses |
| 6 | **Authorisation proof, unchanged from the passing attempts**: on-camera sign-in to the **techpolity.com domain / Zoho admin console** showing control of the domain and mailbox, then to the Business Profile itself. | 20-30s | Authorisation (already passing — do not drop it) |

Rules that decide pass/fail as much as the shot list:

- **Spelling must be exactly "Techpolity"** on every asset shown. Never
  "Tech Policy Ltd" (ADR 0007 summary, owner's words).
- **Keep personal data out of frame**: mask or crop bank account numbers, TFN,
  card numbers, other people's names, and any co-resident's mail. Name +
  address + issuer is what Google needs; nothing else.
- No neighbours' faces, no vehicle plates you do not own.
- Do not stop and restart the camera. If you fumble, discard and reshoot whole.
- Upload directly from the phone through the profile's verification screen.
- Record the attempt in this file's log before submitting.

## (ii) Support route — document-based verification

**Where:** `https://support.google.com/business/` → *Contact us* → choose the
Techpolity profile → topic *Verification* → sub-topic *Video verification /
verification failed* → *Next step: chat or email*. The contact flow only offers
a case once a verification attempt exists on the profile, which it now does
(two). If the flow dead-ends, the Business Profile Help **Community** and the
`@GoogleBusiness` escalation path are the fallbacks, but the case flow is the
one that can attach documents.

**Ready-to-paste case description:**

> Business name: Techpolity
> Location ID: 01090885182245385978
> Google account: the release owner's Google account (the one that owns the Techpolity profile)
> Website: techpolity.com
> Business type: online / service-area business, service area Australia
>
> My profile has now failed video verification twice (rejection emails dated
> 4 September 2026 and 11 September 2026). Both rejections cite "no view of
> surrounding area" and "business name not shown on legitimate assets". The
> authorisation check passed on both attempts.
>
> Techpolity is a home-based, online service-area business. It has no public
> premises, no signage, no branded vehicle and no customer-facing address —
> by design, and consistent with the service-area business type I selected.
> I therefore cannot film exterior signage or neighbouring business frontage
> showing my business name, because none lawfully exists.
>
> I can evidence the business and my authority over it with documents:
> Australian Business Register (ABN) extract in the name Techpolity, a utility
> bill / bank statement at the registered address, and proof of ownership of
> the techpolity.com domain and its administrative mailbox.
>
> Please could you either (a) review this profile via document-based
> verification, or (b) enable an alternative verification method on this
> profile — the verification screen currently offers "Submit a Business Video"
> only, with no live call, postcard or phone option. I am happy to attend a
> live video call at any time if that method can be enabled.

**Documents to have ready to attach** (each PDF/photo, legible, personal data
beyond name/address/issuer masked):

1. **ABN registration extract** from abr.business.gov.au in the name
   **Techpolity** — the primary identity document.
2. **Utility bill or bank statement** at the registered address, dated within
   the last 3 months, showing the business or owner name at that address.
3. **Domain ownership proof** for techpolity.com — registrar account screen or
   the registrar's invoice showing the account holder.
4. Optional: business insurance certificate, or a client invoice on Techpolity
   letterhead.

Keep every attachment consistent on the name **Techpolity**. One document
spelling it differently is a worse outcome than one document fewer.

## (iii) Decision tree

```
Attempt 3 (re-shoot per section i)
  |
  +-- PASS -> Profile verified. 60-day clock runs from 2026-09-01
  |           (creation), so Basic API Access can be filed from ~2026-10-31,
  |           subject to Google counting age from creation rather than
  |           verification -- CONFIRM in the console before filing.
  |           ADR 0007 decisions stand unchanged. Amendment B is withdrawn.
  |
  +-- FAIL -> Run BOTH tracks in parallel, immediately, not in sequence:
              |
              +-- Track 1: open the support case (section ii) and request
              |   document-based verification or an alternative method.
              |
              +-- Track 2: take ADR 0007 "Amendment B" to the release owner
                  for a decision on filing Basic API Access against the
                  already-verified TTropolis profile instead.
              |
              +-- Converge: whichever resolves first decides the applying
                  identity. Do not file the application under two identities.
```

**Why parallel and not sequential:** the support case has an opaque clock, and
Amendment B is an owner decision rather than a Google one — neither blocks the
other, and GBP is post-beta (ADR 0007 decision 10), so nothing on the beta path
waits on either. A third video failure, on the other hand, is evidence the
video method cannot succeed for this business type at all, and continuing to
re-shoot after that is the sunk-cost move.

**Hard stop:** do not attempt a fourth video without either new physical
evidence or support guidance. Repeated failed attempts risk the profile being
suspended rather than merely unverified.

## Attempt log

| Attempt | Date submitted | Outcome | Rejection items |
|---|---|---|---|
| 1 | ~2026-09-03 | Failed (email 2026-09-04) | Surrounding area; name on assets |
| 2 | ~2026-09-10 | Failed (email 2026-09-11) | Surrounding area; name on assets |
| 3 | _pending_ | _pending_ | |
