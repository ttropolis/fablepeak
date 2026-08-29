// ADR 0003 flow 12 (modal keyboard contract): initial focus, Escape, the Tab trap and focus return.
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "../../test-harness/app.mjs";

const active = app => app.document.activeElement;
const focusable = app => app.$$(
  ".modal a[href],.modal button:not([disabled]),.modal input:not([disabled])," +
  ".modal textarea:not([disabled]),.modal select:not([disabled])");

/* jsdom does not move focus on click (and neither do all real browsers), so the
   opener is focused explicitly first — that is the state the app's
   previousModalFocus contract is written against. Native tab order and
   click-to-focus belong to the Playwright tier (ADR 0003 decision 2). */
async function openFrom(app, selector) {
  const opener = app.$(selector);
  opener.focus();
  await app.click(opener);
  await app.waitFor(() => app.modalOpen() && active(app).closest(".modal"),
    { label: "the modal to take focus" });
  return opener;
}

test("opening a post modal moves focus into it and labels it for assistive tech", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());

  await openFrom(app, '[aria-label="Schedule a post on 2026-06-22"]');
  const modal = app.modal();
  assert.equal(modal.getAttribute("role"), "dialog");
  assert.equal(modal.getAttribute("aria-modal"), "true");
  assert.equal(modal.getAttribute("aria-label"), "New post");
  assert.equal(active(app).id, "pm_text", "focus lands on the first control");
});

test("Escape closes an untouched modal and returns focus to whatever opened it", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());

  const opener = await openFrom(app, '[aria-label="Schedule a post on 2026-06-22"]');
  await app.press(active(app), "Escape");

  assert.equal(app.modalOpen(), false);
  assert.deepEqual(app.confirms, [], "a pristine composer has nothing to lose");
  assert.equal(active(app), opener, "focus returns to the opener");
});

test("Escape on a half-written post asks before discarding it", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());

  const opener = await openFrom(app, '[aria-label="Schedule a post on 2026-06-22"]');
  await app.fill("#pm_text", "Half-written thought");

  // The live bug was seen with focus on a native <select>, not the textarea.
  app.answerConfirm(false);
  await app.press("#pm_status", "Escape");
  assert.deepEqual(app.confirms, ["Discard this post?"]);
  assert.equal(app.modalOpen(), true, "declining keeps the composer open");
  assert.equal(app.$("#pm_text").value, "Half-written thought", "the draft text survives");

  app.answerConfirm(true);
  await app.press("#pm_status", "Escape");
  assert.equal(app.modalOpen(), false, "accepting discards and closes");
  assert.equal(app.confirms.length, 2);
  assert.equal(active(app), opener, "focus still returns to the opener");
});

test("changing only a network or the date still counts as content worth keeping", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openFrom(app, '[aria-label="Schedule a post on 2026-06-22"]');

  const box = app.$$("#pm_nets input:not([disabled])").find(i => !i.checked);
  await app.check(box, true);
  app.answerConfirm(false);
  await app.press("#pm_status", "Escape");

  assert.deepEqual(app.confirms, ["Discard this post?"]);
  assert.equal(app.modalOpen(), true);
});

test("saving a changed post never asks to discard it", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openFrom(app, '[aria-label="Schedule a post on 2026-06-22"]');

  await app.fill("#pm_text", "Launch day thread");
  for (const box of app.$$("#pm_nets input")) await app.check(box, box.value === "x");
  await app.click(app.byText(".modalfoot button", "Schedule"));

  assert.equal(app.modalOpen(), false);
  assert.deepEqual(app.confirms, [], "saving is not a discard");
  assert.equal(app.toast(), "Draft saved");
});

test("Tab is trapped inside the modal in both directions", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openFrom(app, '[aria-label="Schedule a post on 2026-06-22"]');

  const controls = focusable(app);
  const first = controls[0], last = controls.at(-1);
  assert.equal(first.id, "pm_text");
  assert.match(last.textContent, /Schedule/);

  last.focus();
  await app.press(last, "Tab");
  assert.equal(active(app), first, "Tab off the last control wraps to the first");

  await app.press(first, "Tab", { shiftKey: true });
  assert.equal(active(app), last, "Shift+Tab off the first control wraps to the last");

  const middle = controls[1];
  middle.focus();
  await app.press(middle, "Tab");
  assert.equal(active(app), middle, "the trap does not steal ordinary tabbing");
});

test("clicking the backdrop closes the modal but clicking the panel does not", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openFrom(app, '[aria-label="Schedule a post on 2026-06-22"]');

  await app.click(app.modal());
  assert.equal(app.modalOpen(), true, "clicks inside the dialog must not dismiss it");

  await app.click("#overlay");
  assert.equal(app.modalOpen(), false);
});

test("clicking the backdrop on a changed composer asks before discarding", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openFrom(app, '[aria-label="Schedule a post on 2026-06-22"]');
  await app.fill("#pm_text", "Half-written thought");

  app.answerConfirm(false);
  await app.click("#overlay");
  assert.deepEqual(app.confirms, ["Discard this post?"]);
  assert.equal(app.modalOpen(), true);

  app.answerConfirm(true);
  await app.click("#overlay");
  assert.equal(app.modalOpen(), false);
});

test("Escape does nothing while no modal is open", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());

  await app.press("#overlay", "Escape");
  assert.equal(app.modalOpen(), false);
  assert.equal(app.text("h1"), "Content Planner");
});

test("Cancel confirms a changed composer, then closes it without saving", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openFrom(app, '[aria-label="Schedule a post on 2026-06-22"]');

  const before = app.db.brands[0].posts.length;
  await app.fill("#pm_text", "Never mind");
  await app.click(app.byText(".modalfoot button", "Cancel"));

  assert.deepEqual(app.confirms, ["Discard this post?"], "Cancel shares the discard guard");
  assert.equal(app.modalOpen(), false);
  assert.equal(app.db.brands[0].posts.length, before);
});
