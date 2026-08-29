-- Per-user meter for the AI writing assist (runbook 8.6). The ai-assist Edge
-- Function counts the rows a user wrote in the last rolling hour, refuses the
-- request above the ceiling, and otherwise inserts one row before calling the
-- provider — so a burst of failing requests still counts and cannot be used to
-- hammer the provider on the account's key.
--
-- The row records who and what, never the customer's text or the model's
-- answer: a rate meter has no reason to hold post content.

create table if not exists public.ai_assist_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action in ('caption', 'hashtags', 'rewrite')),
  created_at timestamptz not null default now()
);

alter table public.ai_assist_requests enable row level security;
-- deliberately NO policies: clients get zero rows; the Edge Function uses
-- service_role, which bypasses RLS. A client that could insert here could
-- also poison someone else's ceiling.

revoke all on public.ai_assist_requests from public, anon, authenticated;
grant all on public.ai_assist_requests to service_role;

-- The only query this table serves: one user's rows inside the rate window.
create index if not exists ai_assist_requests_window_idx
  on public.ai_assist_requests (user_id, created_at desc);

-- Retention. Folded into the existing sweep rather than adding another job —
-- 'fablepeak-prune-job-runs' (20260809120000_scheduled_job_health.sql, extended
-- by 20260829090000_public_smartlinks.sql) is this schema's only scheduled
-- retention job, and cron.schedule replaces a job of the same name. The rate
-- window is one hour; 30 days is kept only so usage can be reviewed after an
-- incident. Equivalent manual statement if pg_cron is ever unavailable:
--   delete from public.ai_assist_requests where created_at < now() - interval '30 days';
select cron.schedule(
  'fablepeak-prune-job-runs',
  '41 20 * * *',
  $job$
    delete from public.scheduled_job_runs where started_at < now() - interval '30 days';
    delete from public.smartlink_clicks where clicked_at < now() - interval '90 days';
    delete from public.ai_assist_requests where created_at < now() - interval '30 days';
  $job$
);
