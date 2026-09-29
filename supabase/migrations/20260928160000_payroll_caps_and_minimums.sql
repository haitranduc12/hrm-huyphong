-- ============================================================================
-- Trần cho khoản lương, mức lương cơ sở / tối thiểu vùng, và biểu thuế sửa được.
-- ----------------------------------------------------------------------------
-- Migration này sửa HAI chỗ đang tính ra số sai, chứ không phải thêm tính năng.
--
--   1. Tiền ăn ca vượt mức miễn thuế vẫn được miễn toàn bộ.
--      ALLOW_MEAL đặt taxable = false cho CẢ khoản. Trả đúng 730.000đ thì
--      đúng, nhưng công ty nâng lên 1.000.000đ thì cả 1 triệu thoát thuế,
--      trong khi quy định chỉ miễn tới 730.000đ. Khấu trừ thiếu thuế TNCN.
--
--   2. Đoàn phí công đoàn không chặn trần.
--      UNION_FEE = 1% mức lương đóng bảo hiểm, không giới hạn. Ghi chú CÓ viết
--      "tối đa 10% mức lương cơ sở" nhưng chỉ là chữ, engine không đọc. Người
--      có mức đóng 46,8 triệu bị trừ 468.000đ/tháng thay vì tối đa 234.000đ.
--      Trừ thừa tiền của người lao động.
--
-- Cùng một nguyên nhân: `payroll_components` không có chỗ khai trần. Thêm hai
-- cột dưới đây sửa được cả hai, và sau này bất kỳ khoản nào có ngưỡng miễn
-- thuế theo quy định đều khai được mà không phải sửa code.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Trần trên từng khoản
-- ---------------------------------------------------------------------------
alter table public.payroll_components
  -- Phần vượt ngưỡng này VẪN chịu thuế TNCN dù khoản được đánh taxable = false.
  -- NULL = không có ngưỡng, `taxable` quyết định toàn bộ như trước.
  add column if not exists tax_exempt_cap numeric(15, 2)
    check (tax_exempt_cap is null or tax_exempt_cap >= 0),
  -- Chặn trên số tiền của khoản, áp sau khi tính xong.
  -- NULL = không chặn.
  add column if not exists max_amount numeric(15, 2)
    check (max_amount is null or max_amount >= 0);

comment on column public.payroll_components.tax_exempt_cap is
  'Ngưỡng miễn thuế TNCN. Phần vượt ngưỡng vẫn chịu thuế dù taxable = false. NULL = không có ngưỡng.';
comment on column public.payroll_components.max_amount is
  'Trần số tiền của khoản, áp sau khi tính. NULL = không chặn.';

-- Tiền ăn ca: giữ miễn thuế, nhưng chỉ miễn tới ngưỡng.
update public.payroll_components
set tax_exempt_cap = 730000,
    note = 'Miễn thuế TNCN tới 730.000đ/tháng theo Thông tư 26/2016/TT-BLDTBXH. '
        || 'Phần trả vượt ngưỡng này tự động tính vào thu nhập chịu thuế.'
where code = 'ALLOW_MEAL' and tax_exempt_cap is null;

-- Đoàn phí công đoàn: 10% mức lương cơ sở 2.340.000đ = 234.000đ.
update public.payroll_components
set max_amount = 234000,
    note = 'CHỈ gán cho nhân viên LÀ ĐOÀN VIÊN công đoàn (đoàn phí 1% người lao động đóng) — '
        || 'không phải mọi nhân viên, khác kinh phí công đoàn 2% doanh nghiệp đóng. '
        || 'Trần 10% mức lương cơ sở theo Điều lệ Công đoàn.'
where code = 'UNION_FEE' and max_amount is null;

-- ---------------------------------------------------------------------------
-- 2. Mức lương cơ sở và lương tối thiểu vùng
-- ---------------------------------------------------------------------------
-- Hai cái trần đang khai (46,8 triệu và 99,2 triệu) thực ra là KẾT QUẢ của hai
-- con số này nhân 20. Không lưu gốc thì kế toán phải tự nhân tay, và hệ thống
-- không kiểm được mức đóng bảo hiểm có tụt dưới lương tối thiểu vùng không —
-- đây là lỗi hay bị bắt nhất khi thanh tra bảo hiểm xã hội.
alter table public.payroll_settings
  add column if not exists base_salary_level numeric(15, 2) not null default 2340000
    check (base_salary_level > 0),
  add column if not exists regional_minimum_wage numeric(15, 2) not null default 4960000
    check (regional_minimum_wage > 0),
  add column if not exists region_code text not null default 'I'
    check (region_code in ('I', 'II', 'III', 'IV'));

comment on column public.payroll_settings.base_salary_level is
  'Mức lương cơ sở. Trần đóng BHXH/BHYT = 20 lần số này; trần đoàn phí công đoàn = 10%.';
comment on column public.payroll_settings.regional_minimum_wage is
  'Lương tối thiểu vùng đang áp dụng. Trần đóng BHTN = 20 lần số này. Mức đóng bảo hiểm thấp hơn số này là sai quy định.';
comment on column public.payroll_settings.region_code is
  'Vùng lương tối thiểu I-IV, dùng để nhắc đúng mức khi kế toán đổi vùng.';

-- ---------------------------------------------------------------------------
-- 3. Biểu thuế lũy tiến khai được
-- ---------------------------------------------------------------------------
-- Trước đây bảy bậc nằm cứng trong code còn giảm trừ gia cảnh thì sửa được —
-- không nhất quán. Luật thuế thu nhập cá nhân đang trong quá trình sửa đổi;
-- nếu bậc thuế đổi thì kế toán phải chờ sửa code và deploy lại mới tính đúng.
create table if not exists public.pit_brackets (
  id uuid primary key default gen_random_uuid(),
  -- Bậc 1..n, dùng để sắp thứ tự và hiển thị.
  step integer not null unique check (step > 0),
  /* Cận trên của bậc, tính trên thu nhập TÍNH THUẾ mỗi tháng.
     NULL = bậc cuối, không có cận trên. */
  upper_bound numeric(15, 2) check (upper_bound is null or upper_bound > 0),
  rate numeric(5, 2) not null check (rate >= 0 and rate <= 100),
  updated_at timestamptz not null default now()
);

comment on table public.pit_brackets is
  'Biểu thuế lũy tiến từng phần. Bậc cuối để upper_bound = NULL.';

insert into public.pit_brackets (step, upper_bound, rate) values
  (1,  5000000,  5),
  (2,  10000000, 10),
  (3,  18000000, 15),
  (4,  32000000, 20),
  (5,  52000000, 25),
  (6,  80000000, 30),
  (7,  null,     35)
on conflict (step) do nothing;

alter table public.pit_brackets enable row level security;

-- Đọc mở cho người đăng nhập: phiếu lương của chính họ hiện diễn giải từng bậc
-- thuế, nên client phải tra được biểu.
drop policy if exists pit_brackets_read on public.pit_brackets;
create policy pit_brackets_read on public.pit_brackets
for select to authenticated using (true);

-- Sửa thì chỉ Admin/CEO, cùng ranh giới với tham số lương.
drop policy if exists pit_brackets_manage on public.pit_brackets;
create policy pit_brackets_manage on public.pit_brackets
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.pit_brackets to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Các khoản còn thiếu trong danh mục
-- ---------------------------------------------------------------------------
-- Khai sẵn để kế toán chọn thay vì phải tự nghĩ ra mã và cách tính. Tất cả để
-- default_amount = 0: có mặt trong danh mục không có nghĩa là ai cũng được
-- hưởng, phải gán cho đơn vị hoặc cho người mới thành tiền.
--
-- Cột `is_system` = false vì đây là khoản nghiệp vụ, công ty xoá được nếu
-- không dùng. Khác với khoản hệ thống sinh ra để engine tham chiếu.
insert into public.payroll_components
  (code, name, kind, calc_type, default_amount,
   input_code, base_code, formula, taxable, insurable, prorate, sort_order, is_active, note)
values
  -- Phụ cấp -----------------------------------------------------------------
  ('ALLOW_RESPONSIBILITY', 'Phụ cấp trách nhiệm', 'EARNING', 'FIXED', 0,
   null, null, null, true, true, true, 111, true,
   'Trả cho người kiêm nhiệm trách nhiệm ngoài chức danh. Tính vào lương đóng bảo hiểm.'),

  ('ALLOW_HAZARD', 'Phụ cấp độc hại, nguy hiểm', 'EARNING', 'FIXED', 0,
   null, null, null, true, true, true, 112, true,
   'Theo danh mục nghề nặng nhọc độc hại của Bộ LĐTBXH. Tính vào lương đóng bảo hiểm.'),

  ('ALLOW_SENIORITY', 'Phụ cấp thâm niên', 'EARNING', 'FIXED', 0,
   null, null, null, true, true, false, 113, true,
   'Trả trọn tháng theo số năm gắn bó, không chia theo ngày công.'),

  ('ALLOW_HOUSING', 'Phụ cấp nhà ở', 'EARNING', 'FIXED', 0,
   null, null, null, true, false, false, 114, true,
   'Chịu thuế TNCN. Không tính vào lương đóng bảo hiểm.'),

  -- Thưởng ------------------------------------------------------------------
  ('BONUS_HOLIDAY', 'Thưởng lễ, Tết', 'EARNING', 'FIXED', 0,
   null, null, null, true, false, false, 320, true,
   'Chịu thuế TNCN vào tháng chi trả. Không tính vào lương đóng bảo hiểm.'),

  ('BONUS_13TH', 'Lương tháng 13', 'EARNING', 'FIXED', 0,
   null, null, null, true, false, false, 321, true,
   'Tính thuế vào tháng thực chi, không rải đều cả năm. Không đóng bảo hiểm.'),

  -- Khoản theo luật lao động -------------------------------------------------
  ('UNUSED_LEAVE', 'Thanh toán phép năm chưa nghỉ', 'EARNING', 'PER_DAY', 0,
   null, null, null, true, false, false, 330, true,
   'Đơn giá ngày × số ngày phép còn lại. Chịu thuế TNCN, không đóng bảo hiểm.'),

  ('STOPPAGE_PAY', 'Lương ngừng việc', 'EARNING', 'PER_DAY', 0,
   null, null, null, true, true, false, 331, true,
   'Điều 99 Bộ luật Lao động. Mức do hai bên thoả thuận, không thấp hơn lương tối thiểu vùng.'),

  ('SEVERANCE', 'Trợ cấp thôi việc', 'EARNING', 'FIXED', 0,
   null, null, null, false, false, false, 332, true,
   'Điều 46 Bộ luật Lao động. Phần trong mức quy định được miễn thuế TNCN; trả vượt mức thì phần vượt phải chịu thuế.'),

  -- Chi phí doanh nghiệp -----------------------------------------------------
  ('ER_UNION_FUND', 'Kinh phí công đoàn (2%)', 'EMPLOYER_COST', 'PERCENT', 2,
   null, 'INSURANCE_BASE', null, false, false, false, 720, true,
   'Doanh nghiệp đóng cho MỌI người lao động, không phụ thuộc có là đoàn viên hay không. '
   || 'Khác đoàn phí 1% do đoàn viên tự đóng. Không trừ vào lương nhân viên.')
on conflict (code) do nothing;
