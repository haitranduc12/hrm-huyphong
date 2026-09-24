-- ============================================================================
-- Gom tỷ lệ bảo hiểm bắt buộc về MỘT nơi.
-- ----------------------------------------------------------------------------
-- Migration 20260921090000 để tỷ lệ bảo hiểm nằm ở hai chỗ khác nhau:
--
--   phần NGƯỜI LAO ĐỘNG đóng  → app_settings (trang Cấu hình hệ thống)
--   phần DOANH NGHIỆP đóng    → payroll_components ER_SOCIAL / ER_HEALTH /
--                                ER_UNEMPLOY (tab Danh mục khoản)
--
-- Cùng một khái niệm, hai màn hình, hai kiểu nhập liệu. Khi mức đóng thay đổi
-- theo quy định, người làm phải nhớ sửa cả hai chỗ — và chỗ bị quên sẽ âm thầm
-- làm sai báo cáo chi phí nhân sự.
--
-- Bất đối xứng nữa: khấu trừ của người lao động do engine tự tính (dòng
-- INS_SOCIAL/INS_HEALTH/INS_UNEMPLOY sinh sẵn), trong khi phần doanh nghiệp
-- lại phải gán tay từng người như một khoản thường. Hai cách làm cho hai nửa
-- của cùng một nghĩa vụ.
--
-- Sau migration này: cả sáu tỷ lệ nằm trong app_settings, engine tự tính cả
-- hai phần, và ba khoản ER_* bị xóa.
-- ============================================================================

do $do$
begin
  if to_regclass('public.app_settings') is null then
    raise notice 'Bỏ qua: app_settings chưa tồn tại.';
    return;
  end if;

  alter table public.app_settings
    add column if not exists employer_social_rate numeric(5, 2) not null default 17.5,
    add column if not exists employer_health_rate numeric(5, 2) not null default 3,
    add column if not exists employer_unemployment_rate numeric(5, 2) not null default 1;

  -- Giữ lại con số người dùng đã chỉnh trên các khoản ER_* (nếu có) thay vì
  -- ghi đè bằng mặc định — họ có thể đã sửa cho đúng thực tế công ty.
  if to_regclass('public.payroll_components') is not null then
    update public.app_settings s
    set employer_social_rate = coalesce(
          (select c.default_amount from public.payroll_components c where c.code = 'ER_SOCIAL'),
          s.employer_social_rate),
        employer_health_rate = coalesce(
          (select c.default_amount from public.payroll_components c where c.code = 'ER_HEALTH'),
          s.employer_health_rate),
        employer_unemployment_rate = coalesce(
          (select c.default_amount from public.payroll_components c where c.code = 'ER_UNEMPLOY'),
          s.employer_unemployment_rate)
    where s.id;

    -- Xóa được an toàn: phiếu lương đã chốt lưu từng dòng tiền dưới dạng bản
    -- sao trong payslip_lines (mã, tên, số tiền là text/numeric rời), nên
    -- không có tham chiếu ngược nào tới payroll_components.
    delete from public.payroll_components
    where code in ('ER_SOCIAL', 'ER_HEALTH', 'ER_UNEMPLOY');
  end if;
end;
$do$;

comment on column public.app_settings.employer_social_rate is
  'BHXH phần doanh nghiệp đóng (%). Không trừ vào lương nhân viên, chỉ vào chi phí nhân sự.';
