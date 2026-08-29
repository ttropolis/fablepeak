// ADR 0003 flow 11 (hostile-input containment): breakout payloads survive a full render as text, not as markup.
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "../../test-harness/app.mjs";

const PAYLOAD = `"><img src=x onerror="__pwn()"><script>__pwn()</script>');__pwn();//`;

/* Elements that can only exist if a payload escaped its text or attribute
   context. None of the covered views render an <img>, <script> or inline
   error/load handler of their own. */
const injections = root =>
  [...root.querySelectorAll("script, img, iframe, object, embed, [onerror], [onload]")]
    .map(el => el.outerHTML.slice(0, 120));

function assertContained(app, root = app.main()) {
  assert.deepEqual(injections(root), [], "the payload must not become markup");
  assert.equal(app.eval("window.__pwnHits"), 0, "nothing the payload named may run");
}

async function boot(t) {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  app.eval("window.__pwnHits = 0; window.__pwn = () => { window.__pwnHits++; };");
  return app;
}

const go = async (app, label) => {
  await app.click(app.byText("#nav button", label));
  await app.flush();
};

test("a hostile brand name is inert everywhere it is displayed", async t => {
  const app = await boot(t);

  await go(app, "Settings");
  await app.fill(app.$("#main input[type=text]"), PAYLOAD);
  assert.equal(app.db.brands[0].name, PAYLOAD);
  assertContained(app);
  assert.equal(app.$("#main input[type=text]").value, PAYLOAD);
  assert.equal(app.$("#brandSel option").textContent, PAYLOAD);
  assertContained(app, app.$("aside"));

  await go(app, "Reports");
  assert.equal(app.text("h1"), `Report — ${PAYLOAD}`);
  assertContained(app);

  await go(app, "Connections");
  assert.match(app.main().textContent, /Simulated connections for/);
  assertContained(app);
});

test("hostile post text is inert on the calendar, in the composer and in reports", async t => {
  const app = await boot(t);

  await app.click('[aria-label="Schedule a post on 2026-06-22"]');
  await app.waitFor(() => app.$("#pm_text"));
  await app.fill("#pm_text", PAYLOAD);
  await app.check('#pm_nets input[value="x"]', true);
  await app.check('#pm_nets input[value="instagram"]', false);
  await app.fill("#pm_status", "published");
  await app.click(app.$(".modalfoot .right button.btn:not(.ghost)"));

  const chip = app.$(`[aria-label="Schedule a post on 2026-06-22"]`).parentElement.querySelector(".post");
  assert.equal(chip.title, PAYLOAD);
  assert.match(chip.getAttribute("aria-label"), /published: "><img/);
  assertContained(app);

  await app.click(chip);
  await app.waitFor(() => app.$("#pm_text"));
  assert.equal(app.$("#pm_text").value, PAYLOAD, "the composer round-trips the text verbatim");
  assertContained(app, app.modal());
  await app.click(app.byText(".modalfoot button", "Cancel"));

  await go(app, "Reports");
  assert.ok(app.main().textContent.includes(PAYLOAD));
  assertContained(app);
});

test("a hostile inbox sender and message body are inert", async t => {
  const app = await boot(t);
  const thread = app.db.brands[0].inbox[0];
  thread.from = PAYLOAD;
  thread.msgs[0].text = PAYLOAD;
  app.call("render");

  await go(app, "Inbox");
  assert.equal(app.text(".msglist .msg .from span:first-child"), PAYLOAD);
  assertContained(app);

  await app.click(app.$$(".msglist .msg")[0]);
  assert.equal(app.$(".bubbles .bub").textContent, PAYLOAD);
  assertContained(app);

  await app.fill("#replyInp", PAYLOAD);
  await app.click(app.byText(".replyrow button", "Send"));
  assert.deepEqual(app.$$(".bubbles .bub").map(b => b.textContent), [PAYLOAD, PAYLOAD]);
  assertContained(app);
});

test("a hostile SmartLink title and URL are inert in the editor and the preview", async t => {
  const app = await boot(t);
  await go(app, "SmartLinks");

  await app.fill(app.$(".slrow input[type=text]"), PAYLOAD);
  await app.fill(app.$(".slrow input[type=url]"), PAYLOAD);
  assert.equal(app.$(".phone .slink").textContent, PAYLOAD);
  assert.equal(app.$(".slrow input[type=url]").value, PAYLOAD);
  assertContained(app);

  await app.fill(app.$$(".sledit input[type=text]")[0], PAYLOAD); // page title
  await app.fill(app.$$(".sledit input[type=text]")[1], PAYLOAD); // bio
  assert.equal(app.text(".phone h5"), PAYLOAD);
  assert.equal(app.text(".phone .bio"), PAYLOAD);
  assertContained(app);
});

test("hostile connection metadata from the server is inert", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: {
      db: {
        activeBrand: "b1",
        brands: [{ id: "b1", name: "Acme", seed: 1, connections: {}, inbox: [], posts: [],
          smartlink: { title: "Acme", bio: "", avatar: "🚀", color: "#22c1dc", links: [] } }],
      },
      available: ["instagram"],
      accounts: [{
        id: "a1", platform: "instagram", display_name: PAYLOAD, status: "error",
        is_default: true, needs_reauth: false, last_verified_at: null,
        last_error: PAYLOAD, avatar_url: null,
      }],
    },
  });
  t.after(() => app.close());
  app.eval("window.__pwnHits = 0; window.__pwn = () => { window.__pwnHits++; };");

  await app.click(app.byText("#nav button", "Connections"));
  await app.waitFor(() => app.$$(".conn").length === 8);

  const instagram = app.$$(".conn")[0];
  assert.ok(instagram.textContent.includes(PAYLOAD));
  assertContained(app);
});

/* ADR 0003 "Current-state risk assessment" §1: renderSmartlinks interpolated
   ${sl.color} unescaped into style="background:…" and value="…". The colour
   picker cannot produce a hostile value, but importData and a tampered local
   cache can. Phase 2a closes it with attr() plus an #rrggbb allowlist. */
test("a hostile SmartLink colour never reaches style or value", async t => {
  const app = await boot(t);
  await go(app, "SmartLinks");

  app.db.brands[0].smartlink.color = `#fff" onmouseover="__pwn()" data-x="`;
  app.call("render");

  assertContained(app);
  assert.equal(app.$(".phone .slink").getAttribute("style"), "background:#22c1dc",
    "an unparseable colour falls back to the default instead of being interpolated");
  assert.equal(app.$(".sledit input[type=color]").getAttribute("value"), "#22c1dc");
  assert.equal(app.$(".phone .slink").getAttribute("onmouseover"), null);

  // A legitimate colour still round-trips, so the guard is an allowlist and
  // not a blanket refusal. (The colour input lower-cases what it is given;
  // the validator itself is case-insensitive.)
  await app.fill(app.$(".sledit input[type=color]"), "#AB12CD");
  assert.equal(app.db.brands[0].smartlink.color, "#ab12cd");
  assert.equal(app.$(".phone .slink").getAttribute("style"), "background:#ab12cd");
  assert.equal(app.call("slColorOf", "#AB12CD"), "#AB12CD");
});

/* Delegation moved every record id out of JavaScript-in-attribute position and
   into data-arg. These two prove the new position is escaped *and* still
   round-trips the id byte-for-byte to the handler. */
test("a hostile SmartLink id cannot break out of data-arg", async t => {
  const app = await boot(t);
  app.db.brands[0].smartlink.links[0].id = PAYLOAD;
  app.call("render");
  await go(app, "SmartLinks");

  const remove = app.byText(".slrow button.dangerb", "✕");
  assert.equal(remove.dataset.arg, PAYLOAD, "the id survives attribute escaping intact");
  assert.equal(remove.getAttribute("onclick"), null);
  assert.equal(app.$(".phone .slink").dataset.arg, PAYLOAD);
  assertContained(app);

  await app.click(remove);
  assert.equal(app.db.brands[0].smartlink.links.some(l => l.id === PAYLOAD), false,
    "the delegated handler received the same id back and deleted the right link");
  assertContained(app);
});

test("a hostile post id cannot break out of data-arg on the calendar", async t => {
  const app = await boot(t);
  const post = app.db.brands[0].posts.find(p => p.status === "draft");
  post.id = PAYLOAD;
  app.call("render");

  const chip = app.byText(".calgrid .post", post.text);
  assert.equal(chip.dataset.arg, PAYLOAD);
  assert.equal(chip.dataset.action, "openPost");
  assert.equal(chip.dataset.drag, "dragPost");
  assert.equal(chip.getAttribute("ondragstart"), null);
  assertContained(app);

  await app.click(chip);
  await app.waitFor(() => app.$("#pm_text"));
  assert.equal(app.$("#pm_text").value, post.text,
    "the id round-tripped through data-arg and opened the right post");
  assertContained(app, app.modal());
});
