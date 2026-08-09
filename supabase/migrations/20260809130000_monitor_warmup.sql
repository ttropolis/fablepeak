-- Record when durable monitoring became active without pretending that any
-- scheduled provider work has already run. operations-health allows each job
-- one normal schedule window from this marker, then missing executions fail.
insert into public.scheduled_job_runs (
  id, job_name, status, started_at, finished_at, result, error
) values (
  gen_random_uuid(),
  'monitor-bootstrap',
  'succeeded',
  now(),
  now(),
  jsonb_build_object('purpose', 'initial monitoring warm-up window'),
  null
);
