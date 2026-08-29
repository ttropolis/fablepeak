// ADR 0003 flow 10 (settings backup round-trip): export, import, and the import validation gap the ADR calls out.
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "../../test-harness/app.mjs";

const PREFIX = "data:application/json;charset=utf-8,";
const LS_KEY = "fablepeak_v1";

async function openSettings(app) {
  await app.click(app.byText("#nav button", "Settings"));
  await app.waitFor(() => app.byText("#main button", "Export backup"), { label: "Settings" });
}

async function exportBackup(app) {
  await app.click(app.byText("#main button", "Export backup"));
  const download = app.downloads.at(-1);
  return { download, json: decodeURIComponent(download.href.slice(PREFIX.length)) };
}

async function importBackup(app, body) {
  await app.click(app.byText("#main button", "Import backup"));
  await app.selectFile("#impFile", { body });
}

test("exporting downloads the whole workspace as dated JSON", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);

  const { download, json } = await exportBackup(app);
  assert.equal(download.name, "fablepeak-backup-2026-06-15.json");
  assert.ok(download.href.startsWith(PREFIX));
  assert.equal(app.toast(), "Backup downloaded");

  const parsed = JSON.parse(json);
  assert.equal(parsed.brands.length, 1);
  assert.equal(parsed.brands[0].name, "My Brand");
  assert.equal(parsed.brands[0].posts.length, 7);
  assert.equal(parsed.brands[0].inbox.length, 4);
  assert.equal(parsed.activeBrand, parsed.brands[0].id);
});

test("a backup restores a workspace that was changed after the export", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);
  const { json } = await exportBackup(app);

  // Damage the workspace the way a user might: rename the brand and drop a post.
  await app.fill(app.$("#main input[type=text]"), "Renamed by mistake");
  await app.click(app.byText("#nav button", "Planner"));
  await app.click(app.$(".calgrid .post"));
  await app.waitFor(() => app.$("#pm_text"));
  await app.click(app.byText(".modalfoot button", "Delete"));
  assert.equal(app.db.brands[0].posts.length, 6);
  assert.equal(app.db.brands[0].name, "Renamed by mistake");

  await openSettings(app);
  await importBackup(app, json);

  assert.equal(app.toast(), "Backup restored ✔");
  assert.equal(app.db.brands[0].name, "My Brand");
  assert.equal(app.db.brands[0].posts.length, 7);
  assert.equal(app.$("#brandSel option").textContent, "My Brand");
  assert.equal(JSON.parse((await exportBackup(app)).json).brands[0].posts.length, 7,
    "a second export round-trips to the same content");
});

test("unparseable JSON is refused and leaves the workspace alone", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);

  await importBackup(app, "{ this is not json ");
  assert.equal(app.toast(), "Invalid backup file");
  assert.equal(app.db.brands[0].name, "My Brand");
  assert.equal(app.db.brands[0].posts.length, 7);
});

test("a file without a brands array is refused and leaves the workspace alone", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);

  await importBackup(app, JSON.stringify({ brands: "nope", activeBrand: "x" }));
  assert.equal(app.toast(), "Invalid backup file");
  assert.equal(app.db.brands[0].name, "My Brand");
  assert.equal(app.$("#main input[type=text]").value, "My Brand");
});

/* ADR 0003 §2a: importData() now validates the whole parsed file against the
   workspace schema *before* it assigns `db`. The previous behaviour — reported
   as invalid only because render() threw, by which point `db` was already
   replaced and queued for persistence — is what this test used to pin. It now
   pins the safe behaviour instead. */
test("a brands array with invalid members is refused and never replaces the workspace", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);
  await app.waitFor(() => app.window.localStorage.getItem(LS_KEY),
    { label: "the seeded workspace to persist" });
  const before = app.window.localStorage.getItem(LS_KEY);

  await importBackup(app, JSON.stringify({ brands: [{ id: "x", name: "Broken" }] }));

  assert.equal(app.toast(), "Invalid backup file", "the user is told the file was rejected");
  assert.equal(app.db.brands[0].name, "My Brand", "the workspace in memory is untouched");
  assert.equal(app.db.activeBrand, app.db.brands[0].id);
  assert.equal(app.db.brands[0].posts.length, 7);
  assert.equal(app.$("#main input[type=text]").value, "My Brand",
    "and the screen still shows the workspace that is still there");

  // Longer than save()'s 200 ms debounce: a rejected import must never persist.
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(app.window.localStorage.getItem(LS_KEY), before,
    "a rejected import must not reach storage — from there it reaches Supabase");
});

test("a backup whose posts are malformed is rejected as a whole", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);
  const good = JSON.parse((await exportBackup(app)).json);

  const broken = structuredClone(good);
  broken.brands[0].posts[0].networks = "instagram";   // string, not an array
  await importBackup(app, JSON.stringify(broken));
  assert.equal(app.toast(), "Invalid backup file");
  assert.equal(app.db.brands[0].posts.length, 7);

  const noSmartlink = structuredClone(good);
  delete noSmartlink.brands[0].smartlink;
  await importBackup(app, JSON.stringify(noSmartlink));
  assert.equal(app.toast(), "Invalid backup file");
  assert.equal(app.db.brands[0].name, "My Brand");

  // ...and the same file, unbroken, is still accepted.
  await importBackup(app, JSON.stringify(good));
  assert.equal(app.toast(), "Backup restored ✔");
  assert.equal(app.db.brands[0].posts.length, 7);
});

test("an out-of-range SmartLink colour is normalised on import", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);
  const good = JSON.parse((await exportBackup(app)).json);
  good.brands[0].smartlink.color = `#fff" onmouseover="alert(1)`;

  await importBackup(app, JSON.stringify(good));
  assert.equal(app.toast(), "Backup restored ✔");
  assert.equal(app.db.brands[0].smartlink.color, "#22c1dc",
    "a colour that is not #rrggbb falls back to the default");
});

test("resetting to demo data asks first and rebuilds the seeded workspace", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);
  await app.fill(app.$("#main input[type=text]"), "Renamed");

  await app.click(app.byText("#main button", "Reset to demo"));
  assert.equal(app.confirms.at(-1), "Replace ALL current data with fresh demo data?");
  assert.equal(app.toast(), "Demo data restored");
  assert.equal(app.db.brands[0].name, "My Brand");
  assert.equal(app.db.brands[0].posts.length, 7);
});

test("local mode says plainly that there is no cloud sync", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);

  assert.match(app.main().textContent, /Mode: 💻 Local \(this browser only\)/);
  assert.match(app.main().textContent, /it intentionally runs without accounts or cloud sync/);
  assert.deepEqual(app.blockedRequests, []);
});
