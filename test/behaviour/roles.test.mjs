// ADR 0006 decision 6, UI half: an editor is not handed a control whose only
// outcome is "not authorised". The guarantee lives in RLS, a trigger and three
// definer RPCs (test/team-roles.test.mjs asserts those); this suite asserts the
// affordance — that the role is read once per brand, that the three owner-only
// surfaces respect it, and that local/demo mode is unaffected.
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "../../test-harness/app.mjs";

const brand = (id, name) => ({
  id, name, seed: 5, connections: {}, inbox: [], posts: [],
  smartlink: { title: name, bio: "", avatar: "🚀", color: "#22c1dc",
    links: [{ id: "l1", title: "Site", url: "https://example.com", clicks: 0 }] },
});
const db = { activeBrand: "b1", brands: [brand("b1", "Acme"), brand("b2", "Beta")] };

const account = {
  id: "a1", platform: "instagram", display_name: "@acme", status: "active",
  is_default: false, needs_reauth: false, last_verified_at: "2026-06-15T11:55:00Z",
  last_error: null, avatar_url: null,
};

const cloud = (role, extra = {}) => ({
  db, role, available: ["instagram"], accounts: [account],
  smartlinkPublishing: { slug: "acme", published: false }, ...extra,
});

async function open(app, viewName) {
  await app.click(app.byText("#nav button", viewName));
  await app.flush();
}
const instagram = app => app.$$(".conn").find(c => c.querySelector("strong").textContent === "Instagram");

test("an owner keeps every workspace control", async t => {
  const app = await bootApp({ mode: "cloud", cloud: cloud("owner") });
  t.after(() => app.close());
  await app.waitFor(() => app.state.roleCache.loaded, { label: "the role lookup" });

  await open(app, "Settings");
  const del = app.$$('button[data-action="deleteBrand"]');
  assert.equal(del.length, 2);
  assert.equal(del[0].disabled, false);
  assert.equal(app.main().textContent.includes("You're an editor"), false);

  await open(app, "Connections");
  await app.waitFor(() => app.$$(".conn").length === 8, { label: "the connection cards" });
  assert.ok(app.byText("button", "Disconnect", instagram(app)));
  assert.ok(app.byText("button", "Use for publishing", instagram(app)));

  await open(app, "SmartLinks");
  await app.waitFor(() => app.$("#sl_public"), { label: "the publish toggle" });
  assert.equal(app.$("#sl_public").disabled, false);
  assert.equal(app.$("#sl_slug").disabled, false);
  assert.equal(app.byText("button", "Change").disabled, false);
});

test("an editor sees the same page with the owner-only controls withdrawn", async t => {
  const app = await bootApp({ mode: "cloud", cloud: cloud("editor") });
  t.after(() => app.close());
  await app.waitFor(() => app.state.roleCache.loaded, { label: "the role lookup" });

  await open(app, "Settings");
  const del = app.$$('button[data-action="deleteBrand"]');
  assert.equal(del.length, 2, "the brands are still listed and still renameable");
  assert.equal(del[0].disabled, true);
  assert.equal(del[0].title, "Only workspace owners can change this.");
  assert.match(app.main().textContent, /Only its owners can delete a brand/);
  assert.equal(app.$("#newBrand").disabled, false, "anyone may create their own brand");

  await open(app, "Connections");
  await app.waitFor(() => app.$$(".conn").length === 8, { label: "the connection cards" });
  assert.equal(app.byText("button", "Disconnect", instagram(app)), null);
  assert.equal(app.byText("button", "Use for publishing", instagram(app)), null);
  // the account itself, its health and the Connect button are all still there
  assert.match(instagram(app).textContent, /@acme/);
  assert.ok(app.byText("button", "Connect", instagram(app)));
  assert.match(app.main().textContent, /Only its owners can disconnect an account/);

  await open(app, "SmartLinks");
  await app.waitFor(() => app.$("#sl_public"), { label: "the publish toggle" });
  assert.equal(app.$("#sl_public").disabled, true);
  assert.equal(app.$("#sl_public").title, "Only workspace owners can change this.");
  assert.equal(app.$("#sl_slug").disabled, true);
  assert.equal(app.byText("button", "Change").disabled, true);
  // the editor can still see and edit the page's content, and read its counts
  assert.equal(app.$$(".slrow").length, 1);
  assert.match(app.main().textContent, /Only its owners can claim a link name/);
});

test("the role is read once per brand and re-read when the brand changes", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: cloud("owner", { roleFor: id => (id === "b2" ? "editor" : "owner") }),
  });
  t.after(() => app.close());
  await app.waitFor(() => app.state.roleCache.loaded, { label: "the role lookup" });

  await open(app, "Settings");
  await open(app, "SmartLinks");
  await open(app, "Settings");
  const lookups = () => app.storeCalls.filter(c => c.name === "myRole").map(c => c.args[0]);
  assert.deepEqual(lookups(), ["b1"], "one lookup, however many renders");

  await app.call("switchBrand", "b2");
  await app.waitFor(() => app.state.roleCache.brandId === "b2" && app.state.roleCache.loaded,
    { label: "the second brand's role" });
  assert.deepEqual(lookups(), ["b1", "b2"]);
  assert.equal(app.$$('button[data-action="deleteBrand"]')[0].disabled, true);
});

test("a role that cannot be read leaves the controls alone", async t => {
  // The database is the guarantee, so an unreadable membership row must not
  // lock an owner out of their own workspace.
  const app = await bootApp({ mode: "cloud", cloud: cloud(null) });
  t.after(() => app.close());
  await app.waitFor(() => app.state.roleCache.loaded, { label: "the role lookup" });

  await open(app, "Settings");
  assert.equal(app.$$('button[data-action="deleteBrand"]')[0].disabled, false);
  await open(app, "SmartLinks");
  await app.waitFor(() => app.$("#sl_public"), { label: "the publish toggle" });
  assert.equal(app.$("#sl_public").disabled, false);
});

test("local mode has no accounts, so it asks nobody and gates nothing", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());

  await open(app, "Settings");
  assert.equal(app.main().textContent.includes("You're an editor"), false);
  await open(app, "SmartLinks");
  assert.equal(app.$("#sl_public"), null, "local mode shows the simulation card, not a toggle");
  assert.equal(app.state.roleCache.loaded, false, "no role lookup without a cloud account");
  assert.deepEqual(app.blockedRequests, []);
});
