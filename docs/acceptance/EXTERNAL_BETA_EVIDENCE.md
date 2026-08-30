# External-customer beta evidence

- Release candidate: FablePeak 1.5.0
- Decision: internal tool now; external access remains invite-only
- Provider freeze: Facebook, Instagram and YouTube only
- Last updated: 2026-08-30

This record is the release gate. A blank human-evidence row is a blocker, not
an implied pass. Never paste access tokens, passwords or customer personal data
here; link to access-controlled evidence instead.

## Technical readiness

| Gate | Status | Evidence |
|---|---|---|
| Proactive renewal for every active authorization | Pass | Hourly maintenance, shared-authorization deduplication, transient-failure preservation, Deno regression tests |
| Per-target delivery recovery | Pass | Bounded transient retries; permanent/unknown siblings excluded; final transport, 5xx and malformed-success outcomes protected from resend |
| Durable delivery visibility | Pass | Target attempts, failure kind, next retry, provider error/link and planner needs-attention state |
| Scheduled-job monitoring | Pass | Non-bootstrap publish, connection and metrics runs recorded below (2026-08-28) with authenticated GitHub OIDC health green in run 33137417802. Cron delivery of a real internal-account post is also evidenced in the publish row (2026-08-28); the unrelated-account human acceptance row "Scheduled mixed-network delivery" is still required |
| Core accessibility | Pass | Live status feedback, keyboard calendar/inbox controls, dialog focus trap/Escape, visible disabled-provider reasons |
| Provider expansion freeze | Pass | LinkedIn, X, TikTok and Pinterest cannot be enabled by credentials alone |
| Automated verification | Pass | `npm run check`: 63 Node tests, 42 Deno tests and all 8 Edge Functions type-check; clean local migration rebuild |

### Production cron observation

| Job | Observed run (UTC) | Result | Evidence |
|---|---|---|---|
| Publish (every minute) | 2026-08-28 02:58:00Z | Pass | `scheduled_job_runs` job_name=publish: succeeded, finished 02:58:00.346Z, result `{"failed":0,"processed":0,"published":0}`. 119 consecutive minute ticks in the two hours to 02:58Z; 27,152 succeeded rows since 2026-08-09 06:25:01Z, zero failed. Non-bootstrap: 19 days after the single `monitor-bootstrap` row (2026-08-09 06:45:39Z), so the warm-up window is long expired. Queue was empty (processed 0), so this evidences scheduler execution, not delivery. Authenticated health green in GitHub run [33137417802](https://github.com/ttropolis/fablepeak/actions/runs/33137417802) (workflow_dispatch 2026-08-28T02:56:30Z): `PASS  authenticated scheduled operations are healthy` at 02:56:42Z = `operations-health` HTTP 200 with `ok:true`. Real delivery through the cron path evidenced later the same day: an internal-brand Facebook-only text post scheduled for 2026-08-28 14:28 AWST was claimed and published by the minute cron with no manual trigger; delivery panel showed Published with remote link `https://facebook.com/1291889143999378_122111105709416585` and no errors. Internal-account evidence only — the unrelated-account "Scheduled mixed-network delivery" human row remains required. |
| Connection maintenance (hourly) | 2026-08-28 02:17:00Z | Pass | `scheduled_job_runs` job_name=connections: succeeded, finished 02:17:01.160Z, result `{"failed":0,"checked":4,"refreshed":2}` with outcomes 2 refreshed / 2 not_due — real work against the reconnected internal accounts. 452 succeeded hourly rows since 2026-08-09 07:17:01Z, zero failed; prior tick 01:17:00Z identical. Non-bootstrap (19 days after the warm-up marker). Same green authenticated health run [33137417802](https://github.com/ttropolis/fablepeak/actions/runs/33137417802). |
| Metrics ingestion (daily) | 2026-08-27 19:17:00Z | Pass | `scheduled_job_runs` job_name=metrics: succeeded, finished 19:17:06.007Z, result `{"failed":0,"attempted":4,"ingested":4}` with `ok:true` for youtube (2 brands), facebook and instagram — real ingestion work. 19 consecutive daily 19:17Z runs from 2026-08-09 to 2026-08-27, zero failed and no missed day. Non-bootstrap (18 days after the warm-up marker). Within the 26h freshness bound at the green authenticated health run [33137417802](https://github.com/ttropolis/fablepeak/actions/runs/33137417802). |

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
| Owner-vs-editor enforcement: an invited editor composes and schedules but cannot delete the brand, disconnect or re-select accounts, or publish SmartLinks | Two unrelated FablePeak users (owner + editor) |  | Pending | ADR 0006 decision 14: the owner-vs-editor axis is a mandatory release gate for the role-enforcement step, not a follow-up. TESTER_GUIDE Script 9; run after the tenant-isolation row |

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
