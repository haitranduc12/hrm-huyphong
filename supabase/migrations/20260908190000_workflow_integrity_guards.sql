-- Bảo vệ tính toàn vẹn các luồng chấm công, nghỉ phép và ca làm việc.
-- UI đã kiểm tra để phản hồi sớm; trigger là lớp chặn cuối khi có client khác
-- hoặc yêu cầu gọi thẳng PostgREST bỏ qua giao diện.

create or replace function public.guard_attendance_approval()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.approved_by_lead
     and (not coalesce(old.approved_by_lead, false) or tg_op = 'INSERT')
     and (new.status <> 'completed' or new.check_out_time is null) then
    raise exception 'Chỉ được duyệt ngày công đã hoàn tất và có giờ check-out.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_approval_guard on public.attendance;
create trigger attendance_approval_guard
before insert or update on public.attendance
for each row execute function public.guard_attendance_approval();

create or replace function public.guard_leave_overlap()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status in ('pending', 'approved') and exists (
    select 1
    from public.leave_requests existing
    where existing.user_id = new.user_id
      and existing.id is distinct from new.id
      and existing.status in ('pending', 'approved')
      and daterange(existing.start_date, existing.end_date, '[]')
          && daterange(new.start_date, new.end_date, '[]')
  ) then
    raise exception 'Khoảng nghỉ bị trùng với một đơn chờ duyệt hoặc đã duyệt.'
      using errcode = '23P01';
  end if;
  return new;
end;
$$;

drop trigger if exists leave_overlap_guard on public.leave_requests;
create trigger leave_overlap_guard
before insert or update on public.leave_requests
for each row execute function public.guard_leave_overlap();

create or replace function public.guard_shift_overlap()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status in ('pending', 'approved') and exists (
    select 1
    from public.shifts existing
    where existing.user_id = new.user_id
      and existing.id is distinct from new.id
      and existing.status in ('pending', 'approved')
      and daterange(existing.start_date, existing.end_date, '[]')
          && daterange(new.start_date, new.end_date, '[]')
  ) then
    raise exception 'Khoảng ca bị trùng với một ca chờ duyệt hoặc đã duyệt.'
      using errcode = '23P01';
  end if;
  return new;
end;
$$;

drop trigger if exists shift_overlap_guard on public.shifts;
create trigger shift_overlap_guard
before insert or update on public.shifts
for each row execute function public.guard_shift_overlap();

