// ADR 0003 flow 3 (compose and schedule): the day modal, the calendar chip and its status.
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, TODAY } from "../../test-harness/app.mjs";

const dayCell = (app, date) =>
  app.$(`[aria-label="Schedule a post on ${date}"]`).parentElement;
const chipsOn = (app, date) => app.$$(".post", dayCell(app, date));
const saveButton = app => app.$(".modalfoot .right button.btn:not(.ghost)");

async function openDay(app, date) {
  await app.click(`[aria-label="Schedule a post on ${date}"]`);
  await app.waitFor(() => app.$("#pm_text"), { label: "the post modal" });
}

async function compose(app, { date, text, networks, status, media = "", time = "14:00" }) {
  await openDay(app, date);
  await app.fill("#pm_text", text);
  for (const box of app.$$("#pm_nets input")) {
    await app.check(box, networks.includes(box.value));
  }
  if (media) await app.fill("#pm_media", media);
  await app.fill("#pm_time", time);
  await app.fill("#pm_status", status);
  await app.click(saveButton(app));
}

test("the day cell opens a composer prefilled with that day", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());

  await openDay(app, "2026-06-22");
  assert.equal(app.modalOpen(), true);
  assert.equal(app.text(".modal h3"), "New post");
  assert.equal(app.$("#pm_date").value, "2026-06-22");
  assert.equal(app.$("#pm_status").value, "draft", "a new post starts as a draft");
  const enabled = app.$$("#pm_nets input:not([disabled])").map(i => i.value);
  assert.deepEqual(enabled, ["instagram", "x", "linkedin", "tiktok"],
    "only the brand's connected networks are selectable");
});

test("composing a scheduled post puts a scheduled chip on that day", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());

  assert.equal(chipsOn(app, "2026-06-22").length, 0);
  await compose(app, {
    date: "2026-06-22", text: "Launch day thread", networks: ["x"], status: "scheduled",
  });

  assert.equal(app.modalOpen(), false, "saving closes the composer");
  assert.equal(app.toast(), "Post scheduled ✔");

  const [chip] = chipsOn(app, "2026-06-22");
  assert.ok(chip, "the post is rendered on the day it was scheduled for");
  assert.equal(chip.className, "post scheduled");
  assert.equal(chip.getAttribute("aria-label"), "14:00, scheduled: Launch day thread");
  assert.equal(chip.textContent.replace(/\s+/g, " ").trim(), "XLaunch day thread");

  const saved = app.db.brands[0].posts.find(p => p.text === "Launch day thread");
  assert.equal(saved.date, "2026-06-22");
  assert.equal(saved.status, "scheduled");
  assert.deepEqual([...saved.networks], ["x"]);
});

test("composing a draft puts a draft chip on that day", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());

  await compose(app, {
    date: "2026-06-23", text: "Half-written idea", networks: ["linkedin"], status: "draft",
  });
  assert.equal(app.toast(), "Draft saved");
  assert.equal(chipsOn(app, "2026-06-23")[0].className, "post draft");
});

test("a post scheduled in the past renders as published once the clock passes it", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());

  await compose(app, {
    date: "2026-06-14", text: "Yesterday's note", networks: ["x"], status: "scheduled",
  });
  // tickPublish() runs on every render and flips due scheduled posts locally.
  assert.equal(chipsOn(app, "2026-06-14")[0].className, "post published");
});

test("editing a post moves its chip to the new day and keeps the status", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());

  await compose(app, {
    date: "2026-06-23", text: "Half-written idea", networks: ["linkedin"], status: "draft",
  });
  const chip = chipsOn(app, "2026-06-23")[0];
  assert.equal(chip.className, "post draft");
  await app.click(chip);
  await app.waitFor(() => app.$("#pm_text"));

  assert.equal(app.text(".modal h3"), "Edit post");
  await app.fill("#pm_text", "Rewritten recap carousel");
  await app.fill("#pm_date", "2026-06-24");
  await app.click(saveButton(app));

  assert.equal(app.toast(), "Post updated");
  assert.equal(chipsOn(app, "2026-06-23").length, 0);
  const moved = chipsOn(app, "2026-06-24")[0];
  assert.equal(moved.className, "post draft");
  assert.match(moved.textContent, /Rewritten recap carousel/);
});

test("duplicating a published post creates a draft copy on the same day", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());

  await app.click(chipsOn(app, "2026-06-13")[0]);
  await app.waitFor(() => app.$("#pm_text"));
  await app.click(app.byText(".modalfoot button", "Duplicate"));

  assert.equal(app.toast(), "Duplicated as draft");
  const classes = chipsOn(app, "2026-06-13").map(c => c.className).sort();
  assert.deepEqual(classes, ["post draft", "post published"]);
});

test("deleting a post asks for confirmation and removes its chip", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());

  await app.click(chipsOn(app, "2026-06-16")[0]);
  await app.waitFor(() => app.$("#pm_text"));
  await app.click(app.byText(".modalfoot button", "Delete"));

  assert.deepEqual(app.confirms, ["Delete this post?"]);
  assert.equal(app.toast(), "Post removed");
  assert.equal(chipsOn(app, "2026-06-16").length, 0);
});

test("the new-post button opens today, and month navigation keeps posts on their days", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());

  await app.click(app.byText(".calhead button", "+ New post"));
  await app.waitFor(() => app.$("#pm_date"));
  assert.equal(app.$("#pm_date").value, TODAY);
  await app.click(app.byText(".modalfoot button", "Cancel"));

  await app.click(app.byText(".calhead button", "Next →"));
  assert.equal(app.text(".calhead h2"), "July 2026");
  assert.equal(app.$$(".calgrid .post").length, 0, "June posts do not follow the cursor");

  await app.click(app.byText(".calhead button", "← Prev"));
  assert.equal(app.text(".calhead h2"), "June 2026");
  assert.equal(app.$$(".calgrid .post").length, 7, "all seeded posts come back");
});
