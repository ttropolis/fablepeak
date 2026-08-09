# ADR 0001: Internal-first external beta readiness

- Status: accepted
- Date: 2026-08-09

## Context

The original backend specification constrained FablePeak to three trusted
teammates and no recurring spend. Later work added self-service signup and DIY
provider OAuth in preparation for unrelated customers. Operating both intents
without a current decision made reliability, provider scope and acceptance
standards ambiguous.

## Decision

FablePeak operates as an internal tool now and is engineered to the standard
required for a small invite-only external-customer beta.

Production provider scope is frozen to Facebook, Instagram and YouTube. No
additional adapter may be production-enabled until all of these are true:

1. Proactive token renewal covers every active authorization.
2. Scheduled delivery has explicit per-target outcomes, bounded safe retries,
   durable user visibility and duplicate protection for ambiguous outcomes.
3. Authenticated monitoring proves Vault, pg_cron and scheduled Edge Functions
   are executing together.
4. Controlled Meta acceptance and the unrelated-customer acceptance matrix pass.
5. Core mobile keyboard, focus and assistive-feedback paths pass.

Self-service account code may remain available for acceptance testing, but it
does not constitute general onboarding. General availability requires a later
decision about support capacity, operating budget and whether to retain DIY
provider integrations or adopt an aggregator.

## Consequences

- Internal users may use documented manual recovery while beta hardening runs.
- External access remains invite-only until the acceptance evidence is recorded.
- Meta App Review and unrelated-account testing remain human-controlled release
  gates; passing automated tests cannot substitute for them.
- LinkedIn, X, TikTok, Pinterest and Google Business remain production-disabled.
