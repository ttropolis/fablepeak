// The composer's splitXThread (js/x-thread.js) and the publish function's
// (platforms.ts) must never drift: one draws the preview that tells the
// customer their post goes out as three tweets, the other decides what X is
// actually sent. Both suites run the same fixture table —
// test/fixtures/x-thread-cases.json — so a semantic change on either side
// breaks the other side's suite until the fixture is updated with it. This is
// the mechanism test/effective-text-parity.test.mjs established.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { splitXThread, X_TEXT_LIMIT } from "../js/x-thread.js";

const { cases } = JSON.parse(readFileSync(new URL("./fixtures/x-thread-cases.json", import.meta.url)));
const width = value => [...value].length;

test("js/x-thread.js splitXThread matches the shared fixture table", () => {
  for (const c of cases) {
    if (c.error) {
      assert.throws(() => splitXThread(c.text), e => e.message === c.error, c.name);
      continue;
    }
    assert.deepEqual(splitXThread(c.text), c.tweets, c.name);
  }
});

test("no case in the table can produce a tweet X would reject", () => {
  // The whole point of reserving room for " (n/m)" before the count is known.
  // A fixture updated with a wrong expectation is caught here rather than by X.
  for (const c of cases) {
    for (const tweet of c.tweets ?? []) {
      assert.ok(width(tweet) <= X_TEXT_LIMIT,
        `${c.name}: ${width(tweet)} characters is over the ${X_TEXT_LIMIT} limit`);
    }
  }
});

test("no split ever lands inside a surrogate pair", () => {
  // Splitting on UTF-16 units instead of code points would halve an emoji and
  // publish two replacement characters. Breaking only at word boundaries makes
  // that impossible; this asserts the property rather than trusting it.
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const c of cases) {
    for (const tweet of c.tweets ?? []) {
      assert.ok(!lone.test(tweet), `${c.name}: a tweet carries half of a surrogate pair`);
    }
  }
});

test("a single tweet is returned unchanged and unnumbered", () => {
  // The customer wrote one tweet and gets one tweet: no " (1/1)", and the
  // adapter's request body for it is the one it sent before threads existed.
  for (const c of cases) {
    if (c.tweets?.length !== 1) continue;
    assert.equal(c.tweets[0], c.text, c.name);
    assert.doesNotMatch(c.tweets[0], /\(1\/1\)$/, c.name);
  }
});

test("every tweet of a real thread is numbered, in order, out of the same total", () => {
  for (const c of cases) {
    if (!c.tweets || c.tweets.length < 2) continue;
    const total = c.tweets.length;
    c.tweets.forEach((tweet, index) => {
      assert.ok(tweet.endsWith(` (${index + 1}/${total})`),
        `${c.name}: tweet ${index + 1} should end in (${index + 1}/${total})`);
    });
  }
});

test("the table covers the shapes the splitter has to get right", () => {
  // A fixture that quietly loses a case stops binding the two implementations.
  const names = cases.map(c => c.name).join(" | ");
  for (const shape of ["280", "281", "paragraph", "sentence", "word", "emoji", "refused"]) {
    assert.match(names, new RegExp(shape), `no case exercises ${shape}`);
  }
  assert.ok(cases.some(c => c.error), "the unsplittable-word refusal must be in the table");
  assert.ok(cases.some(c => c.tweets?.length > 9),
    "a thread past nine tweets is what proves the suffix reservation widens");
});
