create table if not exists public.training_courses (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(trim(title)) between 2 and 160),
  description text,
  category text not null default 'Chung',
  instructor text,
  duration_hours numeric(6,2) not null default 1 check (duration_hours > 0),
  deadline date,
  resource_url text,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.training_enrollments (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.training_courses(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'enrolled' check (status in ('enrolled', 'in_progress', 'completed')),
  progress integer not null default 0 check (progress between 0 and 100),
  note text,
  enrolled_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (course_id, user_id)
);

alter table public.training_courses enable row level security;
alter table public.training_enrollments enable row level security;

create policy training_courses_select on public.training_courses for select to authenticated
  using (status = 'published' or public.can('training'));
create policy training_courses_manage on public.training_courses for all to authenticated
  using (public.can('training')) with check (public.can('training'));
create policy training_enrollments_select on public.training_enrollments for select to authenticated
  using (user_id = auth.uid() or public.can('training'));
create policy training_enrollments_insert on public.training_enrollments for insert to authenticated
  with check (user_id = auth.uid() or public.can('training'));
create policy training_enrollments_update on public.training_enrollments for update to authenticated
  using (user_id = auth.uid() or public.can('training'))
  with check (user_id = auth.uid() or public.can('training'));
create policy training_enrollments_delete on public.training_enrollments for delete to authenticated
  using (user_id = auth.uid() or public.can('training'));