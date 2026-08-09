-- Renew every active provider authorization well before expiry. This job is
-- deliberately independent from metrics ingestion: accounts without metrics
-- support and non-default selectable assets still need credential maintenance.

do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid from cron.job where jobname = 'fablepeak-maintain-connections'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end
$$;

select cron.schedule(
  'fablepeak-maintain-connections',
  '17 * * * *',
  $job$
    select net.http_post(
      url := (
        select decrypted_secret
          from vault.decrypted_secrets
         where name = 'project_url'
         limit 1
      ) || '/functions/v1/maintain-connections',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
            from vault.decrypted_secrets
           where name = 'anon_key'
           limit 1
        ),
        'apikey', (
          select decrypted_secret
            from vault.decrypted_secrets
           where name = 'anon_key'
           limit 1
        ),
        'x-cron-secret', (
          select decrypted_secret
            from vault.decrypted_secrets
           where name = 'cron_secret'
           limit 1
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $job$
);
