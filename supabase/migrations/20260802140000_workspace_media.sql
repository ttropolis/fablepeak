-- Public provider-fetchable media, with authenticated writes scoped to a
-- workspace path: social-media/<brand_id>/<unguessable filename>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'social-media', 'social-media', true, 52428800,
  array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/quicktime','video/webm']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists workspace_media_insert on storage.objects;
create policy workspace_media_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'social-media'
  and public.is_member((storage.foldername(name))[1])
);

drop policy if exists workspace_media_update on storage.objects;
create policy workspace_media_update on storage.objects for update to authenticated
using (
  bucket_id = 'social-media'
  and public.is_member((storage.foldername(name))[1])
)
with check (
  bucket_id = 'social-media'
  and public.is_member((storage.foldername(name))[1])
);

drop policy if exists workspace_media_delete on storage.objects;
create policy workspace_media_delete on storage.objects for delete to authenticated
using (
  bucket_id = 'social-media'
  and public.is_member((storage.foldername(name))[1])
);
