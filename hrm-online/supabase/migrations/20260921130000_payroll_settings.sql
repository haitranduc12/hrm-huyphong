-- ============================================================================
-- Tách tham số lương ra khỏi cấu hình hệ thống.
-- ----------------------------------------------------------------------------
-- Migration 20260921090000 và 20260921120000 để thuế suất, tỷ lệ bảo hiểm,
-- trần đóng và ngày công chuẩn trong `app_settings`. Sai ở hai điểm:
--
-- 1. HỞ QUYỀN. Trang Bảng lương yêu cầu Admin/CEO (`fullAdminOnly`), còn trang
--    Cấu hình chỉ cần quyền lẻ `settings` — quyền có thể cấp cho nhân viên
--    thường. RLS `app_settings_manage` dùng `can('settings')` nên ở tầng
--    database cũng vậy. Kết quả: một người bị cấm XEM bảng lương vẫn SỬA được
--    thuế suất và tỷ lệ bảo hiểm, tức là đổi lương thực nhận của cả công ty.
--    Trái với luật mà chính `lib/permissions.ts` đặt ra: quyền lẻ không đụng
--    tới lương.
--
-- 2. SAI CHỖ. Những tham số này chỉ `lib/payroll.ts` đọc, không module nào
--    khác dùng. Thiết lập chỉ phục vụ một module thì thuộc về module đó.
--
-- `standard_hours_per_day` Ở LẠI `app_settings` vì Bảng công dùng nó làm
-- ngưỡng "đủ giờ công" — đó là thiết lập vận hành dùng chung thật, payroll chỉ
-- đọc ké để quy đổi đơn giá giờ.
-- ============================================================================

create table if not exists public.payroll_settings (
  -- Bảng một dòng, cùng kiểu khoá với app_settings.
  id boolean primary key default true check (id),

  /* Mẫu số cho người hưởng lương tháng. */
  standard_work_days numeric(5, 2) not null default 26 check (standard_work_days > 0),

  /* Phần người lao động trích đóng (%). */
  social_insurance_rate numeric(5, 2) not null default 8,
  health_insurance_rate numeric(5, 2) not null default 1.5,
  unemployment_insurance_rate numeric(5, 2) not null default 1,

  /* Phần doanh nghiệp đóng (%). Không trừ vào lương nhân viên. */
  employer_social_rate numeric(5, 2) not null default 17.5,
  employer_health_rate numeric(5, 2) not null default 3,
  employer_unemployment_rate numeric(5, 2) not null default 1,

  /* Trần tiền lương đóng. BHXH/BHYT và BHTN có trần khác nhau. */
  insurance_salary_cap numeric(15, 2) not null default 46800000,
  unemployment_salary_cap numeric(15, 2) not null default 99200000,

  /* Giảm trừ gia cảnh khi tính thuế TNCN. */
  tax_personal_deduction numeric(15, 2) not null default 11000000,
  tax_dependent_deduction numeric(15, 2) not null default 4400000,

  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.payroll_settings(id) values (true) on conflict (id) do nothing;

-- Chuyển giá trị đang dùng sang, để không ai bị mất thiết lập đã chỉnh.
do $do$
begin
  if to_regclass('public.app_settings') is null then
    return;
  end if;

  update public.payroll_settings p
  set standard_work_days = coalesce(s.standard_work_days, p.standard_work_days),
      social_insurance_rate = coalesce(s.social_insurance_rate, p.social_insurance_rate),
      tax_personal_deduction = coalesce(s.tax_personal_deduction, p.tax_personal_deduction)
  from public.app_settings s
  where p.id;

  -- Các cột dưới đây do migration sau thêm vào; có thể chưa tồn tại trên
  -- database chạy trước đó, nên phải kiểm tra từng cái.
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'app_settings'
               and column_name = 'health_insurance_rate') then
    execute $sql$
      update public.payroll_settings p
      set health_insurance_rate = coalesce(s.health_insurance_rate, p.health_insurance_rate),
          unemployment_insurance_rate = coalesce(s.unemployment_insurance_rate, p.unemployment_insurance_rate),
          tax_dependent_deduction = coalesce(s.tax_dependent_deduction, p.tax_dependent_deduction),
          insurance_salary_cap = coalesce(s.insurance_salary_cap, p.insurance_salary_cap),
          unemployment_salary_cap = coalesce(s.unemployment_salary_cap, p.unemployment_salary_cap)
      from public.app_settings s
      where p.id
    $sql$;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'app_settings'
               and column_name = 'employer_social_rate') then
    execute $sql$
      update public.payroll_settings p
      set employer_social_rate = coalesce(s.employer_social_rate, p.employer_social_rate),
          employer_health_rate = coalesce(s.employer_health_rate, p.employer_health_rate),
          employer_unemployment_rate = coalesce(s.employer_unemployment_rate, p.employer_unemployment_rate)
      from public.app_settings s
      where p.id
    $sql$;
  end if;

  -- Bỏ khỏi app_settings sau khi đã chép. Để lại thì có hai nguồn sự thật cho
  -- cùng một con số — đúng cái vấn đề vừa đi sửa ở migration trước.
  alter table public.app_settings
    drop column if exists standard_work_days,
    drop column if exists social_insurance_rate,
    drop column if exists health_insurance_rate,
    drop column if exists unemployment_insurance_rate,
    drop column if exists employer_social_rate,
    drop column if exists employer_health_rate,
    drop column if exists employer_unemployment_rate,
    drop column if exists insurance_salary_cap,
    drop column if exists unemployment_salary_cap,
    drop column if exists tax_personal_deduction,
    drop column if exists tax_dependent_deduction;
end;
$do$;

create or replace function public.touch_payroll_settings()
returns trigger language plpgsql set search_path = public as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

drop trigger if exists payroll_settings_touch on public.payroll_settings;
create trigger payroll_settings_touch
before update on public.payroll_settings
for each row execute function public.touch_payroll_settings();

-- ---------------------------------------------------------------------------
-- RLS: ĐỌC mở cho mọi người đăng nhập, GHI chỉ Admin/CEO.
-- ---------------------------------------------------------------------------
-- Đọc phải mở vì phiếu lương tạm tính của nhân viên cần ngày công chuẩn và tỷ
-- lệ khấu trừ để tự tính. Những con số này là quy định chung, không phải bí
-- mật — cái cần giấu là lương của từng người, và việc đó do RLS trên
-- `payslips`/`employee_pay_profiles` lo.
--
-- Ghi thì khác hẳn: `is_admin()` chứ KHÔNG phải `can('settings')`, để khớp với
-- quyền vào trang Bảng lương.
alter table public.payroll_settings enable row level security;

drop policy if exists payroll_settings_read on public.payroll_settings;
create policy payroll_settings_read on public.payroll_settings
for select to authenticated using (true);

drop policy if exists payroll_settings_manage on public.payroll_settings;
create policy payroll_settings_manage on public.payroll_settings
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

grant select, insert, update on public.payroll_settings to authenticated;

comment on table public.payroll_settings is
  'Tham số tính lương. Tách khỏi app_settings vì chỉ Admin/CEO được sửa, trong khi app_settings mở cho quyền lẻ `settings`.';
