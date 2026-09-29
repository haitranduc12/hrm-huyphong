-- ============================================================================
-- Gộp hai thiết lập "giờ làm mỗi ngày" vốn trùng nghĩa.
-- ----------------------------------------------------------------------------
-- Migration 20260921090000 thêm `payroll_hours_per_day` để quy đổi đơn giá giờ
-- cho người ăn lương tháng. Nhưng `standard_hours_per_day` đã có sẵn và mang
-- đúng nghĩa đó — Bảng công dùng nó làm ngưỡng "công đủ giờ".
--
-- Hai ô nhập cho cùng một con số là một cái bẫy: ai đó sửa một ô thành 7,5 rồi
-- quên ô kia, và từ đó đơn giá tăng ca lệch với ngưỡng công đủ mà không có
-- cảnh báo nào. Bỏ cột mới, giữ cột cũ.
--
-- An toàn để bỏ: cột vừa được thêm ở migration trước, mọi dòng còn ở giá trị
-- mặc định và chưa có kỳ lương nào được chốt dựa trên nó.
-- ============================================================================

do $do$
begin
  if to_regclass('public.app_settings') is not null then
    alter table public.app_settings drop column if exists payroll_hours_per_day;
  end if;
end;
$do$;

comment on column public.app_settings.standard_hours_per_day is
  'Số giờ làm chuẩn mỗi ngày. Dùng cho CẢ ngưỡng công đủ ở Bảng công lẫn quy đổi đơn giá giờ ở Bảng lương.';
