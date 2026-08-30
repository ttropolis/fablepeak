/* ADR 0005 publishing depth — Instagram carousels in the composer.
 *
 * ADR 0005 decision 14 cut carousels from v1 because they need a media *array*
 * and an N-container upload flow. This is the array half, asserted through the
 * composer because the contract customers actually meet is "the items I added
 * are the carousel Instagram posts, and everybody else gets the first one".
 *
 * Local mode throughout: the carousel is pure client state until publish time,
 * so demo and local workspaces compose one without a single network call.
 *
 * The adapter half — the item containers, the CAROUSEL container, the publish,
 * and what happens when one item is rejected — is in
 * supabase/functions/_shared/platforms.deno.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { TODAY, bootApp } from "../../test-harness/app.mjs";

const DAY = "2026-06-22";
const COVER = "https://cdn.example.com/cover.jpg";
const BACKUP_PREFIX = "data:application/json;charset=utf-8,";
const saveButton = app => app.$(".modalfoot .right button.btn:not(.ghost)");
const panel = app => app.$("#pm_carousel .carousel-panel");
const addButton = app => app.byText("#pm_carousel button", "Add another");
const items = app => app.$$("#pm_carousel input[data-carousel]");
const itemValues = app => items(app).map(box => box.value);

async function openDay(app, date = DAY) {
  await app.click(`[aria-label="Schedule a post on ${date}"]`);
  await app.waitFor(() => app.$("#pm_text"), { label: "the post modal" });
}
async function selectNets(app, ...nets) {
  for (const box of app.$$("#pm_nets input")) await app.check(box, nets.includes(box.value));
}
/** Compose far enough that only the carousel is left to build. */
async function composeForInstagram(app, { date = DAY } = {}) {
  await openDay(app, date);
  await app.fill("#pm_text", "Six shots from the shoot");
  await app.fill("#pm_media", COVER);
  await selectNets(app, "instagram");
  await app.waitFor(() => panel(app), { label: "the carousel panel" });
}
/** Add `count` extra items and fill each with a distinct URL. */
async function addItems(app, count, url = index => `https://cdn.example.com/${index + 2}.jpg`) {
  for (let index = 0; index < count; index++) {
    await app.click(addButton(app));
    await app.fill(`#pm_carousel_${index}`, url(index));
  }
}

/* ---------- the affordance belongs to Instagram, and to nothing else ---------- */

test("a composer that does not target Instagram has no carousel markup at all", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openDay(app);
  await selectNets(app, "x", "facebook");

  assert.equal(app.$("#pm_carousel").innerHTML, "",
    "no Instagram, no carousel — not hidden controls the keyboard would still walk");
  assert.equal(items(app).length, 0);

  await selectNets(app, "x", "facebook", "instagram");
  assert.ok(panel(app), "selecting Instagram brings the affordance with it");
  assert.ok(addButton(app), "…and the affordance is an invitation to add one");

  await selectNets(app, "x", "facebook");
  assert.equal(app.$("#pm_carousel").innerHTML, "", "deselecting takes the whole panel away");
});

test("the panel says what the other networks get, because they get less", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);

  assert.match(app.text("#pm_carousel"), /Other networks post the first item only/,
    "a Facebook post that lost four images should be predicted, not discovered");
  assert.match(app.text("#pm_carousel"), /up to 10 images or videos/);
});

/* ---------- adding, removing, and Instagram's ten ---------- */

test("items are added one at a time, numbered after the cover, and removable", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await addItems(app, 3);

  assert.deepEqual(itemValues(app), [
    "https://cdn.example.com/2.jpg", "https://cdn.example.com/3.jpg",
    "https://cdn.example.com/4.jpg",
  ]);
  assert.deepEqual(app.$$("#pm_carousel .carousel-index").map(el => el.textContent),
    ["1", "2", "3", "4"], "item one is the media field above, and it is numbered as such");
  assert.match(app.text("#pm_carousel .carousel-count"), /4 of 10 items/);

  await app.click(app.$$("#pm_carousel [data-action=removeCarouselItem]")[1]);
  assert.deepEqual(itemValues(app),
    ["https://cdn.example.com/2.jpg", "https://cdn.example.com/4.jpg"],
    "removing the middle item closes the gap rather than blanking it");
  assert.match(app.text("#pm_carousel .carousel-count"), /3 of 10 items/);
});

test("the tenth item is the last one Instagram allows, and the offer stops there", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await addItems(app, 9);

  assert.equal(items(app).length, 9, "nine extras plus the cover is Instagram's ten");
  assert.match(app.text("#pm_carousel .carousel-count"), /10 of 10 items/);
  assert.equal(addButton(app), null, "the invitation is withdrawn rather than left to fail");
  assert.match(app.text("#pm_carousel"), /That is all 10 items Instagram allows/);

  // The rule is in the function, not only in the markup: reaching past the
  // withdrawn button must be refused too.
  app.call("addCarouselItem");
  await app.flush();
  assert.equal(items(app).length, 9);
  assert.equal(app.toast(), "Instagram carousels hold up to 10 items");

  await app.click(app.$$("#pm_carousel [data-action=removeCarouselItem]").at(-1));
  assert.ok(addButton(app), "removing one offers the tenth slot back");
});

/* ---------- what is stored: [cover, ...extras], and only when it means something ---------- */

test("the stored carousel is the cover followed by the extras, in order", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await addItems(app, 2);
  await app.click(saveButton(app));
  await app.waitFor(() => !app.modalOpen(), { label: "the composer to close" });

  const saved = app.db.brands[0].posts.at(-1);
  assert.equal(saved.media_url, COVER, "the single cover every other network publishes");
  assert.deepEqual([...saved.media_urls],
    [COVER, "https://cdn.example.com/2.jpg", "https://cdn.example.com/3.jpg"],
    "item one is the cover itself, so the two can never disagree");
});

test("a post with no extras stores no carousel at all", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await app.click(saveButton(app));
  await app.waitFor(() => !app.modalOpen(), { label: "the composer to close" });

  const saved = app.db.brands[0].posts.at(-1);
  assert.equal(saved.media_urls, null,
    "one item is an ordinary post — storing [media_url] would be that post said twice");
});

test("removing the last extra, or dropping Instagram, clears the carousel", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await addItems(app, 1);
  await app.click(saveButton(app));
  await app.waitFor(() => !app.modalOpen(), { label: "the composer to close" });
  assert.equal(app.db.brands[0].posts.at(-1).media_urls.length, 2);

  await app.click(app.byText(".calgrid .post", "Six shots"));
  await app.waitFor(() => app.$("#pm_text"));
  await app.click(app.$("#pm_carousel [data-action=removeCarouselItem]"));
  await app.click(saveButton(app));
  await app.waitFor(() => !app.modalOpen(), { label: "the composer to close" });
  assert.equal(app.db.brands[0].posts.at(-1).media_urls, null);

  // …and a post that stops targeting Instagram has no carousel to keep.
  await app.click(app.byText(".calgrid .post", "Six shots"));
  await app.waitFor(() => app.$("#pm_text"));
  await addItems(app, 1);
  await selectNets(app, "facebook");
  await app.click(saveButton(app));
  await app.waitFor(() => !app.modalOpen(), { label: "the composer to close" });
  assert.equal(app.db.brands[0].posts.at(-1).media_urls, null,
    "Facebook has no carousel, so the post records none");
});

test("a saved carousel reopens as itself, and duplicating carries it", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await addItems(app, 2);
  await app.click(saveButton(app));
  await app.waitFor(() => !app.modalOpen(), { label: "the composer to close" });

  await app.click(app.byText(".calgrid .post", "Six shots"));
  await app.waitFor(() => app.$("#pm_text"));
  assert.equal(app.$("#pm_media").value, COVER);
  assert.deepEqual(itemValues(app),
    ["https://cdn.example.com/2.jpg", "https://cdn.example.com/3.jpg"],
    "only the extras are editable here — item one stays the media field above");

  await app.click(app.byText(".modalfoot button", "Duplicate"));
  const copies = app.db.brands[0].posts.filter(p => p.text === "Six shots from the shoot");
  assert.equal(copies.length, 2);
  assert.deepEqual([...copies.map(p => p.media_urls.length)], [3, 3]);
});

test("editing only a carousel item is an unsaved change the Escape guard defends", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await addItems(app, 1);
  // Everything so far armed the composer; re-arm so the only change under test
  // is the item URL itself.
  app.setState("composerBaseline", app.call("composerSnapshot"));

  await app.fill("#pm_carousel_0", "https://cdn.example.com/replaced.jpg");

  app.answerConfirm(false);
  await app.press("#pm_status", "Escape");
  assert.deepEqual(app.confirms, ["Discard this post?"],
    "a carousel item is media worth keeping, like the post's own media URL");
  assert.equal(app.modalOpen(), true);
});

/* ---------- refusals ---------- */

test("a carousel item that is not an https URL is refused at save time", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app);
  await addItems(app, 2);
  await app.fill("#pm_carousel_1", "javascript:alert(1)");

  const before = app.db.brands[0].posts.length;
  await app.click(saveButton(app));
  assert.equal(app.toast(), "Carousel item 3 needs a valid https:// URL",
    "the number the customer is looking at, not a zero-based index");
  assert.equal(app.modalOpen(), true, "a refused post keeps the composer open");
  assert.equal(app.db.brands[0].posts.length, before);
  assert.equal(app.$$("#pm_carousel .carousel-thumb.on").length, 1,
    "…and a javascript: URL never became a preview either");
});

/* ---------- containment ---------- */

test("a hostile carousel URL is a string in an input and never markup", async t => {
  const payload =
    `https://cdn.example.com/a.jpg"><img src=x onerror="__pwn()"><script>__pwn()</script>`;
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  app.eval("window.__pwnHits = 0; window.__pwn = () => { window.__pwnHits++; };");

  await composeForInstagram(app);
  await addItems(app, 1);
  await app.fill("#pm_carousel_0", payload);
  await app.click(saveButton(app));
  await app.waitFor(() => !app.modalOpen(), { label: "the composer to close" });

  await app.click(app.byText(".calgrid .post", "Six shots"));
  await app.waitFor(() => app.$("#pm_text"));

  assert.equal(app.$("#pm_carousel_0").value, payload, "it reads back verbatim…");
  assert.deepEqual(
    app.$$("script, iframe, [onerror], [onload]", app.modal()).map(el => el.outerHTML), [],
    "…and never became markup");
  assert.equal(app.eval("window.__pwnHits"), 0);
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

test("a carousel survives an export and its import", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await composeForInstagram(app, { date: TODAY });
  await addItems(app, 2);
  await app.click(saveButton(app));
  await app.waitFor(() => !app.modalOpen(), { label: "the composer to close" });

  await openSettings(app);
  const json = await exportBackup(app);
  const exported = JSON.parse(json).brands[0].posts
    .find(p => p.text === "Six shots from the shoot");
  assert.deepEqual(exported.media_urls,
    [COVER, "https://cdn.example.com/2.jpg", "https://cdn.example.com/3.jpg"]);

  await importBackup(app, json);
  assert.equal(app.toast(), "Backup restored ✔");
  const restored = app.db.brands[0].posts.find(p => p.text === "Six shots from the shoot");
  assert.deepEqual([...restored.media_urls], exported.media_urls);
});

test("a backup carrying a carousel Instagram could never accept never reaches the workspace", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);
  const json = await exportBackup(app);
  const before = JSON.stringify(app.db);

  for (const media_urls of [
    ["https://cdn.example.com/1.jpg"],                                  // one item is not a carousel
    Array.from({ length: 11 }, (_, i) => `https://cdn.example.com/${i}.jpg`),
    ["https://cdn.example.com/1.jpg", "http://cdn.example.com/2.jpg"],  // not https
    ["https://cdn.example.com/1.jpg", "javascript:alert(1)"],
    ["https://cdn.example.com/1.jpg", 42],                              // not a string
    ["https://cdn.example.com/1.jpg", "https://cdn.example.com/" + "x".repeat(2048)],
    { 0: "https://cdn.example.com/1.jpg", 1: "https://cdn.example.com/2.jpg" }, // not an array
  ]) {
    const parsed = JSON.parse(json);
    parsed.brands[0].posts[0].media_urls = media_urls;
    await importBackup(app, JSON.stringify(parsed));
    assert.equal(app.toast(), "Invalid backup file",
      `accepted ${JSON.stringify(media_urls)}`);
    assert.equal(JSON.stringify(app.db), before, "a rejected import changes nothing");
  }
});

test("a backup with no carousel at all is still a valid backup", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);
  const json = await exportBackup(app);

  for (const media_urls of [undefined, null]) {
    const parsed = JSON.parse(json);
    if (media_urls === undefined) delete parsed.brands[0].posts[0].media_urls;
    else parsed.brands[0].posts[0].media_urls = media_urls;
    await importBackup(app, JSON.stringify(parsed));
    assert.equal(app.toast(), "Backup restored ✔",
      "every post that predates carousels has none, and that is not an error");
  }
});
