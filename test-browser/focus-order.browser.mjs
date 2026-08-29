/* ADR 0003 §1b, area 3 — real focus and tab order.
 *
 * test/behaviour/modal-keyboard.test.mjs asserts the same contract against
 * jsdom, but has to fake two things it cannot do: it focuses the opener by hand
 * because jsdom does not move focus on click, and it "presses Tab" by
 * dispatching a KeyboardEvent, which never moves focus by itself — so it can
 * only observe the app's own wrap-around, never the browser's sequential
 * navigation in between. Here the Tab key is real, and so is the order.
 *
 * The concrete thing only this tier can see: <input type="date"> and
 * <input type="time"> are multi-segment controls in Chromium, so one visible
 * field eats several Tab stops. A trap that reasoned about "number of Tab
 * presses" rather than first/last element would pass in jsdom and leak here.
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  LS_KEY, closeBrowser, fixtureDb, newContext, startServer, waitForApp,
} from "../test-harness/browser.mjs";

let server;
before(async () => { server = await startServer({ cloud: false }); });
after(async () => { await server?.close(); await closeBrowser(); });

async function boot(t) {
  const app = await newContext(server, {
    storage: { [LS_KEY]: JSON.stringify(fixtureDb()) },
  });
  t.after(() => app.close());
  await app.page.goto(server.origin + "/", { waitUntil: "load" });
  await waitForApp(app.page);
  return app;
}

/** A stable name for whatever currently holds focus, plus where it lives. */
const focused = page => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { name: "<body>", inModal: false };
  const name = el.id
    || (el.tagName === "OPTION" ? "option" : "")
    || (el.value && el.type === "checkbox" ? `checkbox:${el.value}` : "")
    || `${el.tagName.toLowerCase()}:${(el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24)}`;
  return { name, inModal: !!el.closest("#modalBody"), tag: el.tagName.toLowerCase() };
});

async function openComposer(page, openerName = "+ New post") {
  const opener = page.getByRole("button", { name: openerName, exact: true });
  await opener.click();
  await page.waitForFunction(() => document.getElementById("overlay").classList.contains("open"));
  await page.waitForFunction(() => !!document.activeElement?.closest("#modalBody"));
  return opener;
}

/** Press Tab until focus comes back to where it started; returns every stop. */
async function tabCycle(page, { shift = false, limit = 60 } = {}) {
  const start = (await focused(page)).name;
  const stops = [];
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press(shift ? "Shift+Tab" : "Tab");
    const stop = await focused(page);
    stops.push(stop);
    if (stop.name === start) return { start, stops, closed: true };
  }
  return { start, stops, closed: false };
}

/** Consecutive duplicates collapsed: one entry per control, in visiting order. */
const controls = stops => stops.map(s => s.name).filter((n, i, all) => n !== all[i - 1]);

test("a real click focuses the opener, and the dialog takes focus from there", async t => {
  const { page } = await boot(t);

  await openComposer(page);

  assert.equal((await focused(page)).name, "pm_text",
    "focus lands on the first control in the dialog");
  assert.equal(await page.evaluate(() =>
    __fablepeak.state.previousModalFocus?.textContent?.replace(/\s+/g, " ").trim()), "+ New post",
    "the browser focused the button on click, so the app captured a real opener");
});

test("Tab never escapes the dialog and comes back round to the first control", async t => {
  const { page } = await boot(t);
  await openComposer(page);

  const { start, stops, closed } = await tabCycle(page);

  assert.equal(start, "pm_text");
  assert.ok(closed, "Tab must eventually return to the first control");
  const escaped = stops.filter(stop => !stop.inModal);
  assert.deepEqual(escaped, [],
    "every Tab stop must stay inside the dialog; the page behind it is inert to the keyboard");
});

test("the cycle visits every enabled control once, in DOM order", async t => {
  const { page } = await boot(t);
  await openComposer(page);

  const { start, stops } = await tabCycle(page);
  // stops begins after the first Tab and ends back on `start`; put `start`
  // in front and drop the closing repeat to get one full lap in order.
  const visited = [start, ...controls(stops).slice(0, -1)];

  const expected = await page.evaluate(() =>
    [...document.getElementById("modalBody").querySelectorAll(
      "a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled])," +
      "select:not([disabled]),[tabindex]:not([tabindex='-1'])")]
      .filter(el => !el.hidden && el.getAttribute("aria-hidden") !== "true")
      .map(el => el.id
        || (el.value && el.type === "checkbox" ? `checkbox:${el.value}` : "")
        || `${el.tagName.toLowerCase()}:${(el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24)}`));

  assert.deepEqual(visited, expected,
    "the app's own focusable list and Chromium's sequential navigation must agree");
  assert.ok(expected.includes("checkbox:instagram"),
    "connected network checkboxes are part of the keyboard path");
});

test("multi-segment date and time inputs cost more Tab presses than they look", async t => {
  const { page } = await boot(t);
  await openComposer(page);

  const { stops } = await tabCycle(page);
  const pressesOn = id => stops.filter(stop => stop.name === id).length;

  assert.ok(pressesOn("pm_date") > 1,
    "Chromium tabs through the date field's segments — this is exactly what jsdom cannot model");
  assert.ok(pressesOn("pm_time") > 1);
  assert.ok(stops.length > controls(stops).length,
    "so the number of Tab presses in a full cycle exceeds the number of controls");
});

test("Shift+Tab off the first control wraps backwards to the last", async t => {
  const { page } = await boot(t);
  await openComposer(page);

  await page.keyboard.press("Shift+Tab");
  const wrapped = await focused(page);

  assert.equal(wrapped.inModal, true);
  assert.equal(wrapped.name, "button:Schedule", "wraps to the dialog's last control");

  const { closed, stops } = await tabCycle(page, { shift: true });
  assert.ok(closed, "the trap holds in the reverse direction too");
  assert.deepEqual(stops.filter(stop => !stop.inModal), []);
});

test("Escape closes the dialog and hands focus back to the button that opened it", async t => {
  const { page } = await boot(t);
  const opener = await openComposer(page);

  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    !document.getElementById("overlay").classList.contains("open"));

  assert.equal(await opener.evaluate(el => el === document.activeElement), true,
    "focus returns to the opener, not to <body>");
});

test("focus returns to the day cell when the dialog was opened from the calendar", async t => {
  const { page } = await boot(t);
  const opener = await openComposer(page, "Schedule a post on 2026-06-22");

  assert.equal((await focused(page)).name, "pm_text");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    !document.getElementById("overlay").classList.contains("open"));

  assert.equal(await opener.evaluate(el => el === document.activeElement), true);
});

test("Tab is left alone while no dialog is open", async t => {
  const { page } = await boot(t);

  await page.keyboard.press("Tab");
  const first = await focused(page);
  await page.keyboard.press("Tab");
  const second = await focused(page);

  assert.equal(first.inModal, false);
  assert.notEqual(first.name, second.name,
    "the trap must not be armed when the overlay is closed");
});
