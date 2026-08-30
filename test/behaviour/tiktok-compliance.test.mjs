/* TikTok Content Posting API compliance — the composer's half.
 *
 * TikTok's Direct Post guidelines are a UX contract, not an API one: the form
 * must be built from the creator's own account settings, must not preselect an
 * audience, must disable the interactions their account disables, must collect
 * a commercial-content declaration, and must show the consent line beside the
 * control that posts. Everything below is asserted through the composer,
 * because the contract is about what the customer is shown and what that
 * produces — not about which function was called.
 *
 * The adapter half (the request body, the status poll, the sandbox gate) is in
 * supabase/functions/_shared/platforms.deno.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { TODAY, bootApp } from "../../test-harness/app.mjs";

const DAY = "2026-06-22";
const VIDEO = "https://cdn.example.com/clip.mp4";
const PRIVACY = "#pm_tt_privacy";
const panel = app => app.$("#pm_tiktok .tiktok-panel");
const consent = app => app.text("#pm_tt_consent");
const options = app => [...app.$(PRIVACY).options].map(o => o.value);
const saveButton = app => app.$(".modalfoot .right button.btn:not(.ghost)");

const account = (platform, id) => ({
  id, platform, display_name: `@acme-${platform}`, status: "active",
  is_default: true, needs_reauth: false, last_verified_at: "2026-06-15T11:55:00Z",
  last_error: null, avatar_url: null,
});
const brand = posts => ({
  id: "b1", name: "Acme", seed: 5, connections: { tiktok: "@acme" }, inbox: [], posts,
  approval_required: false,
  smartlink: { title: "Acme", bio: "", avatar: "🚀", color: "#22c1dc",
    links: [{ id: "l1", title: "Site", url: "https://example.com", clicks: 0 }] },
});

/** A signed-in cloud workspace with a connected TikTok account. `tiktokCreator`
 *  is whatever creator_info answers — that is the whole point of the feature. */
async function bootCloud(t, { tiktokCreator, posts = [] } = {}) {
  const app = await bootApp({
    mode: "cloud",
    cloud: {
      role: "owner", available: ["tiktok"], accounts: [account("tiktok", "a1")],
      tiktokCreator,
      db: { activeBrand: "b1", brands: [brand(posts)] },
    },
  });
  t.after(() => app.close());
  await app.waitFor(() => app.state.connCache.loaded, { label: "the connection cache" });
  return app;
}

async function openDay(app, date = DAY) {
  await app.click(`[aria-label="Schedule a post on ${date}"]`);
  await app.waitFor(() => app.$("#pm_text"), { label: "the post modal" });
}
async function selectNets(app, ...nets) {
  for (const box of app.$$("#pm_nets input")) await app.check(box, nets.includes(box.value));
}
/** Compose far enough that only the TikTok choices are left to make. */
async function composeForTikTok(app, { date = DAY } = {}) {
  await openDay(app, date);
  await app.fill("#pm_text", "Behind the scenes");
  await app.fill("#pm_media", VIDEO);
  await selectNets(app, "tiktok");
  await app.waitFor(() => panel(app)?.querySelector(PRIVACY), { label: "the TikTok panel" });
}

/* ---------- the panel appears with the network, and not before ---------- */

test("a composer that never mentions TikTok has no TikTok markup at all", async t => {
  const app = await bootCloud(t);
  await openDay(app);
  await selectNets(app, "tiktok");
  await app.waitFor(() => panel(app), { label: "the TikTok panel" });

  await selectNets(app);
  assert.equal(app.$("#pm_tiktok").innerHTML, "",
    "deselecting TikTok takes the whole form with it — not hidden controls");
  assert.equal(app.$("#pm_tt_consent").innerHTML, "",
    "…and the consent line, which only belongs beside a TikTok post");
});

test("the panel names the account that will actually be posted to", async t => {
  const app = await bootCloud(t, {
    tiktokCreator: {
      nickname: "@acme.studio", avatar_url: "",
      privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
      comment_disabled: false, duet_disabled: false, stitch_disabled: false,
      max_video_post_duration_sec: 300,
    },
  });
  await composeForTikTok(app);

  assert.match(app.text("#pm_tiktok .tiktok-creator"), /Posting to @acme\.studio/);
  assert.deepEqual(app.storeCalls.filter(c => c.name === "tiktokCreatorInfo").map(c => c.args),
    [["b1"]], "creator info is read once, lazily, for this brand");
});

/* ---------- decision: nothing is preselected ---------- */

test("no privacy level is preselected, and only the creator's own are offered", async t => {
  const app = await bootCloud(t, {
    tiktokCreator: {
      nickname: "@acme", avatar_url: "",
      // This account offers three of TikTok's four audiences.
      privacy_level_options: ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
      comment_disabled: false, duet_disabled: false, stitch_disabled: false,
      max_video_post_duration_sec: 600,
    },
  });
  await composeForTikTok(app);

  assert.equal(app.$(PRIVACY).value, "", "the select opens on a prompt, not on an audience");
  assert.deepEqual(options(app),
    ["", "PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
    "MUTUAL_FOLLOW_FRIENDS is not offered because this account does not offer it");
  assert.deepEqual(
    [...app.$(PRIVACY).options].filter(o => o.selected).map(o => o.value), [""],
    "nothing but the prompt is selected");
  assert.deepEqual(
    [...app.$(PRIVACY).options].slice(1).map(o => o.textContent.trim()),
    ["Everyone", "Followers", "Only you"], "TikTok's own labels");

  // …and the save is refused rather than defaulted.
  await app.click(saveButton(app));
  assert.equal(app.toast(), "Choose who can see this video on TikTok");
  assert.equal(app.modalOpen(), true, "the composer keeps the words while it says so");
  assert.equal(app.db.brands[0].posts.length, 0);
});

/* ---------- decision: the account's own restrictions are honoured ---------- */

test("an interaction the creator's account disables is off and cannot be turned on", async t => {
  const app = await bootCloud(t, {
    tiktokCreator: {
      nickname: "@acme", avatar_url: "",
      privacy_level_options: ["PUBLIC_TO_EVERYONE"],
      comment_disabled: true, duet_disabled: false, stitch_disabled: true,
      max_video_post_duration_sec: 600,
    },
  });
  await composeForTikTok(app);

  for (const [id, disabled] of [
    ["#pm_tt_comment", true], ["#pm_tt_duet", false], ["#pm_tt_stitch", true],
  ]) {
    assert.equal(app.$(id).disabled, disabled, `${id} follows the account`);
    assert.equal(app.$(id).checked, !disabled, `${id} is off when the account disables it`);
  }
  assert.match(app.text("#pm_tiktok"), /comments turned off/);

  await app.fill(PRIVACY, "PUBLIC_TO_EVERYONE");
  await app.click(saveButton(app));
  await app.waitFor(() => app.db.brands[0].posts.length, { label: "the saved post" });
  // Spread into this realm: the app's object comes from jsdom's, and a strict
  // deep-equal compares prototypes as well as values.
  assert.deepEqual({ ...app.db.brands[0].posts[0].tiktok_options }, {
    privacy_level: "PUBLIC_TO_EVERYONE",
    disable_comment: true, disable_duet: false, disable_stitch: true,
    disclose_commercial: false, brand_organic: false, brand_content: false,
  }, "what the form said is what the post records");
});

/* ---------- decision: the commercial-content declaration ---------- */

test("disclosure asks what the video promotes, and refuses to be left unanswered", async t => {
  const app = await bootCloud(t);
  await composeForTikTok(app);
  await app.fill(PRIVACY, "PUBLIC_TO_EVERYONE");

  assert.equal(app.$("#pm_tt_brand_organic"), null, "the boxes are absent until disclosure is on");
  await app.check("#pm_tt_disclose", true);
  await app.waitFor(() => app.$("#pm_tt_brand_organic"), { label: "the disclosure boxes" });
  assert.equal(app.$("#pm_tt_brand_organic").checked, false);
  assert.equal(app.$("#pm_tt_brand_content").checked, false);

  await app.click(saveButton(app));
  assert.equal(app.toast(),
    "Say what this video promotes — your brand, branded content, or both");
  assert.equal(app.db.brands[0].posts.length, 0);

  await app.check("#pm_tt_brand_organic", true);
  await app.click(saveButton(app));
  await app.waitFor(() => app.db.brands[0].posts.length, { label: "the saved post" });
  const saved = app.db.brands[0].posts[0].tiktok_options;
  assert.equal(saved.disclose_commercial, true);
  assert.equal(saved.brand_organic, true);
  assert.equal(saved.brand_content, false);
});

test("turning disclosure off retracts both claims with it", async t => {
  const app = await bootCloud(t);
  await composeForTikTok(app);
  await app.fill(PRIVACY, "PUBLIC_TO_EVERYONE");
  await app.check("#pm_tt_disclose", true);
  await app.waitFor(() => app.$("#pm_tt_brand_content"), { label: "the disclosure boxes" });
  await app.check("#pm_tt_brand_content", true);
  await app.check("#pm_tt_disclose", false);

  await app.click(saveButton(app));
  await app.waitFor(() => app.db.brands[0].posts.length, { label: "the saved post" });
  const saved = app.db.brands[0].posts[0].tiktok_options;
  assert.deepEqual(
    [saved.disclose_commercial, saved.brand_organic, saved.brand_content],
    [false, false, false],
    "an undisclosed post must not still carry a partnership flag");
});

/* ---------- decision: branded content cannot be private ---------- */

test("branded content withdraws the private audience and explains why", async t => {
  const app = await bootCloud(t);
  await composeForTikTok(app);
  await app.fill(PRIVACY, "SELF_ONLY");
  await app.check("#pm_tt_disclose", true);
  await app.waitFor(() => app.$("#pm_tt_brand_content"), { label: "the disclosure boxes" });

  await app.check("#pm_tt_brand_content", true);
  assert.equal(app.toast(),
    "TikTok doesn't allow branded content to be private — choose who can see it.");
  assert.equal(app.$(PRIVACY).value, "", "the audience it cannot have is cleared, not kept");
  const selfOnly = [...app.$(PRIVACY).options].find(o => o.value === "SELF_ONLY");
  assert.equal(selfOnly.disabled, true, "…and cannot be chosen again while this is branded content");

  await app.click(saveButton(app));
  assert.equal(app.toast(), "Choose who can see this video on TikTok");

  await app.fill(PRIVACY, "PUBLIC_TO_EVERYONE");
  await app.click(saveButton(app));
  await app.waitFor(() => app.db.brands[0].posts.length, { label: "the saved post" });
  assert.equal(app.db.brands[0].posts[0].tiktok_options.privacy_level, "PUBLIC_TO_EVERYONE");
});

/* ---------- decision: the consent line ---------- */

test("the consent line sits beside Save and changes with the declaration", async t => {
  const app = await bootCloud(t);
  await composeForTikTok(app);

  assert.equal(consent(app), "By posting, you agree to TikTok's Music Usage Confirmation.");
  const music = app.$("#pm_tt_consent a");
  assert.equal(music.getAttribute("href"),
    "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en");

  await app.fill(PRIVACY, "PUBLIC_TO_EVERYONE");
  await app.check("#pm_tt_disclose", true);
  await app.waitFor(() => app.$("#pm_tt_brand_content"), { label: "the disclosure boxes" });
  await app.check("#pm_tt_brand_content", true);

  assert.equal(consent(app),
    "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.");
  assert.deepEqual(app.$$("#pm_tt_consent a").map(a => a.getAttribute("href")), [
    "https://www.tiktok.com/legal/page/global/bc-policy/en",
    "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en",
  ]);
  // It is the last thing before the buttons that post, which is where TikTok
  // requires it to be.
  assert.equal(app.$("#pm_tt_consent").nextElementSibling.className, "modalfoot");
});

/* ---------- decision: the video must fit the creator's account ---------- */

test("a video longer than the account allows is refused with both numbers", async t => {
  const app = await bootCloud(t, {
    tiktokCreator: {
      nickname: "@acme", avatar_url: "",
      privacy_level_options: ["PUBLIC_TO_EVERYONE"],
      comment_disabled: false, duet_disabled: false, stitch_disabled: false,
      max_video_post_duration_sec: 60,
    },
  });
  await composeForTikTok(app);
  await app.fill(PRIVACY, "PUBLIC_TO_EVERYONE");

  // The probe reads metadata off the real URL, which no test may fetch — so
  // the measured length is installed the way the probe would have left it.
  app.setState("composerTikTok", app.intoPage({ ...app.state.composerTikTok, duration: 154 }));
  await app.call("renderTikTokPanel");
  assert.match(app.text("#pm_tiktok .tiktok-note.over"), /154 seconds.*up to 60 seconds/);

  await app.click(saveButton(app));
  assert.equal(app.toast(), "TikTok allows 60 seconds — this video is 154. Trim it.");
  assert.equal(app.db.brands[0].posts.length, 0);
});

test("a length the browser could not measure warns but never blocks", async t => {
  const app = await bootCloud(t);
  await composeForTikTok(app);
  await app.fill(PRIVACY, "PUBLIC_TO_EVERYONE");

  assert.equal(app.state.composerTikTok.duration, null);
  assert.match(app.text("#pm_tiktok"), /length could not be checked here/,
    "the server's answer at publish time is the truth, and the panel says so");
  await app.click(saveButton(app));
  await app.waitFor(() => app.db.brands[0].posts.length, { label: "the saved post" });
});

/* ---------- what the post carries ---------- */

test("the options ride the post, and leave with the network", async t => {
  const app = await bootCloud(t);
  await composeForTikTok(app);
  await app.fill(PRIVACY, "FOLLOWER_OF_CREATOR");
  await app.check("#pm_tt_duet", false);
  await app.click(saveButton(app));
  await app.waitFor(() => app.db.brands[0].posts.length, { label: "the saved post" });

  const [post] = app.db.brands[0].posts;
  assert.equal(post.tiktok_options.privacy_level, "FOLLOWER_OF_CREATOR");
  assert.equal(post.tiktok_options.disable_duet, true, "unchecking Allow duet disables it");

  // Reopening shows the choices back, because they are the customer's and were
  // already made — the no-default rule is about a composer that has none yet.
  await app.call("openPostModal", post.id);
  await app.waitFor(() => app.$(PRIVACY), { label: "the TikTok panel" });
  assert.equal(app.$(PRIVACY).value, "FOLLOWER_OF_CREATOR");
  assert.equal(app.$("#pm_tt_duet").checked, false);

  // Dropping TikTok drops its choices: a post that does not publish there has
  // no audience anybody picked for it.
  await selectNets(app, "x");
  await app.fill("#pm_media", "");
  await app.click(saveButton(app));
  await app.waitFor(() => app.db.brands[0].posts[0].tiktok_options === null,
    { label: "the cleared options" });
});

/* ---------- local and demo workspaces ---------- */

test("a local workspace gets the same form, labelled simulated, and touches no network", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForTikTok(app, { date: TODAY });

  assert.match(app.text("#pm_tiktok"), /Simulated — posting to TikTok needs a cloud workspace/);
  assert.equal(app.$(PRIVACY).value, "", "no preselected audience here either");
  assert.deepEqual(options(app).slice(1),
    ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]);
  assert.equal(consent(app), "By posting, you agree to TikTok's Music Usage Confirmation.");
  assert.deepEqual(app.blockedRequests, [], "a simulated panel reaches nothing at all");

  await app.fill(PRIVACY, "PUBLIC_TO_EVERYONE");
  await app.click(saveButton(app));
  await app.waitFor(() => app.$(".modal") === null || !app.modalOpen(),
    { label: "the composer to close" });
  const saved = app.db.brands.find(b => b.id === app.db.activeBrand).posts
    .find(p => p.text === "Behind the scenes");
  assert.equal(saved.tiktok_options.privacy_level, "PUBLIC_TO_EVERYONE");
});

/* ---------- the account might not answer ---------- */

test("a creator_info refusal says so instead of rendering a form nobody can use", async t => {
  const app = await bootCloud(t, {
    tiktokCreator: { error: "TikTok could not answer (HTTP 401)." },
  });
  await openDay(app);
  await app.fill("#pm_text", "Behind the scenes");
  await app.fill("#pm_media", VIDEO);
  await selectNets(app, "tiktok");
  await app.waitFor(() => app.state.composerTikTok.loaded, { label: "the creator lookup" });

  assert.match(app.text("#pm_tiktok"), /TikTok could not answer \(HTTP 401\)\./);
  assert.equal(app.$(PRIVACY), null, "no select that cannot produce a valid choice");
  assert.equal(consent(app), "", "and no consent line for a post that cannot be composed");

  await app.click(saveButton(app));
  assert.equal(app.toast(), "Choose who can see this video on TikTok");
  assert.equal(app.db.brands[0].posts.length, 0);
});

/* ---------- dirty state ---------- */

test("choosing an audience is an unsaved change the Escape guard defends", async t => {
  const app = await bootCloud(t);
  await composeForTikTok(app);
  app.setState("composerBaseline", app.call("composerSnapshot"));

  await app.fill(PRIVACY, "PUBLIC_TO_EVERYONE");
  app.answerConfirm(false);
  await app.press("#pm_status", "Escape");
  assert.deepEqual(app.confirms, ["Discard this post?"],
    "a TikTok choice is content worth keeping, like the post's own text");
  assert.equal(app.modalOpen(), true);
  assert.equal(app.$(PRIVACY).value, "PUBLIC_TO_EVERYONE", "declining keeps it");
});

/* ---------- backup round trip ---------- */

/* Settings → Import backup is a first-class untrusted input path: whatever it
   accepts is rendered and, on the next sync, reaches Supabase. TikTok's
   choices are now part of a post, so they have to survive their own backup —
   and a file that carries choices TikTok itself refuses has to be rejected
   before it reaches `db`, not after the CHECK constraint refuses the row. */

const BACKUP_PREFIX = "data:application/json;charset=utf-8,";
async function openSettings(app) {
  await app.click(app.byText("#nav button", "Settings"));
  await app.waitFor(() => app.byText("#main button", "Export backup"), { label: "Settings" });
}
async function exportBackup(app) {
  await app.click(app.byText("#main button", "Export backup"));
  return decodeURIComponent(app.downloads.at(-1).href.slice(BACKUP_PREFIX.length));
}
async function importBackup(app, body) {
  await app.click(app.byText("#main button", "Import backup"));
  await app.selectFile("#impFile", { body });
}

test("a post's TikTok choices survive an export and its import", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForTikTok(app, { date: TODAY });
  await app.fill(PRIVACY, "MUTUAL_FOLLOW_FRIENDS");
  await app.check("#pm_tt_stitch", false);
  await app.check("#pm_tt_disclose", true);
  await app.waitFor(() => app.$("#pm_tt_brand_organic"), { label: "the disclosure boxes" });
  await app.check("#pm_tt_brand_organic", true);
  await app.click(saveButton(app));
  await app.waitFor(() => !app.modalOpen(), { label: "the composer to close" });

  await openSettings(app);
  const json = await exportBackup(app);
  const exported = JSON.parse(json).brands[0].posts.find(p => p.text === "Behind the scenes");
  assert.deepEqual(exported.tiktok_options, {
    privacy_level: "MUTUAL_FOLLOW_FRIENDS",
    disable_comment: false, disable_duet: false, disable_stitch: true,
    disclose_commercial: true, brand_organic: true, brand_content: false,
  });

  await importBackup(app, json);
  assert.equal(app.toast(), "Backup restored ✔");
  const restored = app.db.brands[0].posts.find(p => p.text === "Behind the scenes");
  assert.equal(restored.tiktok_options.privacy_level, "MUTUAL_FOLLOW_FRIENDS");
  assert.equal(restored.tiktok_options.brand_organic, true);
});

test("a backup carrying choices TikTok itself refuses never reaches the workspace", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);
  const json = await exportBackup(app);
  const before = JSON.stringify(app.db);

  for (const tiktok_options of [
    { privacy_level: "EVERYBODY" },                                  // not a TikTok audience
    { privacy_level: "PUBLIC_TO_EVERYONE", disable_comment: "yes" }, // not a boolean
    { privacy_level: "PUBLIC_TO_EVERYONE", surprise: true },         // not a key we collect
    { disable_comment: true },                                       // no audience at all
    { privacy_level: "PUBLIC_TO_EVERYONE", disclose_commercial: true },
    { privacy_level: "SELF_ONLY", disclose_commercial: true, brand_content: true },
  ]) {
    const parsed = JSON.parse(json);
    parsed.brands[0].posts[0].tiktok_options = tiktok_options;
    await importBackup(app, JSON.stringify(parsed));
    assert.equal(app.toast(), "Invalid backup file",
      `accepted ${JSON.stringify(tiktok_options)}`);
    assert.equal(JSON.stringify(app.db), before, "a rejected import changes nothing");
  }
});
