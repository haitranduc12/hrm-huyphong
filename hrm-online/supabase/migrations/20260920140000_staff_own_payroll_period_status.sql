-- Cho nhân viên biết kỳ lương của mình đã chốt hay chưa mà không mở quyền đọc
-- toàn bộ timesheet_periods (bảng này còn có ghi chú và người thực hiện khóa).

create or replace function public.get_payroll_period_status(target_month date)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.status
  from public.timesheet_periods p
  where p.month_stazrt = date_trunc('month', target_month)::date
  limit 1;
$$;

revoke all on function public.get_payroll_period_status(date) from public;
grant execute on function public.get_payroll_period_status(date) to authenticated;

comment on function public.get_payroll_period_status(date) is
  'Trả trạng thái OPEN/REVIEW/LOCKED của một kỳ công; không làm lộ metadata nội bộ của kỳ.';
