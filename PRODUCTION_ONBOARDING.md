# FablePeak general customer onboarding gate

This is the release checklist for moving from internal/test accounts to the
same customer model used by established social-management platforms. Customers
click **Connect**, authorize their own account, select an asset when necessary,
and return to a verified connection. They never create developer credentials.

## 1. Deploy the implemented connection foundation

- Apply all Supabase migrations, including account selection, connection
  health, workspace-scoped media, deletion, and stale publish recovery
  (`20260802120000` through `20260805090000`).
- Add `SOCIAL_TOKEN_ENCRYPTION_KEY` and preserve it in the project password
  manager. New provider tokens are AES-GCM encrypted; legacy tokens migrate on
  refresh/reconnect.
- Deploy `oauth-start`, `oauth-callback`, `connection-health`, `publish`, and
  `ingest-metrics` and `delete-account` from the same reviewed commit.
- Confirm `APP_ORIGIN=https://fablepeak.com` and the exact OAuth callback:
  `https://lghsvxwuaebvotutyjtt.supabase.co/functions/v1/oauth-callback`.
- Verify that the public account view returns identity/status/default selection
  but never access or refresh tokens.
- Configure production SMTP, email confirmation, password reset redirects, and
  the `fablepeak.com` Supabase Auth site URL before inviting customers.

Deployment order after an authorized owner links the CLI:

```sh
npm run check
supabase link --project-ref lghsvxwuaebvotutyjtt
supabase db push --dry-run
supabase db push
supabase functions deploy oauth-start
supabase functions deploy oauth-callback
supabase functions deploy connection-health
supabase functions deploy publish
supabase functions deploy ingest-metrics
supabase functions deploy delete-account
npm run smoke:production
```

The repository’s `supabase/config.toml` keeps gateway JWT verification disabled
for these functions because provider callbacks and cron requests do not carry a
Supabase user JWT. Each browser/cron entrypoint performs its own authorization.
Set secrets before deployment; never paste secret values into this file or Git.

## 2. Meta production application

### Facebook Pages

Configure Facebook Login for Business using:

- `pages_show_list` — show Pages the customer authorized.
- `pages_manage_posts` — publish customer-created posts to the selected Page.
- `pages_read_engagement` — display Page identity and supported metrics.

FablePeak stores every Page returned by the customer’s authorization and lets
the customer explicitly select the Page used for publishing.

### Instagram

Use **Instagram API with Instagram Login**, not the Page-linked Facebook flow:

- `instagram_business_basic` — identify the connected professional profile.
- `instagram_business_content_publish` — publish media the customer created.

Instagram uses separate `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` credentials,
`graph.instagram.com`, a long-lived token exchange, and proactive refresh. It
supports Business and Creator profiles without requiring a Facebook Page. Meta’s
official collection documents these direct-login permissions and professional
account requirement: <https://www.postman.com/meta/instagram/folder/23987686-98bfade9-3736-4738-8b4a-f56d6534f6de>.

### Meta review submission

- App name/logo/domain match `fablepeak.com`.
- Privacy policy: <https://fablepeak.com/privacy.html>
- Terms: <https://fablepeak.com/terms.html>
- User-data deletion: <https://fablepeak.com/data-deletion.html>
- Request Advanced Access only for the permissions demonstrated above.
- Record one English-language video showing: new FablePeak account → workspace
  creation → Connect → Meta/Instagram consent → returned account identity →
  Page selection where applicable → media post creation → successful publish →
  disconnect.
- Supply a reviewer account, exact navigation steps, and test assets.
- Complete any business/access verification requested by Meta, then move the
  approved app to Live mode.

## 3. Google / YouTube production application

The implementation requests:

- `youtube.upload` — upload the customer’s video.
- `youtube.readonly` — identify the connected channel and read channel totals.

The app deliberately does not request `yt-analytics.readonly`: the current
product does not call the YouTube Analytics API, and Google's verification
rules require the narrowest scopes used by the live application.

Google requires the narrowest scopes, verified domain ownership, matching app
identity, working homepage/privacy-policy links, detailed scope justification,
and an end-to-end demonstration video for sensitive scopes. See Google’s
official [verification requirements](https://support.google.com/cloud/answer/13464321)
and [OAuth verification overview](https://support.google.com/cloud/answer/13463073).

- Verify `fablepeak.com` ownership in Search Console using a project owner/editor.
- Set the OAuth publishing status to **In production** and submit the requested
  scopes for verification before opening access beyond test users.
- Record: FablePeak account → workspace → Connect YouTube → complete consent
  screen in English → verified channel identity → video post → private upload.
- Submit the separate YouTube API compliance/audit materials required for
  public uploads and any quota extension. YouTube documents that process in its
  [Quota and Compliance Audits guide](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits).

## 4. Customer acceptance matrix

Do not open general onboarding until all rows pass with accounts unrelated to
the FablePeak owners/developers:

| Scenario | Required evidence |
|---|---|
| New customer | Email account created, email confirmed, first workspace created |
| Direct Instagram | Business and Creator profiles connect without a Facebook Page |
| Facebook selection | Multiple authorized Pages appear; chosen Page receives the post |
| YouTube | Correct channel identity appears; upload reaches that channel |
| Connection truth | Wrong/revoked token becomes Error/Needs reconnecting, never Connected |
| Token lifecycle | Refreshable tokens renew automatically; providers without refresh support give a reconnect action before publishing stops |
| Tenant isolation | Customer A cannot list, select, disconnect, publish to, or read Customer B assets |
| Disconnect | Stored provider credential is removed and scheduled delivery stops |
| Scheduling | Claimed post publishes once; per-platform result and remote link/error are retained |
| Deletion | Published deletion instructions work and a request can be completed operationally |

## 5. Launch order

1. Deploy database/functions with encryption configured.
2. Reconnect internal accounts so all active tokens are encrypted.
3. Complete Meta and Google reviews in staging/test mode.
4. Run the external-account acceptance matrix.
5. Publish provider apps and open a small customer beta.
6. Monitor OAuth failures, token refreshes, publish results, and provider quota.
7. Open general onboarding only after the beta evidence remains clean.
