-- Durable execution ledger for every scheduled Edge Function. There are no
-- client policies: only service-role functions can write or inspect global
-- operational health.

create table if not exists public.scheduled_job_runs (
  id uuid primary key,
  job_name text not null,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  started_at timestamptz not null,
  finished_at timestamptz,
  result jsonb,
  error text
);

alter table public.scheduled_job_runs enable row level security;

create index if not exists scheduled_job_runs_latest_idx
  on public.scheduled_job_runs (job_name, started_at desc);

-- Keep enough history for incident review without allowing the per-minute
-- publisher ledger to grow forever.
select cron.schedule(
  'fablepeak-prune-job-runs',
  '41 20 * * *',
  $$delete from public.scheduled_job_runs where started_at < now() - interval '30 days'$$
);
