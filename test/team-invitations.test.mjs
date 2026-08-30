// ADR 0006 delivery item 2: in-app team invitations.
//
// CI rebuilds the whole schema with `supabase db reset --local --no-seed`, so
// everything a running database can prove — that the DDL parses, that the
// partial unique index rejects a second live invite, that an editor's select
// matches no row — is covered there. These assertions cover what a database
// will not fail on: the security posture of nine new objects, the shape of the
// invitee-facing projection, the fact that exactly one revocation model exists,
// and that no Edge Function surface was added.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const NAME = "20260830110000_team_invitations.sql";
const MIGRATION = "supabase/migrations/" + NAME;

/** the text of one `create or replace function public.NAME…` up to its revokes */
function fnBody(sql, name) {
  const start = sql.indexOf("create or replace function public." + name);
  assert.ok(start > 0, name + " must be created in this migration");
  const end = sql.indexOf("\nrevoke all on function", start);
  assert.ok(end > start, name + " must be hardened right after it is created");
  return sql.slice(start, end);
}
/* This migration explains, at length, which mechanisms it refused to use — so
   "the file never mentions X" has to be asked of the SQL, not the prose. */
const code = sql => sql.split("\n").filter(line => !line.trim().startsWith("--")).join("\n");

test("brand_invites carries the invite and grants nothing by existing", async () => {
  const sql = await read(MIGRATION);
  // cascade: deleting a brand must not leave invitations pointing at nothing
  assert.match(sql, /brand_id text not null references public\.brands\(id\) on delete cascade/);
  // normalised at rest, so the index, the sweep and the accept-time match are
  // all plain equality
  assert.match(sql, /check \(email = lower\(btrim\(email\)\)/);
  assert.match(sql, /role text not null default 'editor' check \(role in \('owner','editor'\)\)/);
  assert.match(sql,
    /status text not null default 'pending'\s*\n\s*check \(status in \('pending','accepted','declined','revoked','expired'\)\)/);
  assert.match(sql, /invited_by uuid not null references auth\.users\(id\)/);
  assert.match(sql, /created_at timestamptz not null default now\(\)/);
  assert.match(sql, /expires_at timestamptz not null default now\(\) \+ interval '14 days'/);
  // one decided_by/decided_at pair covers accept, decline and revoke
  assert.match(sql, /decided_by uuid references auth\.users\(id\)/);
  assert.match(sql, /decided_at timestamptz/);
  assert.match(sql, /alter table public\.brand_invites enable row level security;/);
  // exactly two roles (decision 5) — no third value anywhere in the file
  assert.doesNotMatch(sql, /'viewer'|'approver'/);
});

test("one LIVE pending invite per address, and re-inviting after expiry works", async () => {
  const sql = await read(MIGRATION);
  assert.match(sql,
    /create unique index if not exists brand_invites_one_live_pending\s*\n\s*on public\.brand_invites \(brand_id, email\)\s*\n\s*where status = 'pending';/);
  // The index predicate cannot mention now() — index predicates must be
  // IMMUTABLE — so the row has to stop reading 'pending' before the insert.
  // That sweep is the whole mechanism behind the 2026-08-30 amendment
  // "expired invites must not block re-invitation".
  const create = fnBody(sql, "create_invite(");
  assert.match(create,
    /update public\.brand_invites\s*\n\s*set status = 'expired', decided_at = now\(\)\s*\n\s*where brand_id = p_brand_id\s*\n\s*and email = v_email\s*\n\s*and status = 'pending'\s*\n\s*and expires_at <= now\(\)/);
  const sweep = create.indexOf("set status = 'expired'");
  const insert = create.indexOf("insert into public.brand_invites");
  assert.ok(sweep > 0 && insert > sweep, "the sweep must run before the insert it unblocks");
  // and no read anywhere can see a stale row as live
  assert.match(sql, /and i\.expires_at > now\(\)/);
});

test("revocation has exactly one model: status='revoked', the row retained", async () => {
  const sql = await read(MIGRATION);
  assert.match(sql, /set status = 'revoked', decided_at = now\(\), decided_by = auth\.uid\(\)/);
  // The ADR body said "revocation is deleting the pending row" and its schema
  // said status='revoked'. The 2026-08-30 amendment demands one of the two,
  // used consistently. This file makes the other unreachable rather than merely
  // unused: no delete policy, and no DELETE privilege for any client role.
  assert.doesNotMatch(sql, /delete from public\.brand_invites/);
  assert.doesNotMatch(sql, /create policy invites_delete/);
  assert.match(sql, /grant select, insert, update on public\.brand_invites to authenticated;/);
  assert.doesNotMatch(sql, /grant[^;]*delete[^;]*on public\.brand_invites to authenticated/);
  // the frontend must not have invented a second model either
  const adapter = await read("js/remote-store.js");
  assert.doesNotMatch(adapter, /from\("brand_invites"\)[\s\S]{0,120}?\.delete\(\)/);
});

test("only owners reach the table at all", async () => {
  const sql = await read(MIGRATION);
  // Supabase's default privileges hand a new public table to anon and
  // authenticated, so the revokes are load-bearing, not decorative.
  assert.match(sql, /revoke all on public\.brand_invites from anon;/);
  assert.match(sql, /revoke all on public\.brand_invites from authenticated;/);
  for (const [name, command, clause] of [
    ["invites_select", "select", "using \\(public\\.is_owner\\(brand_id\\)\\)"],
    ["invites_insert", "insert", "with check \\(public\\.is_owner\\(brand_id\\)\\)"],
    ["invites_update", "update",
      "using \\(public\\.is_owner\\(brand_id\\)\\) with check \\(public\\.is_owner\\(brand_id\\)\\)"],
  ]) {
    assert.match(sql, new RegExp(
      `create policy ${name} on public\\.brand_invites for ${command} to authenticated\\s*\\n\\s*${clause};`));
  }
  // SELECT is is_owner, not the is_member the ADR body sketched: decision 12
  // buys co-members' addresses, and a pending invitee is not a co-member.
  assert.doesNotMatch(sql, /create policy invites_select[\s\S]{0,120}?is_member/);
  // the invite table is never put on the schema-wide realtime feed
  assert.doesNotMatch(sql, /supabase_realtime add table public\.brand_invites/);
});

test("the confirmed address is read from auth.users, never from a JWT claim", async () => {
  const sql = await read(MIGRATION);
  const fn = fnBody(sql, "current_confirmed_email()");
  assert.match(fn,
    /create or replace function public\.current_confirmed_email\(\)\s*\nreturns text\s*\nlanguage sql\s*\nstable\s*\nsecurity definer\s*\nset search_path = ''/);
  assert.match(fn, /from auth\.users u\s*\n\s*where u\.id = auth\.uid\(\)/);
  // the confirmation itself, not merely the presence of an address
  assert.match(fn, /and u\.email_confirmed_at is not null/);
  assert.match(fn, /select lower\(btrim\(u\.email\)\)/);
  // user_metadata is client-writable through supabase.auth.updateUser({data}),
  // so a JWT claim is not a gate. No executable line in this file may read one
  // (the header discusses both at length, which is why this asks the SQL).
  assert.doesNotMatch(code(sql), /auth\.jwt\(\)/);
  assert.doesNotMatch(code(sql), /email_verified/);
  // no client role holds EXECUTE: every caller is a definer function running as
  // this function's owner
  assert.match(sql, /revoke all on function public\.current_confirmed_email\(\) from public;/);
  assert.match(sql,
    /revoke all on function public\.current_confirmed_email\(\) from anon, authenticated;/);
  assert.doesNotMatch(sql, /grant execute on function public\.current_confirmed_email/);
});

test("list_my_invites leaks no brand_id and no other workspace fact", async () => {
  const sql = await read(MIGRATION);
  const fn = fnBody(sql, "list_my_invites()");
  const declared = fn.slice(fn.indexOf("returns table"), fn.indexOf("language sql"));
  // brand_id is the key every RLS policy in this schema is written on. An
  // un-accepted invitee must not hold one.
  assert.doesNotMatch(declared, /brand_id/);
  assert.match(declared, /invite_id uuid/);
  assert.match(declared, /brand_name text/);
  assert.match(declared, /invite_role text/);
  assert.match(declared, /invited_at timestamptz/);
  assert.match(declared, /expires_at timestamptz/);
  // no inviter address either — the ADR body offered one, the accepted brief
  // does not, and it is another account's PII handed to a non-member
  assert.doesNotMatch(declared, /inviter/);
  assert.match(fn, /select i\.id, b\.name, i\.role, i\.created_at, i\.expires_at/);
  // the authorisation is the confirmed-address match, and it is NULL-safe: an
  // unconfirmed or signed-out caller compares against NULL and matches nothing
  assert.match(fn, /and i\.email = public\.current_confirmed_email\(\)/);
  assert.match(fn, /where i\.status = 'pending'/);
  assert.match(fn,
    /language sql\s*\nstable\s*\nsecurity definer\s*\nset search_path = ''/);
  assert.match(sql, /revoke all on function public\.list_my_invites\(\) from anon;/);
  assert.match(sql, /grant execute on function public\.list_my_invites\(\) to authenticated;/);
});

test("accept re-validates everything and the join reaches no trigger that can refuse it", async () => {
  const sql = await read(MIGRATION);
  const fn = fnBody(sql, "accept_invite(");
  assert.match(fn, /security definer\s*\nset search_path = ''/);
  // signed in, confirmed, addressed to this caller, still pending, not expired
  assert.match(fn, /if v_uid is null then\s*\n\s*raise exception 'sign in first'/);
  assert.match(fn, /if v_email is null then/);
  assert.match(fn, /'email_unconfirmed'/);
  assert.match(fn, /if not found or inv\.email <> v_email then/);
  assert.match(fn, /if inv\.status <> 'pending' then/);
  assert.match(fn, /if inv\.expires_at <= now\(\) then/);
  // an id that is not this caller's is answered exactly like one that does not
  // exist, so the RPC is not an oracle for which invites exist
  assert.match(fn, /'not_found'/);
  // the join itself: role comes from the invite, and re-accepting is a no-op
  assert.match(fn,
    /insert into public\.brand_members \(brand_id, user_id, role\)\s*\n\s*values \(inv\.brand_id, v_uid, inv\.role\)\s*\n\s*on conflict \(brand_id, user_id\) do nothing/);
  assert.match(fn, /set status = 'accepted', decided_at = now\(\), decided_by = v_uid/);

  // Definer rights bypass RLS but NOT triggers, so the phase-1 trigger has to
  // be checked rather than assumed: it is `before update or delete`, so an
  // INSERT never reaches it and the last-owner invariant cannot refuse a join.
  const phase1 = await read("supabase/migrations/20260830100000_owner_role_enforcement.sql");
  assert.match(phase1,
    /create trigger brand_members_keep_an_owner\s+before update or delete on public\.brand_members/);
  assert.doesNotMatch(phase1, /create trigger brand_members_keep_an_owner\s+before insert/);
});

test("decline and revoke are gated the same way accept is", async () => {
  const sql = await read(MIGRATION);
  const decline = fnBody(sql, "decline_invite(");
  assert.match(decline, /security definer\s*\nset search_path = ''/);
  assert.match(decline, /if not found or inv\.email <> v_email then/);
  assert.match(decline, /set status = 'declined', decided_at = now\(\), decided_by = auth\.uid\(\)/);

  const revoke = fnBody(sql, "revoke_invite(");
  assert.match(revoke, /security definer\s*\nset search_path = ''/);
  assert.match(revoke, /if not found or not public\.is_owner\(inv\.brand_id\) then/);
  assert.match(revoke, /if inv\.status <> 'pending' then/);

  const create = fnBody(sql, "create_invite(");
  assert.match(create, /if not public\.is_owner\(p_brand_id\) then\s*\n\s*raise exception/);
  assert.match(create, /errcode = '42501'/);

  for (const signature of [
    "public.create_invite(text, text, text)",
    "public.accept_invite(uuid)",
    "public.decline_invite(uuid)",
    "public.revoke_invite(uuid)",
    "public.brand_member_list(text)",
  ]) {
    const escaped = signature.replace(/[().]/g, c => "\\" + c);
    assert.match(sql, new RegExp(`revoke all on function ${escaped} from public;`));
    assert.match(sql, new RegExp(`revoke all on function ${escaped} from anon;`));
    assert.match(sql, new RegExp(`grant execute on function ${escaped} to authenticated;`));
    assert.doesNotMatch(sql,
      new RegExp(`grant execute on function ${escaped} to [^;]*anon`));
  }
});

test("brand_member_list is member-gated and scoped to one brand", async () => {
  const sql = await read(MIGRATION);
  const fn = fnBody(sql, "brand_member_list(");
  assert.match(fn,
    /language plpgsql\s*\nstable\s*\nsecurity definer\s*\nset search_path = ''/);
  // decision 12: co-members, not owners only — an editor rendering bare UUIDs
  // is the failure this exists to fix
  assert.match(fn, /if not public\.is_member\(p_brand_id\) then\s*\n\s*raise exception/);
  assert.match(fn, /join auth\.users u on u\.id = m\.user_id/);
  assert.match(fn, /where m\.brand_id = p_brand_id/);
  // OUT parameters cannot collide with the columns the body selects
  assert.match(fn, /returns table \(member_id uuid, member_email text, member_role text\)/);
});

test("no Edge Function surface was added — the RPCs are the whole API", async () => {
  const config = await read("supabase/config.toml");
  const pkg = JSON.parse(await read("package.json"));
  const functions = (await readdir(new URL("supabase/functions/", root))).sort();

  // Decision 2 rejected Supabase auth invite emails, which would have needed
  // service-role, a new function and a mail provider. The invite email template
  // block in config.toml is still commented out, and must stay that way.
  assert.match(config, /# \[auth\.email\.template\.invite\]/);
  assert.doesNotMatch(config, /^\[auth\.email\.template\.invite\]/m);
  // exactly the ten functions that existed before this work
  const declared = [...config.matchAll(/^\[functions\.([a-z-]+)\]/gm)].map(m => m[1]).sort();
  assert.deepEqual(declared, [
    "ai-assist", "connection-health", "data-deletion", "delete-account",
    "ingest-metrics", "maintain-connections", "oauth-callback", "oauth-start",
    "operations-health", "publish",
  ]);
  assert.deepEqual(functions.filter(f => f !== "_shared"), declared);
  // and no new Deno file to check or test
  assert.doesNotMatch(pkg.scripts["check:functions"], /invite/);
  assert.doesNotMatch(pkg.scripts["test:functions"], /invite/);
});

test("the privacy notice discloses co-member emails before brand_member_list ships", async () => {
  // ADR 0006 decision 12 is "yes, WITH a disclosure requirement": co-members
  // seeing each other's addresses is the ADR's only new PII exposure, and the
  // answer makes stating it a precondition rather than a follow-up.
  const privacy = await read("privacy.html");
  assert.match(privacy, /<h2>Workspace members and invitations<\/h2>/);
  assert.match(privacy, /can see each other's email addresses and roles/i);
  assert.match(privacy, /Workspace membership and invitation records/i,
    "\"Information we collect\" must name the invitation records too");
  // and the pre-acceptance posture the RPCs actually implement
  assert.match(privacy, /grants nothing on its own/i);
  assert.match(privacy, /only the workspace's display name and the offered role/i);
  assert.match(privacy, /expire after 14 days/i);
  assert.match(privacy, /does not email invitations/i);
  assert.doesNotMatch(privacy, /TODO|CHANGEME|\{\{.+?\}\}/i);
});

test("no later migration re-opens what this one closed", async () => {
  const files = (await readdir(new URL("supabase/migrations/", root))).sort();
  assert.ok(files.includes(NAME), "the migration must be on disk");
  assert.ok(files.indexOf(NAME) > files.indexOf("20260830100000_owner_role_enforcement.sql"),
    "invitations depend on is_owner, so they must sort after it");
  for (const file of files.filter(f => f > NAME)) {
    const sql = await read("supabase/migrations/" + file);
    for (const predicate of [
      /create policy invites_(select|insert|update)/,
      /create or replace function public\.(list_my_invites|accept_invite|current_confirmed_email)/,
      /create policy invites_delete/,
      /delete from public\.brand_invites/,
    ]) {
      assert.doesNotMatch(sql, predicate,
        `${file} sorts after ${NAME}: if it must touch this, it has to keep the posture`);
    }
  }
});

test("the frontend reaches the invite surface only through the RPCs", async () => {
  const adapter = await read("js/remote-store.js");
  const team = await read("js/team.js");
  const actions = await read("js/actions.js");
  const shell = await read("js/shell.js");
  const settings = await read("js/settings.js");

  for (const [method, rpc] of [
    ["listMembers", "brand_member_list"],
    ["inviteMember", "create_invite"],
    ["revokeInvite", "revoke_invite"],
    ["myInvitations", "list_my_invites"],
    ["acceptInvite", "accept_invite"],
    ["declineInvite", "decline_invite"],
  ]) {
    assert.match(adapter, new RegExp(`async ${method}\\([^)]*\\)\\{[\\s\\S]{0,400}?rpc\\("${rpc}"`),
      `${method} must call ${rpc}`);
  }
  // the owner-only pending list is a plain select — the policy is the gate
  assert.match(adapter, /async listInvites\(brandId\)\{[\s\S]{0,300}?from\("brand_invites"\)/);

  // Emails are user-controlled strings rendered into markup, and ids travel in
  // attributes. Everything goes through the two escapers, and nothing is an
  // inline handler (ADR 0003 §2a).
  assert.match(team, /import \{ attr, esc \} from "\.\/escape\.js";/);
  assert.match(team, /\$\{esc\(m\.member_email\)\}/);
  assert.match(team, /\$\{esc\(i\.email\)\}/);
  assert.match(team, /\$\{esc\(i\.brand_name\)\}/);
  assert.match(team, /data-arg="\$\{attr\(i\.invite_id\)\}"/);
  assert.match(team, /data-arg="\$\{attr\(i\.id\)\}"/);
  assert.doesNotMatch(team, /\son[a-z]+=/);
  for (const name of ["inviteMember", "revokeInvite", "acceptInvite", "declineInvite",
                      "simulatedTeamAction"]) {
    assert.match(actions, new RegExp(`^  ${name}: +`, "m"), `${name} must be an ACTIONS entry`);
  }
  // the banner is prepended by the shell, so no view can forget it
  assert.match(shell, /function showInvitations\(m\)\{[\s\S]{0,200}?insertAdjacentHTML\("afterbegin", banner\)/);
  assert.match(settings, /\$\{renderTeamCard\(\)\}/);
  // demo/local reaches no network: the simulated card is chosen before any
  // store call, and its controls toast
  assert.match(team, /if\(!liveMode\(\)\) return simulatedTeamCard\(\);/);
  assert.match(team, /Simulated — team features need a cloud account/);
  assert.match(team, /data-action="simulatedTeamAction"/);
});
