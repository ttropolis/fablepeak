# FablePeak acceptance tester guide

- Product: FablePeak 1.5.0 at <https://fablepeak.com>
- Purpose: collect the nine human-acceptance rows in
  [EXTERNAL_BETA_EVIDENCE.md](EXTERNAL_BETA_EVIDENCE.md)
- Audience: two testers who do not work on FablePeak
- Last updated: 2026-08-30

You do not need to know anything about programming to run this. Every step is
something you click, type or look at. If a screen does not match what a step
describes, stop that step, write down what you actually saw, and tell the
release owner. A mismatch is useful information, not a mistake.

---

## Fill this in before you start

Your release owner completes this box and hands you the guide.

| Field | Value |
|---|---|
| Release owner name | |
| Release owner contact (email or chat) | |
| Where to send evidence (shared drive folder or upload link) | |
| Your tester number (Tester 1 or Tester 2) | |
| Date you start | |

Send every screenshot and note to the one location named above. Do not email
evidence anywhere else and do not post it publicly.

---

## Ground rules — read this page first

**1. Never share a password with anyone, including the release owner.**
Not by email, not by chat, not in a screenshot, not "just this once". You will
type your own passwords into the FablePeak sign-in box and into Facebook,
Instagram and Google. Nobody else ever needs them.

**2. Never share an access token.** A token is a long random string of letters,
numbers and dashes. You should never see one in normal use. If one ever appears
on screen, in a browser address bar, or in an error message, **do not screenshot
it**. Instead, write down "a long code appeared here" and tell the release owner
what page you were on.

**3. Check every screenshot before you send it.** Crop or black out:

- anything in a password box
- any long random code in the browser address bar
- any part of a web address after `?code=`, `?token=`, `access_token=` or
  `#access_token=`
- other people's names, photos or messages that are not part of the test

If you are unsure whether something is safe to include, black it out. A
screenshot with a token in it cannot be used as evidence and has to be
destroyed.

**4. Timestamps matter.** For each screenshot, write down the date and clock
time you took it, and your time zone (for example "3 Sep 2026, 14:32 AEST").
Either include your computer clock in the screenshot or write it in your notes.

**5. Remote links matter.** When FablePeak says a post was published, it shows a
link to the real post on Facebook, Instagram or YouTube. Copy that whole web
address into your notes. That link is the proof the post really arrived.

**6. Do not use anyone else's account.** Use only the accounts you created for
this test.

**7. Post nothing embarrassing.** These posts go to real social accounts.
Use plain, boring test wording such as
`FablePeak acceptance test - please ignore` plus the date.

---

## Prerequisites

### Why your accounts must be unrelated to FablePeak

FablePeak's owners and developers can reach the database and the server
settings directly. If an owner or developer runs these tests, a step can appear
to pass because of something only they can do — a setting they already changed,
an account already trusted by the app, or a permission that ordinary customers
will not have. Evidence collected that way proves nothing about a real customer,
and the release cannot open on it.

So:

- Your FablePeak sign-in email must be **new** and must not have been used with
  FablePeak before.
- Your Facebook, Instagram and Google accounts must be **your own or newly
  created for this test**, and must not be listed as a developer, admin or
  tester on FablePeak's Facebook or Google developer apps.
- If the release owner already knows your FablePeak password, or set the account
  up for you, the evidence is invalid. You create the account yourself.
- Tester 1 and Tester 2 must be **different people** with no shared accounts
  and no shared devices. Do not use two browser profiles on one machine.

If any of this is not true for you, say so before starting.

### What each tester needs

| Item | Tester 1 | Tester 2 | Notes |
|---|---|---|---|
| Fresh email address, never used with FablePeak | Required | Required | You must be able to open its inbox — FablePeak sends a confirmation link |
| A device with a modern browser (Chrome, Safari, Edge, Firefox) | Required | Required | Pop-ups must be allowed for fablepeak.com; the social sign-in opens in a small extra window |
| Facebook account that administers **2 or more Pages** | Required | Not required | Two Pages are needed to prove you can choose which Page receives a post. Free test Pages are fine |
| Instagram **Business** professional profile | Required | Not required | Set in the Instagram app: Settings → Account type and tools → Switch to professional account → Business |
| Instagram **Creator** professional profile | Required | Not required | A second, separate Instagram profile switched to Creator instead of Business |
| YouTube channel you own | Required | Not required | A brand-new channel is fine. Uploads in this test are set to private |
| An image file, JPEG, under 10 MB | Required | Not required | A plain photo. Not a screenshot containing personal data |
| A short video file, MP4, under 50 MB | Required | Not required | 10–20 seconds is plenty |

### Which rows need two testers

| Script | Testers involved |
|---|---|
| 1, 2, 3, 4, 5, 7, 8 | Tester 1 alone |
| **6 — tenant isolation** | **Tester 1 and Tester 2 together** |
| **9 — owner and editor** | **Tester 1 and Tester 2 together** |

Tester 2's only jobs are Scripts 6 and 9. Tester 2 still has to create their own
FablePeak account (see "First-run setup" below) and connect **one** social
account of any kind, so that there is something of their own to compare against.
Tester 2 does not need multiple Pages, a Creator profile or a YouTube channel.

Run the two-tester scripts in this order: **Script 6, then Script 9.** Script 6
proves that two unrelated people cannot see each other's workspaces, so it has to
happen while they are still strangers to each other. Script 9 then invites Tester
2 into Tester 1's workspace on purpose, which makes them genuine teammates —
after that, Script 6 would no longer be a fair test.

Both must be run **before** Script 8, because Script 8 deletes Tester 1's
account.

---

## First-run setup — do this once

Both testers do this. Script 1 continues straight on from here.

1. Open <https://fablepeak.com> in your browser.
2. You land on a dark blue welcome screen headed
   **"All your social media, one clean workspace."**
3. In the white card on the right, click the **Create account** tab.
4. Type your fresh email in **Email** and a password of at least 8 characters in
   **Password**.
5. Click **Create my account**.
6. A green line appears: *"✉️ Check your inbox — click the confirmation link,
   then sign in here."*
7. Open your email inbox and click the confirmation link.
8. Return to <https://fablepeak.com>, click the **Sign in** tab, enter the same
   email and password, and click **Sign in**. A small message reading
   *"Welcome back ✔"* appears at the bottom right.
9. You now see a card headed **"Welcome to FablePeak, …!"** explaining that a
   brand is a workspace. Type a name for your workspace (for example
   `Tester 1 Workspace`) and click **Create brand**.
10. FablePeak moves you straight to the **Connections** screen.

**Evidence to capture (setup)**

- [ ] Screenshot of the confirmation email in your inbox, with the email
      address visible and the link **not** clicked yet
- [ ] Screenshot of the "Welcome to FablePeak" brand-creation card
- [ ] Screenshot of the Connections screen after your brand is created
- [ ] Note: date, time and time zone of each screenshot
- [ ] Note: the workspace (brand) name you chose
- [ ] Confirm no screenshot shows your password box filled in
- [ ] Send to the location in "Fill this in before you start"

**Never** send your password or any long code from the confirmation link.

---

## How to find things in FablePeak

- The dark blue strip on the left (or the row of buttons across the top on a
  phone) is the menu: **Planner, Analytics, Inbox, SmartLinks, Reports,
  Connections, Settings**.
- The **Brand** dropdown at the top of that strip switches between workspaces.
- If somebody has invited you into their workspace, a card headed
  **Invitations** appears at the very top of the screen, above whatever view you
  are on, with **Accept** and **Decline** buttons. Nothing of theirs is shared
  with you until you press Accept. Only Script 9 uses this.
- Small grey messages appear briefly at the bottom right of the screen. They
  disappear after a few seconds, so screenshot them quickly.
- On the **Connections** screen each social network has its own card, showing
  the network name, a short note about what it can do, and a **Connect** button.
- **Do not press the Escape key while the New post window is open.** It closes
  the window immediately and throws away everything you typed, with no warning.
  Click outside a dropdown to close it instead.
- The Planner may show a "⚠️ No profiles connected yet" note even when your
  accounts are connected. Ignore it — check the **Connections** screen for the
  true state. (Known display bug at the time of writing.)

---

## Script 1 — Facebook: connect, choose a Page, publish, disconnect

Tester 1. Allow about 30 minutes.

1. Sign in at <https://fablepeak.com> and open **Connections** from the left
   menu.
2. Find the **Facebook** card. Under the name it should read
   **Available to connect**. Click **Connect**.
3. A small extra window opens with Facebook's sign-in and permission screens.
   Sign in as yourself.
4. When Facebook asks which Pages FablePeak may use, **choose at least two of
   your Pages**. Screenshot this Facebook screen before you continue.
5. Approve the permissions Facebook lists. The small window closes on its own.
6. Back on the Connections screen, the Facebook card now lists **one row per
   Page you authorised**. One row is marked **✓ Publishing account** in green;
   the others each have a **Use for publishing** button. Most rows also show a
   small grey **Verified**.
7. Screenshot the whole Facebook card showing all Pages.
8. Click **Use for publishing** on a *different* Page from the one currently
   marked. A message reads *"… selected for publishing ✔"*, and the green
   **✓ Publishing account** mark moves to the Page you chose. Screenshot this.
   Write down which Page name you selected.
9. Open **Planner** from the left menu. Click **+ New post**.
10. In **Content**, type `FablePeak acceptance test - please ignore` and today's
    date.
11. Leave **Image / video** empty. Facebook accepts text-only posts.
12. Under **Networks**, tick **FB Facebook**. Make sure nothing else is ticked.
13. Leave **Date** and **Time** as they are and set **Status** to `scheduled`.
14. Click **🚀 Publish now**. A confirmation box asks
    *"Publish to Facebook right now? This posts to the real accounts."* —
    click OK.
15. Wait. A message names the network it published to. Reopen the post by
    clicking its coloured chip on the calendar.
16. A panel headed **Delivery results** now appears at the top of the post,
    with a row for **Facebook** reading **Published — view post**.
17. Click **Published — view post**. It opens the real post on Facebook.
    **Check it is on the Page you selected in step 8, not the other one.**
    Copy the full web address from your browser.
18. Screenshot the real Facebook post showing the Page name.
19. Return to FablePeak, open **Connections**, and on the Facebook card click
    **Disconnect** on one of the Page rows. A box asks *"Disconnect …?
    Scheduled posts will stop publishing to it."* — click OK. A message reads
    *"Disconnected"*.
20. Screenshot the Facebook card after disconnecting, showing that the row is
    gone.
21. Repeat step 19 for the remaining Facebook rows so no Facebook account is
    left connected. Screenshot the empty Facebook card.

**Evidence to capture (Script 1)**

- [ ] Screenshot: Facebook's Page-choosing screen with two or more Pages ticked
- [ ] Screenshot: FablePeak Facebook card listing all authorised Pages
- [ ] Screenshot: the green **✓ Publishing account** mark on the Page you chose
- [ ] Note: the exact name of the Page you selected for publishing
- [ ] Screenshot: the **Delivery results** panel showing Facebook —
      **Published — view post**
- [ ] Remote link: the full web address of the real Facebook post
- [ ] Screenshot: the real Facebook post, showing which Page posted it
- [ ] Screenshot: the Facebook card after every Page has been disconnected
- [ ] Note: date, time and time zone for each screenshot
- [ ] Check: no screenshot shows a password box or any long random code
- [ ] Send to the agreed evidence location

---

## Script 2 — Instagram Business: connect, publish an image, disconnect

Tester 1. Allow about 30 minutes. Use your **Business** Instagram profile.

You do **not** need a Facebook Page for this. FablePeak signs you in through
Instagram directly.

1. Open **Connections**. Find the **Instagram** card. Its note reads
   *"Business or Creator profiles connect directly. No Facebook Page is
   required. Every post needs media."*
2. Click **Connect**. A small window opens with Instagram's own sign-in.
3. Sign in with your **Business** profile and approve the permissions.
   Screenshot the Instagram permission screen.
4. Back in FablePeak, the Instagram card now shows your profile name, a green
   **✓ Publishing account** and a grey **Verified**. Screenshot the card.
5. Open **Planner** and click **+ New post**.
6. In **Content**, type `FablePeak acceptance test - please ignore` and the date.
7. For the image, either:
   - click **📱 Choose photo or video** and pick your JPEG — the status line
     counts up `Uploading … 0%` to `Upload complete ✔` and a preview appears; or
   - paste a public `https://` link to a JPEG into **Image / video**.
8. Under **Networks**, tick **IG Instagram** only.
9. Set **Status** to `scheduled` and click **🚀 Publish now**, then OK.
10. Reopen the post from the calendar. The **Delivery results** panel shows
    **Instagram — Published — view post**. Screenshot it.
11. Click the link, confirm the image is really on your Instagram profile, and
    copy the full web address. Screenshot the real Instagram post.
12. Open **Connections**, click **Disconnect** on the Instagram row, confirm,
    and screenshot the card afterwards.

**Evidence to capture (Script 2)**

- [ ] Screenshot: Instagram's own permission screen (no Facebook Page step)
- [ ] Screenshot: FablePeak Instagram card showing your Business profile name
      and **✓ Publishing account**
- [ ] Screenshot: **Delivery results** showing Instagram —
      **Published — view post**
- [ ] Remote link: the full web address of the real Instagram post
- [ ] Screenshot: the real Instagram post on your profile
- [ ] Screenshot: the Instagram card after disconnecting
- [ ] Note: that the profile used was a **Business** profile
- [ ] Note: date, time and time zone for each screenshot
- [ ] Check: no screenshot shows a password box or any long random code
- [ ] Send to the agreed evidence location

---

## Script 3 — Instagram Creator: connect, and check it survives

Tester 1. About 15 minutes on day 1, then two short check-backs.

This row proves a **Creator** profile connects the same way, and that FablePeak
keeps the connection alive by itself over several days without asking you to
sign in again.

**Day 1**

1. Open **Connections** and click **Connect** on the **Instagram** card. (If a
   previous Instagram profile is still listed, the button reads
   **Connect another**.)
2. Sign in with your **Creator** profile and approve the permissions.
3. The Instagram card shows the Creator profile name with **✓ Publishing
   account** and **Verified**. Screenshot the card. Write down the exact
   profile name and the date and time.
4. Hover your mouse over the grey word **Verified** — a small tooltip shows the
   date and time FablePeak last checked the connection. Note it down. (On a
   phone there is no hover; skip this and just note the day-1 time.)

**Day 2 (about 24 hours later)**

5. Sign in, open **Connections**, and screenshot the Instagram card again.
6. It must still show the Creator profile with **✓ Publishing account**.
   It must **not** show **⚠️ Needs reconnecting** or **⚠️ Connection check
   failed**, and you must **not** have been asked to sign in to Instagram again.

**Day 7 (about a week after day 1)**

7. Repeat step 5. Screenshot the card again.
8. Then prove it still works: open **Planner**, create a post with your image,
   tick **IG Instagram** only, and use **🚀 Publish now**. The **Delivery
   results** panel must show **Published — view post**. Copy the link.
9. Open **Connections** and **Disconnect** the Creator profile. Screenshot.

If at any check-back the card shows **⚠️ Needs reconnecting**, stop and report
it immediately with a screenshot and the time — that is a result the release
owner needs.

**Evidence to capture (Script 3)**

- [ ] Screenshot: Instagram card on day 1 showing the **Creator** profile
      connected
- [ ] Note: the exact Creator profile name, and that it is a Creator (not
      Business) profile
- [ ] Note: the day-1 "Verified" tooltip date and time, if you could see it
- [ ] Screenshot: Instagram card on day 2, still healthy, with the date visible
      or noted
- [ ] Screenshot: Instagram card on day 7, still healthy, with the date noted
- [ ] Note: confirmation that you were never asked to sign in to Instagram again
      between day 1 and day 7
- [ ] Screenshot: **Delivery results** for the day-7 post
- [ ] Remote link: the full web address of the day-7 Instagram post
- [ ] Screenshot: the Instagram card after disconnecting
- [ ] Check: no screenshot shows a password box or any long random code
- [ ] Send to the agreed evidence location

> Note for the release owner: FablePeak's screens do not display token renewal
> directly. Pair these dated screenshots with the hourly connection-maintenance
> job evidence in the beta evidence record.

---

## Script 4 — YouTube: connect, check the channel, upload a private video

Tester 1. Allow about 30 minutes.

1. Open **Connections**. The **YouTube** card note reads *"Uploads a video
   (needs a video URL). New API projects publish as private until Google audits
   them."*
2. Click **Connect**. A small window opens with Google's sign-in.
3. Sign in with the Google account that owns your YouTube channel and approve
   the permissions. Screenshot Google's permission screen.
4. Back in FablePeak, the YouTube card shows your channel name with
   **✓ Publishing account**. **Check the channel name is the right one** — if
   your Google account owns several channels, confirm it matches the channel
   you intended. Screenshot the card.
5. Open **Planner** and click **+ New post**.
6. In **Content**, type `FablePeak acceptance test - please ignore` and the date.
7. Add your video: click **📱 Choose photo or video**, pick your MP4, and wait
   for **Upload complete ✔**. A video preview appears.
   - If you paste a link instead, it must be a direct link to a video **file**.
     A `youtube.com/watch` or `youtu.be` link is refused with the message
     *"YouTube needs a direct video file URL, not a YouTube watch link"*.
8. Under **Networks**, tick **YT YouTube** only.
9. Set **Status** to `scheduled` and click **🚀 Publish now**, then OK. This
   takes longer than a text post — wait for it.
10. Reopen the post. **Delivery results** shows **YouTube — Published — view
    post**. Screenshot it and copy the link.
11. Open the link. Sign in to YouTube Studio if asked. Confirm:
    - the video is on the channel named in step 4, and
    - its visibility is **Private**.
    Screenshot the video in YouTube Studio showing the channel name and the
    Private setting.
12. Return to **Connections**, click **Disconnect** on the YouTube row, confirm,
    and screenshot the card afterwards.

**Evidence to capture (Script 4)**

- [ ] Screenshot: Google's permission screen
- [ ] Screenshot: FablePeak YouTube card showing the correct channel name
- [ ] Note: the exact channel name, written out
- [ ] Screenshot: **Delivery results** showing YouTube —
      **Published — view post**
- [ ] Remote link: the full web address of the uploaded video
- [ ] Screenshot: YouTube Studio showing the video on that channel and set to
      **Private**
- [ ] Screenshot: the YouTube card after disconnecting
- [ ] Note: date, time and time zone for each screenshot
- [ ] Check: no screenshot shows a password box or any long random code
- [ ] Send to the agreed evidence location

---

## Script 5 — Revoking access at the provider

Tester 1. Allow about 45 minutes, including a 20-minute wait.

This proves that when you take FablePeak's access away at Facebook itself,
FablePeak notices and says so — and that it does **not** wrongly break a
different account that is still fine.

**You need two accounts connected at once before you start.** Reconnect if you
disconnected them earlier:

- Facebook: connect and authorise at least one Page (as in Script 1).
- YouTube: connect your channel (as in Script 4).

Screenshot the Connections screen showing **both** healthy, each with
**✓ Publishing account**. Note the time. This is your "before" picture.

**Now revoke Facebook only.** Do this in Facebook, not in FablePeak:

1. Go to <https://www.facebook.com/> and sign in as yourself.
2. Open **Settings & privacy → Settings**, then find **Apps and Websites**
   (on some accounts this sits under a **Security** or **Apps** heading, and on
   the Accounts Center it may be listed as **Apps and websites**).
3. Find **FablePeak** in the list of active apps.
4. Screenshot the list showing FablePeak present.
5. Choose **Remove** for FablePeak and confirm.
6. Screenshot the list again showing FablePeak gone.
7. Write down the exact date, time and time zone of the removal. This is the
   most important timestamp in this script.

**Do not touch YouTube. Leave it exactly as it is.**

**Then watch FablePeak:**

8. Wait at least **20 minutes** after the removal. FablePeak re-checks a
   connection only when its last check is more than 15 minutes old, so an
   immediate reload may still show the old, healthy state — that is expected and
   is not a failure.
9. Go back to <https://fablepeak.com>, sign in, and open **Connections**.
   Reload the page once.
10. On the **Facebook** card, the account row must now show
    **⚠️ Needs reconnecting** in red, or **⚠️ Connection check failed** in red,
    with a red explanation line underneath. Screenshot the whole card,
    including the red text.
11. The Facebook card's button will now read **Reconnect**.
12. **The Facebook row must never keep showing the healthy green
    ✓ Publishing account state.** If it still looks healthy 30 minutes after
    the removal, that is a failure — screenshot it, note the time, and report it.
13. On the same screen, the **YouTube** card must still show your channel with
    the green **✓ Publishing account** and no red warning. Screenshot it.
14. Prove the good account still works: open **Planner**, create a post, tick
    **YT YouTube** only, add your video, and **🚀 Publish now**. It must publish
    normally. Screenshot the **Delivery results** and copy the link.
15. Optional but useful: create a second post, tick **FB Facebook** only, and
    try **🚀 Publish now**. It should fail and say so plainly. Screenshot the
    **Delivery results** panel with the Facebook failure message.
16. Click **Reconnect** on the Facebook card, sign in again, and confirm the
    card returns to green **✓ Publishing account**. Screenshot it.

**Evidence to capture (Script 5)**

- [ ] Screenshot: "before" Connections screen with Facebook **and** YouTube both
      healthy
- [ ] Screenshot: Facebook's apps list showing FablePeak, before removal
- [ ] Screenshot: Facebook's apps list after removal, FablePeak gone
- [ ] Note: exact date, time and time zone of the removal, and the exact menu
      path you actually used inside Facebook
- [ ] Note: the time you reloaded FablePeak afterwards
- [ ] Screenshot: FablePeak Facebook card showing **⚠️ Needs reconnecting** (or
      **⚠️ Connection check failed**) with its red message
- [ ] Screenshot: FablePeak YouTube card still healthy at the same moment
- [ ] Screenshot: **Delivery results** for the YouTube post published after the
      Facebook revocation, plus its remote link
- [ ] Screenshot (optional): **Delivery results** showing the Facebook failure
- [ ] Screenshot: Facebook card healthy again after **Reconnect**
- [ ] Check: no screenshot shows a password box or any long random code
- [ ] Send to the agreed evidence location

---

## Script 6 — Two testers: no one can see anyone else's workspace

**Tester 1 and Tester 2 together.** Allow about 45 minutes. Do this on two
separate devices, in the same room or on a call so you can compare screens.
Run this **before Script 9 and before Script 8**.

Before starting, Tester 2 completes "First-run setup" and connects **one**
social account of any kind, so each tester has real assets of their own.

Each tester creates their own account and their own workspace, and **no
invitation passes between them in this script**. Neither tester invites the
other from Settings → Team, and neither accepts an Invitations card, so at this
point the two of you are strangers to the app and to each other. Being invited
into someone else's workspace on purpose is Script 9, which is why Script 9 runs
after this one. If either tester has already accepted an invitation into the
other's workspace, this script cannot produce valid evidence — say so and stop.

**Part A — Tester 2 cannot see Tester 1's things**

1. Both testers sign in at <https://fablepeak.com> on their own devices.
2. Tester 1: open **Settings**. Under **Cloud sync & team accounts** it reads
   `☁️ Cloud · synced · signed in as <your email>`. Screenshot it. Do the same
   on Tester 2's device. These two screenshots prove two different people are
   signed in.
3. Tester 1: click the **Brand** dropdown at the top of the left menu and
   screenshot the full list of workspace names.
4. Tester 2: do the same. **Tester 1's workspace name must not appear in Tester
   2's list, and Tester 2's must not appear in Tester 1's.**
5. Tester 2: open **Connections** and screenshot the whole screen. **None of
   Tester 1's Pages, Instagram profiles or YouTube channels may appear**, and
   there must be no **Use for publishing** or **Disconnect** button belonging to
   Tester 1's accounts.
6. Tester 2: open **Planner** and screenshot the calendar. **None of Tester 1's
   test posts may appear.** Move back a month and forward a month and check
   again.
7. Tester 2: open **Inbox**, **SmartLinks** and **Reports** and screenshot each.
   Nothing belonging to Tester 1 may appear.

**Part B — Tester 2 cannot force Tester 1's workspace in**

8. Tester 1: open **Settings** and click **⬇ Export backup**. A file named
   `fablepeak-backup-<date>.json` downloads. Send **only this file** to Tester 2
   (it contains no passwords and no access tokens, but treat it as private and
   delete it afterwards).
9. Tester 2: open **Settings**, click **⬆ Import backup**, and choose Tester 1's
   file.
10. Watch the bottom right of the screen closely and screenshot immediately. Two
    messages appear in quick succession: *"Backup restored ✔"*, then a red-tinted
    warning beginning **"⚠️ Cloud save failed:"** and mentioning that you are
    **not authorised for this brand**.
11. That second message is the point of the test. It shows the server refused to
    hand Tester 1's workspace to Tester 2, even though Tester 2 held the file.
12. Tester 2: while the imported copy is on screen, open **Connections**.
    Tester 1's connected accounts must **not** be listed — the imported file
    describes a workspace, not access to it. Screenshot this.
13. **Clean up (required).** Tester 2: reload the page (F5, or Cmd-R on a Mac).
    Tester 2's own workspace name returns in the **Brand** dropdown, and Tester
    1's is gone. Screenshot the dropdown after the reload. Then delete the
    backup file from Tester 2's device.

If at any point Tester 2 can see, select, disconnect or post to anything
belonging to Tester 1, stop immediately, screenshot it, note the time, and tell
the release owner. That is a serious finding.

**Evidence to capture (Script 6)**

- [ ] Screenshot: Tester 1's Settings showing "signed in as \<Tester 1 email\>"
- [ ] Screenshot: Tester 2's Settings showing "signed in as \<Tester 2 email\>"
- [ ] Screenshot: Tester 1's **Brand** dropdown list
- [ ] Screenshot: Tester 2's **Brand** dropdown list, without Tester 1's
      workspace
- [ ] Screenshot: Tester 2's **Connections** screen, without Tester 1's accounts
- [ ] Screenshot: Tester 2's **Planner** calendar, without Tester 1's posts
- [ ] Screenshots: Tester 2's **Inbox**, **SmartLinks** and **Reports**
- [ ] Screenshot: the **"⚠️ Cloud save failed … not authorised for this brand"**
      message after the import
- [ ] Screenshot: Tester 2's **Connections** during the imported view, still
      showing none of Tester 1's accounts
- [ ] Screenshot: Tester 2's **Brand** dropdown after reloading, back to normal
- [ ] Note: both testers' names, both dates and times, and confirmation that two
      separate devices were used
- [ ] Confirm: the exported backup file has been deleted from Tester 2's device
- [ ] Check: no screenshot shows a password box or any long random code
- [ ] Send to the agreed evidence location

---

## Script 7 — A scheduled post where one network works and one fails

Tester 1. Allow about 1 hour, mostly waiting.

This proves that when FablePeak sends a scheduled post to two networks at once
and only one succeeds, the success is kept and the failure is shown clearly
rather than hidden.

**Important about time.** FablePeak's scheduler runs on Perth time
(Australia/Perth, AWST). The **Time** box in the post composer has no time-zone
label. Ask the release owner what to type so the post fires roughly 15 minutes
from now, and write down both the time you typed and your own local clock time.

**Set up:** connect **Facebook** (at least one Page) and **Instagram**
(Business profile). Both must show green **✓ Publishing account**. Screenshot
this starting state.

**Make one network fail on purpose.** Use this method — it is the only
verified one. (A PNG-format trick was tested internally on 2026-08-29 and does
NOT work: Instagram's publishing service accepted the PNG and published it.)

- **Remove Instagram's permission after scheduling.** Schedule the post first
  (steps 1–6 below), then immediately go to the Instagram app →
  **Settings and privacy → Website permissions → Apps and websites** and remove
  FablePeak, before the scheduled time arrives.

Now:

1. Open **Planner** and click **+ New post**.
2. **Content:** `FablePeak acceptance test - mixed delivery - please ignore` and
   the date.
3. **Image / video:** add your JPEG image.
4. **Networks:** tick **FB Facebook** *and* **IG Instagram**. Both, together.
5. **Date / Time:** set the time about 15 minutes ahead as agreed above.
6. **Status:** `scheduled`. Click **Schedule**. A message reads
   *"Post scheduled ✔"*. Screenshot the composer before you click, and the
   calendar afterwards showing the light-blue **Scheduled** chip.
7. Remove FablePeak's Instagram permission now, and note the
   time.
8. Wait until the scheduled time passes, then wait another 5 minutes. Reload the
   page.
9. On the calendar the post chip should now be **red**. The legend below the
   calendar labels red as **Needs attention**. Screenshot the calendar.
10. Click the post. The **Delivery results** panel lists both networks
    separately:
    - **Facebook** — **Published — view post** (a link), and
    - **Instagram** — a red failure line explaining what went wrong.
    One of three wordings may appear for the failing network: a plain error
    message, *"Automatic retry scheduled for …"* with a date and time, or
    *"Verify on Instagram before doing anything else — delivery may have
    succeeded."*
11. Screenshot the whole **Delivery results** panel so both rows are visible in
    one image. This single screenshot is the core evidence for this row.
12. Click the Facebook **Published — view post** link, confirm the post is
    really on the Page, and copy the address. Screenshot the real post.
13. Check Instagram directly and confirm nothing was posted there (or, if the
    message said delivery may have succeeded, note what you actually found).
14. If a **Retry failed targets now** button is shown, click it once. A box
    explains that published and uncertain targets will not be repeated. Click
    OK, then screenshot the panel again.
15. **Check nothing was posted twice.** Reload the real Facebook Page and
    confirm there is exactly **one** copy of this test post. Screenshot it.

**Evidence to capture (Script 7)**

- [ ] Note: which method (A or B) you used to make Instagram fail
- [ ] Note: the time you typed into the composer, your own local time, and your
      time zone
- [ ] Screenshot: the composer with both **FB** and **IG** ticked, before saving
- [ ] Screenshot: the calendar showing the **Scheduled** chip
- [ ] Screenshot: the calendar afterwards showing the red **Needs attention**
      chip
- [ ] Screenshot: the full **Delivery results** panel showing Facebook published
      **and** Instagram failed, in one image
- [ ] Note: the exact failure wording shown for Instagram, typed out
- [ ] Remote link: the full web address of the real Facebook post
- [ ] Screenshot: the real Facebook Page showing exactly **one** copy of the post
- [ ] Screenshot (if shown): the panel after using **Retry failed targets now**
- [ ] Note: what you found on Instagram when you checked directly
- [ ] Check: no screenshot shows a password box or any long random code
- [ ] Send to the agreed evidence location

---

## Script 8 — Deleting your data and your account

Tester 1. Allow about 30 minutes. **Do this last.** It destroys the account you
have been testing with, so make sure Scripts 1–7 are finished and their evidence
is already sent.

**Part A — follow the published instructions as written**

1. Open <https://fablepeak.com/data-deletion.html>. This is the public page
   FablePeak points social platforms at. Screenshot the top of it.
2. Follow its first set of instructions, **Disconnect one social account**,
   exactly as printed: sign in to FablePeak, open your workspace, choose
   **Connections**, find one connected account, choose **Disconnect** and
   confirm.
3. Screenshot the Connections card afterwards showing the account is gone.
4. Note whether the printed steps matched what you actually saw. If any wording
   differed, write down both versions.

**Part B — remove FablePeak at Facebook and capture the reference code**

5. In Facebook, go to **Settings & privacy → Settings → Apps and Websites**,
   find **FablePeak**, and choose **Remove**.
6. Facebook may offer a link to check the status of your data-deletion request.
   If it does, follow it. It opens a FablePeak page headed **"Your deletion
   request reference"** showing a **Confirmation code**.
7. **Screenshot that page and write the confirmation code down.** The code is
   the deletion reference this row needs.
8. If Facebook does **not** offer such a link, say so in your notes, then send
   an email from your registered address to the deletion address on the
   data-deletion page, with the subject **Delete my FablePeak account**. Keep
   the reply as your reference and screenshot it.

> The confirmation code on that page is safe to share — it is a request
> reference, not a password and not an access token. The **web address** of that
> page contains the same code after `?code=`; you may include it, but do not
> include any address containing `token`.

**Part C — delete the FablePeak account itself**

9. Sign in to FablePeak and open **Settings**.
10. Scroll to the red-bordered box headed **Delete account**. Screenshot it.
11. Click **Delete my account**.
12. A box asks you to type `DELETE`. Type it in capitals and confirm.
13. A second box asks for your FablePeak password. Enter it. **Do not screenshot
    this box while your password is in it.**
14. A message reads *"Deleting account…"* and the page reloads to the signed-out
    welcome screen. Screenshot the welcome screen.
15. Try to sign in again with the same email and password. It must fail.
    Screenshot the error message on the sign-in card.
16. Note the exact date, time and time zone of the deletion.

**Evidence to capture (Script 8)**

- [ ] Screenshot: the public `data-deletion.html` page
- [ ] Note: whether its printed steps matched the real screens, and any wording
      that differed
- [ ] Screenshot: Connections card after disconnecting per the published steps
- [ ] Screenshot: Facebook's apps list after removing FablePeak
- [ ] Screenshot: the **"Your deletion request reference"** page showing the
      **Confirmation code** — or, if Facebook gave no link, the email reply you
      received instead
- [ ] Note: the confirmation code, typed out
- [ ] Screenshot: the **Delete account** box in Settings
- [ ] Screenshot: the signed-out welcome screen after deletion
- [ ] Screenshot: the failed sign-in attempt afterwards
- [ ] Note: exact date, time and time zone of the deletion
- [ ] Check: **no screenshot shows the password prompt with text in it**, and no
      screenshot shows any address containing `token`
- [ ] Send to the agreed evidence location

---

## Script 9 — Owner and editor: what a teammate can and cannot do

**Tester 1 and Tester 2 together.** Allow about 55 minutes. Two separate
devices, as in Script 6. Run this **after Script 6 and before Script 8.**

Tester 1 owns a workspace. Tester 2 is invited into it as an **editor**. This
proves an editor can do the everyday work — write posts, schedule them, reply in
the Inbox — and can walk out of the workspace whenever they choose, but cannot
delete the brand, disconnect Tester 1's social accounts, change which account
publishes, or publish the SmartLinks page. Part F then proves the approval
workflow with two real people: the editor proposes, the owner decides, and
nothing reaches the calendar as scheduled without an owner's approval while
the switch is on.

Before you start, **Tester 1 must have at least one social account connected**
(reconnect one from Script 1, 2 or 4 if you disconnected them all), otherwise
there is nothing for the editor to be blocked from disconnecting. Tester 2 keeps
their own account and their own workspace throughout — you are not creating a
new account for this script.

**Part A — the invitation, and declining it**

1. Tester 1: open **Settings** and find the **Team** card. It lists everyone in
   the workspace with their role — at this point only Tester 1, marked
   `owner` and `(you)`.
2. Tester 1: under **Invite someone**, type **Tester 2's exact FablePeak
   sign-in email**, leave the role box on **Editor**, and click **Invite**. A
   message reads *"Invitation created — now tell them to sign up with that
   address"*. The address now appears under **Pending invitation** with the role
   and *expires in 14 days*. Screenshot the whole Team card.
3. Tester 2: sign in and reload the page. A card headed **Invitations** appears
   at the top of the screen, above whatever view is open. It names Tester 1's
   workspace, says **as editor**, and reads *"Nothing is shared with you until
   you accept."* Screenshot it.
4. Tester 2: **before** accepting, open the **Brand** dropdown and screenshot
   it. Tester 1's workspace must **not** be listed yet.
5. Tester 2: click **Decline**. A message reads *"Invitation declined"* and the
   Invitations card disappears. Screenshot the screen afterwards, and open the
   **Brand** dropdown again — Tester 1's workspace must still be absent.

**Part B — the owner takes an invitation back**

6. Tester 1: invite the same email address again, as **Editor**.
7. Tester 1: click **Revoke** on that row under **Pending invitation**. A
   message reads *"Invitation revoked"*. Screenshot the Team card with the
   pending row gone.
8. Tester 2: reload the page. **No Invitations card may appear.** Screenshot the
   top of your screen.

**Part C — accepting, as an editor**

9. Tester 1: invite the same address a third time, as **Editor**. Note the date
   and time.
10. Tester 2: reload, and in the **Invitations** card click **Accept**. A
    message reads *"You've joined the workspace ✔"*. Screenshot it.
11. Tester 2: open the **Brand** dropdown. Tester 1's workspace is now listed.
    Choose it. Screenshot the dropdown and note the workspace name.
12. Both testers: open **Settings → Team**. Each of you now sees **both** email
    addresses with their roles — Tester 1 as `owner`, Tester 2 as `editor`.
    People in the same workspace can see each other's sign-in email; that is
    expected, not a leak. Screenshot the card on **both** devices.
13. Tester 2: on that same Team card there is **no invite box and no Revoke
    button**, and a grey line reads *"You're an editor in this workspace. Only
    its owners can invite or remove people."* Screenshot it.

**Part D — what the editor CAN do**

Tester 2 does all of Part D **inside Tester 1's workspace** (check the Brand
dropdown first).

14. Open **Planner** and click **+ New post**. In **Content**, type
    `FablePeak acceptance test - editor - please ignore` and today's date.
15. Tick **one** network under **Networks**, set **Date** at least **seven days
    ahead**, set **Status** to `scheduled`, and click **Schedule**. A message
    reads *"Post scheduled ✔"* and a light-blue **Scheduled** chip appears on
    the calendar. Screenshot the calendar. (Scheduling it a week out means it
    will not publish to Tester 1's real account while you are still testing.)
16. Open **Inbox**, open a conversation, type a short reply, send it, and mark
    the conversation resolved. Screenshot it. (Inbox messages are simulated —
    what this step proves is that an editor is allowed to use the controls.)
17. Reopen the scheduled post from the calendar and **delete** it, so it can
    never fire. Screenshot the calendar showing the chip gone.

**Part E — what the editor must NOT be able to do**

Steps 18 to 20 and step 22 are Tester 2, inside Tester 1's workspace; step 21
needs both of you. In each step, **try the control** — do not just look at it.

18. **Settings → Brands.** The red **✕** button next to Tester 1's brand is
    greyed out and does nothing when clicked. Hover it: a tooltip reads *"Only
    workspace owners can change this."* Underneath the list, a grey line reads
    *"You're an editor in this workspace. Only its owners can delete a brand."*
    Screenshot the card.
19. **Connections.** Tester 1's connected account is listed, with its
    **✓ Publishing account** mark where it applies — but there must be **no
    Disconnect button and no Use for publishing button on any row**. At the
    bottom of the screen a grey line reads *"You're an editor in this workspace.
    Only its owners can disconnect an account or change which one publishes."*
    Screenshot the whole screen.
20. **SmartLinks.** In the **Public page** card, the link-name box and the
    **Claim** (or **Change**) button are greyed out, and so is the **Publish
    this page** tick box if it is shown. A grey line reads *"You're an editor in
    this workspace. Only its owners can claim a link name or publish this
    page."* Click the greyed-out button and try to type in the box — nothing
    must happen, and the public link must not change. Screenshot the card.
21. **Leaving the workspace — and the one person who cannot.** This step needs
    **both** testers, and it puts the workspace back the way it was before step
    22. Do all four parts in order.

    a. **Tester 1** (the owner): open **Settings → Team**. At the bottom of the
       card there is a **Leave workspace** button. Because you are this
       workspace's only owner, it is **greyed out**. Hover it — a tooltip reads
       *"You're this workspace's only owner. Make somebody else an owner first,
       or delete the workspace from Settings → Brands."* The same sentence is
       printed in grey underneath it. Click it anyway: nothing must happen, and
       you must still be in the workspace afterwards. Screenshot the card.

    b. **Tester 2** (the editor, inside Tester 1's workspace): on that same
       **Team** card, the **Leave workspace** button is **not** greyed out.
       Click it. A box asks *"Leave this workspace? You'll lose access until
       re-invited."* — click OK. A message reads *"You've left that workspace"*,
       and Tester 1's workspace **disappears from your Brand dropdown**. Open
       the dropdown and screenshot it. Try to reach Tester 1's workspace again —
       you must not be able to.

    c. **Tester 1**: reload the page and open **Settings → Team** again. Tester
       2's address is **gone** from the list; only Tester 1 remains. Screenshot
       the card.

    d. **Put the workspace back before you continue.** Tester 1 invites Tester
       2's address one more time as **Editor**; Tester 2 reloads, clicks
       **Accept** in the **Invitations** card, and picks Tester 1's workspace in
       the **Brand** dropdown. Both of you check that **Settings → Team** lists
       both people again. Step 22 assumes Tester 2 is back inside Tester 1's
       workspace as an editor.

22. Tester 2: switch the **Brand** dropdown back to **your own** workspace and
    confirm it still behaves normally — your own brand can still be deleted,
    your own account disconnected. Screenshot it. Being an editor somewhere else
    must not change what you can do in your own workspace.

If at any point Tester 2 succeeds at something Part E says must be blocked —
deleting the brand, disconnecting or re-selecting an account, claiming or
publishing the SmartLinks page — or Tester 1's greyed-out **Leave workspace**
actually removes the workspace's only owner, stop immediately, screenshot it,
note the time, and tell the release owner. That is a serious finding.

**Part F — approval: the editor proposes, the owner decides**

Allow about 10 extra minutes. Tester 2 is back inside Tester 1's workspace as
an editor (step 21d put them there).

23. Tester 1 (the owner): open **Settings** and find **Require approval before
    scheduling** on the **Brands** card. Flip it **on**. Tester 2: reload and
    find the same switch — for you it must be **greyed out**; only an owner may
    change it. Screenshot both.

24. Tester 2: in the **Planner**, create a post with any text, a date a few
    days out, and one connected network. The status choices are **Draft** and
    **Submit for approval** — there must be **no way to pick Scheduled**, and
    an already-saved submission must show **no Publish now button**. Submit it.
    The calendar chip turns **amber** and the message reads *"Submitted for
    approval ✔"*. Screenshot the chip and the legend's **Needs approval**
    entry.

25. Tester 1: the **Planner** button in the sidebar now carries a **count
    badge**, and a **Needs approval** filter sits above the calendar. Open the
    post. A **Your decision** panel offers **Approve & schedule** and
    **Request changes**. First click **Request changes** with the note box
    empty — it must refuse and tell you the note is what the author gets back.
    Now write a short note and click **Request changes** again. Tester 2: open
    the post — it is a **draft** again and shows Tester 1's note word for
    word. Screenshot the note as the editor sees it.

26. Tester 2: submit the same post once more. Tester 1: this time click
    **Approve & schedule**. The chip turns to the normal scheduled colour, the
    badge count drops, and the note from step 25 is gone. Screenshot the
    scheduled chip. Leave it scheduled for a moment and confirm nothing
    publishes it early, then either of you can delete the post.

27. Tester 1: flip **Require approval before scheduling** back **off**. Tester
    2: reload and confirm you can once again save a post straight to
    **Scheduled** with no approval step.

If the editor ever reaches **Scheduled** (or a post publishes) while the
switch is on and no owner approved it, stop, screenshot it, note the time, and
tell the release owner. That too is a serious finding.

**Evidence to capture (Script 9)**

- [ ] Note: which tester was the owner and which was the editor, and the
      workspace name used. Never the passwords
- [ ] Screenshot: Tester 1's **Team** card showing the pending invitation with
      its role and expiry
- [ ] Screenshot: Tester 2's **Invitations** card naming the workspace and the
      **editor** role
- [ ] Screenshot: Tester 2's **Brand** dropdown before accepting, without
      Tester 1's workspace
- [ ] Screenshot: the screen after **Decline**, and the Brand dropdown still
      without Tester 1's workspace
- [ ] Screenshot: Tester 1's Team card after **Revoke**, pending row gone
- [ ] Screenshot: Tester 2's screen after the revoke, with no Invitations card
- [ ] Screenshot: the *"You've joined the workspace ✔"* message after **Accept**
- [ ] Screenshot: Tester 2's **Brand** dropdown afterwards, now listing Tester
      1's workspace
- [ ] Screenshots: the **Team** card on **both** devices, showing both emails
      and the roles `owner` and `editor`
- [ ] Screenshot: Tester 2's Team card with no invite box and the
      *"Only its owners can invite or remove people"* line
- [ ] Screenshot: the editor's **Scheduled** chip on Tester 1's calendar
- [ ] Screenshot: the editor's Inbox reply
- [ ] Screenshot: the calendar after the editor deleted that post
- [ ] Screenshot: **Settings → Brands** as the editor, delete button greyed out,
      with the owner-only line visible
- [ ] Screenshot: **Connections** as the editor, no Disconnect and no Use for
      publishing anywhere, with the owner-only line visible
- [ ] Screenshot: **SmartLinks → Public page** as the editor, controls greyed
      out, with the owner-only line visible
- [ ] Screenshot: Tester 1's **Team** card with **Leave workspace** greyed out
      and the only-owner sentence visible
- [ ] Screenshot: Tester 2's **Brand** dropdown after leaving, without Tester
      1's workspace
- [ ] Screenshot: Tester 1's **Team** card after the editor left, listing only
      Tester 1
- [ ] Note: that Tester 2 was re-invited and accepted again before step 22, with
      the date and time
- [ ] Screenshot: Tester 2 back in their own workspace, controls working again
- [ ] Screenshots (Part F): the approval switch as the owner (on) and as the
      editor (greyed out)
- [ ] Screenshot (Part F): the editor's composer offering only **Draft** and
      **Submit for approval**, no Scheduled and no Publish now
- [ ] Screenshot (Part F): the amber **pending approval** chip and the
      **Needs approval** legend entry
- [ ] Screenshot (Part F): the refusal when **Request changes** was clicked
      with an empty note
- [ ] Screenshot (Part F): the owner's note, word for word, as the editor
      sees it on the returned draft
- [ ] Screenshot (Part F): the approved post's normal scheduled chip, badge
      count gone
- [ ] Note (Part F): that the switch was turned back off and the editor could
      schedule directly again
- [ ] Note: date, time and time zone for each screenshot, and confirmation that
      two separate devices were used
- [ ] Check: no screenshot shows a password box or any long random code
- [ ] Send to the agreed evidence location

> Note for the release owner: this release ships no in-product control for a
> member to leave a workspace, so step 21 is expected to find nothing. The
> database permits self-removal; the UI does not offer it yet. Record the
> tester's answer either way — a control appearing here would be the surprise.

---

## When you are finished

Tell the release owner you are done and list which scripts you completed. Then:

- Delete any exported backup files from your device.
- You may keep or delete your test Facebook Pages, Instagram profiles and
  YouTube channel — check with the release owner first, in case any evidence
  still needs to be re-checked.
- Do not delete the evidence you sent.

---

## For the release owner — evidence mapping

Transcribe each completed script into the matching row of the
**Human-controlled provider acceptance** table in
[EXTERNAL_BETA_EVIDENCE.md](EXTERNAL_BETA_EVIDENCE.md). Record the date, the
tester, the result, and a link to the access-controlled evidence folder. Never
paste tokens, passwords or the testers' personal data into that record.

| Script | Evidence-record row (Scenario column) | Account/tester column | Key artefacts to link |
|---|---|---|---|
| First-run setup | Supports rows 1–9; also satisfies the "New customer" line in PRODUCTION_ONBOARDING §4 | Unrelated test account | Confirmation email, brand creation, first Connections view |
| 1 | Facebook OAuth, multi-Page selection, publish, remote link, disconnect | Unrelated test account | Page-choosing screen, multi-Page card, publishing-account switch, delivery panel, Facebook remote link, empty card after disconnect |
| 2 | Direct Instagram Business OAuth, image publish, remote link, disconnect | Unrelated test account | Instagram-only consent screen, connected card, delivery panel, Instagram remote link, card after disconnect |
| 3 | Direct Instagram Creator OAuth and token renewal | Unrelated test account | Day 1 / day 2 / day 7 dated card screenshots, day-7 publish + remote link. Pair with the hourly `connections` job evidence — the UI does not show renewal directly |
| 4 | YouTube OAuth, correct channel, private video upload, disconnect | Unrelated test account | Google consent screen, channel name on card, delivery panel, video link, YouTube Studio showing Private + channel, card after disconnect |
| 5 | Revoked credential becomes needs-reconnect without disabling a still-valid token on transient outage | Controlled provider account | Before/after Facebook apps list with removal timestamp, red **⚠️ Needs reconnecting** card, healthy YouTube card at the same moment, successful YouTube publish afterwards, healthy card after Reconnect. The transient-outage half remains covered by the automated regression tests |
| 6 | Tenant A cannot read/select/disconnect/publish through Tenant B assets | Two unrelated FablePeak users | Both signed-in Settings screenshots, both Brand dropdowns, Tester 2's Connections/Planner/Inbox/SmartLinks/Reports, the **"not authorised for this brand"** cloud-save refusal, post-reload dropdown |
| 7 | Scheduled mixed-network delivery retains success and visibly identifies failure | Unrelated test account | Composer with both networks, Scheduled chip, red Needs-attention chip, single delivery panel showing one published + one failed, Facebook remote link, proof of exactly one live copy |
| 8 | Account deletion and provider-data deletion instructions complete | Unrelated test account | data-deletion.html screenshot, disconnect per published steps, deletion-reference confirmation code (or email reply), Delete account box, signed-out state, failed re-sign-in |
| 9 | Owner-vs-editor enforcement: an invited editor composes and schedules but cannot delete the brand, disconnect or re-select accounts, or publish SmartLinks | Two unrelated FablePeak users (owner + editor) | Team card with the pending invite, Invitations banner, declined and revoked states, both Team cards after acceptance, the editor's scheduled post and Inbox reply, the editor's greyed-out Settings/Connections/SmartLinks controls with their owner-only lines, note on leaving the workspace. ADR 0006 decision 14 makes this a release gate for the role-enforcement step, not a follow-up |
