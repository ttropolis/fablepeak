// ADR 0003 flow 9 (SmartLinks): add, rename, reorder, delete and click tracking, all mirrored in the phone preview.
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "../../test-harness/app.mjs";

const editorTitles = app => app.$$(".slrow input[type=text]").map(i => i.value);
const previewTitles = app => app.$$(".phone .slink").map(a => a.textContent);
const rowFor = (app, title) =>
  app.$$(".slrow").find(r => r.querySelector("input[type=text]").value === title);

async function openSmartlinks(app) {
  await app.click(app.byText("#nav button", "SmartLinks"));
  await app.waitFor(() => app.$(".slwrap"), { label: "the SmartLinks editor" });
}

test("the editor and the phone preview start in agreement", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSmartlinks(app);

  assert.deepEqual(editorTitles(app), ["Our website", "Latest video", "Newsletter"]);
  assert.deepEqual(previewTitles(app), editorTitles(app));
  assert.equal(app.text(".phone h5"), "My Brand");
  assert.equal(app.text(".phone .bio"), "Welcome! All my links in one place.");
  assert.equal(app.text(".phone .av"), "🚀");
});

test("adding a link appends it to the editor and the preview", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSmartlinks(app);

  await app.click(app.byText(".sledit button", "+ Add link"));
  assert.deepEqual(editorTitles(app), ["Our website", "Latest video", "Newsletter", "New link"]);
  assert.deepEqual(previewTitles(app), editorTitles(app));
  assert.equal(rowFor(app, "New link").querySelector("input[type=url]").value, "https://");
  assert.equal(rowFor(app, "New link").querySelector(".clicks").textContent, "0 clicks");
});

test("renaming a link and its URL updates the preview", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSmartlinks(app);

  await app.fill(rowFor(app, "Newsletter").querySelector("input[type=text]"), "Join the list");
  assert.deepEqual(previewTitles(app), ["Our website", "Latest video", "Join the list"]);

  await app.fill(rowFor(app, "Join the list").querySelector("input[type=url]"),
    "https://example.com/subscribe");
  assert.equal(app.db.brands[0].smartlink.links[2].url, "https://example.com/subscribe");
});

test("editing the page title, bio and avatar reaches the preview", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSmartlinks(app);

  await app.fill(app.$$(".sledit input[type=text]")[0], "Acme Links");
  await app.fill(app.$$(".sledit input[type=text]")[1], "Everything in one tap");
  assert.equal(app.text(".phone h5"), "Acme Links");
  assert.equal(app.text(".phone .bio"), "Everything in one tap");
});

test("reordering moves a link in the editor and the preview together", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSmartlinks(app);

  await app.click(app.byText("button", "↑", rowFor(app, "Newsletter")));
  assert.deepEqual(editorTitles(app), ["Our website", "Newsletter", "Latest video"]);
  assert.deepEqual(previewTitles(app), editorTitles(app));

  await app.click(app.byText("button", "↓", rowFor(app, "Our website")));
  assert.deepEqual(editorTitles(app), ["Newsletter", "Our website", "Latest video"]);
  assert.deepEqual(previewTitles(app), editorTitles(app));
});

test("the ends of the list cannot be moved off it", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSmartlinks(app);

  const rows = app.$$(".slrow");
  assert.equal(app.byText("button", "↑", rows[0]).disabled, true);
  assert.equal(app.byText("button", "↓", rows[0]).disabled, false);
  assert.equal(app.byText("button", "↓", rows.at(-1)).disabled, true);
});

test("deleting a link removes it from the editor and the preview", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSmartlinks(app);

  await app.click(app.byText("button", "✕", rowFor(app, "Latest video")));
  assert.deepEqual(editorTitles(app), ["Our website", "Newsletter"]);
  assert.deepEqual(previewTitles(app), editorTitles(app));
  assert.equal(app.db.brands[0].smartlink.links.length, 2);
});

test("clicking a preview link tracks the click", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSmartlinks(app);

  assert.equal(rowFor(app, "Our website").querySelector(".clicks").textContent, "132 clicks");
  await app.click(app.$$(".phone .slink")[0]);

  assert.equal(app.toast(), "Click tracked → https://example.com");
  assert.equal(rowFor(app, "Our website").querySelector(".clicks").textContent, "133 clicks");
});

test("SmartLinks edits survive a switch to another view and back", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSmartlinks(app);

  await app.click(app.byText(".sledit button", "+ Add link"));
  await app.fill(rowFor(app, "New link").querySelector("input[type=text]"), "Press kit");
  await app.click(app.byText("#nav button", "Planner"));
  await openSmartlinks(app);

  assert.deepEqual(previewTitles(app), ["Our website", "Latest video", "Newsletter", "Press kit"]);
});
