-- ============================================================================
-- Gán khoản lương theo ĐƠN VỊ, và dọn luồng lương cũ.
-- ----------------------------------------------------------------------------
-- Trước migration này, khoản lương chỉ gán được cho TỪNG NGƯỜI
-- (`employee_pay_items`). Một phòng 30 người cùng hưởng phụ cấp xăng xe và
-- tiền ăn ca thì phải gán 60 lần, và mỗi người mới vào lại phải nhớ gán lại —
-- quên một người là người đó thiếu tiền mà không ai thấy.
--
-- Mô hình mới, đúng như cách người dùng mô tả: danh mục khoản khai một lần,
-- rồi ĐƠN VỊ chọn những khoản áp cho cả đơn vị, còn từng người chỉ khai phần
-- riêng của mình.
--
--   payroll_components   danh mục — định nghĩa CÁCH tính
--   unit_pay_items       đơn vị chọn khoản → mọi người trong đơn vị thừa hưởng
--   employee_pay_items   người chọn khoản riêng → GHI ĐÈ khoản cùng mã của đơn vị
--
-- Quy tắc ghi đè cố ý đơn giản: cùng một khoản, bản của người thắng bản của
-- đơn vị. Không cộng dồn hai bản — cộng dồn nghĩa là một người vừa hưởng phụ
-- cấp mức chung vừa hưởng mức riêng, gần như luôn là sai.
--
-- KHÔNG kế thừa xuống cây đơn vị con. Cơ cấu hiện tại của khách phẳng, và
-- kế thừa ngầm qua nhiều cấp là thứ rất khó giải thích khi con số ra sai.
-- Muốn áp cho nhiều đơn vị thì gán cho từng đơn vị — tường minh.
-- ============================================================================

create table if not exists public.unit_pay_items (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.organization_units(id) on delete cascade,
  component_id uuid not null references public.payroll_components(id) on delete cascade,

  /* Ghi đè giá trị mặc định của khoản cho riêng đơn vị này. NULL = dùng
     default_amount trong danh mục. */
  amount numeric(15, 2) check (amount is null or amount >= 0),

  /* Công thức riêng của đơn vị, nếu cách tính khác mặt bằng chung. */
  formula text,

  effective_from date not null,
  effective_to date,
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint unit_pay_item_valid_range
    check (effective_to is null or effective_to >= effective_from),
  /* Một đơn vị không gán hai lần cùng một khoản cho cùng ngày hiệu lực —
     nếu không thì không xác định được bản nào thắng. */
  unique (unit_id, component_id, effective_from)
);

create index if not exists unit_pay_items_unit_idx
  on public.unit_pay_items(unit_id, effective_from desc);
create index if not exists unit_pay_items_component_idx
  on public.unit_pay_items(component_id);

drop trigger if exists unit_pay_items_touch on public.unit_pay_items;
create trigger unit_pay_items_touch
before update on public.unit_pay_items
for each row execute function public.touch_payroll_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — cùng ranh giới với khoản gán theo người
-- ---------------------------------------------------------------------------
-- Đọc mở cho người đăng nhập: khoản của đơn vị hiện trên phiếu lương của
-- chính họ, nên họ phải tra được. Giá trị tiền cụ thể của từng người vẫn nằm
-- sau RLS của `payslips` và `employee_pay_profiles`.
alter table public.unit_pay_items enable row level security;

drop policy if exists unit_pay_items_read on public.unit_pay_items;
create policy unit_pay_items_read on public.unit_pay_items
for select to authenticated using (true);

drop policy if exists unit_pay_items_manage on public.unit_pay_items;
create policy unit_pay_items_manage on public.unit_pay_items
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.unit_pay_items to authenticated;

comment on table public.unit_pay_items is
  'Khoản lương áp cho cả đơn vị. Người trong đơn vị thừa hưởng; bản gán riêng ở employee_pay_items ghi đè khoản cùng mã.';
comment on column public.unit_pay_items.amount is
  'Mức riêng của đơn vị. NULL = lấy default_amount trong danh mục khoản.';

-- ---------------------------------------------------------------------------
-- Dọn luồng lương cũ
-- ---------------------------------------------------------------------------
-- `salary_profiles` là mô hình lương đời đầu: mỗi người đúng HAI con số
-- (base_salary, allowance) chạy qua một công thức cứng. Nó đã được thay hoàn
-- toàn bởi `employee_pay_profiles` + `employee_pay_items` từ migration
-- 20260921090000, và chính migration đó đã CHÉP toàn bộ dữ liệu sang.
--
-- Từ đó tới nay không dòng code nào đọc bảng này nữa. Giữ lại chỉ tạo ra một
-- nguồn số liệu thứ hai trông như thật nhưng đã đứng im — đúng loại bẫy mà
-- người vào sau sẽ mất thời gian đối chiếu.
drop table if exists public.salary_profiles;
