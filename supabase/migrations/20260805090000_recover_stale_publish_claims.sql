-- Edge Functions can be interrupted after a post is atomically claimed. Make
-- abandoned claims visible and manually retryable instead of leaving them in
-- `publishing` forever. Fifteen minutes is comfortably beyond the function's
-- normal request lifetime. Successful per-platform targets remain recorded and
-- the publish function skips them on a later retry.

create or replace function public.claim_due_posts(
  p_timezone text default 'Australia/Perth',
  p_limit int default 25
) returns setof public.posts
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Validate the supplied IANA timezone even when no posts are due.
  perform now() at time zone p_timezone;

  update public.post_targets t
     set status = 'failed',
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
     set status = 'draft',
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

revoke all on function public.claim_due_posts(text, int) from public;
revoke all on function public.claim_due_posts(text, int) from anon, authenticated;
grant execute on function public.claim_due_posts(text, int) to service_role;
