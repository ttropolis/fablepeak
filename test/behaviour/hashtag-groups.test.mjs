// ADR 0005 publishing depth — hashtag groups: named, reusable tag sets managed
// in Settings and inserted into a post from the composer.
//
// Everything here runs in local mode on purpose. A group is local data with no
// backend of its own, so the whole feature has to work with no account at all —
// and `app.blockedRequests` proves it reaches no network while doing so.
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "../../test-harness/app.mjs";

const PREFIX = "data:application/json;charset=utf-8,";

async function openSettings(app) {
  await app.click(app.byText("#nav button", "Settings"));
  await app.waitFor(() => app.$("#hgName"), { label: "the Hashtag groups card" });
}
async function openComposer(app) {
  await app.click(app.byText("#main button", "+ New post"));
  await app.waitFor(() => app.$("#pm_text"), { label: "the composer" });
}
/** Fill the group form and press its one button. */
async function submitGroup(app, name, tags) {
  await app.fill("#hgName", name);
  await app.fill("#hgTags", tags);
  await app.click(app.byText("#main button", "Create group")
    || app.byText("#main button", "Save changes"));
}
const groups = app => app.db.brands[0].hashtag_groups;
const groupCards = app => app.$$("#main .hgroup");
/* `db` lives in jsdom's realm, so its arrays and objects are not
   reference-equal to this realm's prototypes and deepEqual refuses them.
   Copying through JSON is how a workspace value is compared to a literal. */
const plain = value => JSON.parse(JSON.stringify(value));
const names = app => plain(groups(app)).map(g => g.name);

/* ---------------------------------------------------------------- Settings */

test("the demo workspace ships groups, and a new one is created from Settings", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);

  assert.deepEqual(names(app), ["Product launch", "Evergreen"]);
  assert.equal(groupCards(app).length, 2);
  assert.match(app.text(".hgroup"), /Product launch/);
  assert.match(app.text(".hgroup"), /#launch #newfeature/);

  // Commas, spaces and a missing "#" are all how people write a tag list.
  await submitGroup(app, "  Local  ", "brisbane, #coffee  roasters");

  assert.equal(app.toast(), "Hashtag group created ✔");
  assert.equal(groups(app).length, 3);
  const created = plain(groups(app)).at(-1);
  assert.equal(created.name, "Local", "the name is trimmed");
  assert.deepEqual(created.tags, ["#brisbane", "#coffee", "#roasters"],
    "split on whitespace and commas, and the # is prepended where it is missing");
  assert.equal(groupCards(app).length, 3);
  assert.equal(app.$("#hgName").value, "", "the form is emptied for the next one");
  assert.deepEqual(app.blockedRequests, [], "a local workspace reaches no network");
});

test("editing a group loads it into the form and replaces it in place", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);
  const id = groups(app)[1].id;

  await app.click(app.$(`[data-action="editHashtagGroup"][data-arg="${id}"]`));
  assert.equal(app.$("#hgName").value, "Evergreen");
  assert.equal(app.$("#hgTags").value, "#marketing #socialmedia #contentstrategy");
  assert.ok(app.byText("#main button", "Save changes"), "the button says what it will do");

  await app.fill("#hgName", "Evergreen v2");
  await app.fill("#hgTags", "#marketing #tips");
  await app.click(app.byText("#main button", "Save changes"));

  assert.equal(app.toast(), "Hashtag group updated ✔");
  assert.equal(groups(app).length, 2, "an edit replaces the group, never adds one");
  assert.equal(groups(app)[1].id, id, "…and keeps its id, so the sync updates one row");
  assert.deepEqual(plain(groups(app))[1], { id, name: "Evergreen v2", tags: ["#marketing", "#tips"] });
  assert.ok(app.byText("#main button", "Create group"),
    "the form goes back to creating once the edit is saved");
});

test("Cancel leaves an edited group exactly as it was", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);
  const before = plain(groups(app));

  await app.click(app.$(`[data-action="editHashtagGroup"][data-arg="${before[0].id}"]`));
  await app.fill("#hgName", "Abandoned");
  await app.click(app.byText("#main button", "Cancel"));

  assert.deepEqual(plain(groups(app)), before);
  assert.equal(app.$("#hgName").value, "");
});

test("deleting a group asks first and removes only that one", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);
  const [first, second] = groups(app);

  app.answerConfirm(false);
  await app.click(app.$(`[data-action="deleteHashtagGroup"][data-arg="${first.id}"]`));
  assert.equal(groups(app).length, 2, "a declined confirm changes nothing");

  app.answerConfirm(true);
  await app.click(app.$(`[data-action="deleteHashtagGroup"][data-arg="${first.id}"]`));
  assert.match(app.confirms.at(-1), /Delete the hashtag group “Product launch”\?/);
  assert.equal(app.toast(), "Hashtag group deleted");
  assert.deepEqual(plain(groups(app)).map(g => g.id), [second.id]);
  assert.equal(groupCards(app).length, 1);
});

test("a group with no name is refused, and nothing is written", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);

  await submitGroup(app, "   ", "#launch #build");

  assert.equal(app.toast(), "Give the group a name.");
  assert.equal(groups(app).length, 2, "the workspace is untouched");
  assert.equal(app.$("#hgTags").value, "#launch #build",
    "and what was typed is still on screen to fix");
});

test("a group with no hashtags at all is refused", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);

  await submitGroup(app, "Empty", "   ,, ");
  assert.equal(app.toast(), "Add at least one hashtag.");
  assert.equal(groups(app).length, 2);
});

test("a malformed tag is refused by the same rules the CHECK constraint states", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);

  // Longer than 100 characters, the per-tag ceiling.
  await submitGroup(app, "Too long", "#" + "a".repeat(120));
  assert.match(app.toast(), /is longer than 100 characters\./);
  assert.equal(groups(app).length, 2);

  // A control character never reaches storage — a tag is rendered back into
  // this app and appended to post text.
  await submitGroup(app, "Control", "#lau\u0001nch");
  assert.equal(app.toast(), "A tag can't contain control characters.");
  assert.equal(groups(app).length, 2);

  // "#" on its own is not a hashtag.
  await submitGroup(app, "Bare hash", "#");
  assert.match(app.toast(), /isn't a hashtag/);
  assert.equal(groups(app).length, 2);

  // More than thirty tags in one group.
  await submitGroup(app, "Too many",
    Array.from({ length: 31 }, (_, i) => "#tag" + i).join(" "));
  assert.equal(app.toast(), "A group holds up to 30 hashtags — this one has 31.");
  assert.equal(groups(app).length, 2);
});

/* ---------------------------------------------------------------- composer */

test("a group's tags are appended to the post, after a blank line", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openComposer(app);

  assert.ok(app.$("#pm_hgroups"), "the disclosure is in the composer");
  const picks = app.$$("#pm_hgroups .hgroup-pick");
  assert.equal(picks.length, 2);
  assert.match(picks[0].textContent, /Product launch/);
  assert.match(picks[0].textContent, /#launch #newfeature #buildinpublic \+1 more/,
    "the first few tags preview what the group holds");

  await app.fill("#pm_text", "New feature drop!");
  await app.click(picks[0]);

  assert.equal(app.$("#pm_text").value,
    "New feature drop!\n\n#launch #newfeature #buildinpublic #saas");
  assert.equal(app.toast(), "Added 4 hashtags from “Product launch”");
  assert.match(app.text("#pm_count"), /^\d+ \/ /, "the counter was redrawn");
});

test("an empty post gets the tags alone, with no leading blank line", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openComposer(app);

  await app.click(app.$$("#pm_hgroups .hgroup-pick")[1]);
  assert.equal(app.$("#pm_text").value, "#marketing #socialmedia #contentstrategy");
});

test("a tag already in the post is never added twice", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openComposer(app);

  // #LAUNCH differs only in case, and Instagram treats the two as one tag.
  await app.fill("#pm_text", "Shipping today #LAUNCH #saas");
  await app.click(app.$$("#pm_hgroups .hgroup-pick")[0]);

  assert.equal(app.$("#pm_text").value,
    "Shipping today #LAUNCH #saas\n\n#newfeature #buildinpublic");
  assert.equal(app.toast(), "Added 2 of 4 — the rest were already there");

  // Pressing it a second time now has nothing left to add.
  app.clearToast();
  const before = app.$("#pm_text").value;
  await app.click(app.$$("#pm_hgroups .hgroup-pick")[0]);
  assert.equal(app.$("#pm_text").value, before, "the post is left exactly as it was");
  assert.equal(app.toast(), "Every hashtag in “Product launch” is already in this post");
});

test("inserted tags survive the save and reopen as ordinary post text", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openComposer(app);

  await app.fill("#pm_text", "Launch day");
  // The default network needs media; this test is about the text, not the rules.
  await app.fill("#pm_media", "https://cdn.example.com/launch.jpg");
  await app.click(app.$$("#pm_hgroups .hgroup-pick")[0]);
  await app.click(app.byText(".modalfoot button", "Schedule"));
  await app.waitFor(() => !app.modalOpen(), { label: "the composer to close" });

  const saved = app.db.brands[0].posts.at(-1);
  assert.match(saved.text, /^Launch day\n\n#launch /);
  assert.equal(saved.hashtag_group, undefined,
    "hashtags reach a post as plain text — the post shape does not change");
});

test("a brand with no groups gets no disclosure at all", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);

  app.answerConfirm(true);
  for (const g of [...groups(app)])
    await app.click(app.$(`[data-action="deleteHashtagGroup"][data-arg="${g.id}"]`));
  assert.equal(groups(app).length, 0);

  await app.click(app.byText("#nav button", "Planner"));
  await openComposer(app);
  assert.equal(app.$("#pm_hgroups"), null,
    "nothing at all, rather than an empty disclosure the keyboard has to walk");
});

/* ------------------------------------------------------------ hostile input */

test("a hostile group name is escaped in the Settings card and in the composer", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);
  const PAYLOAD = `<img src=x onerror="alert(1)">`;

  await submitGroup(app, PAYLOAD, "#safe #tags");
  assert.equal(groups(app).at(-1).name, PAYLOAD, "stored verbatim…");

  const card = app.byText("#main .hgroup", PAYLOAD);
  assert.ok(card, "…and rendered as text in the Settings card");
  assert.equal(card.querySelector("img"), null, "no element was parsed out of it");
  assert.equal(app.$("#main img"), null);

  await app.click(app.byText("#nav button", "Planner"));
  await openComposer(app);
  const pick = app.byText("#pm_hgroups .hgroup-pick", PAYLOAD);
  assert.ok(pick, "the composer menu shows the name as text");
  assert.equal(app.$("#pm_hgroups img"), null);
  assert.equal(app.modal().querySelector("img"), null);

  // The id travels in data-arg through attr(), never in an inline handler.
  assert.equal(pick.dataset.action, "insertHashtagGroup");
  assert.deepEqual(
    [...app.modal().querySelectorAll("*")].filter(el =>
      [...el.attributes].some(a => /^on/i.test(a.name))), []);
});

/* ------------------------------------------------------------------ backup */

test("hashtag groups ride the backup, and a malformed one is refused whole", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);

  await app.click(app.byText("#main button", "Export backup"));
  const json = decodeURIComponent(app.downloads.at(-1).href.slice(PREFIX.length));
  const good = JSON.parse(json);
  assert.deepEqual(good.brands[0].hashtag_groups.map(g => g.name),
    ["Product launch", "Evergreen"]);

  // Destroy them locally, then restore the file.
  app.answerConfirm(true);
  for (const g of [...groups(app)])
    await app.click(app.$(`[data-action="deleteHashtagGroup"][data-arg="${g.id}"]`));
  assert.equal(groups(app).length, 0);

  const importBackup = async body => {
    await app.click(app.byText("#main button", "Import backup"));
    await app.selectFile("#impFile", { body });
  };
  await importBackup(JSON.stringify(good));
  assert.equal(app.toast(), "Backup restored ✔");
  assert.deepEqual(names(app), ["Product launch", "Evergreen"]);

  // The same limits the CHECK enforces, restated where an untrusted file lands.
  for (const [label, damage] of [
    ["a tag with no #", d => { d.brands[0].hashtag_groups[0].tags = ["launch"]; }],
    ["a tag with a space", d => { d.brands[0].hashtag_groups[0].tags = ["#a b"]; }],
    ["a non-string tag", d => { d.brands[0].hashtag_groups[0].tags = [7]; }],
    ["an empty tag list", d => { d.brands[0].hashtag_groups[0].tags = []; }],
    ["thirty-one tags", d => {
      d.brands[0].hashtag_groups[0].tags = Array.from({ length: 31 }, (_, i) => "#t" + i);
    }],
    ["tags that are not an array", d => { d.brands[0].hashtag_groups[0].tags = "#launch"; }],
    ["a name of 61 characters", d => {
      d.brands[0].hashtag_groups[0].name = "n".repeat(61);
    }],
    ["a group that is not an object", d => { d.brands[0].hashtag_groups = ["#launch"]; }],
    ["groups that are not an array", d => { d.brands[0].hashtag_groups = {}; }],
  ]) {
    const broken = structuredClone(good);
    damage(broken);
    await importBackup(JSON.stringify(broken));
    assert.equal(app.toast(), "Invalid backup file", `${label} must be refused`);
    assert.deepEqual(names(app), ["Product launch", "Evergreen"],
      `${label}: the workspace in memory is untouched`);
  }

  // A brand exported before this feature simply has none, which is not an error.
  const older = structuredClone(good);
  delete older.brands[0].hashtag_groups;
  await importBackup(JSON.stringify(older));
  assert.equal(app.toast(), "Backup restored ✔");
  assert.deepEqual(plain(groups(app)), []);
});
