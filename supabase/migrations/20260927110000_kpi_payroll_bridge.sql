-- ============================================================================
-- Nối % KPI đã chốt vào tiền lương — đúng công thức L07/LU-09 trong sheet
-- "Đặc tả Lương – KPI": Lương KPI = mức lương KPI ban đầu × % KPI (quản lý
-- chấm). Đây là việc BRD v0.6 xếp vào "Giai đoạn tài chính" (RC6.2) — làm ở
-- đây theo yêu cầu chủ động của người phụ trách dự án, KHÔNG chờ khách hàng
-- Huy Phong chốt lại toàn bộ câu hỏi còn treo trong sheet Excel (P03: lưu mức
-- KPI theo vị trí hay theo từng nhân viên; LOI-09: có trần 120% không; L07:
-- lương KPI cộng vào dòng nào của phiếu VP/KD). Thiết kế dưới đây CỐ Ý không
-- khoá cứng những điểm đó — xem ghi chú tại từng phần.
--
-- Cách nối, tận dụng NGUYÊN VẸN engine đã có (không sửa payroll.ts/payrollFormula.ts):
--   1. `kpi_position_templates.default_kpi_amount` — "mức lương KPI ban đầu"
--      theo VỊ TRÍ (chọn cách hiểu (a) trong câu hỏi P03 vì mẫu đã gắn theo vị
--      trí sẵn; nếu khách xác nhận cần theo TỪNG NGƯỜI, thêm cột override sau).
--   2. Khi một review được KHOÁ (locked_at chuyển từ null → có giá trị) —
--      đúng bước "(3) Chốt KPI" trong luồng R03 — trigger tự đẩy 2 biến vào
--      `payroll_inputs` (cùng bảng OT/doanh số đang dùng, KHÔNG bảng riêng):
--        KPI_TARGET = default_kpi_amount của mẫu tại thời điểm khoá
--        KPI_PCT    = final_pct đã tính (0–120, đơn vị %, không phải phân số)
--   3. Khoản lương "LUONG_KPI" là DỮ LIỆU trong `payroll_components`
--      (calc_type FORMULA, formula = "KPI_TARGET * KPI_PCT / 100") — kế toán
--      tự sửa công thức qua màn hình Bảng lương sẵn có nếu khách chốt lại quy
--      tắc (ví dụ thêm trần: "MIN(KPI_TARGET * KPI_PCT / 100, KPI_TARGET * 1.2)"),
--      không cần sửa code.
--
-- Đã kiểm tra khớp với engine tính lương hiện có (client/src/lib/payroll.ts)
-- trước khi viết, KHÔNG suy đoán:
--   - `taxable` lọc đúng vào thu nhập chịu thuế (dòng ~564) → để `true`, khớp
--     LU-09(4) "Lương KPI là thu nhập chịu thuế TNCN".
--   - `insurable` là cờ hiển thị, KHÔNG được cộng vào bất kỳ phép tính nào
--     (căn cứ đóng BHXH lấy từ `payProfile.insurance_base`/lương hợp đồng,
--     không phải tổng các dòng có `insurable=true`) → để `false` đúng Ý ĐỊNH
--     (T02/T03: căn cứ BHXH và Quỹ công đoàn không gồm Lương KPI), dù hiện tại
--     việc để `true` hay `false` chưa ảnh hưởng số tiền do cờ này chưa được
--     engine dùng để tính toán — chỉ là cảnh báo phòng khi engine dùng cờ này
--     sau này.
--   - `kind = EARNING` → dòng lương KPI CỘNG vào Gross và vào thu nhập chịu
--     thuế cùng nhịp với các khoản EARNING khác (đúng vòng lặp `earningItems`
--     ở payroll.ts) — đây chính là cách giải quyết mâu thuẫn L07 (công thức
--     Tổng lương của khách chưa liệt kê khoản Lương KPI): chọn CỘNG VÀO, vì
--     nếu không cộng thì khoản này vô nghĩa.
--   - Quỹ công đoàn (T03) KHÔNG có trong engine dưới dạng luật cứng — công ty
--     tự cấu hình một khoản DEDUCTION riêng nếu cần; khoản đó tự nhiên KHÔNG
--     đụng tới LUONG_KPI trừ khi ai đó cố tình đưa mã LUONG_KPI vào công thức.
--
-- Vì sao KHÔNG tự tính KPI_PCT ngay khi review vừa tạo (mà đợi tới lúc khoá):
-- theo đúng thứ tự bắt buộc trong sheet Excel — "chốt KPI" phải xong TRƯỚC
-- "tính lương". Nếu payroll admin gán khoản LUONG_KPI cho một người mà KPI kỳ
-- đó CHƯA khoá, `payrollFormula.ts` sẽ báo lỗi "Không có biến KPI_PCT" trên
-- phiếu lương — đây là CHỦ ĐÍCH (chặn tính lương trước khi KPI chốt xong,
-- hiện cảnh báo rõ ràng thay vì âm thầm ra số 0đ dễ bị hiểu nhầm là "KPI 0%"),
-- không phải thiếu sót. Vì lý do tương tự (không sửa lại được sau khi khoá),
-- guard_kpi_score_bounds() ở migration trước đã chặn sửa điểm khi locked_at
-- có giá trị — final_pct vì vậy không thể lệch khỏi giá trị đã đồng bộ sang
-- payroll_inputs, trừ khi ai đó chủ động sửa default_kpi_amount của MẪU sau
-- khi khoá (xử lý bằng resync_kpi_payroll_inputs() bên dưới).
-- ============================================================================

alter table public.kpi_position_templates
  add column if not exists default_kpi_amount numeric(15, 2) not null default 0
  check (default_kpi_amount >= 0);

comment on column public.kpi_position_templates.default_kpi_amount is
  'Mức lương KPI ban đầu (100% = hưởng trọn số này) theo vị trí — sheet Đặc tả Lương – KPI mục P03. '
  'Suy luận của BA: lưu theo vị trí (mẫu), CHƯA hỗ trợ ghi đè theo từng nhân viên — cần khách hàng xác nhận trước khi dùng số thật.';

-- ---------------------------------------------------------------------------
-- MỘT hàm duy nhất chứa công thức đồng bộ — cả trigger (tự động lúc khoá) lẫn
-- hàm gọi tay (đồng bộ lại) đều gọi qua đây, không có bản sao thứ hai nào của
-- cùng logic để có thể lệch nhau theo thời gian.
-- ---------------------------------------------------------------------------
create or replace function public.sync_kpi_review_to_payroll_inputs(p_review public.performance_reviews)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month_start date;
  v_target numeric;
begin
  -- review kiểu nhập tay cũ (template_id null) không có "mức lương KPI ban
  -- đầu" nào để nhân, nên không tạo ra KPI_TARGET/KPI_PCT.
  if p_review.template_id is null then
    return;
  end if;

  select date_trunc('month', c.start_date)::date into v_month_start
  from public.performance_cycles c
  where c.id = p_review.cycle_id;

  if v_month_start is null then
    -- Không tìm được kỳ lương tương ứng (dữ liệu cycle bất thường) — không
    -- chặn việc khoá review, chỉ bỏ qua bước đồng bộ sang lương.
    return;
  end if;

  select default_kpi_amount into v_target
  from public.kpi_position_templates
  where id = p_review.template_id;

  -- Mở khoá tạm thời (chỉ trong transaction hiện tại — tham số `true` thứ ba
  -- của set_config) cho chính 2 dòng INSERT ngay dưới đây đi qua được
  -- guard_kpi_payroll_inputs_readonly(); mọi ghi KPI_TARGET/KPI_PCT từ nơi
  -- khác (kể cả màn "Số liệu tháng" nhập tay) sẽ bị trigger đó chặn.
  perform set_config('app.kpi_payroll_sync', 'on', true);

  insert into public.payroll_inputs (user_id, month_start, code, quantity, note, created_by)
  values
    (p_review.user_id, v_month_start, 'KPI_TARGET', coalesce(v_target, 0),
     'Tự động từ mẫu KPI khi khoá kỳ đánh giá (performance_reviews.id = ' || p_review.id || ').', null),
    (p_review.user_id, v_month_start, 'KPI_PCT', coalesce(p_review.final_pct, 0),
     'Tự động từ % hoàn thành KPI khi khoá kỳ đánh giá (performance_reviews.id = ' || p_review.id || ').', null)
  on conflict (user_id, month_start, code) do update
    set quantity = excluded.quantity,
        note = excluded.note,
        updated_at = now();
end;
$$;

revoke all on function public.sync_kpi_review_to_payroll_inputs(public.performance_reviews) from public;
grant execute on function public.sync_kpi_review_to_payroll_inputs(public.performance_reviews) to authenticated;

create or replace function public.trg_sync_kpi_review_to_payroll_inputs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_kpi_review_to_payroll_inputs(new);
  return new;
end;
$$;

drop trigger if exists performance_reviews_sync_payroll on public.performance_reviews;
create trigger performance_reviews_sync_payroll
  after update of locked_at on public.performance_reviews
  for each row
  when (new.locked_at is not null and old.locked_at is null)
  execute function public.trg_sync_kpi_review_to_payroll_inputs();

-- Đồng bộ lại thủ công — ví dụ default_kpi_amount của mẫu bị sửa SAU khi đã
-- khoá review, hoặc review bị khoá trước khi migration này tồn tại. Gate theo
-- quyền Bảng lương (admin.payroll), không phải quyền KPI: đây là ghi vào
-- payroll_inputs, thuộc phạm vi kế toán lương chứ không phải HR chấm KPI.
create or replace function public.resync_kpi_payroll_inputs(p_review_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_review public.performance_reviews;
begin
  if not public.can_function('admin.payroll') then
    raise exception 'Không có quyền đồng bộ dữ liệu lương.' using errcode = '42501';
  end if;

  select * into v_review from public.performance_reviews where id = p_review_id;
  if v_review.id is null then
    raise exception 'Không tìm thấy kỳ đánh giá.' using errcode = 'P0002';
  end if;
  if v_review.locked_at is null then
    raise exception 'Kỳ đánh giá này chưa khoá — chỉ đồng bộ được review đã khoá.' using errcode = '42501';
  end if;

  perform public.sync_kpi_review_to_payroll_inputs(v_review);
end;
$$;

revoke all on function public.resync_kpi_payroll_inputs(uuid) from public;
grant execute on function public.resync_kpi_payroll_inputs(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Khoá tay đối với 2 mã KPI_TARGET/KPI_PCT trong payroll_inputs.
-- ----------------------------------------------------------------------------
-- Màn "Số liệu tháng" (MonthlyInputsTab.tsx) hiện CÁC mã dùng trong công thức
-- thành ô nhập tự do cho payroll admin gõ số — nó không phân biệt được "mã
-- người dùng phải tự nhập" (giờ OT, doanh số) với "mã hệ thống tự ghi, không
-- ai được sửa tay" (KPI_TARGET/KPI_PCT). Không có trigger này, một payroll
-- admin hoàn toàn có thể vô tình gõ đè lên % KPI đã chốt ngay trên chính màn
-- hình đó — sai số liệu mà không ai biết, đúng kiểu lỗi con người 15 file
-- Excel KPI gốc của khách đang mắc phải, chỉ là chuyển từ Excel sang đây.
--
-- Chặn bằng cờ transaction-local `app.kpi_payroll_sync`: chỉ hàm
-- sync_kpi_review_to_payroll_inputs() ở trên được bật cờ này trước khi ghi;
-- mọi đường ghi khác (UI nhập tay, API, SQL trực tiếp) đều bị chặn.
create or replace function public.guard_kpi_payroll_inputs_readonly()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.code in ('KPI_TARGET', 'KPI_PCT')
     and coalesce(current_setting('app.kpi_payroll_sync', true), '') <> 'on' then
    raise exception
      'Mã "%" chỉ được hệ thống tự ghi khi khoá kỳ đánh giá KPI, không sửa tay được ở Số liệu tháng. '
      'Muốn đổi mức lương KPI: sửa "Mức lương KPI ban đầu" của mẫu vị trí. '
      'Muốn đổi %% KPI: mở lại/chấm lại kỳ đánh giá rồi khoá lại (hoặc dùng resync_kpi_payroll_inputs).',
      new.code
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists payroll_inputs_kpi_readonly_guard on public.payroll_inputs;
create trigger payroll_inputs_kpi_readonly_guard
  before insert or update on public.payroll_inputs
  for each row execute function public.guard_kpi_payroll_inputs_readonly();

-- ---------------------------------------------------------------------------
-- Khoản lương "LUONG_KPI" — DỮ LIỆU cấu hình sẵn trong payroll_components,
-- kế toán chỉnh formula qua màn hình Bảng lương (không cần sửa code) nếu
-- khách hàng chốt lại quy tắc (trần %, có/không tính vào Quỹ công đoàn...).
-- is_active = true nhưng KHÔNG tự động áp cho ai: payroll admin phải chủ động
-- gán khoản này vào employee_pay_items của từng người, đúng cách mọi khoản
-- lương khác trong hệ thống hoạt động — không có gì "ngầm" xảy ra.
-- ---------------------------------------------------------------------------
insert into public.payroll_components (
  code, name, kind, calc_type, formula, taxable, insurable, sort_order, is_active, is_system, note
) values (
  'LUONG_KPI',
  'Lương KPI',
  'EARNING',
  'FORMULA',
  'KPI_TARGET * KPI_PCT / 100',
  true,
  false,
  200,
  true,
  true,
  'Công thức KPI_TARGET * KPI_PCT / 100 KHÔNG có trần (sheet Đặc tả Lương – KPI, mục LOI-09, ghi nhận mẫu KTT thực tế vượt 100% mà không bị chặn — chưa rõ có trần 120% hay không). '
  'Nếu khách hàng xác nhận có trần, sửa formula thành: MIN(KPI_TARGET * KPI_PCT / 100, KPI_TARGET * <hệ số trần>). '
  'KPI_TARGET/KPI_PCT chỉ tồn tại trong payroll_inputs của tháng SAU KHI kỳ đánh giá KPI tương ứng đã được khoá (performance_reviews.locked_at) — gán khoản này cho ai trước khi KPI khoá sẽ hiện cảnh báo lỗi công thức trên phiếu lương, đúng chủ đích (chặn tính lương trước khi KPI chốt xong).'
)
on conflict (code) do nothing;
