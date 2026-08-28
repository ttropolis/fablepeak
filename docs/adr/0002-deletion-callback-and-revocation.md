# ADR 0002: Provider data-deletion callback and authorization revocation

- Status: accepted
- Date: 2026-08-28

## Spec

1. `POST /functions/v1/data-deletion` accepts Meta's `signed_request`
   (form-encoded, JSON body or query string) and verifies its HMAC-SHA256
   signature against `META_APP_SECRET`, then `INSTAGRAM_APP_SECRET`; the
   secret that verifies also names the platform.
2. Verification is constant-time and rejects a missing, malformed, tampered,
   wrongly-signed or non-`HMAC-SHA256` request with `400` and no side effects.
   Non-POST is `405`. Unconfigured secrets are `503`, never a silent success.
3. A verified request records one `provider_deletion_requests` row
   (`provider_user_id`, `platform`, `status`, `confirmation_code`) and deletes
   every `social_connections` row the platform's scoped identifiers match (4).
4. Matching is conservative: only identifiers the verified platform actually
   scopes are trusted. Instagram's callback id equals the stored `external_id`.
   Facebook's app-scoped user id (ASID) is never a Page id, so a Facebook
   request additionally matches `meta->>'asid'`; the two identifiers are queried
   separately and neither is inferred from the other. A row holding neither
   records `no_matching_connection` for the documented manual 30-day path.
5. The Facebook adapter captures the ASID with `GET /me?fields=id` on the
   long-lived *user* token — a Page token would resolve `/me` to the Page — and
   returns it as `meta.asid` from both `identifyAll` (every Page discovered in
   one handshake belongs to one person) and `refreshAccess`. The lookup is best
   effort: a failure returns no ASID and never fails a connect or a renewal.
6. Response is always `{ "url": "<origin>/data-deletion.html?code=<code>",
   "confirmation_code": "<code>" }` with a fresh 24-hex random code.
7. `data-deletion.html` echoes a `?code=` query param as the confirmation
   reference, stating plainly that it displays the code from the link only.
8. `PlatformAdapter.revoke(tokens)` asks the provider to drop FablePeak's
   authorization. Live platforms only: Facebook `DELETE /me/permissions`,
   YouTube `POST oauth2.googleapis.com/revoke`, Instagram a documented no-op
   reporting `unsupported`. Frozen adapters omit the field entirely.
9. Revocation is best effort: `revokeUserAuthorizations` never throws, so a
   provider outage can never block local deletion or disconnect.
10. Out of scope: a status-lookup API behind the confirmation code, revocation
    for X, LinkedIn, TikTok, Pinterest or Google Business, and any
    `productionEnabled` change.

## Context

Meta requires a registered Data Deletion Callback URL that answers a signed
POST with a status URL and confirmation code. FablePeak previously offered only
a documented manual path, which does not satisfy the callback contract.

Separately, disconnecting an account or deleting a FablePeak account removed
the stored credential but left the authorization live at the provider, so the
grant kept appearing in the customer's Facebook or Google security settings.

Per-connection disconnect runs entirely in the browser through the
`disconnect_account` security-definer RPC, which depends on `auth.uid()` and
therefore cannot be called with the service role from an Edge Function.

## Decision

Two seams, no new authenticated endpoint.

`connection-health` gains an `action: "revoke"` branch. It is already the only
authenticated, membership-checked, per-connection function that decrypts
credentials and holds the adapter table, so revocation costs one branch there
instead of a new function, a new RPC and a new migration. The browser calls it
best effort immediately before the unchanged `disconnect_account` RPC; the
RLS story and the RPC's default-account reassignment are untouched.

`delete-account` revokes every connection of the deleting user before
`prepare_account_deletion` removes the rows, because after deletion the
credentials can no longer be read.

Both call `revokeUserAuthorizations` in `token-manager.ts`, which owns
decryption and swallows every provider failure into a reported outcome.

The ASID is captured at `identifyAll`, not at `exchangeCode`, because
`oauth-callback` writes one row per identity and copies `identity.meta` into it:
capturing there guarantees the ASID is present on every row the callback
creates. Renewal carries it too, on a new optional `TokenSet.meta` that
`token-manager` merges into the row's existing `meta` after a successful
refresh, so `account_name` and `authorization_id` survive. The merge is skipped
for shared authorizations (Pinterest), where a single patch rewrites every
sibling row and would overwrite their per-asset meta with one asset's.

`data-deletion` is a new unauthenticated Edge Function with
`verify_jwt = false`: Meta's POST carries no Supabase JWT, and the
`signed_request` signature is the authentication.

## Consequences

- Facebook-originated deletion callbacks auto-match through `meta.asid`, but
  only for connections that carry one. A connection written before this change
  gains its ASID at its next *successful token renewal* — `maintain-connections`
  renews a Facebook authorization once it is within seven days of expiry, and
  Meta's long-lived user token lasts about 60 days, so the existing fleet
  backfills itself within roughly two months with no customer action — or
  immediately if the customer reconnects. Until a row is backfilled its callback
  still records `no_matching_connection`, and that row remains the operator's
  queue for the manual 30-day path.
- A Facebook connection whose renewal keeps failing never backfills, which is
  the correct outcome: it is already headed for `expired` and reconnection.
- The confirmation status page is honest about being a static echo; adding a
  real lookup needs a read endpoint and is deliberately deferred.
- Instagram disconnect reports `unsupported` rather than claiming a provider
  action it cannot perform.
- Adding `revoke` to a frozen adapter stays a deliberate, separate change.
