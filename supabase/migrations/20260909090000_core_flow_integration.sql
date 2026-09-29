-- Integrate the five core HRM flows: timekeeping/payroll periods, geofence,
-- cross-module calendar integrity, and project task authorization.

-- ---------------------------------------------------------------------------
-- 1. Timesheet periods are the hand-off contract from Attendance to Payroll.
-- ---------------------------------------------------------------------------
create table if not exists public.timesheet_periods (
  id uuid primary key default gen_random_uuid(),
  month_start date not null unique,
  status text not null default 'OPEN' check (status in ('OPEN', 'REVIEW', 'LOCKED')),
  locked_by uuid references public.profiles(id) on delete set null,
  locked_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (month_start = date_trunc('month', month_start)::date),
  check ((status = 'LOCKED') = (locked_at is not null))
);

alter table public.timesheet_periods enable row level security;

drop policy if exists timesheet_periods_read on public.timesheet_periods;
create policy timesheet_periods_read on public.timesheet_periods
for select to authenticated using (public.can('attendance'));

drop policy if exists timesheet_periods_manage on public.timesheet_periods;
create policy timesheet_periods_manage on public.timesheet_periods
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

grant select, insert, update on public.timesheet_periods to authenticated;

create or replace function public.touch_timesheet_period()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  if tg_op = 'UPDATE' and new.status is distinct from old.status and not (
    (old.status = 'OPEN' and new.status = 'REVIEW')
    or (old.status = 'REVIEW' and new.status = 'LOCKED')
    or (old.status = 'LOCKED' and new.status = 'OPEN')
  ) then
    raise exception 'Chuyển trạng thái kỳ công không hợp lệ (% → %).', old.status, new.status
      using errcode = '23514';
  end if;

  if new.status = 'LOCKED' and (tg_op = 'INSERT' or old.status <> 'LOCKED') and exists (
    select 1 from public.attendance a
    where a.date >= new.month_start
      and a.date < (new.month_start + interval '1 month')::date
      and (a.status <> 'completed' or not coalesce(a.approved_by_lead, false))
  ) then
    raise exception 'Không thể khóa kỳ: còn bản ghi chấm công đang làm hoặc chưa được duyệt.'
      using errcode = '23514';
  end if;

  if new.status = 'LOCKED' and (tg_op = 'INSERT' or old.status <> 'LOCKED') then
    new.locked_at = now();
    new.locked_by = auth.uid();
  elsif new.status <> 'LOCKED' then
    new.locked_at = null;
    new.locked_by = null;
  end if;
  return new;
end;
$$;

drop trigger if exists timesheet_period_touch on public.timesheet_periods;
create trigger timesheet_period_touch
before insert or update on public.timesheet_periods
for each row execute function public.touch_timesheet_period();

create or replace function public.guard_locked_period_changes()
returns trigger language plpgsql set search_path = public as $$
declare
  old_date_from date;
  old_date_to date;
  new_date_from date;
  new_date_to date;
begin
  if tg_table_name = 'attendance' then
    if tg_op <> 'INSERT' then old_date_from := old.date; old_date_to := old.date; end if;
    if tg_op <> 'DELETE' then new_date_from := new.date; new_date_to := new.date; end if;
  elsif tg_table_name = 'task_worklogs' then
    if tg_op <> 'INSERT' then old_date_from := old.work_date; old_date_to := old.work_date; end if;
    if tg_op <> 'DELETE' then new_date_from := new.work_date; new_date_to := new.work_date; end if;
  else
    if tg_op <> 'INSERT' then old_date_from := old.start_date; old_date_to := old.end_date; end if;
    if tg_op <> 'DELETE' then new_date_from := new.start_date; new_date_to := new.end_date; end if;
  end if;

  if exists (
    select 1 from public.timesheet_periods p
    where p.status = 'LOCKED'
      and (
        (tg_op in ('UPDATE', 'DELETE') and daterange(p.month_start, (p.month_start + interval '1 month - 1 day')::date, '[]')
          && daterange(old_date_from, old_date_to, '[]'))
        or
        (tg_op in ('INSERT', 'UPDATE') and daterange(p.month_start, (p.month_start + interval '1 month - 1 day')::date, '[]')
          && daterange(new_date_from, new_date_to, '[]'))
      )
  ) then
    raise exception 'Kỳ công chứa ngày này đã khóa. Hãy mở khóa kỳ trước khi điều chỉnh.'
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists attendance_locked_period_guard on public.attendance;
create trigger attendance_locked_period_guard
before insert or update or delete on public.attendance
for each row execute function public.guard_locked_period_changes();

drop trigger if exists leave_locked_period_guard on public.leave_requests;
create trigger leave_locked_period_guard
before insert or update or delete on public.leave_requests
for each row execute function public.guard_locked_period_changes();

drop trigger if exists worklog_locked_period_guard on public.task_worklogs;
create trigger worklog_locked_period_guard
before insert or update or delete on public.task_worklogs
for each row execute function public.guard_locked_period_changes();

-- ---------------------------------------------------------------------------
-- 2. Geofence is enforced in the database when its feature flag is enabled.
-- ---------------------------------------------------------------------------
create or replace function public.guard_attendance_geofence()
returns trigger language plpgsql set search_path = public as $$
declare
  enabled boolean := false;
  nearest record;
begin
  if tg_op <> 'INSERT' or new.check_in_time is null then return new; end if;

  select coalesce(f.enabled, false) into enabled
  from public.feature_flags f where f.key = 'geofence_attendance';
  if not enabled then return new; end if;

  if new.check_in_latitude is null or new.check_in_longitude is null then
    raise exception 'Cần cấp quyền GPS để chấm công tại địa điểm được phép.' using errcode = '23514';
  end if;

  select l.id, l.name, l.radius_meters,
    6371000 * acos(least(1, greatest(-1,
      cos(radians(new.check_in_latitude::double precision))
      * cos(radians(l.latitude::double precision))
      * cos(radians(l.longitude::double precision) - radians(new.check_in_longitude::double precision))
      + sin(radians(new.check_in_latitude::double precision))
      * sin(radians(l.latitude::double precision))
    ))) as distance_meters
  into nearest
  from public.work_locations l
  where l.is_active and l.latitude is not null and l.longitude is not null
  order by distance_meters
  limit 1;

  if nearest.id is null then
    raise exception 'Chưa có địa điểm GPS hoạt động. Quản trị viên cần cấu hình trước khi chấm công.' using errcode = '23514';
  end if;
  if nearest.distance_meters > nearest.radius_meters then
    raise exception 'Bạn đang ở ngoài phạm vi chấm công của địa điểm gần nhất (% cách % m).',
      nearest.name, round(nearest.distance_meters) using errcode = '23514';
  end if;

  new.location_id := nearest.id;
  new.check_in_method := coalesce(new.check_in_method, 'GPS');
  new.anomaly_flags := array_remove(coalesce(new.anomaly_flags, '{}'), 'OUT_OF_GEOFENCE');
  return new;
end;
$$;

drop trigger if exists attendance_geofence_guard on public.attendance;
create trigger attendance_geofence_guard
before insert on public.attendance
for each row execute function public.guard_attendance_geofence();

-- ---------------------------------------------------------------------------
-- 3/4. Leave, shifts and attendance share one calendar integrity contract.
-- ---------------------------------------------------------------------------
create or replace function public.guard_leave_calendar_conflict()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status <> 'approved') then
    if exists (
      select 1 from public.shifts s
      where s.user_id = new.user_id and s.status = 'approved'
        and daterange(s.start_date, s.end_date, '[]') && daterange(new.start_date, new.end_date, '[]')
    ) then
      raise exception 'Không thể duyệt nghỉ: nhân viên đang có ca đã duyệt trong khoảng này.' using errcode = '23P01';
    end if;
    if exists (
      select 1 from public.attendance a
      where a.user_id = new.user_id and a.date between new.start_date and new.end_date
    ) then
      raise exception 'Không thể duyệt nghỉ: khoảng ngày đã có dữ liệu chấm công.' using errcode = '23P01';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists leave_calendar_conflict_guard on public.leave_requests;
create trigger leave_calendar_conflict_guard
before insert or update on public.leave_requests
for each row execute function public.guard_leave_calendar_conflict();

create or replace function public.guard_shift_leave_conflict()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status in ('pending', 'approved') and exists (
    select 1 from public.leave_requests l
    where l.user_id = new.user_id and l.status = 'approved'
      and daterange(l.start_date, l.end_date, '[]') && daterange(new.start_date, new.end_date, '[]')
  ) then
    raise exception 'Không thể đăng ký hoặc duyệt ca trùng thời gian nghỉ đã duyệt.' using errcode = '23P01';
  end if;
  return new;
end;
$$;

drop trigger if exists shift_leave_conflict_guard on public.shifts;
create trigger shift_leave_conflict_guard
before insert or update on public.shifts
for each row execute function public.guard_shift_leave_conflict();

create or replace function public.guard_attendance_leave_conflict()
returns trigger language plpgsql set search_path = public as $$
begin
  if exists (
    select 1 from public.leave_requests l
    where l.user_id = new.user_id and l.status = 'approved'
      and new.date between l.start_date and l.end_date
  ) then
    raise exception 'Không thể chấm công trong ngày nghỉ đã được duyệt.' using errcode = '23P01';
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_leave_conflict_guard on public.attendance;
create trigger attendance_leave_conflict_guard
before insert or update of date, user_id on public.attendance
for each row execute function public.guard_attendance_leave_conflict();

-- ---------------------------------------------------------------------------
-- 5. Extensible project roles: every operation checks a business permission,
--    never a hard-coded role name.
-- ---------------------------------------------------------------------------
create table if not exists public.project_role_definitions (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,49}$'),
  name text not null,
  description text,
  permissions text[] not null default '{}',
  is_system boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (permissions <@ array[
    'project.view', 'member.manage',
    'task.create', 'task.edit', 'task.delete', 'task.assign',
    'task.move_any', 'task.move_own'
  ]::text[])
);

insert into public.project_role_definitions (code, name, description, permissions, is_system, sort_order)
values
  ('lead', 'Trưởng dự án', 'Điều hành dự án, thành viên và toàn bộ tác vụ.', array['project.view','member.manage','task.create','task.edit','task.delete','task.assign','task.move_any','task.move_own'], true, 10),
  ('coordinator', 'Điều phối dự án', 'Lập kế hoạch, phân công và điều phối tác vụ nhưng không xóa.', array['project.view','task.create','task.edit','task.assign','task.move_any','task.move_own'], true, 20),
  ('reviewer', 'Người kiểm duyệt', 'Theo dõi và chuyển trạng thái tác vụ phục vụ nghiệm thu.', array['project.view','task.move_any','task.move_own'], true, 30),
  ('member', 'Thành viên', 'Thực hiện và cập nhật trạng thái tác vụ được giao.', array['project.view','task.move_own'], true, 40),
  ('viewer', 'Người xem', 'Chỉ được theo dõi dự án và tác vụ.', array['project.view'], true, 50)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  permissions = excluded.permissions,
  is_system = excluded.is_system,
  sort_order = excluded.sort_order,
  updated_at = now();

alter table public.project_role_definitions enable row level security;
drop policy if exists project_roles_read on public.project_role_definitions;
create policy project_roles_read on public.project_role_definitions
for select to authenticated using (is_active or public.is_admin());
drop policy if exists project_roles_manage on public.project_role_definitions;
create policy project_roles_manage on public.project_role_definitions
for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select on public.project_role_definitions to authenticated;
grant insert, update, delete on public.project_role_definitions to authenticated;

alter table public.project_members add column if not exists role_code text;
update public.project_members set role_code = role where role_code is null;
alter table public.project_members alter column role_code set default 'member';
alter table public.project_members alter column role_code set not null;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'project_members_role_code_fkey'
      and conrelid = 'public.project_members'::regclass
  ) then
    alter table public.project_members
      add constraint project_members_role_code_fkey
      foreign key (role_code) references public.project_role_definitions(code);
  end if;
end $$;

-- Đồng bộ cột `role` cũ để các client chưa nâng cấp vẫn hoạt động. Role mở rộng
-- được ánh xạ về `member` ở cột cũ; quyền thật luôn đọc từ `role_code`.
create or replace function public.sync_project_member_role_code()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.role in ('lead', 'member', 'viewer') and (new.role_code is null or new.role_code = 'member') then
      new.role_code := new.role;
    end if;
  elsif new.role is distinct from old.role and new.role_code is not distinct from old.role_code then
    new.role_code := new.role;
  end if;

  if tg_op = 'UPDATE' and new.role_code is distinct from old.role_code then
    new.role := case when new.role_code in ('lead', 'member', 'viewer') then new.role_code else 'member' end;
  elsif new.role_code not in ('lead', 'member', 'viewer') then
    new.role := 'member';
  end if;
  return new;
end;
$$;

drop trigger if exists project_member_role_code_sync on public.project_members;
create trigger project_member_role_code_sync
before insert or update of role, role_code on public.project_members
for each row execute function public.sync_project_member_role_code();

create or replace function public.project_member_has_permission(
  target_project uuid,
  target_user uuid,
  required_permission text
)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = target_user and p.is_active
      and (p.role in ('admin', 'ceo') or 'projects' = any(coalesce(p.permissions, '{}')))
  ) or exists (
    select 1
    from public.project_members pm
    join public.project_role_definitions rd on rd.code = pm.role_code and rd.is_active
    where pm.project_id = target_project
      and pm.user_id = target_user
      and required_permission = any(rd.permissions)
  );
$$;

create or replace function public.current_user_can_manage_project(target_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.project_member_has_permission(target_project, auth.uid(), 'task.edit');
$$;

create or replace function public.guard_task_member_changes()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target_project uuid;
begin
  if tg_op = 'DELETE' then
    target_project := old.project_id;
  else
    target_project := new.project_id;
  end if;

  if tg_op <> 'DELETE' and new.assignee_id is not null and not exists (
    select 1 from public.project_members pm
    where pm.project_id = new.project_id and pm.user_id = new.assignee_id
  ) then
    raise exception 'Người được giao phải là thành viên của dự án.' using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    if auth.uid() is null or public.project_member_has_permission(target_project, auth.uid(), 'task.delete') then return old; end if;
    raise exception 'Vai trò của bạn không có quyền xóa tác vụ.' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if auth.uid() is not null and not public.project_member_has_permission(target_project, auth.uid(), 'task.create') then
      raise exception 'Vai trò của bạn không có quyền tạo tác vụ.' using errcode = '42501';
    end if;
    if new.assignee_id is not null and auth.uid() is not null
       and not public.project_member_has_permission(target_project, auth.uid(), 'task.assign') then
      raise exception 'Vai trò của bạn không có quyền phân công tác vụ.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.assignee_id is distinct from old.assignee_id
     and auth.uid() is not null
     and not public.project_member_has_permission(target_project, auth.uid(), 'task.assign') then
    raise exception 'Vai trò của bạn không có quyền phân công lại tác vụ.' using errcode = '42501';
  end if;

  if new.project_id is distinct from old.project_id and auth.uid() is not null
     and not (
       public.project_member_has_permission(old.project_id, auth.uid(), 'task.edit')
       and public.project_member_has_permission(new.project_id, auth.uid(), 'task.create')
     ) then
    raise exception 'Vai trò của bạn không có quyền chuyển tác vụ sang dự án này.' using errcode = '42501';
  end if;

  if new.project_id is distinct from old.project_id
     or new.title is distinct from old.title
     or new.description is distinct from old.description
     or new.start_date is distinct from old.start_date
     or new.due_date is distinct from old.due_date
     or new.priority is distinct from old.priority
     or new.parent_task_id is distinct from old.parent_task_id
     or new.estimated_hours is distinct from old.estimated_hours then
    if auth.uid() is not null and not public.project_member_has_permission(target_project, auth.uid(), 'task.edit') then
      raise exception 'Vai trò của bạn không có quyền sửa nội dung tác vụ.' using errcode = '42501';
    end if;
  end if;

  if new.status is distinct from old.status or new.order_index is distinct from old.order_index then
    if auth.uid() is not null
       and not public.project_member_has_permission(target_project, auth.uid(), 'task.move_any')
       and not (old.assignee_id = auth.uid() and public.project_member_has_permission(target_project, auth.uid(), 'task.move_own')) then
      raise exception 'Vai trò của bạn không có quyền chuyển trạng thái tác vụ này.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists task_member_change_guard on public.tasks;
create trigger task_member_change_guard
before insert or update or delete on public.tasks
for each row execute function public.guard_task_member_changes();
