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
   every `social_connections` row matching `platform` + `external_id`.
4. Matching is conservative: only the verified platform's own scoped identifier
   is trusted. Instagram's callback id equals the stored `external_id`;
   Facebook's app-scoped user id does not equal a Page id, so those requests
   record `no_matching_connection` for the documented manual 30-day path.
5. Response is always `{ "url": "<origin>/data-deletion.html?code=<code>",
   "confirmation_code": "<code>" }` with a fresh 24-hex random code.
6. `data-deletion.html` echoes a `?code=` query param as the confirmation
   reference, stating plainly that it displays the code from the link only.
7. `PlatformAdapter.revoke(tokens)` asks the provider to drop FablePeak's
   authorization. Live platforms only: Facebook `DELETE /me/permissions`,
   YouTube `POST oauth2.googleapis.com/revoke`, Instagram a documented no-op
   reporting `unsupported`. Frozen adapters omit the field entirely.
8. Revocation is best effort: `revokeUserAuthorizations` never throws, so a
   provider outage can never block local deletion or disconnect.
9. Out of scope: a status-lookup API behind the confirmation code, storing
   Facebook app-scoped user ids at connect time, revocation for X, LinkedIn,
   TikTok, Pinterest or Google Business, and any `productionEnabled` change.

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

`data-deletion` is a new unauthenticated Edge Function with
`verify_jwt = false`: Meta's POST carries no Supabase JWT, and the
`signed_request` signature is the authentication.

## Consequences

- Facebook-originated deletion callbacks are recorded and answered correctly
  but cannot be auto-matched, because the app-scoped user id in the callback is
  not the Page id FablePeak stores. The recorded row is the operator's queue.
- The confirmation status page is honest about being a static echo; adding a
  real lookup needs a read endpoint and is deliberately deferred.
- Instagram disconnect reports `unsupported` rather than claiming a provider
  action it cannot perform.
- Adding `revoke` to a frozen adapter stays a deliberate, separate change.
