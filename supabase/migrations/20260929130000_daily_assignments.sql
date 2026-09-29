-- ============================================================================
-- Giao việc hằng ngày (daily_assignments).
-- ----------------------------------------------------------------------------
-- Bảng này vốn chỉ tồn tại trong file SUPABASE_DAILY_ASSIGNMENTS.sql nằm rời ở
-- thư mục gốc, KHÔNG có trong supabase/migrations. Nghĩa là dựng một database
-- mới từ migrations sẽ thiếu hẳn bảng này, và module Giao việc cùng badge đếm
-- việc chờ trên sidebar sẽ hỏng mà không có gì báo trước.
--
-- Chuyển nguyên văn thành migration. Toàn bộ lệnh đều idempotent
-- (`if not exists` / `drop policy if exists` trước mỗi `create policy`) nên
-- chạy trên database đã có bảng là vô hại.
-- ============================================================================

create table if not exists public.daily_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  assigned_by uuid references public.profiles(id) on delete set null,
  work_date date not null,
  title text not null check (length(trim(title)) > 0),
  description text,
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'critical')),
  status text not null default 'pending' check (status in ('pending', 'submitted', 'approved', 'rejected')),
  submit_note text,
  submitted_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists daily_assignments_user_date_idx
  on public.daily_assignments (user_id, work_date);

create index if not exists daily_assignments_status_idx
  on public.daily_assignments (status);

create index if not exists daily_assignments_assigned_by_idx
  on public.daily_assignments (assigned_by);

alter table public.daily_assignments enable row level security;

grant select, insert, update, delete on public.daily_assignments to authenticated;

drop policy if exists "daily assignments readable by authenticated users" on public.daily_assignments;
create policy "daily assignments readable by authenticated users"
  on public.daily_assignments for select
  to authenticated
  using (
    auth.uid() = user_id
    or auth.uid() = assigned_by
    or auth.uid() = reviewed_by
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'ceo')
    )
  );

drop policy if exists "users can create their own assignments" on public.daily_assignments;
create policy "users can create their own assignments"
  on public.daily_assignments for insert
  to authenticated
  with check (auth.uid() = user_id or auth.uid() = assigned_by);

drop policy if exists "users can update their own assignment fields" on public.daily_assignments;
create policy "users can update their own assignment fields"
  on public.daily_assignments for update
  to authenticated
  using (
    auth.uid() = user_id
    or auth.uid() = assigned_by
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'ceo')
    )
  )
  with check (
    auth.uid() = user_id
    or auth.uid() = assigned_by
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'ceo')
    )
  );

drop policy if exists "daily assignments deletable by owner or assigner" on public.daily_assignments;
create policy "daily assignments deletable by owner or assigner"
  on public.daily_assignments for delete
  to authenticated
  using (
    auth.uid() = user_id
    or auth.uid() = assigned_by
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('admin', 'ceo')
    )
  );

notify pgrst, 'reload schema';
