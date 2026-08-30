-- Capability tiers for the AI writing assist.
--
-- The ai-assist Edge Function no longer speaks to one provider: a request names
-- a capability tier ('standard' today, 'enhanced' and 'advanced' built but not
-- yet entitled), and the tier decides which provider serves it. The meter has
-- to record which tier a request spent, because the tiers do not cost the same
-- to serve and a per-tier ceiling must be answerable from this table alone.
--
-- Forward-only, like every migration in this schema. Existing rows predate
-- tiers and were all served by the tier that is now called 'standard', so the
-- default backfills them correctly and the column can be NOT NULL immediately.
--
-- What the row records is unchanged in kind: who, what, and now which tier —
-- never the customer's text or the model's answer.

alter table public.ai_assist_requests
  add column if not exists tier text not null default 'standard';

alter table public.ai_assist_requests
  drop constraint if exists ai_assist_requests_tier_check;

alter table public.ai_assist_requests
  add constraint ai_assist_requests_tier_check
  check (tier in ('standard', 'enhanced', 'advanced'));

-- No new index: the rate window is still queried by (user_id, created_at), and
-- ai_assist_requests_window_idx (20260829120000_ai_assist_requests.sql) still
-- serves it. A per-tier ceiling filters an already-tiny result set.
--
-- Retention is unchanged: the 30-day sweep for this table lives in
-- 'fablepeak-prune-job-runs' (20260829120000_ai_assist_requests.sql).
