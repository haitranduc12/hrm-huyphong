-- Video attachments for training courses.

alter table public.training_courses add column if not exists video_path text;
alter table public.training_courses add column if not exists video_file_name text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('training-videos', 'training-videos', false, 524288000, array['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists training_videos_select on storage.objects;
drop policy if exists training_videos_insert on storage.objects;
drop policy if exists training_videos_update on storage.objects;
drop policy if exists training_videos_delete on storage.objects;

create policy training_videos_select on storage.objects for select to authenticated
  using (bucket_id = 'training-videos' and (public.can('training') or exists (
    select 1 from public.training_enrollments e
    where e.user_id = auth.uid()
      and e.course_id::text = (storage.foldername(name))[1]
  )));
create policy training_videos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'training-videos' and public.can('training'));
create policy training_videos_update on storage.objects for update to authenticated
  using (bucket_id = 'training-videos' and public.can('training'));
create policy training_videos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'training-videos' and public.can('training'));
