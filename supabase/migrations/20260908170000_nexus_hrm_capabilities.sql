-- Additive capabilities based on the Nexus HRM feature report.

alter table public.profiles add column if not exists hire_date date;
alter table public.profiles add column if not exists dependents_count integer not null default 0 check (dependents_count >= 0);

create table if not exists public.work_locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  latitude numeric(10,7),
  longitude numeric(10,7),
  radius_meters integer not null default 200 check (radius_meters between 20 and 5000),
  wifi_bssid text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.attendance add column if not exists location_id uuid references public.work_locations(id) on delete set null;
alter table public.attendance add column if not exists check_in_method text check (check_in_method is null or check_in_method in ('GPS','WIFI','MANUAL'));
alter table public.attendance add column if not exists check_in_latitude numeric(10,7);
alter table public.attendance add column if not exists check_in_longitude numeric(10,7);
alter table public.attendance add column if not exists wifi_bssid text;
alter table public.attendance add column if not exists anomaly_flags text[] not null default '{}';

create table if not exists public.employee_lifecycle_processes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  process_type text not null check (process_type in ('ONBOARDING','OFFBOARDING')),
  title text not null,
  start_date date not null default current_date,
  target_date date,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','COMPLETED','CANCELLED')),
  mentor_id uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.employee_checklist_items (
  id uuid primary key default gen_random_uuid(),
  process_id uuid not null references public.employee_lifecycle_processes(id) on delete cascade,
  title text not null,
  owner_id uuid references public.profiles(id) on delete set null,
  due_date date,
  completed boolean not null default false,
  completed_at timestamptz,
  order_index integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.performance_cycles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  start_date date not null,
  end_date date not null,
  status text not null default 'DRAFT' check (status in ('DRAFT','ACTIVE','CLOSED')),
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create table if not exists public.performance_goals (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.performance_cycles(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text,
  target_value numeric(12,2) not null default 100,
  current_value numeric(12,2) not null default 0,
  weight integer not null default 100 check (weight between 1 and 100),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','COMPLETED','CANCELLED')),
  created_at timestamptz not null default now()
);

create table if not exists public.performance_reviews (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.performance_cycles(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  reviewer_id uuid references public.profiles(id) on delete set null,
  self_score numeric(4,2) check (self_score between 0 and 5),
  manager_score numeric(4,2) check (manager_score between 0 and 5),
  self_comment text,
  manager_comment text,
  rating text check (rating is null or rating in ('A','B','C','D')),
  status text not null default 'SELF_REVIEW' check (status in ('SELF_REVIEW','MANAGER_REVIEW','COMPLETED')),
  updated_at timestamptz not null default now(),
  unique (cycle_id, user_id)
);

create table if not exists public.feature_flags (
  key text primary key,
  name text not null,
  description text,
  enabled boolean not null default false,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.feature_flags(key, name, description, enabled) values
  ('geofence_attendance', 'Chấm công Geofence', 'Xác thực vị trí GPS hoặc Wi-Fi khi check-in.', false),
  ('multi_level_approval', 'Phê duyệt nhiều cấp', 'Bật chuỗi duyệt quản lý trực tiếp và HR.', false),
  ('performance_reviews', 'Đánh giá hiệu suất', 'Mở KPI/OKR và đánh giá định kỳ.', true),
  ('employee_lifecycle', 'Onboarding & Offboarding', 'Mở checklist hội nhập và nghỉ việc.', true)
on conflict (key) do nothing;

alter table public.work_locations enable row level security;
alter table public.employee_lifecycle_processes enable row level security;
alter table public.employee_checklist_items enable row level security;
alter table public.performance_cycles enable row level security;
alter table public.performance_goals enable row level security;
alter table public.performance_reviews enable row level security;
alter table public.feature_flags enable row level security;

create policy work_locations_read on public.work_locations for select to authenticated using (true);
create policy work_locations_manage on public.work_locations for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy lifecycle_read on public.employee_lifecycle_processes for select to authenticated using (user_id = auth.uid() or mentor_id = auth.uid() or public.is_admin());
create policy lifecycle_manage on public.employee_lifecycle_processes for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy checklist_read on public.employee_checklist_items for select to authenticated using (exists (select 1 from public.employee_lifecycle_processes p where p.id = process_id and (p.user_id = auth.uid() or p.mentor_id = auth.uid() or public.is_admin())));
create policy checklist_manage on public.employee_checklist_items for all to authenticated using (owner_id = auth.uid() or public.is_admin()) with check (owner_id = auth.uid() or public.is_admin());
create policy cycles_read on public.performance_cycles for select to authenticated using (status <> 'DRAFT' or public.is_admin());
create policy cycles_manage on public.performance_cycles for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy goals_read on public.performance_goals for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy goals_manage on public.performance_goals for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy reviews_read on public.performance_reviews for select to authenticated using (user_id = auth.uid() or reviewer_id = auth.uid() or public.is_admin());
create policy reviews_self_update on public.performance_reviews for update to authenticated using (user_id = auth.uid() or reviewer_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or reviewer_id = auth.uid() or public.is_admin());
create policy reviews_manage on public.performance_reviews for insert to authenticated with check (public.is_admin());
create policy flags_read on public.feature_flags for select to authenticated using (true);
create policy flags_manage on public.feature_flags for all to authenticated using (public.is_admin()) with check (public.is_admin());

