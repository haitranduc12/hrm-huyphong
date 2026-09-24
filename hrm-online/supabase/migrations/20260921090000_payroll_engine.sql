-- ============================================================================
-- Bộ máy tính lương theo thành phần (pay components).
-- ----------------------------------------------------------------------------
-- Trước đây mỗi nhân sự chỉ có đúng hai con số trong `salary_profiles`
-- (base_salary, allowance) và TẤT CẢ đi qua một công thức cứng viết thẳng
-- trong AdminPayroll.tsx. Thực tế mỗi người một kiểu: người ăn lương tháng,
-- người tính theo giờ, người khoán sản phẩm, sales ăn hoa hồng theo doanh số.
-- Không có chỗ nào diễn đạt được những khác biệt đó.
--
-- Mô hình ở đây theo cách các hệ thống lương quốc tế làm (Odoo Salary Rules,
-- Gusto/Deel earning codes, SAP wage types):
--
--   payroll_components    Danh mục khoản lương của công ty — định nghĩa CÁCH
--                         tính một khoản (cố định, theo giờ, theo sản phẩm,
--                         % của khoản khác, hoặc biểu thức tự do).
--   employee_pay_profiles Cơ chế lương của từng người, CÓ NGÀY HIỆU LỰC. Tăng
--                         lương là thêm bản ghi mới chứ không ghi đè lịch sử.
--   employee_pay_items    Khoản nào áp cho ai, giá trị riêng của người đó.
--   payroll_inputs        Số liệu biến động theo tháng: giờ tăng ca, sản lượng,
--                         doanh số. Cái mà công thức lấy làm biến đầu vào.
--   payroll_runs          Kỳ chạy lương: DRAFT -> CALCULATED -> APPROVED -> PAID.
--   payslips/_lines       Phiếu lương ĐÓNG BĂNG. Đây là điểm khác quan trọng
--                         nhất so với bản cũ: bảng lương cũ tính lại từ đầu
--                         mỗi lần mở trang, nên sửa cấu hình hôm nay làm đổi
--                         luôn lương tháng trước đã trả. Giờ chốt kỳ là ghi
--                         từng dòng tiền xuống database, không tính lại nữa.
--
-- Thuế TNCN, bảo hiểm bắt buộc và lương gốc theo cơ chế do engine tự tính
-- (luật định, cần logic riêng); components lo phần còn lại.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Sửa lỗi gõ sai tên cột khiến RPC luôn ném lỗi.
--    `month_stazrt` không tồn tại -> mọi nhân viên đều thấy "hệ thống chưa bật
--    quản lý kỳ công" dù kỳ đã khóa.
-- ---------------------------------------------------------------------------
create or replace function public.get_payroll_period_status(target_month date)
returns text
language sql
stable
security definer
set search_path = public
as $fn$
  select p.status
  from public.timesheet_periods p
  where p.month_start = date_trunc('month', target_month)::date
  limit 1;
$fn$;

revoke all on function public.get_payroll_period_status(date) from public;
grant execute on function public.get_payroll_period_status(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Danh mục thành phần lương
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_components (
  id uuid primary key default gen_random_uuid(),
  -- Mã dùng làm BIẾN trong biểu thức của khoản khác, nên phải viết hoa không dấu.
  code text not null unique check (code ~ '^[A-Z][A-Z0-9_]*$'),
  name text not null,
  kind text not null check (kind in ('EARNING', 'DEDUCTION', 'EMPLOYER_COST')),
  calc_type text not null check (calc_type in (
    'FIXED',      -- số tiền cố định mỗi tháng
    'PER_DAY',    -- đơn giá x số ngày công hưởng lương
    'PER_HOUR',   -- đơn giá x số giờ lấy từ payroll_inputs
    'PER_UNIT',   -- đơn giá x sản lượng lấy từ payroll_inputs
    'PERCENT',    -- tỷ lệ % x giá trị của base_code
    'FORMULA'     -- biểu thức tự do, xem client/src/lib/payroll.ts
  )),
  -- Giá trị mặc định cho cả công ty; từng người ghi đè ở employee_pay_items.
  default_amount numeric(15, 2) not null default 0 check (default_amount >= 0),
  -- Với PER_HOUR/PER_UNIT: lấy số lượng từ payroll_inputs.code = input_code.
  input_code text check (input_code is null or input_code ~ '^[A-Z][A-Z0-9_]*$'),
  -- Với PERCENT: lấy % trên giá trị của mã này (BASE, GROSS hoặc code khác).
  base_code text,
  formula text,
  -- Tính vào thu nhập chịu thuế TNCN. Tiền ăn ca trong mức miễn thì tắt.
  taxable boolean not null default true,
  -- Tính vào tiền lương làm căn cứ đóng bảo hiểm bắt buộc.
  insurable boolean not null default false,
  -- Chia theo tỷ lệ ngày công thực tế thay vì trả trọn tháng.
  prorate boolean not null default false,
  -- Thứ tự tính. Khoản PERCENT/FORMULA chỉ thấy được khoản có số nhỏ hơn.
  sort_order integer not null default 100,
  is_active boolean not null default true,
  -- Khoản hệ thống sinh sẵn: sửa được giá trị nhưng không xóa được.
  is_system boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_component_percent_needs_base
    check (calc_type <> 'PERCENT' or base_code is not null),
  constraint payroll_component_formula_needs_expression
    check (calc_type <> 'FORMULA' or nullif(trim(formula), '') is not null),
  constraint payroll_component_quantity_needs_input
    check (calc_type not in ('PER_HOUR', 'PER_UNIT') or input_code is not null)
);

create index if not exists payroll_components_active_idx
  on public.payroll_components(is_active, sort_order);

-- ---------------------------------------------------------------------------
-- 2. Cơ chế lương từng người, có ngày hiệu lực
-- ---------------------------------------------------------------------------
create table if not exists public.employee_pay_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- Bản ghi áp dụng từ ngày này. Kỳ lương lấy bản mới nhất <= cuối tháng.
  effective_from date not null,
  pay_basis text not null default 'MONTHLY' check (pay_basis in (
    'MONTHLY',    -- lương tháng chia theo ngày công chuẩn
    'HOURLY',     -- đơn giá giờ x giờ làm thực tế từ chấm công
    'DAILY',      -- đơn giá ngày x ngày công
    'PIECE',      -- khoán: chỉ ăn theo sản lượng, không có lương cứng
    'COMMISSION'  -- lương cứng thấp + hoa hồng doanh số
  )),
  -- Nghĩa thay đổi theo pay_basis: lương tháng / đơn giá giờ / đơn giá ngày.
  base_amount numeric(15, 2) not null default 0 check (base_amount >= 0),
  -- Mức lương đóng bảo hiểm nếu khác lương thực tế. NULL = dùng base_amount.
  insurance_base numeric(15, 2) check (insurance_base is null or insurance_base >= 0),
  -- Không đóng bảo hiểm: thử việc, cộng tác viên, hợp đồng dưới 1 tháng.
  insurance_enabled boolean not null default true,
  -- Số người phụ thuộc đã đăng ký giảm trừ gia cảnh.
  dependents integer not null default 0 check (dependents >= 0),
  tax_mode text not null default 'PROGRESSIVE' check (tax_mode in (
    'PROGRESSIVE', -- biểu thuế lũy tiến 7 bậc, cho hợp đồng từ 3 tháng
    'FLAT',        -- khấu trừ thẳng một tỷ lệ (thời vụ dưới 3 tháng: 10%)
    'NONE'         -- không khấu trừ tại nguồn
  )),
  flat_tax_rate numeric(5, 2) not null default 10
    check (flat_tax_rate >= 0 and flat_tax_rate <= 100),
  -- Ngày công chuẩn riêng của người này. NULL = theo cấu hình công ty.
  standard_days_override numeric(5, 2)
    check (standard_days_override is null or standard_days_override > 0),
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, effective_from)
);

create index if not exists employee_pay_profiles_user_idx
  on public.employee_pay_profiles(user_id, effective_from desc);

-- ---------------------------------------------------------------------------
-- 3. Khoản lương gán riêng cho từng người
-- ---------------------------------------------------------------------------
create table if not exists public.employee_pay_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  component_id uuid not null references public.payroll_components(id) on delete cascade,
  -- Ghi đè giá trị mặc định của khoản. NULL = dùng default_amount.
  amount numeric(15, 2) check (amount is null or amount >= 0),
  -- Ghi đè biểu thức riêng cho người này: cùng một khoản, cách tính khác.
  formula text,
  effective_from date not null,
  -- NULL = còn hiệu lực. Có giá trị = hết hiệu lực sau ngày này.
  effective_to date,
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_pay_item_valid_range
    check (effective_to is null or effective_to >= effective_from)
);

create index if not exists employee_pay_items_user_idx
  on public.employee_pay_items(user_id, effective_from desc);
create index if not exists employee_pay_items_component_idx
  on public.employee_pay_items(component_id);

-- ---------------------------------------------------------------------------
-- 4. Số liệu biến động theo tháng
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_inputs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  month_start date not null,
  -- Khớp với payroll_components.input_code, và là biến trong biểu thức.
  code text not null check (code ~ '^[A-Z][A-Z0-9_]*$'),
  quantity numeric(15, 2) not null default 0,
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, month_start, code),
  check (month_start = date_trunc('month', month_start)::date)
);

create index if not exists payroll_inputs_month_idx
  on public.payroll_inputs(month_start);

-- ---------------------------------------------------------------------------
-- 5. Kỳ chạy lương
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  month_start date not null unique,
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'CALCULATED', 'APPROVED', 'PAID')),
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  calculated_at timestamptz,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (month_start = date_trunc('month', month_start)::date)
);

-- ---------------------------------------------------------------------------
-- 6. Phiếu lương đóng băng
-- ---------------------------------------------------------------------------
create table if not exists public.payslips (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.payroll_runs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- Chép lại tên/mã tại thời điểm chốt: người nghỉ việc vẫn tra cứu được.
  employee_name text not null,
  employee_code text,
  department text,
  pay_basis text not null,
  work_days numeric(6, 2) not null default 0,
  leave_days numeric(6, 2) not null default 0,
  paid_days numeric(6, 2) not null default 0,
  standard_days numeric(6, 2) not null default 0,
  work_hours numeric(8, 2) not null default 0,
  gross_pay numeric(15, 2) not null default 0,
  taxable_income numeric(15, 2) not null default 0,
  insurance_employee numeric(15, 2) not null default 0,
  insurance_employer numeric(15, 2) not null default 0,
  personal_income_tax numeric(15, 2) not null default 0,
  other_deductions numeric(15, 2) not null default 0,
  net_pay numeric(15, 2) not null default 0,
  -- Ảnh chụp tham số đã dùng: thuế suất, ngày công chuẩn, người phụ thuộc...
  snapshot jsonb not null default '{}'::jsonb,
  note text,
  created_at timestamptz not null default now(),
  unique (run_id, user_id)
);

create index if not exists payslips_user_idx on public.payslips(user_id);

create table if not exists public.payslip_lines (
  id uuid primary key default gen_random_uuid(),
  payslip_id uuid not null references public.payslips(id) on delete cascade,
  sequence integer not null default 0,
  code text not null,
  name text not null,
  kind text not null check (kind in ('EARNING', 'DEDUCTION', 'EMPLOYER_COST')),
  -- Số lượng và đơn giá giữ lại để phiếu tự giải thích được con số.
  quantity numeric(15, 2),
  rate numeric(15, 2),
  amount numeric(15, 2) not null default 0,
  taxable boolean not null default true,
  insurable boolean not null default false,
  detail text
);

create index if not exists payslip_lines_payslip_idx
  on public.payslip_lines(payslip_id, sequence);

-- ---------------------------------------------------------------------------
-- 7. Trigger updated_at dùng chung
-- ---------------------------------------------------------------------------
create or replace function public.touch_payroll_updated_at()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

do $do$
declare
  t text;
begin
  foreach t in array array[
    'payroll_components', 'employee_pay_profiles', 'employee_pay_items',
    'payroll_inputs', 'payroll_runs'
  ] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format(
      'create trigger %I_touch before update on public.%I
       for each row execute function public.touch_payroll_updated_at()', t, t);
  end loop;
end;
$do$;

-- ---------------------------------------------------------------------------
-- 8. Phiếu lương đã duyệt thì bất biến.
--    Chốt lương xong mà vẫn sửa được từng dòng tiền thì việc đóng băng vô
--    nghĩa. Muốn sửa phải mở lại kỳ (APPROVED -> DRAFT) một cách có chủ đích.
-- ---------------------------------------------------------------------------
create or replace function public.guard_payslip_immutable()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  run_status text;
  target_run uuid;
  slip_id uuid;
begin
  -- Trên DELETE thì NEW chưa được gán, trên INSERT thì OLD chưa được gán.
  -- Đụng vào trường của bản ghi chưa gán là lỗi runtime, nên phải rẽ theo
  -- TG_OP chứ không gộp bằng coalesce(new.x, old.x).
  if tg_table_name = 'payslips' then
    if tg_op = 'DELETE' then
      target_run := old.run_id;
    else
      target_run := new.run_id;
    end if;
  else
    if tg_op = 'DELETE' then
      slip_id := old.payslip_id;
    else
      slip_id := new.payslip_id;
    end if;
    select p.run_id into target_run from public.payslips p where p.id = slip_id;
  end if;

  select r.status into run_status from public.payroll_runs r where r.id = target_run;

  if run_status in ('APPROVED', 'PAID') then
    raise exception 'Kỳ lương đã duyệt, không sửa được phiếu. Mở lại kỳ trước khi tính lại.'
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$fn$;

drop trigger if exists payslips_immutable on public.payslips;
create trigger payslips_immutable
before insert or update or delete on public.payslips
for each row execute function public.guard_payslip_immutable();

drop trigger if exists payslip_lines_immutable on public.payslip_lines;
create trigger payslip_lines_immutable
before insert or update or delete on public.payslip_lines
for each row execute function public.guard_payslip_immutable();

-- ---------------------------------------------------------------------------
-- 9. Chuyển trạng thái kỳ lương phải đi đúng đường
-- ---------------------------------------------------------------------------
create or replace function public.guard_payroll_run_status()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if not (
      (old.status = 'DRAFT' and new.status = 'CALCULATED')
      or (old.status = 'CALCULATED' and new.status in ('DRAFT', 'APPROVED'))
      or (old.status = 'APPROVED' and new.status in ('DRAFT', 'PAID'))
      or (old.status = 'PAID' and new.status = 'DRAFT')
    ) then
      raise exception 'Chuyển trạng thái kỳ lương không hợp lệ (% -> %).', old.status, new.status
        using errcode = '23514';
    end if;

    -- Duyệt lương trước khi chốt công thì số liệu còn chạy dưới chân.
    if new.status = 'APPROVED' and not exists (
      select 1 from public.timesheet_periods p
      where p.month_start = new.month_start and p.status = 'LOCKED'
    ) then
      raise exception 'Chưa khóa kỳ công tháng %, không duyệt được bảng lương.', new.month_start
        using errcode = '23514';
    end if;

    new.calculated_at := case when new.status = 'CALCULATED' then now() else new.calculated_at end;
    new.approved_at := case when new.status = 'APPROVED' then now()
                            when new.status = 'DRAFT' then null
                            else new.approved_at end;
    new.approved_by := case when new.status = 'DRAFT' then null else new.approved_by end;
    new.paid_at := case when new.status = 'PAID' then now()
                        when new.status = 'DRAFT' then null
                        else new.paid_at end;
  end if;

  return new;
end;
$fn$;

drop trigger if exists payroll_runs_status_guard on public.payroll_runs;
create trigger payroll_runs_status_guard
before update on public.payroll_runs
for each row execute function public.guard_payroll_run_status();

-- ---------------------------------------------------------------------------
-- 10. RLS. Lương là dữ liệu nhạy cảm nhất trong hệ thống.
--     Admin/CEO quản lý; nhân viên chỉ đọc phiếu CỦA MÌNH và chỉ sau khi duyệt
--     (tránh việc nhân viên thấy bản nháp rồi thắc mắc về con số chưa chốt).
-- ---------------------------------------------------------------------------
alter table public.payroll_components enable row level security;
alter table public.employee_pay_profiles enable row level security;
alter table public.employee_pay_items enable row level security;
alter table public.payroll_inputs enable row level security;
alter table public.payroll_runs enable row level security;
alter table public.payslips enable row level security;
alter table public.payslip_lines enable row level security;

drop policy if exists payroll_components_read on public.payroll_components;
create policy payroll_components_read on public.payroll_components
for select to authenticated using (public.is_admin());

drop policy if exists payroll_components_manage on public.payroll_components;
create policy payroll_components_manage on public.payroll_components
for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists employee_pay_profiles_read on public.employee_pay_profiles;
create policy employee_pay_profiles_read on public.employee_pay_profiles
for select to authenticated using (user_id = auth.uid() or public.is_admin());

drop policy if exists employee_pay_profiles_manage on public.employee_pay_profiles;
create policy employee_pay_profiles_manage on public.employee_pay_profiles
for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists employee_pay_items_read on public.employee_pay_items;
create policy employee_pay_items_read on public.employee_pay_items
for select to authenticated using (user_id = auth.uid() or public.is_admin());

drop policy if exists employee_pay_items_manage on public.employee_pay_items;
create policy employee_pay_items_manage on public.employee_pay_items
for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists payroll_inputs_read on public.payroll_inputs;
create policy payroll_inputs_read on public.payroll_inputs
for select to authenticated using (user_id = auth.uid() or public.is_admin());

drop policy if exists payroll_inputs_manage on public.payroll_inputs;
create policy payroll_inputs_manage on public.payroll_inputs
for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists payroll_runs_read on public.payroll_runs;
create policy payroll_runs_read on public.payroll_runs
for select to authenticated using (public.is_admin());

drop policy if exists payroll_runs_manage on public.payroll_runs;
create policy payroll_runs_manage on public.payroll_runs
for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists payslips_read on public.payslips;
create policy payslips_read on public.payslips
for select to authenticated using (
  public.is_admin()
  or (
    user_id = auth.uid()
    and exists (
      select 1 from public.payroll_runs r
      where r.id = payslips.run_id and r.status in ('APPROVED', 'PAID')
    )
  )
);

drop policy if exists payslips_manage on public.payslips;
create policy payslips_manage on public.payslips
for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists payslip_lines_read on public.payslip_lines;
create policy payslip_lines_read on public.payslip_lines
for select to authenticated using (
  exists (
    select 1 from public.payslips s
    join public.payroll_runs r on r.id = s.run_id
    where s.id = payslip_lines.payslip_id
      and (public.is_admin() or (s.user_id = auth.uid() and r.status in ('APPROVED', 'PAID')))
  )
);

drop policy if exists payslip_lines_manage on public.payslip_lines;
create policy payslip_lines_manage on public.payslip_lines
for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.payroll_components to authenticated;
grant select, insert, update, delete on public.employee_pay_profiles to authenticated;
grant select, insert, update, delete on public.employee_pay_items to authenticated;
grant select, insert, update, delete on public.payroll_inputs to authenticated;
grant select, insert, update, delete on public.payroll_runs to authenticated;
grant select, insert, update, delete on public.payslips to authenticated;
grant select, insert, update, delete on public.payslip_lines to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Seed danh mục khoản lương theo thực tiễn Việt Nam.
--     Đây là điểm khởi đầu để HR sửa, không phải danh sách bắt buộc.
--     sort_order quyết định thứ tự tính: khoản PERCENT/FORMULA chỉ đọc được
--     giá trị của khoản có sort_order nhỏ hơn nó.
-- ---------------------------------------------------------------------------
insert into public.payroll_components
  (code, name, kind, calc_type, default_amount, input_code, base_code, formula,
   taxable, insurable, prorate, sort_order, is_system, note)
values
  -- Phụ cấp cố định ------------------------------------------------------
  ('ALLOW_POSITION', 'Phụ cấp chức vụ', 'EARNING', 'FIXED', 0,
   null, null, null, true, true, true, 110, true,
   'Trả theo chức danh, chia theo ngày công thực tế.'),
  ('ALLOW_MEAL', 'Tiền ăn ca', 'EARNING', 'FIXED', 730000,
   null, null, null, false, false, true, 120, true,
   'Miễn thuế TNCN tới 730.000đ/tháng theo Thông tư 26/2016/TT-BLDTBXH.'),
  ('ALLOW_FUEL', 'Phụ cấp xăng xe, đi lại', 'EARNING', 'FIXED', 0,
   null, null, null, true, false, true, 130, true, null),
  ('ALLOW_PHONE', 'Phụ cấp điện thoại', 'EARNING', 'FIXED', 0,
   null, null, null, true, false, false, 140, true,
   'Trả trọn tháng, không chia theo ngày công.'),
  ('ALLOW_ATTENDANCE', 'Thưởng chuyên cần', 'EARNING', 'FIXED', 0,
   null, null, null, true, false, false, 150, true,
   'Thường gắn điều kiện đi đủ công, HR tự tắt khi người đó nghỉ quá quy định.'),

  -- Làm thêm giờ. Tỷ lệ theo Điều 98 Bộ luật Lao động 2019 -----------------
  ('OT_WEEKDAY', 'Tăng ca ngày thường (150%)', 'EARNING', 'FORMULA', 0,
   'OT_WEEKDAY_HOURS', null, 'HOURLY_RATE * 1.5 * OT_WEEKDAY_HOURS',
   true, false, false, 210, true,
   'Đơn giá giờ x 150% x số giờ. Nhập số giờ ở tab Số liệu tháng.'),
  ('OT_WEEKEND', 'Tăng ca ngày nghỉ (200%)', 'EARNING', 'FORMULA', 0,
   'OT_WEEKEND_HOURS', null, 'HOURLY_RATE * 2 * OT_WEEKEND_HOURS',
   true, false, false, 220, true, null),
  ('OT_HOLIDAY', 'Tăng ca ngày lễ (300%)', 'EARNING', 'FORMULA', 0,
   'OT_HOLIDAY_HOURS', null, 'HOURLY_RATE * 3 * OT_HOLIDAY_HOURS',
   true, false, false, 230, true, null),
  ('NIGHT_SHIFT', 'Phụ cấp ca đêm (30%)', 'EARNING', 'FORMULA', 0,
   'NIGHT_HOURS', null, 'HOURLY_RATE * 0.3 * NIGHT_HOURS',
   true, false, false, 240, true,
   'Cộng thêm 30% đơn giá giờ cho giờ làm ban đêm, Điều 98.2.'),

  -- Khoán sản phẩm và hoa hồng ---------------------------------------------
  ('PIECE_RATE', 'Lương khoán sản phẩm', 'EARNING', 'PER_UNIT', 0,
   'UNITS', null, null, true, false, false, 310, true,
   'Đơn giá x sản lượng nghiệm thu trong tháng.'),
  ('COMMISSION', 'Hoa hồng doanh số', 'EARNING', 'PERCENT', 3,
   null, 'REVENUE', null, true, false, false, 320, true,
   'Phần trăm trên doanh số cá nhân nhập ở tab Số liệu tháng.'),
  ('BONUS_KPI', 'Thưởng KPI', 'EARNING', 'FIXED', 0,
   null, null, null, true, false, false, 330, true, null),

  -- Khấu trừ ngoài luật định ------------------------------------------------
  ('UNION_FEE', 'Đoàn phí công đoàn', 'DEDUCTION', 'PERCENT', 1,
   null, 'INSURANCE_BASE', null, false, false, false, 610, true,
   'Tối đa 10% mức lương cơ sở theo Điều lệ Công đoàn.'),
  ('ADVANCE', 'Tạm ứng đã nhận', 'DEDUCTION', 'FIXED', 0,
   null, null, null, false, false, false, 620, true,
   'Trừ vào lương cuối tháng.'),
  ('PENALTY', 'Khấu trừ khác', 'DEDUCTION', 'FIXED', 0,
   null, null, null, false, false, false, 630, true, null),

  -- Chi phí doanh nghiệp. Không trừ vào lương, chỉ để biết tổng chi phí nhân sự.
  ('ER_SOCIAL', 'BHXH doanh nghiệp đóng (17,5%)', 'EMPLOYER_COST', 'PERCENT', 17.5,
   null, 'INSURANCE_BASE', null, false, false, false, 710, true, null),
  ('ER_HEALTH', 'BHYT doanh nghiệp đóng (3%)', 'EMPLOYER_COST', 'PERCENT', 3,
   null, 'INSURANCE_BASE', null, false, false, false, 720, true, null),
  ('ER_UNEMPLOY', 'BHTN doanh nghiệp đóng (1%)', 'EMPLOYER_COST', 'PERCENT', 1,
   null, 'INSURANCE_BASE', null, false, false, false, 730, true, null)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 12. Chuyển dữ liệu lương cũ sang cơ chế mới.
--     Mọi người đang ở salary_profiles đều là lương tháng; phụ cấp gộp một cục
--     đổ vào ALLOW_POSITION để không mất tiền của ai trong lúc chuyển.
--     Bảng salary_profiles GIỮ NGUYÊN, không xóa: còn là bản đối chiếu nếu số
--     liệu mới lệch.
-- ---------------------------------------------------------------------------
insert into public.employee_pay_profiles
  (user_id, effective_from, pay_basis, base_amount, dependents, note, created_by)
select
  s.user_id,
  date_trunc('month', coalesce(s.updated_at, now()))::date,
  'MONTHLY',
  s.base_salary,
  0,
  coalesce(s.note, 'Chuyển tự động từ hồ sơ lương cũ.'),
  s.updated_by
from public.salary_profiles s
on conflict (user_id, effective_from) do nothing;

insert into public.employee_pay_items
  (user_id, component_id, amount, effective_from, note, created_by)
select
  s.user_id,
  c.id,
  s.allowance,
  date_trunc('month', coalesce(s.updated_at, now()))::date,
  'Phụ cấp gộp chuyển từ hồ sơ lương cũ, HR tách lại theo từng khoản.',
  s.updated_by
from public.salary_profiles s
cross join public.payroll_components c
where c.code = 'ALLOW_POSITION'
  and s.allowance > 0
  and not exists (
    select 1 from public.employee_pay_items i
    where i.user_id = s.user_id and i.component_id = c.id
  );

-- ---------------------------------------------------------------------------
-- 13. Tham số luật định còn thiếu trong cấu hình chung.
--     Bản cũ chỉ có `social_insurance_rate` 8% và gọi đó là "bảo hiểm", nên
--     nhân viên bị trừ thiếu 2,5% (BHYT 1,5% + BHTN 1%). Thiếu cả giảm trừ
--     người phụ thuộc và trần tiền lương đóng bảo hiểm.
-- ---------------------------------------------------------------------------
-- `app_settings` không được tạo bởi migration nào trong repo này — nó đến từ
-- schema nền, và trên database đang chạy thì bảng đó KHÔNG tồn tại. Hệ quả:
-- mọi cấu hình chung (tên công ty, ngày công chuẩn, tỷ lệ bảo hiểm) luôn rơi
-- về mặc định trong code và trang Cấu hình không lưu được gì.
--
-- Tạo lại ở đây theo đúng những cột mà `client/src/lib/settings.ts` đọc và
-- ghi, vì bộ máy lương lấy tham số thuế và bảo hiểm từ chính bảng này — không
-- có nó thì HR không đổi được thuế suất khi luật thay đổi.
create table if not exists public.app_settings (
  -- Bảng một dòng: khoá chính boolean luôn bằng true nên không thể chèn dòng
  -- thứ hai. Nhờ vậy mọi truy vấn ở tầng client không cần điều kiện lọc.
  id boolean primary key default true check (id),
  org_name text,
  contact_email text,
  phone text,
  require_task_approval boolean not null default true,
  auto_notify boolean not null default true,
  standard_work_days numeric(5, 2) not null default 26,
  standard_hours_per_day numeric(5, 2) not null default 8,
  default_annual_leave numeric(5, 2) not null default 12,
  social_insurance_rate numeric(5, 2) not null default 8,
  tax_personal_deduction numeric(15, 2) not null default 11000000,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.app_settings(id) values (true) on conflict (id) do nothing;

alter table public.app_settings enable row level security;

-- Ai cũng cần đọc cấu hình (ngày công chuẩn hiện ở phiếu lương nhân viên),
-- nhưng chỉ người có quyền `settings` mới được sửa.
drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings
for select to authenticated using (true);

drop policy if exists app_settings_manage on public.app_settings;
create policy app_settings_manage on public.app_settings
for all to authenticated
using (public.can('settings')) with check (public.can('settings'));

grant select, insert, update on public.app_settings to authenticated;

-- Vẫn bọc ALTER trong điều kiện: nếu vì lý do nào đó bảng không tạo được
-- (quyền, schema khác), cả migration lương không nên đổ vỡ theo.
do $do$
begin
  if to_regclass('public.app_settings') is not null then
    alter table public.app_settings
      add column if not exists health_insurance_rate numeric(5, 2) not null default 1.5,
      add column if not exists unemployment_insurance_rate numeric(5, 2) not null default 1,
      add column if not exists tax_dependent_deduction numeric(15, 2) not null default 4400000,
      -- Trần đóng BHXH/BHYT: 20 lần mức lương cơ sở (2.340.000 x 20).
      add column if not exists insurance_salary_cap numeric(15, 2) not null default 46800000,
      -- Trần đóng BHTN: 20 lần lương tối thiểu vùng (vùng I 4.960.000 x 20).
      add column if not exists unemployment_salary_cap numeric(15, 2) not null default 99200000,
      -- Giờ làm chuẩn mỗi ngày dùng để quy đổi đơn giá giờ cho lương tháng.
      add column if not exists payroll_hours_per_day numeric(5, 2) not null default 8;
  else
    raise notice 'Bỏ qua app_settings: bảng chưa tồn tại. Tham số lương sẽ dùng mặc định.';
  end if;
end;
$do$;

comment on table public.payroll_components is
  'Danh mục khoản lương: định nghĩa cách tính, không gắn với người cụ thể.';
comment on table public.employee_pay_profiles is
  'Cơ chế lương từng người theo ngày hiệu lực. Tăng lương = thêm dòng mới.';
comment on table public.payslips is
  'Phiếu lương đã đóng băng. Không tính lại, kể cả khi cấu hình thay đổi.';
