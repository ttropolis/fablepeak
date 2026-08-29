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

/* ---------- ADR 0004: the public page, wired to the live backend ---------- */

const cloudDb = {
  activeBrand: "b1",
  brands: [{
    id: "b1", name: "Acme", seed: 5, connections: {}, inbox: [], posts: [],
    smartlink: {
      title: "Acme", bio: "Everything in one tap", avatar: "🚀", color: "#22c1dc",
      links: [
        { id: "L1", title: "Our website", url: "https://example.com", clicks: 132 },
        { id: "L2", title: "Latest video", url: "https://example.com/video", clicks: 87 },
      ],
    },
  }],
};

/** Boot cloud mode and land on a fully loaded SmartLinks view. */
async function openCloudSmartlinks(cloud = {}) {
  const app = await bootApp({ mode: "cloud", cloud: { db: cloudDb, ...cloud } });
  await app.click(app.byText("#nav button", "SmartLinks"));
  await app.waitFor(() => app.$("#sl_slug"), { label: "the publish controls" });
  return app;
}

const calls = (app, name) => app.storeCalls.filter(c => c.name === name);
const publishCard = app => app.byText(".card", "Public page").textContent.replace(/\s+/g, " ");

test("local mode says its page is a simulation and keeps its simulated counts", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSmartlinks(app);

  assert.match(app.main().textContent, /nothing here is public/);
  assert.match(app.main().textContent, /simulated demo data/);
  assert.equal(app.$("#sl_slug"), null, "local mode offers no slug to claim");
  assert.equal(rowFor(app, "Our website").querySelector(".clicks").textContent, "132 clicks");
});

test("claiming a slug goes through set_smartlink_slug and unlocks publishing", async t => {
  const app = await openCloudSmartlinks();
  t.after(() => app.close());

  assert.ok(app.byText(".card button", "Claim"), "an unclaimed brand is offered Claim");
  assert.equal(app.$("#sl_public"), null, "publishing is unavailable without a slug");

  await app.fill("#sl_slug", "acme-links");
  await app.click(app.byText(".card button", "Claim"));

  assert.deepEqual(calls(app, "setSmartlinkSlug").map(c => c.args), [["b1", "acme-links"]]);
  assert.equal(app.toast(), "Link name saved ✔");
  assert.ok(app.byText(".card button", "Change"), "a claimed slug is renamed, not re-claimed");
  assert.equal(app.$("#sl_slug").value, "acme-links");
  assert.ok(app.$("#sl_public"), "publishing is offered once a slug exists");
  assert.equal(app.$("#sl_public").checked, false, "publishing stays off by default");
});

test("a slug the backend refuses is reported and nothing is claimed", async t => {
  const app = await openCloudSmartlinks({
    slugResult: () => ({ ok: false, error: "slug_taken" }),
  });
  t.after(() => app.close());

  await app.fill("#sl_slug", "acme-links");
  await app.click(app.byText(".card button", "Claim"));

  assert.equal(calls(app, "setSmartlinkSlug").length, 1, "the backend was asked");
  assert.match(app.toast(), /already taken/);
  assert.ok(app.byText(".card button", "Claim"), "the brand still has no slug");
  assert.equal(app.$("#sl_public"), null);
});

test("the editor applies the backend's slug rules before spending a round trip", async t => {
  const app = await openCloudSmartlinks();
  t.after(() => app.close());

  for (const [slug, expected] of [
    ["ab", /between 3 and 30/],
    ["acme_links", /lowercase letters/],
    ["-acme", /lowercase letters/],
    ["acme--links", /Two hyphens/],
    ["admin", /reserved/],
  ]) {
    await app.fill("#sl_slug", slug);
    await app.click(app.byText(".card button", "Claim"));
    assert.match(app.toast(), expected, `"${slug}" should be refused locally`);
  }
  assert.deepEqual(calls(app, "setSmartlinkSlug"), [], "the backend was never called");

  await app.fill("#sl_slug", "acme-links");
  assert.match(app.$("#sl_slug_hint").textContent,
    /links\.fablepeak\.com\/\?b=acme-links/, "a valid slug previews its URL");

  // set_smartlink_slug case-folds, so mixed case is normalised rather than refused
  await app.fill("#sl_slug", "ACME");
  await app.click(app.byText(".card button", "Claim"));
  assert.deepEqual(calls(app, "setSmartlinkSlug").map(c => c.args), [["b1", "acme"]]);
});

test("publishing shows the live URL and unpublishing hides it again", async t => {
  const app = await openCloudSmartlinks({
    smartlinkPublishing: { slug: "acme", published: false },
  });
  t.after(() => app.close());

  assert.equal(app.$(".slurl"), null, "an unpublished page has no public URL");

  await app.check("#sl_public", true);
  assert.deepEqual(calls(app, "setSmartlinkPublic").map(c => c.args), [["b1", true]]);
  assert.equal(app.text(".slurl"), "https://links.fablepeak.com/?b=acme");
  assert.equal(app.toast(), "Your page is live ✔");

  await app.check("#sl_public", false);
  assert.deepEqual(calls(app, "setSmartlinkPublic").map(c => c.args), [["b1", true], ["b1", false]]);
  assert.equal(app.$(".slurl"), null, "unpublishing takes the URL away immediately");
  assert.equal(app.toast(), "Your page is no longer public");
});

test("cloud click counts come from the aggregate view and are labelled approximate", async t => {
  const app = await openCloudSmartlinks({
    smartlinkPublishing: { slug: "acme", published: true },
    clickTotals: [{ link_id: "L1", total: 4200, last_7d: 31 }],
  });
  t.after(() => app.close());

  assert.deepEqual(calls(app, "smartlinkClickTotals").map(c => c.args), [["b1"]]);
  assert.equal(rowFor(app, "Our website").querySelector(".clicks").textContent,
    "4200 clicks · approx.", "the jsonb clicks value (132) is no longer authoritative");
  assert.equal(rowFor(app, "Our website").querySelector(".clicks").title,
    "31 in the last 7 days");
  assert.equal(rowFor(app, "Latest video").querySelector(".clicks").textContent,
    "0 clicks · approx.", "a link with no rows counts zero, not its legacy jsonb value");
  assert.match(publishCard(app), /Click counts are approximate/);
});

test("a preview click in cloud mode does not invent a click", async t => {
  const app = await openCloudSmartlinks({
    smartlinkPublishing: { slug: "acme", published: true },
    clickTotals: [{ link_id: "L1", total: 7, last_7d: 7 }],
  });
  t.after(() => app.close());

  await app.click(app.$$(".phone .slink")[0]);

  assert.match(app.toast(), /Preview only/);
  assert.equal(rowFor(app, "Our website").querySelector(".clicks").textContent, "7 clicks · approx.");
  assert.equal(app.db.brands[0].smartlink.links[0].clicks, 132, "the legacy counter is untouched");
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
