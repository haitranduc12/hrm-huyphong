-- ============================================================================
-- Quỹ công đoàn (T03, sheet "Đặc tả Lương – KPI") — khoản khấu trừ DUY NHẤT
-- còn thiếu hoàn toàn trong hệ thống trước migration này.
-- ----------------------------------------------------------------------------
-- Công thức đã rõ, không cần đoán: Quỹ công đoàn = (Lương thời gian + Lương
-- doanh số/vận chuyển) × 1%.
--
-- Ghi chú quan trọng từ chính sheet Excel (mục T03), không phải suy luận của
-- BA: khoản 1% này là ĐOÀN PHÍ — chỉ áp dụng cho người LÀ ĐOÀN VIÊN công
-- đoàn, khác với "kinh phí công đoàn 2%" doanh nghiệp đóng cho mọi lao động.
-- Vì vậy KHÔNG được gán mặc định cho tất cả nhân viên — payroll admin phải tự
-- gán khoản này (qua employee_pay_items) cho đúng những người là đoàn viên,
-- đúng cách mọi khoản lương khác trong hệ thống hoạt động (không có gì ngầm).
--
-- Giới hạn CHƯA giải quyết được — nêu rõ để không ai tưởng nhầm là đã xong:
-- vế "Lương doanh số/vận chuyển" (L08–L10) CHƯA tồn tại dưới dạng component
-- nào cả (hoa hồng bậc thang khối Kinh doanh, lương vận chuyển khối Kho vận
-- đều chưa dựng — xem docs/RA_SOAT_LUONG_KPI.md mục L08–L10). Formula dưới
-- đây vì vậy CHỈ đúng cho khối Văn phòng (không có doanh số/vận chuyển nên vế
-- đó bằng 0, công thức rút gọn còn đúng "Lương thời gian × 1%"). Khi L08–L10
-- được dựng, PHẢI sửa lại formula để cộng thêm đúng các mã đó — payroll admin
-- tự sửa qua màn Bảng lương (dữ liệu, không phải code).
-- ============================================================================

insert into public.payroll_components (
  code, name, kind, calc_type, formula, taxable, insurable, sort_order, is_active, is_system, note
) values (
  'QUY_CONG_DOAN',
  'Quỹ công đoàn',
  'DEDUCTION',
  'FORMULA',
  'BASE_WORK * 0.01',
  false,
  false,
  900,
  true,
  true,
  'T03 sheet Đặc tả Lương – KPI: (Lương thời gian + Lương doanh số/vận chuyển) × 1%. '
  'Formula hiện CHỈ có BASE_WORK (Lương thời gian, mã L01) vì Lương doanh số/vận chuyển (L08–L10) chưa dựng thành component — '
  'ĐÚNG cho khối Văn phòng, CHƯA ĐỦ cho khối Kinh doanh (thiếu vế doanh số). Sửa formula khi L08–L10 có mã. '
  'CHỈ gán cho nhân viên LÀ ĐOÀN VIÊN công đoàn (đoàn phí 1% NLĐ đóng) — không phải mọi nhân viên, khác kinh phí công đoàn 2% DN đóng.'
)
on conflict (code) do nothing;
