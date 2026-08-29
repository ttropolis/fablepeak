import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The public SmartLinks renderer (smartlinks-site/) is a dependency-free static
// site deployed to a separate origin, https://links.fablepeak.com. It has no
// build step to fail and no framework to hold the line for it, so its security
// properties are properties of the source text itself: ADR 0004 decision 4
// requires DOM built with textContent, an http(s)-only URL gate and a strict
// CSP, and the 2026-08-29 amendments require fetch(keepalive) rather than the
// beacon API. Each of those is asserted here against the file that ships.

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const SITE = "smartlinks-site/";
const SUPABASE_ORIGIN = "https://lghsvxwuaebvotutyjtt.supabase.co";

// Everything between <tag> and </tag> — exactly the bytes a browser hashes for
// a CSP inline-content hash.
function inlineBlock(html, tag) {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = html.indexOf(open);
  const end = html.indexOf(close, start);
  assert.ok(start !== -1 && end !== -1, `index.html must contain a single <${tag}> block`);
  assert.equal(html.indexOf(open, start + 1), -1, `index.html must contain only one <${tag}> block`);
  return html.slice(start + open.length, end);
}

const sha256 = source => createHash("sha256").update(source, "utf8").digest("base64");

test("the renderer ships a strict meta CSP", async () => {
  const html = await read(`${SITE}index.html`);
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(meta, "index.html must carry a meta CSP — static hosting cannot set response headers");
  const csp = meta[1];

  assert.match(csp, /(^|;\s*)default-src 'none'/, "everything must be denied by default");
  // The two anon RPCs are the only network destinations that may exist.
  assert.match(csp, new RegExp(`(^|;\\s*)connect-src ${SUPABASE_ORIGIN.replace(/[.]/g, "\\.")}\\s*(;|$)`));
  assert.match(csp, /(^|;\s*)base-uri 'none'/, "an injected <base> must not be able to repoint relative URLs");
  assert.match(csp, /(^|;\s*)form-action 'none'/, "there is no form, so exfiltration by form must be impossible");
  // Neither 'unsafe-inline' nor 'unsafe-eval' may appear anywhere: this page
  // renders one tenant's text to the whole internet, and script-src is the
  // control that turns a rendering bug into a non-event.
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|unsafe-hashes/);
});

test("the CSP hashes match the inline script and style that ship", async () => {
  const html = await read(`${SITE}index.html`);
  // A stale hash bricks the page in the browser while every other assertion
  // still passes, so this is the assertion that has to fail on drift.
  for (const tag of ["script", "style"]) {
    const digest = sha256(inlineBlock(html, tag));
    assert.match(
      html,
      new RegExp(`${tag}-src 'sha256-${digest.replace(/[+/=]/g, ch => `\\${ch}`)}'`),
      `${tag}-src must carry sha256-${digest} — recompute the CSP hash after editing the <${tag}> block`,
    );
  }
});

test("no dynamic value is ever parsed as markup or code", async () => {
  const html = await read(`${SITE}index.html`);
  // ADR 0004 decision 4: the public page renders text authored by one tenant to
  // every visitor, so the renderer must build nodes, never strings.
  for (const sink of [
    /innerHTML/i,
    /outerHTML/i,
    /insertAdjacentHTML/i,
    /document\.write/i,
    /createContextualFragment/i,
    /DOMParser/i,
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
  ]) {
    assert.doesNotMatch(html, sink, `${sink} must not appear in the public renderer`);
  }
  assert.match(html, /createElement\(/, "link nodes must be constructed");
  assert.match(html, /\.textContent\s*=/, "tenant-authored text must reach the DOM through textContent");
});

test("outbound links are gated to http(s) and hardened", async () => {
  const html = await read(`${SITE}index.html`);
  // javascript:, data: and vbscript: must all fail the gate before any href is
  // assigned. The gate is expressed as an allowlist of exactly two protocols.
  assert.match(html, /new URL\(/, "URLs must be parsed, not pattern-matched, before the protocol test");
  assert.match(
    html,
    /protocol !== "http:" && [\s\S]{0,40}protocol !== "https:"/,
    "only http: and https: may survive the URL gate",
  );
  assert.match(html, /\.rel = "noopener nofollow"/);
  assert.match(html, /\.referrerPolicy = "strict-origin"/);
  // The in-app preview interpolates sl.color into a style attribute unescaped;
  // the public renderer must validate it before it reaches any style.
  assert.match(html, /\/\^#\[0-9a-f\]\{6\}\$\//, "the button color must be validated against ^#[0-9a-f]{6}$");
});

test("clicks are recorded with keepalive and never block navigation", async () => {
  const html = await read(`${SITE}index.html`);
  assert.match(html, /rpc\/|record_smartlink_click/, "clicks go through the anon record_smartlink_click RPC");
  assert.match(
    html,
    /fetch\(RPC \+ "record_smartlink_click", \{[\s\S]{0,120}?keepalive: true/,
    "decision 8 as amended: fetch(..., { keepalive: true })",
  );
  // sendBeacon cannot reliably attach the Supabase apikey/authorization
  // headers this RPC needs, which is why the amendment rules it out.
  assert.doesNotMatch(html, /sendBeacon/i);
  // Tracking must never delay or block a link: nothing may cancel the anchor's
  // default navigation.
  assert.doesNotMatch(html, /preventDefault/);
});

test("the public pages store nothing on a visitor's device", async () => {
  // privacy.html promises no cookies and no identifiers on public pages.
  for (const file of ["index.html", "404.html"]) {
    const html = await read(SITE + file);
    for (const api of [/localStorage/i, /sessionStorage/i, /indexedDB/i, /\.cookie/i, /navigator\.storage/i]) {
      assert.doesNotMatch(html, api, `${file} must not touch client-side storage (${api})`);
    }
  }
});

test("the site is self-contained — no external fonts, scripts or styles", async () => {
  for (const file of ["index.html", "404.html"]) {
    const html = await read(SITE + file);
    assert.doesNotMatch(html, /<script[^>]+src=/i, `${file} must not load an external script`);
    assert.doesNotMatch(html, /<link[^>]+rel=["']?stylesheet/i, `${file} must not load an external stylesheet`);
    assert.doesNotMatch(html, /fonts\.(googleapis|gstatic)\.com/i, `${file} must not load remote fonts`);
    // The only absolute URLs allowed are the Supabase origin the CSP names and
    // the canonical/ADR references inside comments.
    for (const [, url] of html.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+)["']/gi)) {
      assert.ok(url.startsWith(SUPABASE_ORIGIN), `${file} must not reference ${url}`);
    }
  }
});

test("deployment files pin the public origin", async () => {
  assert.equal((await read(`${SITE}CNAME`)).trim(), "links.fablepeak.com");
  // Decisions 2 and 3: the public renderer lives on its own origin, never on
  // the authenticated app's.
  const html = await read(`${SITE}index.html`);
  assert.match(html, /https:\/\/links\.fablepeak\.com\/\?b=<slug>/, "the canonical URL shape must be documented in the file");

  // ADR 0004 decision 1 rejected routing slugs through the 404 fallback, which
  // GitHub Pages serves with a real 404 status; strays go to the root instead.
  const notFound = await read(`${SITE}404.html`);
  assert.match(notFound, /<meta http-equiv="refresh" content="0;url=\/">/);
  assert.doesNotMatch(notFound, /<script/i, "the 404 page must not run any script");
});
