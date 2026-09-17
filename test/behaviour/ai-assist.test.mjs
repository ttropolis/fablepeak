// The composer's AI assist row: cloud-only, one request at a time, model output
// treated as data, and the Edge Function's own error messages shown as toasts.
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, TODAY } from "../../test-harness/app.mjs";

/* Three active accounts: two the assist has a house style for, and one (Google
   Business) it does not — which is a different refusal from "pick exactly one". */
const accounts = [
  { id: "a1", platform: "instagram", display_name: "@acme", status: "active", is_default: true },
  { id: "a2", platform: "x", display_name: "@acme", status: "active", is_default: false },
  { id: "a3", platform: "gbp", display_name: "Acme HQ", status: "active", is_default: false },
];

function fixture(extra = {}) {
  return {
    available: ["instagram", "x"],
    accounts,
    db: {
      activeBrand: "b1",
      brands: [{
        id: "b1", name: "Acme", seed: 5, connections: {}, inbox: [],
        smartlink: { title: "Acme", bio: "", avatar: "🚀", color: "#22c1dc", links: [] },
        posts: [{
          id: "p1", date: TODAY, time: "10:00", text: "Old text",
          networks: ["instagram"], status: "draft", media_url: "", targets: [],
        }],
      }],
    },
    ...extra,
  };
}

const row = app => app.$("#pm_ai");
const assistButton = (app, label) => app.byText("#pm_ai .ai-row button", label);
const assistButtons = app => app.$$('#pm_ai button[data-action="runAiAssist"]');
const suggestions = app => app.$$("#pm_ai .ai-sugg").map(b => b.textContent);
const calls = (app, name) => app.storeCalls.filter(c => c.name === name);

/** Open the seeded draft, which already has text, so nothing has been typed. */
async function openSeededPost(app) {
  await app.click(app.$(".calgrid .post"));
  await app.waitFor(() => app.$("#pm_text"), { label: "the composer" });
}
async function openNewPost(app, date = TODAY) {
  await app.click(`[aria-label="Schedule a post on ${date}"]`);
  await app.waitFor(() => app.$("#pm_text"), { label: "the composer" });
}
async function bootComposer(extra = {}) {
  const app = await bootApp({ mode: "cloud", cloud: fixture(extra) });
  await openSeededPost(app);
  return app;
}

/* ---------- who sees it at all ---------- */

test("local mode offers no AI assist, not even a teaser", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());

  await openNewPost(app, "2026-06-22");
  assert.equal(row(app), null);
  assert.doesNotMatch(app.modal().textContent, /AI assist/);
});

test("the signed-out demo composer offers no AI assist either", async t => {
  const app = await bootApp({ mode: "demo" });
  t.after(() => app.close());

  await openNewPost(app, "2026-06-22");
  assert.equal(row(app), null);
});

test("a signed-in cloud composer offers all four assists", async t => {
  const app = await bootComposer();
  t.after(() => app.close());

  assert.ok(row(app), "cloud mode shows the row");
  assert.deepEqual(assistButtons(app).map(b => b.textContent.trim()),
    ["Suggest captions", "Hashtags", "Rewrite for network", "Fit to template"]);
  assert.equal(app.$("#pm_ai_template"), null,
    "a brand with no saved templates gets no picker — the button already says where to make one");
});

test("a published post is read-only, so it gets no assist row", async t => {
  const app = await bootApp({
    mode: "cloud",
    cloud: fixture({
      db: {
        activeBrand: "b1",
        brands: [{
          id: "b1", name: "Acme", seed: 5, connections: {}, inbox: [],
          smartlink: { title: "Acme", bio: "", avatar: "🚀", color: "#22c1dc", links: [] },
          posts: [{
            id: "p1", date: TODAY, time: "10:00", text: "Already out",
            networks: ["instagram"], status: "published", media_url: "", targets: [],
          }],
        }],
      },
    }),
  });
  t.after(() => app.close());

  await openSeededPost(app);
  assert.equal(row(app), null);
});

/* ---------- what each button needs before it can run ---------- */

test("an empty composer disables every assist and says what it wants", async t => {
  const app = await bootComposer();
  t.after(() => app.close());

  await app.fill("#pm_text", "");
  assert.deepEqual(assistButtons(app).map(b => b.disabled), [true, true, true, true]);
  assert.match(assistButton(app, "Suggest captions").title, /Type the topic/);
  assert.equal(assistButton(app, "Hashtags").title, "Write some content first");

  // Typing re-enables them without waiting for the textarea to lose focus.
  // "Fit to template" stays disabled: this brand has saved none, which is a
  // different problem from an empty box and says so.
  await app.fill("#pm_text", "Our new espresso blend");
  assert.deepEqual(assistButtons(app).map(b => b.disabled), [false, false, false, true]);
  assert.equal(assistButton(app, "Hashtags").hasAttribute("title"), false);
  assert.equal(assistButton(app, "Fit to template").title,
    "Save a template in Settings → Post templates first");
});

test("rewrite needs exactly one network the assist knows a house style for", async t => {
  const app = await bootComposer();
  t.after(() => app.close());
  const rewrite = () => assistButton(app, "Rewrite for network");
  const box = value => app.$(`#pm_nets input[value="${value}"]`);

  assert.equal(rewrite().disabled, false, "the seeded post names exactly one network");

  await app.check(box("x"), true);
  assert.equal(rewrite().disabled, true);
  assert.equal(rewrite().title, "Select exactly one network to rewrite for");

  await app.check(box("instagram"), false);
  await app.check(box("x"), false);
  assert.equal(rewrite().disabled, true);
  assert.equal(rewrite().title, "Select exactly one network to rewrite for");

  await app.check(box("gbp"), true);
  assert.equal(rewrite().disabled, true);
  assert.equal(rewrite().title, "AI assist has no house style for that network yet",
    "the Edge Function has no conventions for Google Business — a 400 waiting to happen");

  await app.check(box("gbp"), false);
  await app.check(box("x"), true);
  assert.equal(rewrite().disabled, false);
});

test("input longer than the server's ceiling is refused before a round trip", async t => {
  const app = await bootComposer();
  t.after(() => app.close());

  await app.fill("#pm_text", "x".repeat(4001));
  assert.deepEqual(assistButtons(app).map(b => b.disabled), [true, true, true, true]);
  assert.match(assistButton(app, "Hashtags").title, /up to 4000 characters — this is 4001/);
  assert.deepEqual(calls(app, "aiAssist"), []);
});

/* ---------- the happy paths ---------- */

test("captions are requested for the composer's text and listed as choices", async t => {
  const app = await bootComposer({
    aiAssist: { suggestions: ["Beans, but better ☕", "Meet the new blend", "Your 7am upgrade"] },
  });
  t.after(() => app.close());

  await app.fill("#pm_text", "Our new espresso blend");
  await app.click(assistButton(app, "Suggest captions"));

  assert.deepEqual(calls(app, "aiAssist").map(c => c.args), [[
    "b1", { action: "caption", topic: "Our new espresso blend", network: "instagram" },
  ]], "the single selected network is passed as a hint; the topic is the composer's text");
  assert.deepEqual(suggestions(app),
    ["Beans, but better ☕", "Meet the new blend", "Your 7am upgrade"]);
  assert.match(app.$("#pm_ai .ai-note").textContent, /Written by AI/);
});

test("the clicked button says it is thinking, and nothing else can start", async t => {
  const app = await bootComposer();
  t.after(() => app.close());

  assistButton(app, "Suggest captions").click();          // deliberately not awaited
  assert.ok(app.byText("#pm_ai button", "Thinking"), "the clicked button reports itself");
  assert.deepEqual(assistButtons(app).map(b => b.disabled), [true, true, true, true],
    "one request at a time");

  assistButton(app, "Hashtags").click();
  await app.flush();
  assert.equal(calls(app, "aiAssist").length, 1, "the second click was ignored");
  assert.deepEqual(assistButtons(app).map(b => b.disabled), [false, false, false, true],
    "the row comes back when the answer does — bar the one this brand has no templates for");
});

test("choosing a caption replaces the content and still counts as an unsaved edit", async t => {
  const app = await bootComposer({ aiAssist: { suggestions: ["Meet the new blend"] } });
  t.after(() => app.close());

  await app.click(assistButton(app, "Suggest captions"));
  await app.click(app.$("#pm_ai .ai-sugg"));

  assert.equal(app.$("#pm_text").value, "Meet the new blend");
  assert.equal(app.toast(), "Content replaced");

  app.answerConfirm(false);
  await app.click(app.byText(".modalfoot button", "Cancel"));
  assert.ok(app.confirms.includes("Discard this post?"),
    "the composer's dirty-state baseline treats a suggestion as an edit");
  assert.equal(app.modalOpen(), true, "…and declining the discard keeps the text");
  assert.equal(app.$("#pm_text").value, "Meet the new blend");
});

test("a rewrite names the one selected network and replaces the post", async t => {
  const app = await bootComposer({
    aiAssist: request => request.action === "rewrite"
      ? { suggestions: ["A tighter, punchier Old text."] } : { suggestions: [] },
  });
  t.after(() => app.close());

  await app.click(assistButton(app, "Rewrite for network"));
  assert.deepEqual(calls(app, "aiAssist").map(c => c.args), [[
    "b1", { action: "rewrite", text: "Old text", network: "instagram" },
  ]]);

  await app.click(app.$("#pm_ai .ai-sugg"));
  assert.equal(app.$("#pm_text").value, "A tighter, punchier Old text.");
});

test("hashtags append to the post instead of replacing it, and never twice", async t => {
  const app = await bootComposer({
    aiAssist: { suggestions: ["#coffee", "#espresso"], truncated: true },
  });
  t.after(() => app.close());

  await app.fill("#pm_text", "Morning ritual");
  await app.click(assistButton(app, "Hashtags"));
  assert.deepEqual(calls(app, "aiAssist").map(c => c.args), [[
    "b1", { action: "hashtags", text: "Morning ritual", network: "instagram" },
  ]]);
  assert.match(app.$("#pm_ai .ai-note").textContent, /may be cut short/,
    "a truncated answer says so");

  await app.click(app.byText("#pm_ai .ai-sugg", "#coffee"));
  assert.equal(app.$("#pm_text").value, "Morning ritual #coffee");
  assert.equal(app.toast(), "Hashtag added");

  await app.click(app.byText("#pm_ai .ai-sugg", "#coffee"));
  assert.equal(app.$("#pm_text").value, "Morning ritual #coffee", "the same tag is not doubled");

  await app.click(app.byText("#pm_ai .ai-sugg", "#espresso"));
  assert.equal(app.$("#pm_text").value, "Morning ritual #coffee #espresso");
});

test("the dismiss control clears the suggestions and leaves the post alone", async t => {
  const app = await bootComposer({ aiAssist: { suggestions: ["Meet the new blend"] } });
  t.after(() => app.close());

  await app.click(assistButton(app, "Suggest captions"));
  assert.equal(suggestions(app).length, 1);

  await app.click(app.$('#pm_ai [data-action="clearAiAssist"]'));
  assert.deepEqual(suggestions(app), []);
  assert.equal(app.$("#pm_text").value, "Old text");
  assert.ok(row(app), "the buttons stay; only the answer goes");
});

/* ---------- failures ---------- */

test("a rate limit is reported with how long it has left to run", async t => {
  const app = await bootComposer({
    aiAssist: {
      error: "AI assist is limited to 20 requests an hour. Try again later.",
      status: 429, retry_after_seconds: 3600,
    },
  });
  t.after(() => app.close());

  await app.click(assistButton(app, "Suggest captions"));

  assert.equal(app.toast(),
    "AI assist is limited to 20 requests an hour. Try again in about 60 minutes.");
  assert.deepEqual(suggestions(app), []);
  assert.deepEqual(assistButtons(app).map(b => b.disabled), [false, false, false, true],
    "a failure releases the row for another attempt");
});

test("an unconfigured server is quoted exactly as the function worded it", async t => {
  const app = await bootComposer({
    aiAssist: { error: "AI assist is not configured on the server", status: 503 },
  });
  t.after(() => app.close());

  await app.click(assistButton(app, "Hashtags"));
  assert.equal(app.toast(), "AI assist is not configured on the server");
});

test("a refusal and an unexpected failure both surface as plain sentences", async t => {
  const app = await bootComposer({
    aiAssist: request => request.action === "caption"
      ? { error: "The AI couldn't help with that content. Try rewording it.", status: 422 }
      : { error: "AI assist hit an unexpected error — try again shortly.", status: 500 },
  });
  t.after(() => app.close());

  await app.click(assistButton(app, "Suggest captions"));
  assert.equal(app.toast(), "The AI couldn't help with that content. Try rewording it.");

  await app.click(assistButton(app, "Hashtags"));
  assert.equal(app.toast(), "AI assist hit an unexpected error — try again shortly.");
  assert.doesNotMatch(app.toast(), /[{}]/, "no response body ever reaches the toast");
});

test("an answer with nothing usable in it says so rather than showing an empty list", async t => {
  const app = await bootComposer({ aiAssist: { suggestions: ["", "   "] } });
  t.after(() => app.close());

  await app.click(assistButton(app, "Suggest captions"));
  assert.equal(app.toast(), "AI assist returned nothing usable. Try again.");
  assert.deepEqual(suggestions(app), []);
});

/* ---------- lifecycle and containment ---------- */

test("suggestions do not outlive the composer that asked for them", async t => {
  const app = await bootComposer({ aiAssist: { suggestions: ["Meet the new blend"] } });
  t.after(() => app.close());

  await app.click(assistButton(app, "Suggest captions"));
  assert.equal(suggestions(app).length, 1);

  await app.click(app.byText(".modalfoot button", "Cancel"));
  assert.equal(app.modalOpen(), false);
  assert.equal(app.state.aiAssist.items.length, 0, "the state is cleared on close");

  await openSeededPost(app);
  assert.deepEqual(suggestions(app), [], "a reopened composer starts with no answer");
});

test("a hostile suggestion is rendered as text and never as markup", async t => {
  const payload = `"><img src=x onerror="__pwn()"><script>__pwn()</script>');__pwn();//`;
  const app = await bootComposer({ aiAssist: { suggestions: [payload] } });
  t.after(() => app.close());
  app.eval("window.__pwnHits = 0; window.__pwn = () => { window.__pwnHits++; };");

  await app.click(assistButton(app, "Suggest captions"));

  assert.deepEqual(
    app.$$("script, img, iframe, [onerror], [onload]", app.modal()).map(el => el.outerHTML), [],
    "model output must not become markup");
  assert.deepEqual(suggestions(app), [payload], "…it is shown verbatim, as text");

  await app.click(app.$("#pm_ai .ai-sugg"));
  assert.equal(app.$("#pm_text").value, payload);
  assert.equal(app.eval("window.__pwnHits"), 0);
});

/* ---------- ADR 0005 decision 13: rewrite targets the focused variant ---------- */

const variantBox = (app, net) => app.$(`#pm_variants textarea[data-net="${net}"]`);

/** Open the per-network panel with `nets` selected, and put the caret in one. */
async function focusVariant(app, net, nets) {
  for (const box of app.$$("#pm_nets input")) await app.check(box, nets.includes(box.value));
  await app.check("#pm_percustom", true);
  await app.waitFor(() => variantBox(app, net), { label: `the ${net} section` });
  variantBox(app, net).focus();                 // the real path: a caret, not a keystroke
  await app.flush();
}

test("rewrite retargets to the focused network however many are selected", async t => {
  const app = await bootComposer({
    aiAssist: request => request.action === "rewrite"
      ? { suggestions: ["Old text, but in 40 characters."] } : { suggestions: [] },
  });
  t.after(() => app.close());
  const rewrite = () => assistButton(app, "Rewrite for network");

  // Two networks selected: before this decision, rewrite was simply blocked.
  await focusVariant(app, "x", ["instagram", "x"]);
  assert.equal(rewrite().disabled, false,
    "the caret names the network, so the one-network restriction is retired");

  await app.click(rewrite());
  assert.deepEqual(calls(app, "aiAssist").map(c => c.args).at(-1), [
    "b1", { action: "rewrite", text: "Old text", network: "x" },
  ], "an empty variant inherits, so the base text is what the model is given — for X");

  await app.click(app.$("#pm_ai .ai-sugg"));
  assert.equal(variantBox(app, "x").value, "Old text, but in 40 characters.",
    "the suggestion lands in the variant the caret was in");
  assert.equal(app.$("#pm_text").value, "Old text", "…and the post's own content is untouched");
  assert.equal(app.toast(), "X / Twitter version replaced");
  assert.equal(variantBox(app, "instagram").value, "",
    "the network that was not targeted still inherits");
});

test("an AI suggestion in a variant is an unsaved change, and saves as per-network copy", async t => {
  const app = await bootComposer({ aiAssist: { suggestions: ["A tighter X line."] } });
  t.after(() => app.close());

  await focusVariant(app, "x", ["instagram", "x"]);
  await app.click(assistButton(app, "Rewrite for network"));
  await app.click(app.$("#pm_ai .ai-sugg"));

  app.answerConfirm(false);
  await app.click(app.byText(".modalfoot button", "Cancel"));
  assert.ok(app.confirms.includes("Discard this post?"),
    "model output in a variant is an edit like any other");
  assert.equal(app.modalOpen(), true);

  await app.fill("#pm_media", "https://cdn.example.com/photo.jpg");   // Instagram needs one
  await app.click(app.byText(".modalfoot button", "Save"));
  assert.equal(app.modalOpen(), false);
  const saved = app.db.brands[0].posts.find(p => p.id === "p1");
  assert.deepEqual({ ...saved.variants }, { x: "A tighter X line." });
  assert.equal(saved.text, "Old text");
});

test("a focused variant for a network with no house style is refused, not silently redirected", async t => {
  const app = await bootComposer();
  t.after(() => app.close());

  // Google Business is connected and selectable, and the Edge Function has no
  // conventions for it — a 400 waiting to happen. With the caret in its
  // section, falling back to the one other selected network would rewrite the
  // wrong thing, so the button refuses instead.
  await focusVariant(app, "gbp", ["instagram", "gbp"]);
  const rewrite = assistButton(app, "Rewrite for network");
  assert.equal(rewrite.disabled, true);
  assert.equal(rewrite.title, "AI assist has no house style for that network yet");
  assert.deepEqual(calls(app, "aiAssist"), []);
});

test("with no variant focused, rewrite still needs exactly one selected network", async t => {
  const app = await bootComposer();
  t.after(() => app.close());
  const rewrite = () => assistButton(app, "Rewrite for network");

  // The base text has no network of its own, so the original rule governs it.
  await app.check(app.$('#pm_nets input[value="x"]'), true);
  assert.equal(rewrite().disabled, true);
  assert.equal(rewrite().title, "Select exactly one network to rewrite for");
});

test("moving the caret back to the post's own content retargets the rewrite with it", async t => {
  const app = await bootComposer();
  t.after(() => app.close());
  const rewrite = () => assistButton(app, "Rewrite for network");

  await focusVariant(app, "x", ["instagram", "x"]);
  assert.equal(rewrite().disabled, false, "the X section is the subject");

  app.$("#pm_text").focus();
  await app.flush();
  assert.equal(rewrite().disabled, true);
  assert.equal(rewrite().title, "Select exactly one network to rewrite for",
    "the base text is the subject again, and two networks cannot both claim it");
});

/* ---------- ADR 0009: fitting a post to a saved template ----------

   The distinctive thing about this action is that it is the only one with a
   *second* subject: the post's text and the skeleton it goes into. The
   skeleton is chosen in a <select> that lives in a row paintAiAssist() rebuilds
   from scratch on every request, so "does the choice survive the re-render" is
   the behaviour these tests exist to hold. */

const TEMPLATE_BODY = "🎙️ New episode {number}: {title}\n\n{hook}\n\n👉 Listen: {link}";

/** The seeded fixture plus two saved templates on the brand. */
function templateFixture(extra = {}) {
  const base = fixture(extra);
  base.db.brands[0].post_templates = [
    { id: "t1", name: "Podcast episode", body: TEMPLATE_BODY },
    { id: "t2", name: "Feature launch", body: "{headline}\n\n{summary}" },
  ];
  return base;
}
async function bootTemplateComposer(extra = {}) {
  const app = await bootApp({ mode: "cloud", cloud: templateFixture(extra) });
  await openSeededPost(app);
  return app;
}
const picker = app => app.$("#pm_ai_template");

test("with templates saved, the picker appears and the button waits for a choice", async t => {
  const app = await bootTemplateComposer();
  t.after(() => app.close());

  assert.deepEqual([...picker(app).options].map(o => [o.value, o.textContent.trim()]),
    [["", "Template…"], ["t1", "Podcast episode"], ["t2", "Feature launch"]]);
  assert.equal(assistButton(app, "Fit to template").disabled, true);
  assert.equal(assistButton(app, "Fit to template").title,
    "Choose a template to fit this post into", "a different refusal from having none");

  await app.fill(picker(app), "t1");
  assert.equal(assistButton(app, "Fit to template").disabled, false);
  assert.equal(assistButton(app, "Fit to template").hasAttribute("title"), false);
});

test("the chosen template survives the row being repainted mid-request", async t => {
  const app = await bootTemplateComposer({
    aiAssist: { suggestions: ["🎙️ New episode 12: Old text\n\nA hook.\n\n👉 Listen: {link}"] },
  });
  t.after(() => app.close());

  await app.fill(picker(app), "t1");
  // paintAiAssist() replaces #pm_ai's innerHTML when the request starts and
  // again when it lands. A <select> that held the choice in the DOM would come
  // back on "Template…" both times, and the second click would be refused.
  assistButton(app, "Fit to template").click();          // deliberately not awaited
  assert.equal(picker(app).value, "t1", "…during the request");
  await app.flush();
  assert.equal(picker(app).value, "t1", "…and after it");
  assert.equal(assistButton(app, "Fit to template").disabled, false,
    "so a second fit needs no second choice");
});

test("the request carries the template body itself, and no network", async t => {
  const app = await bootTemplateComposer({
    aiAssist: { suggestions: ["🎙️ New episode 12: Old text\n\nA hook.\n\n👉 Listen: {link}"] },
  });
  t.after(() => app.close());

  await app.fill(picker(app), "t1");
  await app.click(assistButton(app, "Fit to template"));

  assert.deepEqual(calls(app, "aiAssist").map(c => c.args), [[
    "b1", { action: "template", text: "Old text", template_body: TEMPLATE_BODY },
  ]], "the body travels on the request — the Edge Function never reads the table — "
    + "and no network, because the skeleton is the shape");

  assert.match(app.$("#pm_ai .ai-outhead").textContent, /Tap the filled-in template/);
  await app.click(app.$("#pm_ai .ai-sugg"));
  assert.equal(app.$("#pm_text").value,
    "🎙️ New episode 12: Old text\n\nA hook.\n\n👉 Listen: {link}",
    "the answer replaces the content, unfilled slot and all");
  assert.equal(app.toast(), "Content replaced");
});

test("a template deleted under the composer blocks the button rather than sending a stale body", async t => {
  const app = await bootTemplateComposer();
  t.after(() => app.close());

  await app.fill(picker(app), "t1");
  app.db.brands[0].post_templates = app.db.brands[0].post_templates.filter(t => t.id !== "t1");
  await app.call("syncAiAssist");

  assert.equal(assistButton(app, "Fit to template").disabled, true);
  assert.equal(assistButton(app, "Fit to template").title, "Choose a template to fit this post into");
  await app.click(assistButton(app, "Fit to template"));
  assert.deepEqual(calls(app, "aiAssist"), [], "nothing is sent for a template that is gone");
});

test("the choice does not outlive the composer that made it", async t => {
  const app = await bootTemplateComposer();
  t.after(() => app.close());

  await app.fill(picker(app), "t2");
  await app.click(app.byText(".modalfoot button", "Cancel"));
  assert.equal(app.modalOpen(), false);
  assert.equal(app.state.composerTemplate, "", "cleared on close, like the suggestions");

  await openSeededPost(app);
  assert.equal(picker(app).value, "", "a reopened composer starts with nothing chosen");
});

test("a filled template reaches the box whole, whitespace and all", async t => {
  /* The composer is the last place a filled template can be damaged, and it had
     the same bug the Edge Function's parser had: an unconditional
     `.map(s => s.trim())` over every suggestion. Both readRequest and
     saveTemplate promise that whitespace outside the slots is part of the
     skeleton; a trim here breaks that promise at the last possible moment, and
     a skeleton that opens with a blank line cannot round-trip.

     The provider-side half of this — that a multi-line answer arrives as ONE
     suggestion rather than three — is asserted against the real parser in
     supabase/functions/ai-assist/index.deno.ts. This test is about what the
     composer does with the answer it is handed. */
  const filled = "\n🎙️ New episode 12: Compilers\n\nA hook, with a blank line above it.\n\n👉 example.test/12  ";
  const app = await bootTemplateComposer({ aiAssist: { suggestions: [filled] } });
  t.after(() => app.close());

  await app.fill(picker(app), "t1");
  await app.click(assistButton(app, "Fit to template"));

  assert.equal(app.$$("#pm_ai .ai-sugg").length, 1,
    "one filled template is one choice, never one per line");
  await app.click(app.$("#pm_ai .ai-sugg"));
  assert.equal(app.$("#pm_text").value, filled,
    "byte for byte, leading newline and trailing spaces included");

  // An answer that is only whitespace is still nothing, not a blank post.
  const blank = await bootTemplateComposer({ aiAssist: { suggestions: ["   \n  "] } });
  t.after(() => blank.close());
  await blank.fill(picker(blank), "t1");
  await blank.click(assistButton(blank, "Fit to template"));
  assert.deepEqual(blank.$$("#pm_ai .ai-sugg").map(b => b.textContent), []);
  assert.equal(blank.toast(), "AI assist returned nothing usable. Try again.");

  // …and the other actions still get their whitespace tidied, so this is the
  // template action's rule and not a lost behaviour.
  const caption = await bootTemplateComposer({ aiAssist: { suggestions: ["  Meet the blend  "] } });
  t.after(() => caption.close());
  await caption.click(assistButton(caption, "Suggest captions"));
  await caption.click(caption.$("#pm_ai .ai-sugg"));
  assert.equal(caption.$("#pm_text").value, "Meet the blend");
});
