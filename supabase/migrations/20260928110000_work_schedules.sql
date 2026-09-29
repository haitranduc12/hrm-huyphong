-- ============================================================================
-- Ca làm việc hành chính — hạ tầng còn thiếu cuối cùng của nhóm chấm công.
-- ----------------------------------------------------------------------------
-- Giải quyết tham số P02 trong sheet "Đặc tả Lương – KPI" và mở đường cho bốn
-- hạng mục đang cùng tắc vì một thiếu sót gốc.
--
-- P02: công chuẩn tháng KHÔNG phải hằng số. Phiếu lương T8/2026 của khách ghi
-- 23,5 công = 21 ngày thứ Hai–Sáu + 5 thứ Bảy × 0,5. Hệ thống đang dùng cứng
-- một con số (mặc định 26) cho mọi tháng, trong khi đây là MẪU SỐ của mọi
-- khoản tính theo ngày — lệch ở đây là lệch toàn bộ bảng lương.
--
-- Thiếu sót gốc thứ hai: không nơi nào lưu GIỜ VÀO CHUẨN. Không có nó thì
-- không đo được phút đi muộn, kéo theo bốn hạng mục không làm được:
--   L16    phạt đi muộn (5.000đ/phút 1–15, 10.000đ/phút từ 16)
--   L17    phạt quá số lần đi muộn (ngưỡng 6 lần/tháng)
--   L14    thưởng đúng giờ 100k/200k/300k lũy kế trong quý
--   LU-06  tiêu chí chuyên cần của KPI
--
-- Bảng này CHỈ cung cấp dữ liệu. Chính sách phạt/thưởng vẫn nằm ở
-- `payroll_components` như mọi khoản khác — đặc tả còn ghi "Cần xác nhận" cho
-- phần lớn các ngưỡng, và mục L16 cảnh báo Điều 127 BLLĐ 2019 cấm phạt tiền
-- thay cho xử lý kỷ luật. Khoá cứng chính sách vào đây là chốt hộ khách một
-- quyết định họ chưa đưa ra, nên không làm.
--
-- Ngày lễ dùng lại `company_holidays` (migration 20260927120000), không tạo
-- bảng thứ hai.
-- ============================================================================

create table if not exists public.work_schedules (
  id uuid primary key default gen_random_uuid(),
  name text not null,

  /* Khoảng áp dụng. Đặc tả LU-01 nêu giờ mùa hè và mùa đông khác nhau. */
  effective_from date not null,
  effective_to date,

  /* Giờ vào và ra của một ngày làm đủ. */
  start_time time not null default '08:00',
  end_time time not null default '17:30',

  /* Nghỉ trưa, trừ ra khi quy đổi giờ công chuẩn mỗi ngày. */
  break_minutes integer not null default 90 check (break_minutes >= 0),

  /*
   * Thứ Bảy nghỉ / nửa ngày / cả ngày. Chính là thứ quyết định công chuẩn
   * 23,5 trong phiếu mẫu của khách.
   */
  saturday_mode text not null default 'HALF'
    check (saturday_mode in ('OFF', 'HALF', 'FULL')),

  /*
   * Phút ân hạn trước khi tính là đi muộn. Không có ngưỡng này thì tắc đường
   * một phút cũng thành vi phạm và quản lý sẽ phải ngồi bỏ tay từng trường
   * hợp. Mặc định 0 vì đặc tả chưa nêu — HR tự đặt theo quy chế công ty.
   */
  grace_minutes integer not null default 0 check (grace_minutes >= 0),

  is_active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint work_schedule_valid_range
    check (effective_to is null or effective_to >= effective_from),
  constraint work_schedule_valid_hours
    check (end_time > start_time)
);

create index if not exists work_schedules_effective_idx
  on public.work_schedules(effective_from desc);

drop trigger if exists work_schedules_touch on public.work_schedules;
create trigger work_schedules_touch
before update on public.work_schedules
for each row execute function public.touch_payroll_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Đọc mở cho mọi người đăng nhập: nhân viên cần biết giờ vào chuẩn để hiểu vì
-- sao mình bị tính muộn. Giấu đi thì mỗi thắc mắc lại thành một lần hỏi HR.
alter table public.work_schedules enable row level security;

drop policy if exists work_schedules_read on public.work_schedules;
create policy work_schedules_read on public.work_schedules
for select to authenticated using (true);

drop policy if exists work_schedules_manage on public.work_schedules;
create policy work_schedules_manage on public.work_schedules
for all to authenticated
using (public.can('attendance')) with check (public.can('attendance'));

grant select, insert, update, delete on public.work_schedules to authenticated;

-- ---------------------------------------------------------------------------
-- Seed theo đặc tả LU-01
-- ---------------------------------------------------------------------------
-- Giờ trong đặc tả: hè 8h–17h30, đông 8h–17h; thứ Bảy nửa ngày (suy từ công
-- chuẩn 23,5). NGÀY CHUYỂN MÙA đang nằm trong danh sách "Cần xác nhận" của
-- đặc tả (LU-01 câu hỏi 5) — tạm lấy 01/04 và 01/10 để hệ thống có lịch chạy
-- được ngay, HR sửa lại khi khách trả lời.
insert into public.work_schedules
  (name, effective_from, effective_to, start_time, end_time, saturday_mode, note)
select * from (values
  ('Giờ mùa hè', date '2026-04-01', date '2026-09-30', time '08:00', time '17:30', 'HALF',
   'Theo đặc tả LU-01. Ngày chuyển mùa CHƯA được khách xác nhận — HR chỉnh lại khi có quy định.'),
  ('Giờ mùa đông', date '2026-10-01', date '2027-03-31', time '08:00', time '17:00', 'HALF',
   'Theo đặc tả LU-01. Ngày chuyển mùa CHƯA được khách xác nhận.')
) as seed(name, effective_from, effective_to, start_time, end_time, saturday_mode, note)
where not exists (select 1 from public.work_schedules);

comment on table public.work_schedules is
  'Ca hành chính theo mùa. Dùng tính công chuẩn từng tháng (P02) và đo phút đi muộn (L16/L17/L14/LU-06).';
comment on column public.work_schedules.saturday_mode is
  'Quyết định công chuẩn tháng: HALF cho ra 23,5 công như phiếu mẫu T8/2026 của khách.';
