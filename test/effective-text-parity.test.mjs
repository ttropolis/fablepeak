// The composer's effectiveText (js/planner.js) and the publish function's
// (platforms.ts) must never drift: a post whose counter says "inherits" must
// inherit at publish. Both suites run the same fixture table —
// test/fixtures/effective-text-cases.json — so a semantic change on either
// side breaks the other side's suite until the fixture is updated with it.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { effectiveText } from "../js/planner.js";

const { cases } = JSON.parse(readFileSync(new URL("./fixtures/effective-text-cases.json", import.meta.url)));

test("js/planner.js effectiveText matches the shared fixture table", () => {
  for (const c of cases) {
    assert.equal(effectiveText(c.post, c.platform), c.expect, c.name);
  }
});
