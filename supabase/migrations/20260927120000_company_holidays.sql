-- ============================================================================
-- Danh sách ngày nghỉ lễ công ty — hạ tầng còn thiếu để tách đúng L03 (Lương
-- nghỉ lễ) khỏi L01/L02 trong sheet "Đặc tả Lương – KPI".
-- ----------------------------------------------------------------------------
-- `leave.ts` (countWorkingDays) đã tự ghi nhận giới hạn này từ trước:
-- "Chưa trừ ngày lễ — hệ thống chưa có bảng ngày lễ." Không có bảng này thì
-- không thể nào tách được ngày nghỉ lễ (L03, có lương, KHÔNG trừ vào quỹ
-- phép) ra khỏi ngày công đi làm (L01) hay ngày nghỉ phép (L02, CÓ trừ quỹ
-- phép) — ba khoản khác hẳn nhau về nguồn gốc dữ liệu và cách trừ quỹ.
-- ============================================================================

create table if not exists public.company_holidays (
  id uuid primary key default gen_random_uuid(),
  holiday_date date not null unique,
  name text not null,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists company_holidays_date_idx
  on public.company_holidays(holiday_date) where is_active;

alter table public.company_holidays enable row level security;

-- Mọi nhân viên cần đọc được (dùng cho tính lương phía client và xem lịch
-- nghỉ) — chỉ việc THÊM/SỬA mới cần quyền. Cùng nhóm quyền với thiết lập chấm
-- công (admin.attendance_settings), vì đây là chính sách lịch làm việc chung
-- của công ty, không phải riêng nghiệp vụ kế toán lương.
drop policy if exists company_holidays_read on public.company_holidays;
create policy company_holidays_read on public.company_holidays for select to authenticated using (true);
drop policy if exists company_holidays_manage on public.company_holidays;
create policy company_holidays_manage on public.company_holidays for all to authenticated
  using (public.can_function('admin.attendance_settings')) with check (public.can_function('admin.attendance_settings'));

grant select, insert, update, delete on public.company_holidays to authenticated;

-- Chưa seed ngày lễ 2026 cụ thể: lịch nghỉ lễ chính thức (có hoán đổi ngày làm
-- việc hay không, nghỉ bù...) cần Phòng Nhân sự Huy Phong xác nhận, không tự
-- suy đoán. Bảng để trống, admin tự nhập qua UI (chưa có UI — xem ghi chú ở
-- lib/payroll.ts).
