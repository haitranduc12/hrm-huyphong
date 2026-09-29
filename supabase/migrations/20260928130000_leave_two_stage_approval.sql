-- ============================================================================
-- Duyệt nghỉ phép hai cấp theo số ngày (LU-02).
-- ----------------------------------------------------------------------------
-- Sheet "Đặc tả Lương – KPI", mục LU-02: "Duyệt nghỉ: 1 ngày – Trưởng bộ phận,
-- từ 2 ngày – BGĐ." Đây cũng là câu hỏi đầu tiên của khách trong hồ sơ so sánh
-- với MISA AMIS ("nếu nghỉ ít ngày chỉ cần quản lý trực tiếp duyệt, nếu dài
-- ngày phải lên ban giám đốc thì có xây dựng được quy trình riêng biệt không").
--
-- Hệ thống hiện chỉ có MỘT cấp: pending → approved. Có sẵn một công tắc
-- `feature_flags.multi_level_approval` từ migration 20260908170000 nhưng
-- KHÔNG dòng code nào đọc giá trị của nó — bật hay tắt đều không đổi gì.
--
-- Cách làm ở đây: chặn tại DATABASE thay vì sửa giao diện.
-- Giao diện Nghỉ phép vẫn cập nhật `status` như cũ; trigger dưới đây quyết
-- định thao tác đó có thành "đã duyệt" hay chỉ là "xong cấp một, chuyển tiếp
-- lên BGĐ". Nhờ vậy không có đường nào duyệt tắt — kể cả gọi thẳng PostgREST.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Ngưỡng ngày, cấu hình được
-- ---------------------------------------------------------------------------
-- Đặc tả ghi "từ 2 ngày" nhưng đây là quy chế nội bộ, công ty khác đặt khác.
do $do$
begin
  if to_regclass('public.app_settings') is not null then
    alter table public.app_settings
      add column if not exists leave_director_threshold_days numeric(5, 2) not null default 2
        check (leave_director_threshold_days > 0);
  end if;
end;
$do$;

-- ---------------------------------------------------------------------------
-- 2. Cấp duyệt đang chờ
-- ---------------------------------------------------------------------------
alter table public.leave_requests
  add column if not exists approval_stage text
    check (approval_stage is null or approval_stage in ('MANAGER', 'DIRECTOR')),
  add column if not exists manager_approved_by uuid references public.profiles(id) on delete set null,
  add column if not exists manager_approved_at timestamptz;

comment on column public.leave_requests.approval_stage is
  'Cấp đang chờ duyệt: MANAGER = trưởng bộ phận, DIRECTOR = ban giám đốc. NULL khi đơn đã xong hoặc tạo trước khi bật duyệt hai cấp.';
comment on column public.leave_requests.manager_approved_by is
  'Người duyệt cấp một. Giữ lại để biết đơn đã qua ai, khác approved_by là người duyệt cuối.';

-- Đơn đang chờ từ trước: đặt vào cấp một để không kẹt ở trạng thái không rõ.
update public.leave_requests
set approval_stage = 'MANAGER'
where status = 'pending' and approval_stage is null;

-- ---------------------------------------------------------------------------
-- 3. Ngưỡng hiện hành
-- ---------------------------------------------------------------------------
create or replace function public.leave_director_threshold()
returns numeric
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(
    (select leave_director_threshold_days from public.app_settings limit 1),
    2
  );
$fn$;

grant execute on function public.leave_director_threshold() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Đặt cấp duyệt khi tạo đơn
-- ---------------------------------------------------------------------------
create or replace function public.set_leave_approval_stage()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if new.status = 'pending' and new.approval_stage is null then
    new.approval_stage := 'MANAGER';
  end if;
  return new;
end;
$fn$;

drop trigger if exists leave_requests_set_stage on public.leave_requests;
create trigger leave_requests_set_stage
before insert on public.leave_requests
for each row execute function public.set_leave_approval_stage();

-- ---------------------------------------------------------------------------
-- 5. Chặn duyệt tắt cấp
-- ---------------------------------------------------------------------------
create or replace function public.guard_leave_two_stage_approval()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  threshold numeric;
begin
  -- Chỉ can thiệp đúng bước pending → approved. Từ chối đơn, hủy đơn, sửa nội
  -- dung đều đi đường cũ.
  if not (old.status = 'pending' and new.status = 'approved') then
    return new;
  end if;

  threshold := public.leave_director_threshold();

  -- Đơn ngắn: một cấp là đủ, giữ nguyên hành vi cũ.
  if new.days < threshold then
    new.approval_stage := null;
    return new;
  end if;

  -- Đơn dài, đang ở cấp một: ghi nhận trưởng bộ phận đã duyệt rồi ĐƯA VỀ LẠI
  -- trạng thái chờ ở cấp hai. Người duyệt cấp một không thể tự hoàn tất đơn
  -- dài ngày, dù họ bấm nút "Duyệt" hay gọi thẳng API.
  if coalesce(old.approval_stage, 'MANAGER') = 'MANAGER' then
    new.status := 'pending';
    new.approval_stage := 'DIRECTOR';
    new.manager_approved_by := auth.uid();
    new.manager_approved_at := now();
    new.approved_by := null;
    new.approved_at := null;
    return new;
  end if;

  -- Đang ở cấp hai: chỉ ban giám đốc mới chốt được.
  if not public.is_admin() then
    raise exception 'Đơn nghỉ từ % ngày phải do Ban giám đốc duyệt.', threshold
      using errcode = '42501';
  end if;

  new.approval_stage := null;
  return new;
end;
$fn$;

drop trigger if exists leave_requests_two_stage on public.leave_requests;
create trigger leave_requests_two_stage
before update on public.leave_requests
for each row execute function public.guard_leave_two_stage_approval();

-- ---------------------------------------------------------------------------
-- 6. Bật công tắc đã nằm đó từ lâu mà không làm gì
-- ---------------------------------------------------------------------------
update public.feature_flags
set enabled = true,
    description = 'Nghỉ phép: đơn ngắn do trưởng bộ phận duyệt, đơn dài phải lên Ban giám đốc. Ngưỡng đặt ở Thiết lập công & chấm công.'
where key = 'multi_level_approval';
