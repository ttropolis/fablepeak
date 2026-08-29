// ADR 0003 flows 6 (connect/disconnect rendering) and 7 (connection refresh fan-out).
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, reloadAccounts } from "../../test-harness/app.mjs";

const db = {
  activeBrand: "b1",
  brands: [{
    id: "b1", name: "Acme", seed: 5, connections: {}, inbox: [],
    smartlink: { title: "Acme", bio: "", avatar: "🚀", color: "#22c1dc", links: [] },
    posts: [{ id: "p1", date: "2026-06-16", time: "09:00", text: "Later this week",
              networks: ["instagram"], status: "scheduled", media_url: "", targets: [] }],
  }],
};

const account = extra => ({
  id: "a1", platform: "instagram", display_name: "@acme", status: "active",
  is_default: true, needs_reauth: false, last_verified_at: "2026-06-15T11:55:00Z",
  last_error: null, avatar_url: null, ...extra,
});

const card = (app, netId) => {
  const name = { instagram: "Instagram", facebook: "Facebook", x: "X / Twitter",
    linkedin: "LinkedIn", tiktok: "TikTok", youtube: "YouTube",
    pinterest: "Pinterest", gbp: "Google Business" }[netId];
  return app.$$(".conn").find(c => c.querySelector("strong").textContent === name);
};
const cardText = (app, netId) => card(app, netId).textContent.replace(/\s+/g, " ").trim();

async function openConnections(app) {
  await app.click(app.byText("#nav button", "Connections"));
  await app.waitFor(() => app.$$(".conn").length === 8, { label: "the connection cards" });
}

test("a verified default account renders as the publishing account", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: { db, available: ["instagram", "facebook", "youtube"], accounts: [account()] },
  });
  t.after(() => app.close());
  await openConnections(app);

  const instagram = card(app, "instagram");
  assert.equal(instagram.querySelector(".st").classList.contains("on"), true);
  assert.equal(instagram.querySelector(".st").textContent.trim(), "@acme");
  assert.match(cardText(app, "instagram"), /✓ Publishing account/);
  assert.match(cardText(app, "instagram"), /Verified/);
  assert.equal(app.byText("span", "Verified", instagram).title, "2026-06-15T11:55:00Z");
  assert.ok(app.byText("button", "Disconnect", instagram));
  assert.equal(app.byText("button", "Use for publishing", instagram), null,
    "the default account is not offered to itself");
});

test("an expired account asks to be reconnected and shows its last error", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: {
      db, available: ["instagram"],
      accounts: [account({ status: "expired", needs_reauth: true, last_verified_at: null,
        last_error: "Instagram token expired on 12 June" })],
    },
  });
  t.after(() => app.close());
  await openConnections(app);

  const instagram = card(app, "instagram");
  assert.match(cardText(app, "instagram"), /⚠️ Needs reconnecting/);
  assert.match(cardText(app, "instagram"), /Instagram token expired on 12 June/);
  assert.equal(instagram.querySelector(".st").classList.contains("on"), false,
    "an expired account is not shown as live");
  assert.ok(app.byText("button", "Reconnect", instagram));
  assert.equal(app.byText("span", "Verified", instagram), null);
});

test("a failed health check is distinguished from an expired token", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: {
      db, available: ["instagram"],
      accounts: [account({ status: "error", needs_reauth: false, last_error: "429 from Instagram" })],
    },
  });
  t.after(() => app.close());
  await openConnections(app);

  assert.match(cardText(app, "instagram"), /⚠️ Connection check failed/);
  assert.doesNotMatch(cardText(app, "instagram"), /Needs reconnecting/);
  assert.match(cardText(app, "instagram"), /429 from Instagram/);
});

test("a second active account can be promoted to the publishing account", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: {
      db, available: ["instagram"],
      accounts: [account(), account({ id: "a2", display_name: "@acme.studio", is_default: false })],
    },
  });
  t.after(() => app.close());
  await openConnections(app);

  const promote = app.byText("button", "Use for publishing", card(app, "instagram"));
  assert.ok(promote, "a non-default active account offers promotion");
  await app.click(promote);
  await app.waitFor(() => app.storeCalls.some(c => c.name === "selectAccount"),
    { label: "the account selection call" });
  assert.deepEqual(app.storeCalls.findLast(c => c.name === "selectAccount").args, ["a2"]);
});

test("configured platforms offer Connect and unconfigured ones name their gate", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: { db, available: ["instagram", "facebook", "youtube"], accounts: [] },
  });
  t.after(() => app.close());
  await openConnections(app);

  const facebook = app.byText("button", "Connect", card(app, "facebook"));
  assert.equal(facebook.disabled, false);
  assert.equal(card(app, "facebook").querySelector(".st").textContent.trim(), "Available to connect");

  for (const [netId, reason] of [
    ["x", "Paid API credentials pending"],
    ["linkedin", "Developer app credentials pending"],
    ["tiktok", "Deferred — compliance workflow pending"],
    ["pinterest", "Developer app and acceptance test pending"],
    ["gbp", "Not implemented"],
  ]) {
    const button = app.byText("button", "Connect", card(app, netId));
    assert.equal(button.disabled, true, `${netId} must not be connectable`);
    assert.equal(button.title, reason);
    assert.equal(card(app, netId).querySelector(".st").textContent.trim(), reason);
  }
});

test("with no platform configured the whole surface says so honestly", async t => {
  const app = await bootApp({ mode: "cloud", cloud: { db, available: [], accounts: [] } });
  t.after(() => app.close());
  await openConnections(app);

  assert.match(app.main().textContent, /Social connections are temporarily unavailable\./);
  assert.match(app.main().textContent,
    /You do not need to create developer credentials or configure anything yourself\./);
});

test("disconnecting confirms, calls the backend and re-renders from the fresh account list", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: { db, available: ["instagram"], accounts: [account()] },
  });
  t.after(() => app.close());
  await openConnections(app);

  app.store.disconnectAccount = async id => {
    app.storeCalls.push({ name: "disconnectAccount", args: [id] });
    app.store.listAccounts = async () => app.intoPage([]);
  };
  await app.click(app.byText("button", "Disconnect", card(app, "instagram")));
  await app.waitFor(() => app.toast() === "Disconnected", { label: "the disconnect toast" });

  assert.equal(app.confirms.at(-1),
    "Disconnect @acme? Scheduled posts will stop publishing to it.");
  assert.deepEqual(app.storeCalls.findLast(c => c.name === "disconnectAccount").args, ["a1"]);
  assert.equal(card(app, "instagram").querySelector(".st").textContent.trim(), "Available to connect");
  assert.equal(app.byText("button", "Disconnect", card(app, "instagram")), null);
});

test("account changes fan out to the planner and the composer, not just Connections", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: { db, available: ["instagram"], accounts: [] },
  });
  t.after(() => app.close());

  assert.match(app.text(".sub"), /⚠️ No profiles connected yet — go to Connections\./);

  await reloadAccounts(app, [account()]);
  assert.equal(app.view, "planner", "the fan-out re-renders the view the user is actually on");
  assert.doesNotMatch(app.text(".sub"), /No profiles connected yet/);

  await app.click('[aria-label="Schedule a post on 2026-06-22"]');
  await app.waitFor(() => app.$("#pm_nets"));
  assert.deepEqual(app.$$("#pm_nets input:not([disabled])").map(i => i.value), ["instagram"],
    "the composer offers exactly the live connected accounts");

  await app.click(app.byText(".modalfoot button", "Cancel"));
  await reloadAccounts(app, [account({ status: "expired", needs_reauth: true })]);
  assert.match(app.text(".sub"), /⚠️ No profiles connected yet/,
    "an expired account stops counting as connected everywhere");
});

test("the planner never claims nothing is connected while connections are still loading", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: { db, available: ["instagram"], accounts: [account()] },
  });
  t.after(() => app.close());
  assert.doesNotMatch(app.text(".sub"), /No profiles connected yet/,
    "a loaded cache with a live account is not a warning");

  // Exactly the state right after sign-in or a brand switch: the accounts are
  // real and connected, the cache simply has not come back yet.
  app.eval("connCache = { brandId:null, available:[], accounts:[], loaded:false }");
  await app.call("render");
  assert.doesNotMatch(app.text(".sub"), /No profiles connected yet/,
    "an unloaded cache means unknown, not empty");
});

test("local mode renders simulated connections and never claims they are real", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openConnections(app);

  assert.match(app.main().textContent, /These are placeholders, not real accounts\./);
  assert.match(app.main().textContent,
    /Real platform connections need the cloud backend\. Local mode can only simulate them\./);
  assert.match(cardText(app, "instagram"), /Simulated · @mybrand/);
  assert.ok(app.$("#h_youtube"), "unconnected platforms offer a simulated handle field");

  await app.click(app.byText("button", "Remove", card(app, "instagram")));
  assert.equal(app.toast(), "Instagram removed");
  assert.equal(card(app, "instagram").querySelector(".st").textContent.trim(), "Not connected");
  assert.deepEqual(app.blockedRequests, []);
});
