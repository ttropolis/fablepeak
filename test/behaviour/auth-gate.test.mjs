// ADR 0003 flow 1 (auth gating) and flow 2 (first-brand onboarding).
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "../../test-harness/app.mjs";

test("signed-out cloud mode shows the welcome gate and empties the workspace", async t => {
  const app = await bootApp({ mode: "signedOut" });
  t.after(() => app.close());

  const welcome = app.$("#welcome");
  assert.equal(welcome.hidden, false, "the gate must be visible");
  assert.match(welcome.textContent, /All your social media, one clean workspace\./);

  assert.equal(app.main().innerHTML, "", "main must be emptied behind the gate");
  assert.equal(app.$("#nav").innerHTML, "", "nav must be emptied behind the gate");
  assert.equal(app.$("#brandSel").innerHTML, "", "the brand picker must be emptied");
  assert.equal(app.$("aside").inert, true);
  assert.equal(app.$("#main").inert, true);

  assert.deepEqual(app.blockedRequests, [], "the gate must not reach the network");
});

test("the gate offers sign in, create account and demo, and validates before calling the store", async t => {
  const app = await bootApp({ mode: "signedOut" });
  t.after(() => app.close());

  assert.ok(app.byText("#welcome button", "Sign in"));
  assert.ok(app.byText("#welcome button", "Create account"));
  assert.ok(app.byText("#welcome button", "Explore the demo first"));

  await app.click(".wcard button.wsubmit");
  assert.equal(app.text("#w_err"), "Email and password, please.");

  await app.click(app.byText(".wtabs button", "Create account"));
  await app.fill("#w_email", "someone@example.com");
  await app.fill("#w_pw", "short");
  await app.click(".wcard button.wsubmit");
  assert.equal(app.text("#w_err"), "Use at least 8 characters.");
  assert.deepEqual(app.blockedRequests, [], "a rejected form must not reach the network");
});

test("entering the demo replaces the gate with a seeded planner", async t => {
  const app = await bootApp({ mode: "signedOut" });
  t.after(() => app.close());

  await app.click(app.byText("#welcome button", "Explore the demo first"));
  await app.waitFor(() => app.main().querySelector("h1"), { label: "the planner" });

  assert.equal(app.$("#welcome").hidden, true);
  assert.equal(app.$("aside").inert, false);
  assert.equal(app.text("h1"), "Content Planner");
  assert.equal(app.text("#demoBadge"), "DEMO");
  assert.match(app.toast(), /Demo mode/);
  assert.equal(app.window.localStorage.getItem("fablepeak_demo"), "1");
  assert.ok(app.$$("#nav button").length >= 7, "navigation comes back with the workspace");
  assert.ok(app.$$(".calgrid .post").length > 0, "seeded posts render on the calendar");
  assert.deepEqual(app.blockedRequests, [], "demo mode must reach no network at all");
});

test("local mode never shows the gate", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());

  assert.equal(app.$("#welcome").hidden, true);
  assert.equal(app.store.name, "local");
  assert.equal(app.text("h1"), "Content Planner");
  assert.equal(app.text("#demoBadge"), "");
});

test("a signed-in account with no brands renders onboarding instead of throwing", async t => {
  const app = await bootApp({ mode: "cloud", cloud: { db: null } });
  t.after(() => app.close());

  assert.equal(app.db.brands.length, 0);
  assert.match(app.text(".obwrap h2"), /^Welcome to FablePeak, owner!$/);
  assert.ok(app.$("#ob_name"), "the create-brand field is offered");
  assert.deepEqual(app.jsdomErrors, [], "render() must not throw on an empty account");
});

test("naming the first brand creates it and moves on to connections", async t => {
  const app = await bootApp({ mode: "cloud", cloud: { db: null, available: [] } });
  t.after(() => app.close());

  await app.fill("#ob_name", "Peak Studio");
  await app.click(app.byText(".obwrap button", "Create brand"));
  await app.waitFor(() => app.view === "connections", { label: "the connections view" });

  assert.equal(app.db.brands.length, 1);
  assert.equal(app.db.brands[0].name, "Peak Studio");
  assert.equal(app.db.activeBrand, app.db.brands[0].id);
  assert.equal(app.$("#brandSel option").textContent, "Peak Studio");
  assert.deepEqual(app.blockedRequests, []);
});

test("an unnamed first brand is refused with a toast", async t => {
  const app = await bootApp({ mode: "cloud", cloud: { db: null } });
  t.after(() => app.close());

  await app.click(app.byText(".obwrap button", "Create brand"));
  assert.equal(app.toast(), "Give your brand a name");
  assert.equal(app.db.brands.length, 0);
});
