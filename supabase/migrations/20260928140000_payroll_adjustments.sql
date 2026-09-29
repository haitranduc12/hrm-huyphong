-- ============================================================================
-- Điều chỉnh lương: truy lĩnh và truy thu kỳ sau.
-- ----------------------------------------------------------------------------
-- Sheet "Đặc tả Lương – KPI", mục LU-14 ghi rõ khoảng trống này: "Sai sót
-- phát hiện sau khi khóa kỳ: truy lĩnh/truy thu kỳ sau – phiếu hiện chưa có
-- dòng này." eVIMICO cũng có menu riêng "Điều chỉnh dữ liệu lương".
--
-- Vì sao cần bảng riêng thay vì dùng khoản lương sẵn có:
--
-- Hệ thống ĐÃ có khoản `ADVANCE` (tạm ứng) và các khoản thưởng, nên về mặt
-- tiền thì gán một khoản là đủ. Thứ thiếu là TRUY VẾT: một khoản truy lĩnh
-- phải trả lời được "bù cho kỳ nào, vì sai sót gì, ai duyệt". Không có mối
-- nối ngược về kỳ gốc thì ba tháng sau không ai giải thích nổi dòng tiền đó,
-- và kiểm toán nội bộ sẽ hỏi đúng câu hệ thống không trả lời được.
--
-- Nguyên tắc giữ nguyên: kỳ lương đã duyệt KHÔNG bị sửa. Điều chỉnh luôn
-- chảy vào một kỳ CHƯA chốt, đúng như đặc tả yêu cầu.
-- ============================================================================

create table if not exists public.payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,

  /* Kỳ lương sẽ CHI TRẢ khoản điều chỉnh này. */
  month_start date not null,

  /* Kỳ lương phát sinh sai sót. Chính là mối nối mà cách gán khoản không có. */
  origin_month date,

  kind text not null check (kind in ('RECOVERY', 'CLAWBACK')),

  /* Luôn dương; chiều cộng/trừ do `kind` quyết định. Cho phép nhập số âm là
     mở đường cho một khoản truy thu âm — tức truy lĩnh — nằm sai nhóm. */
  amount numeric(15, 2) not null check (amount > 0),

  reason text not null,

  /*
   * Truy lĩnh tiền lương là thu nhập chịu thuế. Nhưng có khoản hoàn lại
   * (ví dụ trả lại tiền phạt đã trừ nhầm) thì không — để cấu hình được thay
   * vì mặc định cứng.
   */
  taxable boolean not null default true,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payroll_adjustment_month_is_first_day
    check (month_start = date_trunc('month', month_start)::date),
  constraint payroll_adjustment_origin_before_payment
    check (origin_month is null or origin_month <= month_start)
);

create index if not exists payroll_adjustments_month_idx
  on public.payroll_adjustments(month_start);
create index if not exists payroll_adjustments_user_idx
  on public.payroll_adjustments(user_id, month_start desc);

drop trigger if exists payroll_adjustments_touch on public.payroll_adjustments;
create trigger payroll_adjustments_touch
before update on public.payroll_adjustments
for each row execute function public.touch_payroll_updated_at();

-- ---------------------------------------------------------------------------
-- Không cho sửa điều chỉnh của kỳ đã duyệt
-- ---------------------------------------------------------------------------
-- Cùng nguyên tắc với `payslips`: chốt xong là bất biến. Thiếu chốt này thì
-- người ta có thể thêm một khoản truy lĩnh vào kỳ đã trả và con số trên phiếu
-- lương đã phát không còn khớp bảng lương.
create or replace function public.guard_payroll_adjustment_period()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  target_month date;
  run_status text;
begin
  if tg_op = 'DELETE' then
    target_month := old.month_start;
  else
    target_month := new.month_start;
  end if;

  select r.status into run_status
  from public.payroll_runs r
  where r.month_start = target_month;

  if run_status in ('APPROVED', 'PAID') then
    raise exception 'Kỳ lương tháng % đã duyệt — ghi điều chỉnh vào kỳ chưa chốt.', target_month
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$fn$;

drop trigger if exists payroll_adjustments_period_guard on public.payroll_adjustments;
create trigger payroll_adjustments_period_guard
before insert or update or delete on public.payroll_adjustments
for each row execute function public.guard_payroll_adjustment_period();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Nhân viên đọc được điều chỉnh của chính mình: dòng này hiện trên phiếu
-- lương, nên họ phải tra được lý do mà không cần hỏi kế toán.
alter table public.payroll_adjustments enable row level security;

drop policy if exists payroll_adjustments_read on public.payroll_adjustments;
create policy payroll_adjustments_read on public.payroll_adjustments
for select to authenticated
using (user_id = auth.uid() or public.can('attendance'));

drop policy if exists payroll_adjustments_manage on public.payroll_adjustments;
create policy payroll_adjustments_manage on public.payroll_adjustments
for all to authenticated
using (public.can('attendance')) with check (public.can('attendance'));

grant select, insert, update, delete on public.payroll_adjustments to authenticated;

comment on table public.payroll_adjustments is
  'Truy lĩnh / truy thu kỳ sau (LU-14). Khác khoản lương thường ở chỗ có mối nối ngược về kỳ phát sinh sai sót.';
comment on column public.payroll_adjustments.origin_month is
  'Kỳ lương phát sinh sai sót. Để trả lời được "khoản này bù cho tháng nào" khi rà soát về sau.';
