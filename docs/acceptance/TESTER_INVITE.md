# FablePeak acceptance testing — invitation package

- Product: FablePeak 1.6.5 at <https://fablepeak.com>
- For: the two external acceptance testers (Tester 1 and Tester 2)
- Sender: the release owner, Techpolity
- Companion document: [TESTER_GUIDE.md](TESTER_GUIDE.md) — the step-by-step scripts
- Last updated: 2026-09-11

This package has four parts: the cover email to send, the tester checklist, the
results-report template, and the rules. Send parts 2–4 as the attachment or link
that the cover email refers to, together with the tester guide.

---

## 1. Cover email

**Subject:** FablePeak acceptance testing — would you run two of the scripts?

Hello <name>,

FablePeak is a social-media scheduling tool. Before it opens to anyone outside
the team, two people who do not work on it have to run the acceptance scripts on
real accounts. We would like you to be one of them.

What it involves: you create your own FablePeak account at
<https://fablepeak.com> with an email address and password, confirm it from the
email that arrives from fablepeak@techpolity.com, connect your own social
accounts, and work through the scripts in the attached guide, capturing
screenshots as you go.

Time: Tester 1 is about 5 to 6 hours of hands-on work spread across seven days
(two of the steps are short check-backs on day 2 and day 7). Tester 2 is about
2 hours, on two agreed evenings.

Before you start you need: a Facebook account that administers at least two
Pages, an Instagram professional profile, and a YouTube channel if you have one.
Two of the scripts need both testers online at once on separate devices, so we
will schedule those. Use accounts you control and are happy to post plain test
content from. We do not test TikTok in this round.

Reporting: fill in the results template in the attached package, one line per
row, and send it with your screenshots to the location named in the guide.

Questions or anything that looks wrong: fablepeak@techpolity.com.

Thank you,
Techpolity

---

## 2. Tester checklist

Run the scripts in the order below. Every reference is a section heading in
[TESTER_GUIDE.md](TESTER_GUIDE.md).

### Tester 1

| # | Do this | Guide section | Time | Evidence row it proves |
|---|---|---|---|---|
| 1 | Create your account, confirm the email, create a brand | *First-run setup — do this once* | 20 min | Supports every row |
| 2 | Facebook: connect, choose a Page, publish, disconnect | *Script 1* | 30 min | Facebook OAuth, multi-Page selection, publish, remote link, disconnect |
| 3 | Instagram Business: connect, publish an image, disconnect | *Script 2* | 30 min | Direct Instagram Business OAuth, image publish, remote link, disconnect |
| 4 | Instagram Creator: connect (day 1 only) | *Script 3*, Day 1 | 15 min | Direct Instagram Creator OAuth and token renewal |
| 5 | YouTube: connect, check the channel, upload a private video | *Script 4* | 30 min | YouTube OAuth, correct channel, private video upload, disconnect |
| 6 | Revoke FablePeak's access at Facebook and watch what happens | *Script 5* | 45 min | Revoked credential becomes needs-reconnect without disabling a still-valid token |
| 7 | Instagram Creator check-back | *Script 3*, Day 2 | 5 min | Same row as #4 |
| 8 | **With Tester 2:** no one can see anyone else's workspace | *Script 6* | 45 min | Tenant A cannot read/select/disconnect/publish through Tenant B assets |
| 9 | **With Tester 2:** owner and editor, including Part F approval | *Script 9* | 55 min | Owner-vs-editor enforcement |
| 10 | Scheduled post where one network works and one fails | *Script 7* | 1 hr, mostly waiting | Scheduled mixed-network delivery retains success and visibly identifies failure |
| 11 | Instagram Creator check-back, day-7 publish, disconnect | *Script 3*, Day 7 | 20 min | Same row as #4 |
| 12 | Delete your data and your account — **do this last** | *Script 8* | 30 min | Account deletion and provider-data deletion instructions complete |

### Tester 2

| # | Do this | Guide section | Time |
|---|---|---|---|
| 1 | Create your own account, brand, and connect **one** social account of any kind | *First-run setup — do this once* | 25 min |
| 2 | **With Tester 1:** no one can see anyone else's workspace | *Script 6* | 45 min |
| 3 | **With Tester 1:** owner and editor, including Part F approval | *Script 9* | 55 min |

### Order rules you must not break

- Script 6 runs **before** Script 9. Script 6 only works while the two of you are
  strangers to the app; Script 9 deliberately makes you teammates.
- Both run **before** Script 8, which destroys Tester 1's account.
- Script 3 is spread over seven days. Start it early and keep going with the
  other scripts in between.
- Do not test TikTok. It is still in review and is not part of this round.

---

## 3. Results report template

One row per line. Copy this table, fill it in as you go, and send it with your
screenshots. Do not put passwords, access tokens or anyone's personal data in it.

| Row / script | Result | Date, time and time zone | Remote post link | Notes |
|---|---|---|---|---|
| First-run setup | Pass / Fail | | n/a | |
| Script 1 — Facebook | Pass / Fail | | | |
| Script 2 — Instagram Business | Pass / Fail | | | |
| Script 3 — Instagram Creator, day 1 | Pass / Fail | | n/a | |
| Script 3 — day 2 check-back | Pass / Fail | | n/a | |
| Script 3 — day 7 check-back and publish | Pass / Fail | | | |
| Script 4 — YouTube | Pass / Fail | | | |
| Script 5 — revoked access | Pass / Fail | | | |
| Script 6 — tenant isolation | Pass / Fail | | n/a | |
| Script 9 — owner and editor (Parts A–E) | Pass / Fail | | n/a | |
| Script 9 — Part F, approval | Pass / Fail | | n/a | |
| Script 7 — mixed-network delivery | Pass / Fail | | | |
| Script 8 — deletion | Pass / Fail | | n/a | |

Column notes:

- **Result** — mark Fail if anything differed from what the guide describes, even
  slightly. A fail is useful information, not a problem you caused.
- **Date, time and time zone** — for example `4 Sep 2026, 14:32 AWST`.
- **Remote post link** — the full web address of the real post on Facebook,
  Instagram or YouTube, copied from the delivery panel. Write `n/a` where the
  script publishes nothing.
- **Notes** — the exact wording of any message you saw, and for a fail, what you
  expected and what actually happened.

Header block to put above the table:

```
Tester number:      Tester 1 / Tester 2
Your name:
Dates covered:
Browser and device:
Scripts completed:
```

---

## 4. Rules

**Use test content and mark it as a test.** Every post you make goes to a real
social account. Use plain wording such as
`FablePeak acceptance test - please ignore` plus the date. Nothing personal,
nothing embarrassing, no customer or client material.

**Delete your test posts when you are finished.** Once the release owner
confirms your evidence is accepted, remove the test posts from Facebook,
Instagram and YouTube. Tell the release owner before you delete anything, in
case a post still needs re-checking.

**Never share a password.** Not with the release owner, not with the other
tester, not in a screenshot, not once. You type your own passwords and nobody
else ever needs them. The same applies to access tokens — any long random string
of letters and numbers. If one appears on screen, do not screenshot it; write
down which page you were on and report it.

**Report bugs with steps.** For anything that looks wrong, record: which script
and step number, what you did, what you expected, what actually happened, the
exact wording on screen, the date and time with your time zone, and a screenshot
with anything sensitive blacked out. Send it to fablepeak@techpolity.com.

**Stop and report immediately** if one tester can see, change or post to
anything belonging to the other, or if an editor succeeds at something Script 9
says must be blocked. Do not continue that script.
