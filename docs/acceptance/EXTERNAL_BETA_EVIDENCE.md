# External-customer beta evidence

- Release candidate: FablePeak 1.4.0
- Decision: internal tool now; external access remains invite-only
- Provider freeze: Facebook, Instagram and YouTube only
- Last updated: 2026-08-09

This record is the release gate. A blank human-evidence row is a blocker, not
an implied pass. Never paste access tokens, passwords or customer personal data
here; link to access-controlled evidence instead.

## Technical readiness

| Gate | Status | Evidence |
|---|---|---|
| Proactive renewal for every active authorization | Pass | Hourly maintenance, shared-authorization deduplication, transient-failure preservation, Deno regression tests |
| Per-target delivery recovery | Pass | Bounded transient retries; permanent/unknown siblings excluded; final transport, 5xx and malformed-success outcomes protected from resend |
| Durable delivery visibility | Pass | Target attempts, failure kind, next retry, provider error/link and planner needs-attention state |
| Scheduled-job monitoring | Pending observation | Run ledger and authenticated GitHub OIDC health endpoint deployed; record a non-bootstrap publish, connection and metrics run below |
| Core accessibility | Pass | Live status feedback, keyboard calendar/inbox controls, dialog focus trap/Escape, visible disabled-provider reasons |
| Provider expansion freeze | Pass | LinkedIn, X, TikTok and Pinterest cannot be enabled by credentials alone |
| Automated verification | Pass | `npm run check`: 63 Node tests, 42 Deno tests and all 8 Edge Functions type-check; clean local migration rebuild |

### Production cron observation

| Job | Observed run (UTC) | Result | Evidence |
|---|---|---|---|
| Publish (every minute) |  | Pending |  |
| Connection maintenance (hourly) |  | Pending |  |
| Metrics ingestion (daily) |  | Pending |  |

The scheduled GitHub production smoke must return HTTP 200 from
`operations-health` after the warm-up window and must fail on stale, stuck,
failed or workload-failed runs.

## Human-controlled provider acceptance

| Scenario | Account/tester | Date | Result | Evidence / notes |
|---|---|---|---|---|
| Facebook OAuth, multi-Page selection, publish, remote link, disconnect | Unrelated test account |  | Pending |  |
| Direct Instagram Business OAuth, image publish, remote link, disconnect | Unrelated test account |  | Pending |  |
| Direct Instagram Creator OAuth and token renewal | Unrelated test account |  | Pending |  |
| YouTube OAuth, correct channel, private video upload, disconnect | Unrelated test account |  | Pending | Existing internal end-to-end pass does not replace unrelated-account evidence |
| Revoked credential becomes needs-reconnect without disabling a still-valid token on transient outage | Controlled provider account |  | Pending |  |
| Tenant A cannot read/select/disconnect/publish through Tenant B assets | Two unrelated FablePeak users |  | Pending |  |
| Scheduled mixed-network delivery retains success and visibly identifies failure | Unrelated test account |  | Pending |  |
| Account deletion and provider-data deletion instructions complete | Unrelated test account |  | Pending |  |

## Release decision

The invite-only beta may open only when:

1. all three production cron rows have non-bootstrap evidence and authenticated
   health is green;
2. every human-controlled row above passes;
3. Meta App Review/Live-mode access required for unrelated accounts is active;
4. no production provider outside the frozen scope is enabled; and
5. the release owner records the go/no-go decision, date and rollback owner
   below.

- Decision: **NO-GO (human acceptance and cron observation pending)**
- Decision date:
- Release owner:
- Rollback owner:
- Notes:
