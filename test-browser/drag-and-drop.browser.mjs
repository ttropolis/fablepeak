/* ADR 0003 §1b, area 1 — HTML5 drag-and-drop.
 *
 * These two flows were the skips in test/behaviour/drag-reschedule.test.mjs:
 * jsdom exposes neither DataTransfer nor DragEvent, so a drop there could only
 * be faked by calling dropPost() with a hand-built event object, which asserts
 * the harness rather than the app. Here the drag is performed by Chromium's own
 * input pipeline and the DataTransfer is the real platform object.
 *
 * test/behaviour/drag-reschedule.test.mjs keeps the rendered drag *contract*
 * (which chips carry draggable="true"); this file owns the drop itself.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  LS_KEY, chip, closeBrowser, dayCell, fixtureDb, installDb, newContext,
  readDb, startServer, toastText, waitForApp,
} from "../test-harness/browser.mjs";

let localServer, cloudServer;
before(async () => {
  localServer = await startServer({ cloud: false });
  cloudServer = await startServer({ cloud: true });
});
after(async () => {
  await localServer?.close();
  await cloudServer?.close();
  await closeBrowser();
});

const postById = (db, id) => db.brands[0].posts.find(p => p.id === id);

/** Local mode: the fixture arrives through the app's real load() path. */
async function bootLocal(t) {
  const app = await newContext(localServer, {
    storage: { [LS_KEY]: JSON.stringify(fixtureDb()) },
  });
  t.after(() => app.close());
  await app.page.goto(localServer.origin + "/", { waitUntil: "load" });
  await waitForApp(app.page);
  return app;
}

/** Cloud mode signed in, which is the only state where publishing is real and
 *  dropPost()'s refusal branch exists. backend-config.js comes from the test
 *  server and the Supabase SDK import is fulfilled with a local stub, so the
 *  real RemoteAdapter boot path runs with no network. */
async function bootLive(t) {
  const app = await newContext(cloudServer, {});
  t.after(() => app.close());
  await app.page.goto(cloudServer.origin + "/", { waitUntil: "load" });
  await waitForApp(app.page);
  assert.equal(await app.page.evaluate(() => liveMode()), true,
    "the fixture must actually reach live mode, or the refusal branch is unreachable");
  await installDb(app.page, fixtureDb());
  return app;
}

/* A drop built from the page's own DataTransfer and DragEvent constructors.
   Chromium's synthesised mouse drag cannot start on an element the page marked
   draggable="false", so this is how the handler's own guard gets exercised. */
async function dropWithRealDataTransfer(page, postId, date) {
  return page.evaluate(({ postId, date }) => {
    const cell = document.querySelector(
      `.calgrid .day:has([aria-label="Schedule a post on ${date}"])`);
    const transfer = new DataTransfer();
    transfer.setData("text/plain", postId);
    const event = new DragEvent("drop", {
      bubbles: true, cancelable: true, dataTransfer: transfer,
    });
    cell.dispatchEvent(event);
    return {
      isRealDataTransfer: transfer instanceof DataTransfer,
      carried: event.dataTransfer.getData("text/plain"),
      defaultPrevented: event.defaultPrevented,
    };
  }, { postId, date });
}

test("Chromium really does have the APIs jsdom is missing", async t => {
  const app = await bootLocal(t);
  const present = await app.page.evaluate(() => ({
    dataTransfer: typeof DataTransfer, dragEvent: typeof DragEvent,
  }));
  assert.deepEqual(present, { dataTransfer: "function", dragEvent: "function" },
    "the counterpart of the jsdom guard test — this tier only earns its keep " +
    "while these exist here and not there");
});

test("dragging a scheduled chip onto another day reschedules it", async t => {
  const app = await bootLocal(t);
  const { page } = app;

  assert.equal(await chip(page, "Still a draft").getAttribute("draggable"), "true");
  assert.equal(await dayCell(page, "2026-06-18").locator(".post").count(), 1);

  await chip(page, "Still a draft").dragTo(dayCell(page, "2026-06-22"),
    { targetPosition: { x: 20, y: 60 } });

  const post = postById(await readDb(page), "p-sched");
  assert.equal(post.date, "2026-06-22", "the drop must move the post to the dropped day");
  assert.equal(post.status, "scheduled", "an unpublished post keeps its status");
  assert.match(await toastText(page), /Post moved to 2026-06-22/);
  assert.equal(await dayCell(page, "2026-06-18").locator(".post").count(), 0);
  assert.equal(await dayCell(page, "2026-06-22").locator(".post").count(), 1);
  assert.deepEqual(app.external, [], "a reschedule must not touch the network in local mode");
});

test("a rescheduled post survives a reload, so the drop was persisted", async t => {
  const app = await bootLocal(t);
  const { page } = app;

  await chip(page, "Still a draft").dragTo(dayCell(page, "2026-06-22"),
    { targetPosition: { x: 20, y: 60 } });
  await page.waitForFunction(() => JSON.parse(
    localStorage.getItem("fablepeak_v1")).brands[0].posts
    .some(p => p.id === "p-sched" && p.date === "2026-06-22"), null, { timeout: 5000 });

  await page.reload({ waitUntil: "load" });
  await waitForApp(page);
  assert.equal(await dayCell(page, "2026-06-22").locator(".post").count(), 1);
});

test("dropping a post back on the day it already sits on is a no-op move", async t => {
  const app = await bootLocal(t);
  const { page } = app;

  await chip(page, "Still a draft").dragTo(dayCell(page, "2026-06-18"),
    { targetPosition: { x: 20, y: 70 } });

  assert.equal(postById(await readDb(page), "p-sched").date, "2026-06-18");
  assert.equal(await dayCell(page, "2026-06-18").locator(".post").count(), 1,
    "the chip must not be duplicated or lost");
});

test("a live published chip is not draggable, so a real drag cannot move it", async t => {
  const app = await bootLive(t);
  const { page } = app;

  assert.equal(await chip(page, "Already out there").getAttribute("draggable"), "false");

  await chip(page, "Already out there").dragTo(dayCell(page, "2026-06-22"),
    { targetPosition: { x: 20, y: 60 } });

  assert.equal(postById(await readDb(page), "p-live").date, "2026-06-10",
    "Chromium must refuse to start the drag, leaving the post where it was");
  assert.equal(await dayCell(page, "2026-06-10").locator(".post").count(), 1);
});

test("dropPost refuses a published post even when a real drop reaches it", async t => {
  const app = await bootLive(t);
  const { page } = app;

  const dropped = await dropWithRealDataTransfer(page, "p-live", "2026-06-22");
  assert.equal(dropped.isRealDataTransfer, true);
  assert.equal(dropped.carried, "p-live", "the id travelled in a real DataTransfer");

  assert.equal(postById(await readDb(page), "p-live").date, "2026-06-10");
  assert.match(await toastText(page),
    /Published posts can't be rescheduled — duplicate it as a draft instead/);
});

test("the same real drop does reschedule a post that is not published", async t => {
  const app = await bootLive(t);
  const { page } = app;

  const dropped = await dropWithRealDataTransfer(page, "p-sched", "2026-06-22");
  assert.equal(dropped.defaultPrevented, true, "dropPost claims the drop");

  assert.equal(postById(await readDb(page), "p-sched").date, "2026-06-22",
    "the refusal above is about the post's status, not about the synthetic drop");
  assert.match(await toastText(page), /Post moved to 2026-06-22/);
});
