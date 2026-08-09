-- Preserve delivery failures as first-class state. Definitive provider errors
-- receive bounded retries; ambiguous outcomes always require human verification
-- so automatic recovery cannot create duplicate social posts.

alter table public.posts drop constraint if exists posts_status_check;
alter table public.posts add constraint posts_status_check
  check (status in ('draft', 'scheduled', 'publishing', 'published', 'failed'));

alter table public.post_targets
  add column if not exists failure_kind text,
  add column if not exists next_retry_at timestamptz;

alter table public.post_targets drop constraint if exists post_targets_failure_kind_check;
alter table public.post_targets add constraint post_targets_failure_kind_check
  check (failure_kind is null or failure_kind in ('retryable', 'permanent', 'unknown'));

-- Historical failures predate classification. Treat interrupted deliveries as
-- unknown and every other old failure as permanent; neither is auto-retried.
update public.post_targets
   set failure_kind = case
     when error = 'Delivery was interrupted. Verify the platform before retrying.'
       then 'unknown'
     else 'permanent'
   end
 where status in ('failed', 'skipped')
   and failure_kind is null;

create index if not exists post_targets_retry_due_idx
  on public.post_targets (next_retry_at, post_id)
  where status = 'failed' and failure_kind = 'retryable' and attempts < 3;

create or replace function public.claim_due_posts(
  p_timezone text default 'Australia/Perth',
  p_limit int default 25
) returns setof public.posts
language plpgsql
security definer
set search_path = public
as $$
begin
  perform now() at time zone p_timezone;

  update public.post_targets t
     set status = 'failed',
         failure_kind = 'unknown',
         next_retry_at = null,
         error = 'Delivery was interrupted. Verify the platform before retrying.',
         updated_at = now()
   where t.status = 'publishing'
     and exists (
       select 1 from public.posts p
        where p.id = t.post_id
          and p.status = 'publishing'
          and p.publish_claimed_at < now() - interval '15 minutes'
     );

  update public.posts
     set status = 'failed',
         publish_claimed_at = null,
         updated_at = now()
   where status = 'publishing'
     and publish_claimed_at < now() - interval '15 minutes';

  return query
  with candidates as (
    select p.id
      from public.posts p
     where p.status = 'scheduled'
       and (p.date + coalesce(nullif(p.time, ''), '10:00')::time)
           <= (now() at time zone p_timezone)
       and (
         not exists (select 1 from public.post_targets t where t.post_id = p.id)
         or exists (
           select 1 from public.post_targets t
            where t.post_id = p.id
              and t.status = 'failed'
              and t.failure_kind = 'retryable'
              and t.attempts < 3
              and t.next_retry_at <= now()
         )
       )
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

-- Explicit user retry is allowed for definitive failures after the user fixes
-- the cause. Unknown outcomes remain blocked inside publishPost and are never
-- sent again until separately reconciled with the provider.
create or replace function public.claim_post_for_retry(p_post_id text)
returns setof public.posts
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select p.id
      from public.posts p
     where p.id = p_post_id
       and p.status in ('draft', 'scheduled', 'published', 'failed')
       and exists (
         select 1 from public.post_targets t
          where t.post_id = p.id
            and t.status in ('failed', 'skipped')
            and coalesce(t.failure_kind, 'permanent') <> 'unknown'
       )
     for update skip locked
  )
  update public.posts p
     set status = 'publishing',
         publish_claimed_at = now(),
         updated_at = now()
    from candidate c
   where p.id = c.id
  returning p.*;
end
$$;

revoke all on function public.claim_due_posts(text, int) from public, anon, authenticated;
grant execute on function public.claim_due_posts(text, int) to service_role;
revoke all on function public.claim_post_for_retry(text) from public, anon, authenticated;
grant execute on function public.claim_post_for_retry(text) to service_role;
