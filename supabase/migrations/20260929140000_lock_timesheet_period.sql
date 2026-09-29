-- ============================================================================
-- Khóa kỳ công phải khóa thật.
-- ----------------------------------------------------------------------------
-- `timesheet_peariods.status = 'LOCKED'` đang chỉ làm một việc: khóa nút Duyệt
-- bảng lương trên giao diện. Không có gì chặn sửa dữ liệu chấm công của tháng
-- đã khóa.
--
-- Hệ quả là chuỗi tin cậy đứt ở giữa:
--   1. Khóa kỳ công tháng 9.
--   2. Duyệt bảng lương — phiếu lương đóng băng với số ngày công tại thời
--      điểm đó.
--   3. Sau đó vẫn sửa/thêm/xóa được bản ghi chấm công của tháng 9.
--   → Phiếu lương ghi một con số, bảng công ghi một con số khác, và không có
--     gì đối chiếu ra. Đúng loại sai lệch chỉ lộ ra khi thanh tra hoặc khi
--     người lao động khiếu nại.
--
-- Migration này đóng lỗ đó ở TẦNG DATABASE, nơi giao diện không đi vòng được.
-- Đơn nghỉ phép cũng chặn theo, vì ngày nghỉ có lương được tính vào ngày công
-- hưởng lương — sửa đơn nghỉ sau khi khóa cũng làm lệch đúng con số ấy.
--
-- thao tác đó có ghi `locked_by`/`locked_at` nên truy vết được — khác hẳn với
-- việc sửa lén một bản ghi.
-- ============================================================================

create or replace function public.timesheet_period_locked(p_date date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.timesheet_periods p
    where p.month_start = date_trunc('month', p_date)::date
      and p.status = 'LOCKED'
  );
$$;

comment on function public.timesheet_period_locked(date) is
  'Tháng chứa ngày này đã khóa kỳ công chưa.';

revoke all on function public.timesheet_period_locked(date) from public;
grant execute on function public.timesheet_period_locked(date) to authenticated;

-- ---------------------------------------------------------------------------
-- Chặn sửa chấm công của kỳ đã khóa
-- ---------------------------------------------------------------------------
create or replace function public.guard_attendance_period_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_date date;
begin
  -- Rẽ theo TG_OP: trên DELETE thì `NEW` chưa được gán, chạm vào là lỗi.
  if tg_op = 'DELETE' then
    v_date := old.date;
  else
    v_date := new.date;
  end if;

  if public.timesheet_period_locked(v_date) then
    raise exception
      'Kỳ công tháng % đã khóa, không sửa được dữ liệu chấm công. Mở lại kỳ ở trang Bảng công nếu thực sự cần sửa.',
      to_char(date_trunc('month', v_date), 'MM/YYYY')
      using errcode = 'check_violation';
  end if;

  -- Chuyển bản ghi từ tháng mở sang tháng đã khóa cũng là sửa số liệu của
  -- tháng đã khóa, nên phải chặn cả chiều ngược lại.
  if tg_op = 'UPDATE' and old.date is distinct from new.date
     and public.timesheet_period_locked(old.date) then
    raise exception
      'Không chuyển được bản ghi ra khỏi kỳ công tháng % đã khóa.',
      to_char(date_trunc('month', old.date), 'MM/YYYY')
      using errcode = 'check_violation';
  end if;

  return coalesce(new, old);
end;
$fn$;

drop trigger if exists attendance_period_lock on public.attendance;
create trigger attendance_period_lock
before insert or update or delete on public.attendance
for each row execute function public.guard_attendance_period_lock();

-- ---------------------------------------------------------------------------
-- Chặn sửa đơn nghỉ phép chạm vào kỳ đã khóa
-- ---------------------------------------------------------------------------
-- Ngày nghỉ có lương được cộng vào ngày công hưởng lương, nên sửa đơn nghỉ sau
-- khi khóa làm lệch đúng con số mà phiếu lương đã đóng băng.
create or replace function public.guard_leave_period_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_start date;
  v_end date;
begin
  if tg_op = 'DELETE' then
    v_start := old.start_date;
    v_end := old.end_date;
  else
    v_start := new.start_date;
    v_end := new.end_date;
  end if;

  -- Đơn có thể trải qua nhiều tháng: chặn nếu BẤT KỲ tháng nào đã khóa.
  if exists (
    select 1
    from generate_series(
      date_trunc('month', v_start)::date,
      date_trunc('month', coalesce(v_end, v_start))::date,
      interval '1 month'
    ) as m(month_start)
    where public.timesheet_period_locked(m.month_start::date)
  ) then
    raise exception
      'Đơn nghỉ này chạm vào kỳ công đã khóa, không sửa được. Mở lại kỳ nếu thực sự cần sửa.'
      using errcode = 'check_violation';
  end if;

  return coalesce(new, old);
end;
$fn$;

drop trigger if exists leave_requests_period_lock on public.leave_requests;
create trigger leave_requests_period_lock
before insert or update or delete on public.leave_requests
for each row execute function public.guard_leave_period_lock();

comment on function public.guard_attendance_period_lock() is
  'Chặn mọi thay đổi dữ liệu chấm công thuộc kỳ công đã khóa.';
comment on function public.guard_leave_period_lock() is
  'Chặn mọi thay đổi đơn nghỉ phép chạm vào kỳ công đã khóa.';
