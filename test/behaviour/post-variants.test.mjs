/* ADR 0005 delivery item 3 — per-network copy in the composer.
 *
 * One post, one media URL, one schedule, and optionally a different string of
 * copy per network. Everything here is asserted through the composer, because
 * the contract customers actually meet is "what I typed for X is what X gets,
 * and what I left blank inherits the post".
 *
 * Local mode throughout: variants are pure client state (decision 2 needs no
 * provider permission at all), so demo and local workspaces get them too.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "../../test-harness/app.mjs";

const DAY = "2026-06-22";
const saveButton = app => app.$(".modalfoot .right button.btn:not(.ghost)");
const sections = app => app.$$("#pm_variants details");
const sectionNets = app =>
  app.$$("#pm_variants textarea[data-net]").map(box => box.dataset.net);
const variantBox = (app, net) => app.$(`#pm_variants textarea[data-net="${net}"]`);
const baseCount = app => app.text("#pm_count");

async function openDay(app, date = DAY) {
  await app.click(`[aria-label="Schedule a post on ${date}"]`);
  await app.waitFor(() => app.$("#pm_text"), { label: "the post modal" });
}
async function selectNets(app, ...nets) {
  for (const box of app.$$("#pm_nets input")) await app.check(box, nets.includes(box.value));
}
async function openPanel(app) {
  await app.check("#pm_percustom", true);
  await app.waitFor(() => app.$("#pm_variants"), { label: "the per-network panel" });
}

/* ---------- decision 11: off by default ---------- */

test("a composer with no variants looks exactly as it did before the feature", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openDay(app);

  const toggle = app.$("#pm_percustom");
  assert.ok(toggle, "the disclosure is offered");
  assert.equal(toggle.checked, false, "…and it is off");
  assert.equal(app.$("#pm_variants").innerHTML, "",
    "off means no markup at all — not hidden controls the keyboard would still walk");
  assert.equal(sections(app).length, 0);
});

test("the disclosure reveals one section per selected network, and follows the picker", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openDay(app);
  await selectNets(app, "x", "linkedin");
  await openPanel(app);

  assert.deepEqual(sectionNets(app), ["x", "linkedin"],
    "one <details> per selected network, in the picker's order");
  assert.equal(app.$$("#pm_variants summary").length, 2, "…each one a native disclosure");
  assert.match(app.$("#pm_variants summary").textContent, /X \/ Twitter/);

  await selectNets(app, "x", "linkedin", "instagram");
  assert.deepEqual(sectionNets(app), ["instagram", "x", "linkedin"],
    "selecting a network adds its section without reopening the composer");

  await selectNets(app, "x");
  assert.deepEqual(sectionNets(app), ["x"], "deselecting removes it again");

  await app.check("#pm_percustom", false);
  assert.equal(app.$("#pm_variants").innerHTML, "", "turning the panel off takes the DOM with it");
});

test("with the panel open and nothing selected, it says what it is waiting for", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openDay(app);
  await selectNets(app);
  await openPanel(app);

  assert.equal(sections(app).length, 0);
  assert.match(app.text("#pm_variants"), /Pick a network/);
});

test("a variant box shows the base text it would inherit as its placeholder", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openDay(app);
  await app.fill("#pm_text", "The long, considered version.");
  await selectNets(app, "x");
  await openPanel(app);

  assert.equal(variantBox(app, "x").placeholder, "The long, considered version.",
    "the customer can see what X gets if they leave this alone");
  assert.match(app.$("#pm_variants .variant-state").textContent, /inherits/i);

  await app.fill(variantBox(app, "x"), "The short one.");
  assert.match(app.$("#pm_variants .variant-state").textContent, /custom/i);
});

/* ---------- dirty state ---------- */

test("editing only a variant is an unsaved change the Escape guard defends", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openDay(app);
  await app.fill("#pm_text", "Base copy");
  await selectNets(app, "x");
  await openPanel(app);
  // Everything so far is part of arming the composer; re-arm the baseline so
  // the only change under test is the variant itself.
  app.setState("composerBaseline", app.call("composerSnapshot"));

  await app.fill(variantBox(app, "x"), "A shorter X version.");

  app.answerConfirm(false);
  await app.press("#pm_status", "Escape");
  assert.deepEqual(app.confirms, ["Discard this post?"],
    "per-network copy is content worth keeping, like the post's own text");
  assert.equal(app.modalOpen(), true);
  assert.equal(variantBox(app, "x").value, "A shorter X version.", "declining keeps it");
});

/* ---------- decision 12: X's 280 is refused, never truncated ---------- */

test("the composer counts the base text against the strictest network still inheriting it", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openDay(app);
  await selectNets(app, "x", "linkedin");

  await app.fill("#pm_text", "n".repeat(100));
  assert.equal(baseCount(app), "100 / 280 · X / Twitter",
    "X's 280 is tighter than LinkedIn's 3000, so X is the number that matters");
  assert.equal(app.$("#pm_count").className, "charcount");

  await app.fill("#pm_text", "n".repeat(270));
  assert.equal(app.$("#pm_count").className, "charcount near", "amber approaching the cap");

  await app.fill("#pm_text", "n".repeat(281));
  assert.equal(baseCount(app), "281 / 280 · X / Twitter");
  assert.equal(app.$("#pm_count").className, "charcount over");

  await selectNets(app, "linkedin");
  assert.equal(baseCount(app), "281 / 3000 · LinkedIn",
    "drop X and LinkedIn's own cap takes over");
  assert.equal(app.$("#pm_count").className, "charcount");
});

test("a base text over 280 is refused while X is selected without its own version", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openDay(app);
  await selectNets(app, "x");
  await app.fill("#pm_text", "n".repeat(281));

  const before = app.db.brands[0].posts.length;
  await app.click(saveButton(app));
  assert.equal(app.toast(),
    "X / Twitter allows 280 characters — this post is 281. Shorten it, or give X / Twitter its own shorter version.");
  assert.equal(app.modalOpen(), true, "a refused post keeps the composer open");
  assert.equal(app.db.brands[0].posts.length, before, "…and is not saved");

  // The offer the toast makes has to actually work.
  await openPanel(app);
  await app.fill(variantBox(app, "x"), "The version that fits.");
  await app.click(saveButton(app));
  assert.equal(app.modalOpen(), false);
  const saved = app.db.brands[0].posts.at(-1);
  assert.equal(saved.text.length, 281, "the long post survives for the networks that allow it");
  assert.equal(saved.variants.x, "The version that fits.");
});

test("an over-length X variant is refused too, and says so about the version", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openDay(app);
  await app.fill("#pm_text", "A short enough base.");
  await selectNets(app, "x");
  await openPanel(app);
  await app.fill(variantBox(app, "x"), "z".repeat(300));

  const before = app.db.brands[0].posts.length;
  await app.click(saveButton(app));
  assert.equal(app.toast(),
    "X / Twitter allows 280 characters — that version is 300. Shorten it.");
  assert.equal(app.db.brands[0].posts.length, before);
  assert.equal(app.text('#pm_variants [data-count]'), "300 / 280");
  assert.match(app.$("#pm_variants [data-count]").className, /over/);
});

test("an over-length variant for a network that is not selected cannot block the save", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openDay(app);
  await app.fill("#pm_text", "A short enough base.");
  await selectNets(app, "x");
  await openPanel(app);
  await app.fill(variantBox(app, "x"), "z".repeat(300));
  await selectNets(app, "linkedin");                    // X is retained, not sent

  await app.click(saveButton(app));
  assert.equal(app.modalOpen(), false, "an unselected network's draft is not published, so not validated");
  const saved = app.db.brands[0].posts.at(-1);
  assert.deepEqual([...saved.networks], ["linkedin"]);
  assert.equal(saved.variants.x.length, 300, "…and the draft is kept for when X comes back");
});

/* ---------- the inheritance contract, end to end ---------- */

test("a blank variant means inherit, and survives save and reopen as inheritance", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openDay(app);
  await app.fill("#pm_text", "The long, considered version.");
  await selectNets(app, "x", "linkedin");
  await openPanel(app);
  await app.fill(variantBox(app, "x"), "The short one.");
  await app.fill(variantBox(app, "linkedin"), "    ");   // whitespace only
  await app.fill("#pm_status", "scheduled");
  await app.click(saveButton(app));

  const saved = app.db.brands[0].posts.at(-1);
  assert.deepEqual({ ...saved.variants }, { x: "The short one." },
    "a blank variant is not stored at all — it is the absence that means inherit");

  await app.click(app.$$(".calgrid .post").find(c => c.textContent.includes("The long")));
  await app.waitFor(() => app.$("#pm_text"));
  assert.equal(app.$("#pm_percustom").checked, true,
    "a post with per-network copy reopens with it on screen");
  assert.equal(variantBox(app, "x").value, "The short one.");
  assert.equal(variantBox(app, "linkedin").value, "",
    "…and LinkedIn is still inheriting, not carrying four spaces");
  assert.equal(variantBox(app, "linkedin").placeholder, "The long, considered version.");
});

test("a post that never opens the panel stores an empty map and reopens unchanged", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openDay(app);
  await app.fill("#pm_text", "One message for everyone");
  await selectNets(app, "x");
  await app.click(saveButton(app));

  const saved = app.db.brands[0].posts.at(-1);
  assert.deepEqual({ ...saved.variants }, {}, "no variants means no variants");

  await app.click(app.byText(".calgrid .post", "One message for everyone"));
  await app.waitFor(() => app.$("#pm_text"));
  assert.equal(app.$("#pm_percustom").checked, false, "the panel stays off");
  assert.equal(app.$("#pm_variants").innerHTML, "");
});

test("duplicating a post copies its per-network copy with it", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openDay(app);
  await app.fill("#pm_text", "Base copy for duplication");
  await selectNets(app, "x");
  await openPanel(app);
  await app.fill(variantBox(app, "x"), "The short one.");
  await app.click(saveButton(app));

  await app.click(app.byText(".calgrid .post", "Base copy for duplication"));
  await app.waitFor(() => app.$("#pm_text"));
  await app.click(app.byText(".modalfoot button", "Duplicate"));

  const copies = app.db.brands[0].posts.filter(p => p.text === "Base copy for duplication");
  assert.equal(copies.length, 2);
  assert.deepEqual([...copies.map(p => p.variants.x)], ["The short one.", "The short one."]);
});

/* ---------- containment ---------- */

test("a hostile variant is a string in a textarea and never markup", async t => {
  const payload = `"></textarea><img src=x onerror="__pwn()"><script>__pwn()</script>`;
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  app.eval("window.__pwnHits = 0; window.__pwn = () => { window.__pwnHits++; };");

  await openDay(app);
  await app.fill("#pm_text", "Base copy");
  await selectNets(app, "x");
  await openPanel(app);
  await app.fill(variantBox(app, "x"), payload);
  await app.click(saveButton(app));

  await app.click(app.byText(".calgrid .post", "Base copy"));
  await app.waitFor(() => app.$("#pm_text"));

  assert.equal(variantBox(app, "x").value, payload, "it reads back verbatim…");
  assert.deepEqual(
    app.$$("script, img, iframe, [onerror], [onload]", app.modal()).map(el => el.outerHTML), [],
    "…and never became markup");
  assert.equal(app.eval("window.__pwnHits"), 0);
});

test("per-network copy does not outlive the composer that wrote it", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openDay(app);
  await selectNets(app, "x");
  await openPanel(app);
  await app.fill(variantBox(app, "x"), "Only for this composer");

  app.answerConfirm(true);
  await app.click(app.byText(".modalfoot button", "Cancel"));
  assert.equal(app.modalOpen(), false);

  await openDay(app);
  assert.equal(app.$("#pm_percustom").checked, false);
  await selectNets(app, "x");
  await openPanel(app);
  assert.equal(variantBox(app, "x").value, "",
    "a fresh composer starts with no copy from the discarded one");
});
