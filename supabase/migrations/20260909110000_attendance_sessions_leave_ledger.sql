-- Close findings F-07 and F-10: attendance is composed of real sessions and
-- approved leave is changed only through an auditable cancellation workflow.

-- ---------------------------------------------------------------------------
-- Attendance sessions
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_sessions (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references public.attendance(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  source text not null default 'CHECK_IN' check (source in ('CHECK_IN', 'REOPEN', 'ADMIN')),
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);

create unique index if not exists attendance_one_open_session
on public.attendance_sessions(attendance_id) where ended_at is null;
create index if not exists attendance_sessions_user_started_idx
on public.attendance_sessions(user_id, started_at);

insert into public.attendance_sessions (attendance_id, user_id, started_at, ended_at, source)
select a.id, a.user_id, a.check_in_time, a.check_out_time, 'CHECK_IN'
from public.attendance a
where a.check_in_time is not null
  and not exists (select 1 from public.attendance_sessions s where s.attendance_id = a.id);

alter table public.attendance_sessions enable row level security;
drop policy if exists attendance_sessions_read on public.attendance_sessions;
create policy attendance_sessions_read on public.attendance_sessions
for select to authenticated using (user_id = auth.uid() or public.can('attendance'));
grant select on public.attendance_sessions to authenticated;

create or replace function public.sync_attendance_sessions()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.check_in_time is not null then
    insert into public.attendance_sessions(attendance_id, user_id, started_at, ended_at, source)
    values (new.id, new.user_id, new.check_in_time, new.check_out_time, 'CHECK_IN')
    on conflict do nothing;
    return new;
  end if;

  if old.check_out_time is null and new.check_out_time is not null then
    update public.attendance_sessions
    set ended_at = new.check_out_time
    where id = (
      select id from public.attendance_sessions
      where attendance_id = new.id and ended_at is null
      order by started_at desc limit 1
    );
  elsif old.check_out_time is not null and new.check_out_time is null and new.status = 'active' then
    insert into public.attendance_sessions(attendance_id, user_id, started_at, source)
    values (new.id, new.user_id, now(), 'REOPEN')
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_session_sync on public.attendance;
create trigger attendance_session_sync
after insert or update of check_out_time, status on public.attendance
for each row execute function public.sync_attendance_sessions();

-- ---------------------------------------------------------------------------
-- Leave ledger and approved-leave cancellation
-- ---------------------------------------------------------------------------
alter table public.leave_requests add column if not exists is_cancelled boolean not null default false;
alter table public.leave_requests add column if not exists cancelled_at timestamptz;
alter table public.leave_requests add column if not exists cancelled_by uuid references public.profiles(id) on delete set null;

create table if not exists public.leave_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  leave_type text not null,
  leave_year integer not null,
  entry_type text not null check (entry_type in ('GRANT', 'CARRY_FORWARD', 'USED', 'REFUND', 'ADJUSTMENT')),
  days numeric(7,2) not null check (days <> 0),
  source_request_id uuid references public.leave_requests(id) on delete restrict,
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists leave_ledger_request_entry_unique
on public.leave_ledger(source_request_id, entry_type) where source_request_id is not null;
create unique index if not exists leave_ledger_annual_grant_unique
on public.leave_ledger(user_id, leave_year, leave_type, entry_type) where entry_type = 'GRANT';
create index if not exists leave_ledger_user_year_idx
on public.leave_ledger(user_id, leave_year, leave_type);

insert into public.leave_ledger(user_id, leave_type, leave_year, entry_type, days, note)
select p.id, 'annual', extract(year from current_date)::integer, 'GRANT', p.annual_leave_quota, 'Hạn mức đầu kỳ từ hồ sơ nhân sự'
from public.profiles p
where p.annual_leave_quota > 0
on conflict do nothing;

insert into public.leave_ledger(user_id, leave_type, leave_year, entry_type, days, source_request_id, note, created_by)
select l.user_id, l.leave_type, extract(year from l.start_date)::integer, 'USED', -abs(l.days), l.id, 'Đơn nghỉ đã duyệt', l.approved_by
from public.leave_requests l
where l.status = 'approved' and not l.is_cancelled
on conflict do nothing;

alter table public.leave_ledger enable row level security;
drop policy if exists leave_ledger_read on public.leave_ledger;
create policy leave_ledger_read on public.leave_ledger
for select to authenticated using (user_id = auth.uid() or public.can('leave'));
grant select on public.leave_ledger to authenticated;

create table if not exists public.leave_cancellation_requests (
  id uuid primary key default gen_random_uuid(),
  leave_request_id uuid not null references public.leave_requests(id) on delete restrict,
  requested_by uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (length(trim(reason)) >= 3),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists leave_one_pending_cancellation
on public.leave_cancellation_requests(leave_request_id) where status = 'pending';

alter table public.leave_cancellation_requests enable row level security;
drop policy if exists leave_cancellations_read on public.leave_cancellation_requests;
create policy leave_cancellations_read on public.leave_cancellation_requests
for select to authenticated using (requested_by = auth.uid() or public.can('leave'));
drop policy if exists leave_cancellations_insert on public.leave_cancellation_requests;
create policy leave_cancellations_insert on public.leave_cancellation_requests
for insert to authenticated with check (requested_by = auth.uid());
drop policy if exists leave_cancellations_review on public.leave_cancellation_requests;
create policy leave_cancellations_review on public.leave_cancellation_requests
for update to authenticated using (public.can('leave')) with check (public.can('leave'));
grant select, insert, update on public.leave_cancellation_requests to authenticated;

create or replace function public.guard_leave_cancellation_request()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target_leave public.leave_requests%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into target_leave from public.leave_requests where id = new.leave_request_id;
    if target_leave.id is null or target_leave.user_id <> auth.uid() or new.requested_by <> auth.uid() then
      raise exception 'Bạn chỉ được yêu cầu hủy đơn nghỉ của chính mình.' using errcode = '42501';
    end if;
    if target_leave.status <> 'approved' or target_leave.is_cancelled then
      raise exception 'Chỉ đơn đã duyệt và còn hiệu lực mới có thể yêu cầu hủy.' using errcode = '23514';
    end if;
    new.status := 'pending';
    new.reviewed_by := null;
    new.reviewed_at := null;
    return new;
  end if;

  if not public.can('leave') then
    raise exception 'Bạn không có quyền xử lý yêu cầu hủy phép.' using errcode = '42501';
  end if;
  if old.status <> 'pending' or new.status not in ('approved', 'rejected') then
    raise exception 'Yêu cầu hủy đã được xử lý hoặc trạng thái không hợp lệ.' using errcode = '23514';
  end if;
  if new.leave_request_id is distinct from old.leave_request_id
     or new.requested_by is distinct from old.requested_by
     or new.reason is distinct from old.reason then
    raise exception 'Không được thay đổi nội dung gốc của yêu cầu hủy.' using errcode = '23514';
  end if;
  new.reviewed_by := auth.uid();
  new.reviewed_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.apply_leave_cancellation()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target_leave public.leave_requests%rowtype;
begin
  if new.status = 'approved' and old.status = 'pending' then
    update public.leave_requests
    set is_cancelled = true, cancelled_at = now(), cancelled_by = new.reviewed_by
    where id = new.leave_request_id and status = 'approved' and not is_cancelled
    returning * into target_leave;
    if target_leave.id is null then
      raise exception 'Đơn nghỉ không còn hiệu lực để hủy.' using errcode = '23514';
    end if;
    insert into public.leave_ledger(user_id, leave_type, leave_year, entry_type, days, source_request_id, note, created_by)
    values (target_leave.user_id, target_leave.leave_type, extract(year from target_leave.start_date)::integer,
      'REFUND', abs(target_leave.days), target_leave.id, 'Hoàn phép do yêu cầu hủy được duyệt', new.reviewed_by)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists leave_cancellation_guard on public.leave_cancellation_requests;
create trigger leave_cancellation_guard
before insert or update on public.leave_cancellation_requests
for each row execute function public.guard_leave_cancellation_request();
drop trigger if exists leave_cancellation_apply on public.leave_cancellation_requests;
create trigger leave_cancellation_apply
after update of status on public.leave_cancellation_requests
for each row execute function public.apply_leave_cancellation();

create or replace function public.write_leave_usage_ledger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'approved' and not new.is_cancelled
     and (tg_op = 'INSERT' or old.status <> 'approved') then
    insert into public.leave_ledger(user_id, leave_type, leave_year, entry_type, days, source_request_id, note, created_by)
    values (new.user_id, new.leave_type, extract(year from new.start_date)::integer, 'USED', -abs(new.days), new.id, 'Đơn nghỉ được duyệt', new.approved_by)
    on conflict do nothing;
  end if;
  if tg_op = 'UPDATE' and old.status = 'approved' and new.status <> 'approved' then
    raise exception 'Đơn đã duyệt phải đi qua quy trình yêu cầu hủy.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.guard_direct_leave_cancellation()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' and coalesce(new.is_cancelled, false) then
    raise exception 'Không được tạo trực tiếp đơn ở trạng thái đã hủy.' using errcode = '23514';
  end if;
  -- Việc cập nhật hợp lệ được gọi lồng từ trigger duyệt yêu cầu hủy.
  if tg_op = 'UPDATE' and new.is_cancelled is distinct from old.is_cancelled and pg_trigger_depth() < 2 then
    raise exception 'Đơn đã duyệt phải đi qua quy trình yêu cầu hủy.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists leave_direct_cancellation_guard on public.leave_requests;
create trigger leave_direct_cancellation_guard
before insert or update of is_cancelled on public.leave_requests
for each row execute function public.guard_direct_leave_cancellation();

drop trigger if exists leave_usage_ledger_write on public.leave_requests;
create trigger leave_usage_ledger_write
after insert or update of status on public.leave_requests
for each row execute function public.write_leave_usage_ledger();

create or replace function public.write_leave_quota_adjustment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.annual_leave_quota is distinct from old.annual_leave_quota then
    insert into public.leave_ledger(user_id, leave_type, leave_year, entry_type, days, note, created_by)
    values (new.id, 'annual', extract(year from current_date)::integer, 'ADJUSTMENT',
      new.annual_leave_quota - old.annual_leave_quota, 'Điều chỉnh hạn mức phép năm', auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists profile_leave_quota_ledger on public.profiles;
create trigger profile_leave_quota_ledger
after update of annual_leave_quota on public.profiles
for each row execute function public.write_leave_quota_adjustment();

-- Effective leave must ignore an approved request after its cancellation was approved.
create or replace function public.guard_leave_overlap()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status in ('pending', 'approved') and not coalesce(new.is_cancelled, false) and exists (
    select 1 from public.leave_requests existing
    where existing.user_id = new.user_id
      and existing.id is distinct from new.id
      and existing.status in ('pending', 'approved')
      and not coalesce(existing.is_cancelled, false)
      and daterange(existing.start_date, existing.end_date, '[]')
          && daterange(new.start_date, new.end_date, '[]')
  ) then
    raise exception 'Khoảng nghỉ bị trùng với một đơn chờ duyệt hoặc đã duyệt.' using errcode = '23P01';
  end if;
  return new;
end;
$$;

create or replace function public.guard_shift_leave_conflict()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status in ('pending', 'approved') and exists (
    select 1 from public.leave_requests l
    where l.user_id = new.user_id and l.status = 'approved' and not coalesce(l.is_cancelled, false)
      and daterange(l.start_date, l.end_date, '[]') && daterange(new.start_date, new.end_date, '[]')
  ) then
    raise exception 'Không thể đăng ký hoặc duyệt ca trùng thời gian nghỉ đã duyệt.' using errcode = '23P01';
  end if;
  return new;
end;
$$;

create or replace function public.guard_attendance_leave_conflict()
returns trigger language plpgsql set search_path = public as $$
begin
  if exists (
    select 1 from public.leave_requests l
    where l.user_id = new.user_id and l.status = 'approved' and not coalesce(l.is_cancelled, false)
      and new.date between l.start_date and l.end_date
  ) then
    raise exception 'Không thể chấm công trong ngày nghỉ đã được duyệt.' using errcode = '23P01';
  end if;
  return new;
end;
$$;
