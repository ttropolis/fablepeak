// ADR 0009 post templates — the Settings card, exercised in the browser.
//
// Local mode on purpose, like the hashtag groups behaviour tests beside it: a
// template is local data with no backend of its own, so the whole management
// half of the feature has to work with no account at all. (The composer's
// "Fit to template" button is cloud-only and lives in ai-assist.test.mjs.)
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "../../test-harness/app.mjs";

async function openSettings(app) {
  await app.click(app.byText("#nav button", "Settings"));
  await app.waitFor(() => app.$("#tplName"), { label: "the Post templates card" });
}
/** A lone surrogate — half of a pair, left behind by a slice that cut between
 *  the two UTF-16 units an emoji is stored as. */
const hasLoneSurrogate = text => [...text].some(ch =>
  ch.length === 1 && ch.charCodeAt(0) >= 0xD800 && ch.charCodeAt(0) <= 0xDFFF);

test("a card preview of an emoji template never renders half a character", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);

  /* A first line longer than the 70-character preview limit, made of astral
     emoji, so the truncation point lands between the halves of a pair unless it
     is measured in code points. 🎙 is one code point and two UTF-16 units, so
     50 of them is 50 characters and 100 units — a `.slice(0, 70)` cuts at unit
     70, which is the middle of the 36th emoji. */
  const firstLine = "🎙".repeat(50) + " a podcast episode about compilers and parsers";
  await app.fill("#tplName", "Emoji heavy");
  await app.fill("#tplBody", `${firstLine}\n\n{hook}`);
  await app.click(app.byText("#main button", "Create template"));

  const preview = app.$$("#main .tpl-preview").at(-1);   // the one just created
  assert.ok(preview, "the card rendered");
  assert.equal(hasLoneSurrogate(preview.textContent), false,
    "the preview must not be cut between the halves of an emoji");
  assert.equal([...preview.textContent].length, 71, "70 characters and the ellipsis");
  assert.ok(preview.textContent.endsWith("…"));
  assert.ok(preview.textContent.startsWith("🎙🎙"));

  // …and the name the customer typed survived, so the card is about the right
  // template. The stored body is untouched by anything the preview does.
  assert.equal(app.db.brands[0].post_templates.at(-1).body, `${firstLine}\n\n{hook}`);
  assert.deepEqual(app.blockedRequests, [], "managing a template reaches no network");
});

test("a short first line is shown whole, with no ellipsis", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openSettings(app);

  await app.fill("#tplName", "Short");
  await app.fill("#tplBody", "🎙️ New episode {number}\n\n{hook}");
  await app.click(app.byText("#main button", "Create template"));

  const preview = app.$$("#main .tpl-preview").at(-1);
  assert.equal(preview.textContent, "🎙️ New episode {number}");
  assert.equal(hasLoneSurrogate(preview.textContent), false);
});
