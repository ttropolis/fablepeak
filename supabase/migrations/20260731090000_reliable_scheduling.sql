-- Reliable server-side scheduling for real social publishing.
--
-- Required Vault secrets (set once in Supabase Vault before relying on cron):
--   project_url  = https://<project-ref>.supabase.co
--   anon_key     = the project's public anon key
--   cron_secret  = the same value as the Edge Function CRON_SECRET

alter table public.posts add column if not exists publish_claimed_at timestamptz;

alter table public.posts drop constraint if exists posts_status_check;
alter table public.posts add constraint posts_status_check
  check (status in ('draft', 'scheduled', 'publishing', 'published'));

-- Claim due posts in one transaction. The wall-clock date/time is interpreted
-- in the configured IANA timezone, including daylight-saving transitions.
create or replace function public.claim_due_posts(
  p_timezone text default 'Australia/Perth',
  p_limit int default 25
) returns setof public.posts
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Force PostgreSQL to validate the supplied IANA timezone even if no rows
  -- are currently due.
  perform now() at time zone p_timezone;

  return query
  with candidates as (
    select p.id
    from public.posts p
    where p.status = 'scheduled'
      and (p.date + coalesce(nullif(p.time, ''), '10:00')::time)
          <= (now() at time zone p_timezone)
    order by p.date, p.time, p.id
    for update skip locked
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
  )
  update public.posts p
     set status = 'publishing',
         publish_claimed_at = now(),
         updated_at = now()
    from candidates c
   where p.id = c.id
  returning p.*;
end
$$;

-- Manual "Publish now" uses the same single-claim rule as cron. Published or
-- already-publishing posts cannot accidentally be delivered again.
create or replace function public.claim_post_for_publish(p_post_id text)
returns setof public.posts
language sql
security definer
set search_path = public
as $$
  update public.posts
     set status = 'publishing',
         publish_claimed_at = now(),
         updated_at = now()
   where id = p_post_id
     and status in ('draft', 'scheduled')
  returning *
$$;

revoke all on function public.claim_due_posts(text, int) from public;
revoke all on function public.claim_due_posts(text, int) from anon, authenticated;
grant execute on function public.claim_due_posts(text, int) to service_role;

revoke all on function public.claim_post_for_publish(text) from public;
revoke all on function public.claim_post_for_publish(text) from anon, authenticated;
grant execute on function public.claim_post_for_publish(text) to service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Remove the legacy job that merely changed status to "published" without
-- calling a social platform, plus older copies of the real jobs.
do $$
declare existing_job record;
begin
  for existing_job in
    select jobid
      from cron.job
     where jobname in (
       'fablepeak-auto-publish',
       'fablepeak-publish-due',
       'fablepeak-metrics'
     )
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end
$$;

select cron.schedule(
  'fablepeak-publish-due',
  '* * * * *',
  $job$
    select net.http_post(
      url := (
        select decrypted_secret
          from vault.decrypted_secrets
         where name = 'project_url'
         limit 1
      ) || '/functions/v1/publish',
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
      body := '{"due":true}'::jsonb,
      timeout_milliseconds := 120000
    );
  $job$
);

-- pg_cron runs in UTC. 19:17 UTC is 03:17 the next day in Perth.
select cron.schedule(
  'fablepeak-metrics',
  '17 19 * * *',
  $job$
    select net.http_post(
      url := (
        select decrypted_secret
          from vault.decrypted_secrets
         where name = 'project_url'
         limit 1
      ) || '/functions/v1/ingest-metrics',
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
