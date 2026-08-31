/* ADR 0005 publishing depth — the per-post Instagram options in the composer.
 *
 * Two choices Instagram gives the customer that FablePeak has so far made for
 * them by omission: where a Reel appears, and what a screen reader says about an
 * image. Both are asserted through the composer, because the contract customers
 * actually meet is "the choice I was shown is the choice that was stored", and
 * because the most important assertion in the whole feature is a negative one —
 * a post that makes neither choice must still be exactly the post it was.
 *
 * Local mode throughout: these are client state until publish time, so a demo or
 * local workspace composes them for real without a single network call.
 *
 * The adapter half — which parameter reaches which container, and the
 * byte-identical baseline when there are no options — is in
 * supabase/functions/_shared/platforms.deno.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "../../test-harness/app.mjs";

const DAY = "2026-06-22";
const IMAGE = "https://cdn.example.com/cover.jpg";
const VIDEO = "https://cdn.example.com/clip.mp4";
const BACKUP_PREFIX = "data:application/json;charset=utf-8,";
const saveButton = app => app.$(".modalfoot .right button.btn:not(.ghost)");
const panel = app => app.$("#pm_instagram .instagram-panel");
const altBox = app => app.$("#pm_ig_alt");
const choices = app => app.$$("#pm_instagram input[name=pm_ig_share]");
const checkedChoice = app => choices(app).find(radio => radio.checked)?.value ?? null;

async function openDay(app, date = DAY) {
  await app.click(`[aria-label="Schedule a post on ${date}"]`);
  await app.waitFor(() => app.$("#pm_text"), { label: "the post modal" });
}
async function selectNets(app, ...nets) {
  for (const box of app.$$("#pm_nets input")) await app.check(box, nets.includes(box.value));
}
/** Compose far enough that only the Instagram choices are left to make. */
async function composeForInstagram(app, { media = IMAGE, date = DAY } = {}) {
  await openDay(app, date);
  await app.fill("#pm_text", "One good picture");
  await app.fill("#pm_media", media);
  await selectNets(app, "instagram");
  await app.waitFor(() => panel(app), { label: "the Instagram panel" });
}
const savedPost = app => app.db.brands[0].posts.at(-1);
async function save(app) {
  await app.click(saveButton(app));
  await app.waitFor(() => !app.modalOpen(), { label: "the composer to close" });
}

/* ---------- the affordance belongs to Instagram, and to its media ---------- */

test("a composer that does not target Instagram has no Instagram markup at all", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openDay(app);
  await app.fill("#pm_media", IMAGE);
  await selectNets(app, "x", "facebook");

  assert.equal(app.$("#pm_instagram").innerHTML, "",
    "no Instagram, no panel — not hidden controls the keyboard would still walk");
  assert.equal(altBox(app), null);

  await selectNets(app, "x", "facebook", "instagram");
  assert.ok(panel(app), "selecting Instagram brings the choices with it");

  await selectNets(app, "x", "facebook");
  assert.equal(app.$("#pm_instagram").innerHTML, "", "deselecting takes the whole panel away");
});

test("with no media there is nothing to place and nothing to describe", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openDay(app);
  await selectNets(app, "instagram");

  assert.equal(app.$("#pm_instagram").innerHTML, "",
    "the choices are about the media, so they wait for it");

  await app.fill("#pm_media", IMAGE);
  assert.ok(panel(app), "…and arrive with it");
});

test("the panel says it is simulated in a local workspace, and contacts nothing", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);

  assert.match(app.text("#pm_instagram"), /Simulated/,
    "a local workspace cannot post to Instagram and says so beside the controls");
  assert.deepEqual(app.blockedRequests, [], "and nothing here reaches the network");
});

/* ---------- a video: where the Reel appears ---------- */

test("a video is offered the three placements, and only Instagram's default is preselected", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app, { media: VIDEO });

  assert.match(app.text("#pm_instagram"), /Where does this video appear\?/);
  assert.deepEqual(choices(app).map(radio => radio.value), ["", "true", "false"]);
  assert.equal(checkedChoice(app), "",
    "the default is preselected because it IS today's behaviour — nothing else may be");
  assert.match(app.text("#pm_instagram"), /Reel \+ Home feed/);
  assert.match(app.text("#pm_instagram"), /Reel only/);
  assert.equal(altBox(app), null, "a video has no alt text to write");
});

test("leaving the placement alone stores no Instagram options at all", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app, { media: VIDEO });
  await save(app);

  assert.equal(savedPost(app).instagram_options, null,
    "an untouched panel must leave the post exactly as it was before this feature");
});

test("each placement stores the boolean it stands for", async t => {
  for (const [index, expected] of [[1, true], [2, false]]) {
    const app = await bootApp({ mode: "local" });
    await composeForInstagram(app, { media: VIDEO });
    await app.check(`#pm_ig_share_${index}`, true);
    await save(app);

    assert.deepEqual({ ...savedPost(app).instagram_options }, { share_to_feed: expected });
    app.close();
  }
});

test("choosing a placement and then going back to the default clears it again", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app, { media: VIDEO });
  await app.check("#pm_ig_share_2", true);
  await app.check("#pm_ig_share_0", true);
  await save(app);

  assert.equal(savedPost(app).instagram_options, null,
    "'Instagram default' is the absence of a preference, not a third value to send");
});

test("a saved placement reopens as itself", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app, { media: VIDEO });
  await app.check("#pm_ig_share_2", true);
  await save(app);

  await app.click(app.byText(".calgrid .post", "One good picture"));
  await app.waitFor(() => panel(app), { label: "the Instagram panel" });
  assert.equal(checkedChoice(app), "false", "the choice the customer made is the choice shown");
});

/* ---------- a single image: alt text ---------- */

test("a single image is offered alt text, with a counter and a screen-reader placeholder", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);

  assert.ok(altBox(app), "an image has a description to write");
  assert.match(altBox(app).placeholder, /screen reader/);
  assert.equal(choices(app).length, 0, "an image is not a Reel and has no placement");

  await app.fill("#pm_ig_alt", "A grey cat asleep on a stack of books");
  assert.equal(app.text("#pm_ig_alt_count"), "37 / 1000");
});

test("alt text is stored, reopens as itself, and survives a duplicate", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await app.fill("#pm_ig_alt", "  A grey cat asleep on a stack of books  ");
  await save(app);

  assert.deepEqual({ ...savedPost(app).instagram_options },
    { alt_text: "A grey cat asleep on a stack of books" },
    "trimmed — leading whitespace is not a description, and it is read aloud");

  await app.click(app.byText(".calgrid .post", "One good picture"));
  await app.waitFor(() => altBox(app), { label: "the alt text field" });
  assert.equal(altBox(app).value, "A grey cat asleep on a stack of books");

  await app.click(app.byText(".modalfoot button", "Duplicate"));
  const copies = app.db.brands[0].posts.filter(p => p.text === "One good picture");
  assert.equal(copies.length, 2);
  assert.deepEqual([...copies.map(p => p.instagram_options.alt_text)],
    ["A grey cat asleep on a stack of books", "A grey cat asleep on a stack of books"]);
});

test("empty alt text stores nothing — Instagram writes its own", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await app.fill("#pm_ig_alt", "   ");
  await save(app);

  assert.equal(savedPost(app).instagram_options, null);
});

test("alt text past Instagram's 1000 is refused rather than trimmed", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await app.fill("#pm_ig_alt", "x".repeat(1001));

  const before = app.db.brands[0].posts.length;
  await app.click(saveButton(app));
  assert.equal(app.toast(),
    "Instagram allows 1000 characters of alt text — this is 1001. Shorten it.");
  assert.equal(app.modalOpen(), true, "a refused post keeps the composer open");
  assert.equal(app.db.brands[0].posts.length, before);
  assert.match(app.$("#pm_ig_alt_count").className, /over/, "…and the counter said so first");
});

/* ---------- a carousel: one description per item ---------- */

const itemAlts = app => app.$$("#pm_carousel input[data-carousel-alt]");
/** Add `count` extra items, each with a distinct URL — a real carousel of
    `count + 1` items, the cover included. */
async function addItems(app, count) {
  for (let index = 0; index < count; index++) {
    await app.click(app.byText("#pm_carousel button", "Add another"));
    await app.fill(`#pm_carousel_${index}`, `https://cdn.example.com/${index + 2}.jpg`);
  }
}

test("a carousel asks for one description per item, beside each item", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await app.fill("#pm_ig_alt", "A grey cat asleep on a stack of books");
  await addItems(app, 2);

  assert.equal(altBox(app), null,
    "alt_text is a per-container parameter, so one description cannot cover ten items");
  assert.equal(itemAlts(app).length, 3, "the cover is a container like any other, so it has one");
  assert.deepEqual(itemAlts(app).map(box => box.getAttribute("aria-label")), [
    "Alt text for carousel item 1", "Alt text for carousel item 2",
    "Alt text for carousel item 3",
  ], "a screen reader has to be able to tell which picture it is describing");
  assert.match(app.text("#pm_instagram"), /one\s+description per item/,
    "…and the panel points at them rather than apologising for their absence");

  await app.fill("#pm_carousel_alt_0", "A grey cat asleep on a stack of books");
  assert.equal(app.text("#pm_carousel_alt_0_count"), "37 / 1000",
    "the same counter treatment the single image's description gets");
});

test("the descriptions are stored in the carousel's own order", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await addItems(app, 2);
  await app.fill("#pm_carousel_alt_0", "  The cover  ");
  await app.fill("#pm_carousel_alt_2", "The third picture");
  await save(app);

  const saved = savedPost(app);
  assert.deepEqual([...saved.media_urls],
    [IMAGE, "https://cdn.example.com/2.jpg", "https://cdn.example.com/3.jpg"]);
  assert.deepEqual([...saved.instagram_options.carousel_alt_texts],
    ["The cover", "", "The third picture"],
    "the blank in the middle is a position, not a gap — item three is item three");
});

test("trailing blanks are trimmed, and a carousel nobody described stores nothing", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await addItems(app, 2);
  await save(app);
  assert.equal(savedPost(app).instagram_options, null,
    "an untouched carousel must leave the post exactly as it was before this feature");

  await composeForInstagram(app, { date: "2026-06-23" });
  await addItems(app, 2);
  await app.fill("#pm_carousel_alt_0", "The cover");
  await save(app);
  assert.deepEqual([...savedPost(app).instagram_options.carousel_alt_texts], ["The cover"],
    "a trailing blank says nothing an absent entry does not, so it is not stored");
});

test("removing an item takes its description with it, and the rest keep their places", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await addItems(app, 3);
  for (const slot of [0, 1, 2, 3]) await app.fill(`#pm_carousel_alt_${slot}`, `Item ${slot + 1}`);

  await app.click(app.$$("#pm_carousel [data-action=removeCarouselItem]")[1]);
  assert.deepEqual(itemAlts(app).map(box => box.value), ["Item 1", "Item 2", "Item 4"],
    "the description goes with the picture it described, not with the slot number");

  await save(app);
  const saved = savedPost(app);
  assert.deepEqual([...saved.media_urls],
    [IMAGE, "https://cdn.example.com/2.jpg", "https://cdn.example.com/4.jpg"]);
  assert.deepEqual([...saved.instagram_options.carousel_alt_texts],
    ["Item 1", "Item 2", "Item 4"], "…and the two arrays still describe each other");
});

test("an item whose URL was left blank takes its description out of the alignment", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await addItems(app, 2);
  await app.fill("#pm_carousel_0", "");
  await app.fill("#pm_carousel_alt_0", "The cover");
  await app.fill("#pm_carousel_alt_1", "A picture nobody added");
  await app.fill("#pm_carousel_alt_2", "The one after it");
  await save(app);

  const saved = savedPost(app);
  assert.deepEqual([...saved.media_urls], [IMAGE, "https://cdn.example.com/3.jpg"]);
  assert.deepEqual([...saved.instagram_options.carousel_alt_texts],
    ["The cover", "The one after it"],
    "a description for an item that is not published would shift every later one");
});

test("a saved carousel reopens with its descriptions, and duplicating carries them", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await addItems(app, 2);
  await app.fill("#pm_carousel_alt_0", "The cover");
  await app.fill("#pm_carousel_alt_2", "The third picture");
  await save(app);

  await app.click(app.byText(".calgrid .post", "One good picture"));
  await app.waitFor(() => itemAlts(app).length, { label: "the carousel descriptions" });
  assert.deepEqual(itemAlts(app).map(box => box.value),
    ["The cover", "", "The third picture"],
    "the descriptions the customer wrote are the descriptions shown");

  await app.click(app.byText(".modalfoot button", "Duplicate"));
  const copies = app.db.brands[0].posts.filter(p => p.text === "One good picture");
  assert.equal(copies.length, 2);
  for (const copy of copies) {
    assert.deepEqual([...copy.instagram_options.carousel_alt_texts],
      ["The cover", "", "The third picture"]);
  }
});

test("a carousel description past Instagram's 1000 names the item it belongs to", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await addItems(app, 1);
  await app.fill("#pm_carousel_alt_1", "x".repeat(1001));

  const before = app.db.brands[0].posts.length;
  await app.click(saveButton(app));
  assert.equal(app.toast(),
    "Instagram allows 1000 characters of alt text — carousel item 2 is 1001. Shorten it.",
    "the number the customer is looking at, not a zero-based index");
  assert.equal(app.modalOpen(), true, "a refused post keeps the composer open");
  assert.equal(app.db.brands[0].posts.length, before);
  assert.match(app.$("#pm_carousel_alt_1_count").className, /over/,
    "…and the counter said so first");
});

test("a hostile carousel description is a string in an input and never markup", async t => {
  const payload = `Cat"><img src=x onerror="__pwn()"><script>__pwn()</script>`;
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  app.eval("window.__pwnHits = 0; window.__pwn = () => { window.__pwnHits++; };");

  await composeForInstagram(app);
  await addItems(app, 1);
  await app.fill("#pm_carousel_alt_1", payload);
  await save(app);

  await app.click(app.byText(".calgrid .post", "One good picture"));
  await app.waitFor(() => itemAlts(app).length, { label: "the carousel descriptions" });

  assert.equal(app.$("#pm_carousel_alt_1").value, payload, "it reads back verbatim…");
  assert.deepEqual(
    app.$$("script, iframe, [onerror], [onload]", app.modal()).map(el => el.outerHTML), [],
    "…and never became markup");
  assert.equal(app.eval("window.__pwnHits"), 0);
});

test("the single image's description gives way to the carousel's, and is not stored behind it", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await app.fill("#pm_ig_alt", "A grey cat asleep on a stack of books");

  // One row is enough: the question the panel asks is already the carousel's,
  // before its URL is typed, because the row is on screen.
  await app.click(app.byText("#pm_carousel button", "Add another"));
  assert.equal(altBox(app), null);
  assert.equal(itemAlts(app).length, 2);

  await save(app);
  assert.equal(savedPost(app).instagram_options, null,
    "the description that no longer applies is not stored behind the customer's back");
});

test("removing the last carousel item offers alt text back, with what was typed", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await app.fill("#pm_ig_alt", "A grey cat asleep on a stack of books");
  await app.click(app.byText("#pm_carousel button", "Add another"));
  await app.fill("#pm_carousel_0", "https://cdn.example.com/2.jpg");
  assert.equal(altBox(app), null);

  await app.click(app.$("#pm_carousel [data-action=removeCarouselItem]"));
  assert.equal(altBox(app).value, "A grey cat asleep on a stack of books",
    "the panel is rebuilt, but what was typed is state — a rebuild must not lose it");
});

test("swapping an image for a video swaps the question, and stores only what was asked", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await app.fill("#pm_ig_alt", "A grey cat asleep on a stack of books");

  await app.fill("#pm_media", VIDEO);
  assert.equal(altBox(app), null, "a video has no image to describe");
  await app.check("#pm_ig_share_1", true);
  await save(app);

  assert.deepEqual({ ...savedPost(app).instagram_options }, { share_to_feed: true },
    "the alt text belonged to an image this post no longer has");
});

test("dropping Instagram clears the choices with the target", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await app.fill("#pm_ig_alt", "A grey cat asleep on a stack of books");
  await selectNets(app, "facebook");
  await save(app);

  assert.equal(savedPost(app).instagram_options, null,
    "Facebook has no Reel placement and no alt text, so the post records none");
});

/* ---------- containment ---------- */

test("hostile alt text is a string in an input and never markup", async t => {
  const payload = `Cat"><img src=x onerror="__pwn()"><script>__pwn()</script>`;
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  app.eval("window.__pwnHits = 0; window.__pwn = () => { window.__pwnHits++; };");

  await composeForInstagram(app);
  await app.fill("#pm_ig_alt", payload);
  await save(app);

  await app.click(app.byText(".calgrid .post", "One good picture"));
  await app.waitFor(() => altBox(app), { label: "the alt text field" });

  assert.equal(altBox(app).value, payload, "it reads back verbatim…");
  assert.deepEqual(
    app.$$("script, iframe, [onerror], [onload]", app.modal()).map(el => el.outerHTML), [],
    "…and never became markup");
  assert.equal(app.eval("window.__pwnHits"), 0);
});

/* ---------- the unsaved-changes guard ---------- */

test("editing only the alt text is an unsaved change the Escape guard defends", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  // Everything so far armed the composer; re-arm so the only change under test
  // is the description itself.
  app.setState("composerBaseline", app.call("composerSnapshot"));

  await app.fill("#pm_ig_alt", "A grey cat asleep on a stack of books");

  app.answerConfirm(false);
  await app.press("#pm_status", "Escape");
  assert.deepEqual(app.confirms, ["Discard this post?"],
    "a description somebody wrote is worth the same question as the post's own words");
  assert.equal(app.modalOpen(), true);
});

/* ---------- the backup boundary ---------- */

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

test("Instagram options survive an export and its import", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await app.fill("#pm_ig_alt", "A grey cat asleep on a stack of books");
  await save(app);

  await openSettings(app);
  const json = await exportBackup(app);
  const exported = JSON.parse(json).brands[0].posts.find(p => p.text === "One good picture");
  assert.deepEqual(exported.instagram_options,
    { alt_text: "A grey cat asleep on a stack of books" });

  await importBackup(app, json);
  assert.equal(app.toast(), "Backup restored ✔");
  const restored = app.db.brands[0].posts.find(p => p.text === "One good picture");
  assert.deepEqual({ ...restored.instagram_options }, exported.instagram_options);
});

test("a carousel's descriptions survive an export and its import", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await addItems(app, 2);
  await app.fill("#pm_carousel_alt_0", "The cover");
  await app.fill("#pm_carousel_alt_2", "The third picture");
  await save(app);

  await openSettings(app);
  const json = await exportBackup(app);
  const exported = JSON.parse(json).brands[0].posts.find(p => p.text === "One good picture");
  assert.deepEqual(exported.instagram_options,
    { carousel_alt_texts: ["The cover", "", "The third picture"] });

  await importBackup(app, json);
  assert.equal(app.toast(), "Backup restored ✔");
  const restored = app.db.brands[0].posts.find(p => p.text === "One good picture");
  assert.deepEqual([...restored.instagram_options.carousel_alt_texts],
    exported.instagram_options.carousel_alt_texts);
});

test("a backup carrying Instagram options the column would refuse never reaches the workspace", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);
  const json = await exportBackup(app);
  const before = JSON.stringify(app.db);

  for (const instagram_options of [
    {},                                              // "no options" is spelled null
    { share_to_feed: "true" },                       // a string is not the boolean
    { share_to_feed: 1 },
    { alt_text: "x".repeat(1001) },                  // past Instagram's ceiling
    { alt_text: "line one\nline two" },              // a control character
    { alt_text: 42 },
    { share_to_feed: true, caption: "extra" },       // an unknown key is a drifted client
    { boomerang: true },
    [{ share_to_feed: true }],                       // not an object
    // …and the same rules per entry, for the carousel's own descriptions.
    { carousel_alt_texts: [] },                      // "none" is spelled by absence
    { carousel_alt_texts: Array(11).fill("A cat") }, // past Instagram's ten items
    { carousel_alt_texts: ["x".repeat(1001)] },      // past Instagram's ceiling
    { carousel_alt_texts: ["line one\nline two"] },  // a control character
    { carousel_alt_texts: ["A cat", 42] },
    { carousel_alt_texts: "A cat" },                 // not an array
  ]) {
    const parsed = JSON.parse(json);
    parsed.brands[0].posts[0].instagram_options = instagram_options;
    await importBackup(app, JSON.stringify(parsed));
    assert.equal(app.toast(), "Invalid backup file",
      `accepted ${JSON.stringify(instagram_options)}`);
    assert.equal(JSON.stringify(app.db), before, "a rejected import changes nothing");
  }
});

test("a backup with no Instagram options at all is still a valid backup", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);
  const json = await exportBackup(app);

  for (const instagram_options of [undefined, null, { share_to_feed: false },
                                   { alt_text: "A cat" },
                                   { share_to_feed: true, alt_text: "A cat" },
                                   // The widening: everything above was valid
                                   // before carousel_alt_texts existed and stays
                                   // valid, and the new key joins them.
                                   { carousel_alt_texts: [""] },
                                   { carousel_alt_texts: ["A cat", "", "A dog"] },
                                   { carousel_alt_texts: Array(10).fill("A cat") }]) {
    const parsed = JSON.parse(json);
    if (instagram_options === undefined) delete parsed.brands[0].posts[0].instagram_options;
    else parsed.brands[0].posts[0].instagram_options = instagram_options;
    await importBackup(app, JSON.stringify(parsed));
    assert.equal(app.toast(), "Backup restored ✔",
      `refused ${JSON.stringify(instagram_options)}`);
  }
});
