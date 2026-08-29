/* ADR 0003 §1b — the browser tier's own wiring.
 *
 * Source-text checks, deliberately living in this tier rather than in
 * test/production-readiness.test.mjs, because everything they assert is about
 * this tier and nothing they assert needs a browser to be correct. They exist
 * because two of the constraints on this tier are silent when broken:
 *
 *  - it must stay out of `npm run check` (ADR 0003 decision 2), and a stray
 *    rename to *.test.mjs would quietly pull a 30-second browser suite into the
 *    fast job that every PR waits on;
 *  - playwright-core only ever looks for the browser build matching its own
 *    exact version, so the pin in package.json and the version CI downloads
 *    have to be the same string.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { PLAYWRIGHT_VERSION, ROOT_DIR } from "../test-harness/browser.mjs";

const read = name => readFileSync(ROOT_DIR + name, "utf8");
const pkg = JSON.parse(read("package.json"));

test("the browser tier has its own npm script and stays out of the fast suite", () => {
  assert.equal(pkg.scripts["test:browser"], "node --test test-browser/*.browser.mjs");
  assert.doesNotMatch(pkg.scripts.test, /test:browser|test-browser/,
    "`npm test` must not run the browser tier");
  assert.doesNotMatch(pkg.scripts.check, /test:browser|test-browser/,
    "ADR 0003 decision 2: this tier is kept out of the fast check job");
});

test("no browser test file is named so that bare `node --test` would collect it", () => {
  /* Node's default discovery matches **\/*.test.?(c|m)js, **\/*-test.*,
     **\/*_test.*, **\/test-*.*, **\/test.* and anything under a test/ directory.
     The .browser.mjs suffix matches none of those, which is the only thing
     keeping `npm test` from booting Chromium. */
  const collected = /(^|[.\-_])test\.(c|m)?js$|^test-.*\.(c|m)?js$/;
  for (const entry of readdirSync(ROOT_DIR + "test-browser")) {
    assert.doesNotMatch(entry, collected,
      `${entry} would be picked up by \`node --test\`; keep the .browser.mjs suffix`);
  }
});

test("the pinned playwright-core version matches what CI downloads a browser for", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.equal(pkg.devDependencies["playwright-core"], PLAYWRIGHT_VERSION,
    "package.json, test-harness/browser.mjs and CI must agree on one version");
  assert.match(workflow, /npx playwright-core install --with-deps chromium/,
    "CI installs the browser through the pinned playwright-core, not through a " +
    "floating `npx playwright`, or the download would be for the wrong revision");
  assert.match(workflow, /npm run test:browser/);
});

test("the browser job is separate from the check job and does not delay it", () => {
  const workflow = read(".github/workflows/ci.yml");
  const jobs = workflow.match(/^ {2}[a-z-]+:$/gm).map(line => line.trim().replace(":", ""));
  assert.ok(jobs.includes("browser"), `expected a browser job, found ${jobs.join(", ")}`);
  assert.doesNotMatch(workflow, /needs:\s*(\[\s*)?browser/,
    "nothing may wait on the browser job");

  const checkJob = workflow.slice(workflow.indexOf("  test:"), workflow.indexOf("  browser:"));
  assert.doesNotMatch(checkJob, /playwright/i,
    "the fast job must not install or run Playwright");
});
