-- TikTok "draft" posting mode — additive columns, no status change.
--
-- The draft flow drops a video into the user's TikTok inbox as a draft
-- instead of publishing it. Rather than rewrite the pipeline's existing
-- "published" semantics, the mode is tracked with two additive, nullable
-- columns and every existing enum, CHECK and trigger is left untouched:
--
--   * a delivered draft keeps `post_targets.status = 'published'` — TikTok
--     did accept and store the upload, so the delivery attempt succeeded;
--     "draft" describes *what* was delivered, not whether delivery worked;
--   * `tiktok_options` stays NULL for a draft post, exactly as it already
--     does for any post that predates that column or does not target
--     TikTok (see 20260831090000_tiktok_options.sql) — a draft has no
--     privacy level or interaction settings to enforce, so
--     `valid_post_tiktok_options` accepting NULL already covers it;
--   * NULL on both new columns means "legacy/direct", the only meaning
--     every existing row can have, so no backfill is needed.
--
-- In short: a delivered draft is an attribute of a normal published
-- delivery, not a new status.

-- Columns and CHECKs are added separately so the constraint is re-assertable
-- on a partially-applied migration (add column if not exists skips an inline
-- CHECK when the column already exists); named to match the repo's convention.
alter table public.posts
  add column if not exists tiktok_mode text;
alter table public.posts
  drop constraint if exists posts_tiktok_mode_check;
alter table public.posts
  add constraint posts_tiktok_mode_check check (tiktok_mode in ('direct','draft'));

alter table public.post_targets
  add column if not exists delivered_as text;
alter table public.post_targets
  drop constraint if exists post_targets_delivered_as_check;
alter table public.post_targets
  add constraint post_targets_delivered_as_check check (delivered_as in ('post','draft'));
