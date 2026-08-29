import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const MIGRATION = "supabase/migrations/20260829090000_public_smartlinks.sql";

// CI rebuilds the whole schema with `supabase db reset --local --no-seed`, so
// anything the database itself can prove — constraints, resolution, RLS
// isolation, the click ceiling, cascade deletes — is covered by that rebuild.
// These assertions cover only the properties a running database will not fail
// on: grants, search_path hardening and the *absence* of a policy or a column.

test("public SmartLinks read and write RPCs are hardened definer functions", async () => {
  const migration = await read(MIGRATION);
  for (const signature of [
    "public\\.get_smartlink\\(p_slug text\\)",
    "public\\.record_smartlink_click\\(",
    "public\\.set_smartlink_slug\\(p_brand_id text, p_slug text\\)",
  ]) {
    // each definer function must restrict search_path; an unrestricted
    // search_path in a definer function is a privilege-escalation vector
    assert.match(
      migration,
      new RegExp(`${signature}[\\s\\S]{0,400}?security definer[\\s\\S]{0,120}?set search_path = ''`),
      `${signature} must be security definer with an emptied search_path`,
    );
  }
  // With search_path emptied, an unqualified relation name is a runtime error
  // waiting to happen, so every FROM/JOIN inside a function body must name its
  // schema. Local CTEs and pg_catalog set-returning functions are the only
  // names allowed to stand alone.
  const localNames = new Set(["wanted", "resolved", "jsonb_array_elements"]);
  const bodies = [...migration.matchAll(/as \$\$([\s\S]*?)\$\$;/g)]
    .map(m => m[1].replace(/--[^\n]*/g, ""));
  assert.equal(bodies.length, 5, "migration defines five functions");
  for (const body of bodies) {
    // "is distinct from x" is not a relation reference
    for (const [, name] of body.matchAll(/(?<!distinct )\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/g)) {
      assert.ok(
        name.startsWith("public.") || localNames.has(name),
        `"${name}" must be schema-qualified inside a function whose search_path is empty`,
      );
    }
  }
});

test("anon gains execute on exactly the two public SmartLinks RPCs", async () => {
  const migration = await read(MIGRATION);
  assert.match(migration, /revoke all on function public\.get_smartlink\(text\) from public;/);
  assert.match(migration, /grant execute on function public\.get_smartlink\(text\) to anon, authenticated;/);
  assert.match(migration, /revoke all on function public\.record_smartlink_click\(text, text, text\) from public;/);
  assert.match(migration, /grant execute on function public\.record_smartlink_click\(text, text, text\) to anon, authenticated;/);

  // claiming a slug is member-only and must never be reachable anonymously
  assert.match(migration, /revoke all on function public\.set_smartlink_slug\(text, text\) from anon;/);
  assert.match(migration, /grant execute on function public\.set_smartlink_slug\(text, text\) to authenticated;/);
  assert.doesNotMatch(migration, /grant execute on function public\.set_smartlink_slug\([^)]*\) to [^;]*anon/);

  const anonGrants = migration.match(/^grant [^;]*to [^;]*anon\b[^;]*;$/gim) ?? [];
  assert.deepEqual(
    anonGrants.map(line => line.replace(/\s+/g, " ")),
    [
      "grant execute on function public.get_smartlink(text) to anon, authenticated;",
      "grant execute on function public.record_smartlink_click(text, text, text) to anon, authenticated;",
    ],
    "ADR 0004: every new anon grant must be reviewed, so the set must stay exactly these two RPCs",
  );
});

test("no table or view is reachable by anon, and clicks carry no anon policy", async () => {
  const migration = await read(MIGRATION);
  for (const relation of [
    "public\\.smartlink_clicks",
    "public\\.smartlink_slug_aliases",
    "public\\.smartlink_click_totals",
  ]) {
    assert.match(
      migration,
      new RegExp(`revoke all on ${relation} from [^;]*anon`),
      `${relation} must be revoked from anon`,
    );
  }
  assert.match(migration, /alter table public\.smartlink_clicks enable row level security/);
  assert.match(migration, /alter table public\.smartlink_slug_aliases enable row level security/);
  // an anon INSERT policy would let anyone forge brand_id, clicked_at and referrer
  assert.doesNotMatch(migration, /create policy [^;]*on public\.smartlink_clicks[^;]*to anon/i);
  assert.doesNotMatch(migration, /create policy [^;]*on public\.smartlink_slug_aliases[^;]*to anon/i);
  assert.match(
    migration,
    /create policy smartlink_clicks_select on public\.smartlink_clicks\s+for select to authenticated using \(public\.is_member\(brand_id\)\)/,
  );
  // aggregates must resolve against the caller's own RLS, not the view owner's
  assert.match(migration, /create view public\.smartlink_click_totals\s+with \(security_invoker = true\)/);
});

test("the public payload cannot leak the tenant key or unpublished pages", async () => {
  const migration = await read(MIGRATION);
  const body = migration.slice(
    migration.indexOf("create or replace function public.get_smartlink"),
    migration.indexOf("revoke all on function public.get_smartlink"),
  );
  assert.ok(body.length > 0, "get_smartlink body must be present");
  assert.doesNotMatch(body, /'brand_id'/, "brand_id must never appear in the public payload");
  assert.doesNotMatch(body, /'clicks'/, "the legacy jsonb clicks counter must not be published");
  // publication is the gate on every resolution path
  assert.match(body, /where b\.smartlink_public/);
  // an unknown or unpublished slug is indistinguishable, and returns no row
  assert.match(body, /'\{\}'::jsonb/);
  const keys = [...body.matchAll(/^\s*'([a-z_]+)',/gm)].map(m => m[1]);
  assert.deepEqual(
    [...new Set(keys)].sort(),
    ["avatar", "bio", "color", "id", "links", "slug", "title", "url"],
    "get_smartlink must project only ADR 0004 presentation fields",
  );
});

test("slug rules match ADR 0004 decision 5 including the widened reserved list", async () => {
  const migration = await read(MIGRATION);
  assert.match(migration, /p_slug ~ '\^\[a-z0-9\]\[a-z0-9-\]\{1,28\}\[a-z0-9\]\$'/,
    "3-30 characters, [a-z0-9-], no leading or trailing hyphen");
  assert.match(migration, /p_slug !~ '--'/, "consecutive hyphens are rejected");
  for (const reserved of [
    // ADR body denylist
    "l", "api", "app", "www", "admin", "static", "assets", "oauth",
    "privacy", "terms", "functions", "data-deletion",
    // decision 5 additions
    "login", "signup", "support", "help", "legal", "security", "status",
    "well-known",
    // infrastructure names
    "mail", "root", "fablepeak",
  ]) {
    assert.match(migration, new RegExp(`'${reserved}'`), `'${reserved}' must be reserved`);
  }
  // the same rule must back the column constraint and the claim RPC
  assert.match(migration, /check \(smartlink_slug is null or public\.smartlink_slug_is_valid\(smartlink_slug\)\)/);
  assert.match(migration, /if not public\.smartlink_slug_is_valid\(v_slug\) then/);
  assert.match(migration, /create unique index if not exists brands_smartlink_slug_key\s+on public\.brands \(lower\(smartlink_slug\)\)/);
  assert.match(migration, /add column if not exists smartlink_public boolean not null default false/,
    "publishing is opt-in and off by default");
});

test("a retired slug is retained and can never be claimed by another brand", async () => {
  const migration = await read(MIGRATION);
  assert.match(migration, /create table if not exists public\.smartlink_slug_aliases \(\s*slug text primary key,\s*brand_id text not null references public\.brands\(id\) on delete cascade,\s*created_at timestamptz not null default now\(\)/);
  // claim-time protection: live on another brand, or ever held by another brand
  assert.match(migration, /where a\.slug = v_slug and a\.brand_id <> p_brand_id/);
  assert.match(migration, /where lower\(b\.smartlink_slug\) = v_slug and b\.id <> p_brand_id/);
  // both the outgoing and the incoming slug are recorded
  const inserts = migration.match(/insert into public\.smartlink_slug_aliases \(slug, brand_id\)/g) ?? [];
  assert.equal(inserts.length, 2, "set_smartlink_slug records the old slug and reserves the new one");
  // the guard closes the direct-PATCH bypass left open by the brands UPDATE policy
  assert.match(migration, /create trigger brands_guard_smartlink_slug\s+before insert or update on public\.brands/);
  assert.match(migration, /raise exception 'set brands\.smartlink_slug through public\.set_smartlink_slug\(\)'/);
  // conflicts are typed results, not raised errors
  for (const code of ["invalid_slug", "slug_taken", "unknown_brand"]) {
    assert.match(migration, new RegExp(`'error', '${code}'`));
  }
});

test("click records hold no visitor identifier and are purged after 90 days", async () => {
  const migration = await read(MIGRATION);
  const table = migration.slice(
    migration.indexOf("create table if not exists public.smartlink_clicks"),
    migration.indexOf("create index if not exists smartlink_clicks_brand_link_idx"),
  );
  assert.ok(table.length > 0, "smartlink_clicks definition must be present");
  for (const forbidden of ["ip", "user_agent", "cookie", "visitor", "fingerprint", "device"]) {
    assert.doesNotMatch(table, new RegExp(`\\b${forbidden}`, "i"), `smartlink_clicks must not store ${forbidden}`);
  }
  assert.match(table, /referrer_host text/);
  assert.match(table, /link_id text not null/, "attribution is by stable link id, not array index");
  assert.match(table, /brand_id text not null references public\.brands\(id\) on delete cascade/);

  // the referrer is reduced to a bare hostname before storage
  assert.match(migration, /v_host := split_part\(v_host, '\?', 1\);/);
  assert.match(migration, /v_host := split_part\(v_host, '#', 1\);/);
  assert.match(migration, /v_host := split_part\(v_host, ':', 1\);/);
  assert.match(migration, /length\(v_host\) > 100/);

  // per-slug per-minute ceiling, dropped silently (decision 9)
  assert.match(migration, /clicked_at > now\(\) - interval '1 minute'/);
  assert.match(migration, /if v_recent >= 600 then\s+return;/);
  assert.match(migration, /returns void/, "the click RPC must reveal nothing about which slugs exist");

  // 90-day raw retention, folded into this schema's existing retention sweep
  assert.match(migration, /delete from public\.smartlink_clicks where clicked_at < now\(\) - interval '90 days'/);
  assert.match(migration, /select cron\.schedule\(\s*'fablepeak-prune-job-runs'/);
  const existing = await read("supabase/migrations/20260809120000_scheduled_job_health.sql");
  assert.match(existing, /'fablepeak-prune-job-runs',\s*'41 20 \* \* \*'/);
  assert.match(migration, /'fablepeak-prune-job-runs',\s*'41 20 \* \* \*'/,
    "re-scheduling the existing job must keep its schedule and its original statement");
  assert.match(migration, /delete from public\.scheduled_job_runs where started_at < now\(\) - interval '30 days'/);
});

test("the privacy notice covers public SmartLinks before the first page can publish", async () => {
  const privacy = await read("privacy.html");
  assert.match(privacy, /<h2>Public SmartLinks pages<\/h2>/);
  assert.match(privacy, /opt-in/i);
  assert.match(privacy, /do not store IP addresses, cookies, device identifiers/i);
  assert.match(privacy, /approximate/i);
  assert.match(privacy, /referring website hostname/i);
  assert.match(privacy, /deleted after 90 days/i);
  assert.match(privacy, /Unpublishing takes effect immediately/i);
  assert.match(privacy, /third-party websites/i);
  assert.match(privacy, /Aggregate SmartLink click counts/i,
    "\"Information we collect\" must name aggregate click counts");
  assert.doesNotMatch(privacy, /TODO|CHANGEME|\{\{.+?\}\}/i);
});

test("ADR 0004 records that the backend has landed", async () => {
  const adr = await read("docs/adr/0004-public-smartlinks.md");
  assert.match(adr, /Backend\s+implemented in `supabase\/migrations\/20260829090000_public_smartlinks\.sql`/);
});
