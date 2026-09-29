-- ============================================================================
-- Phần tiền làm thêm giờ trả CAO HƠN giờ thường được miễn thuế TNCN (T04).
-- ----------------------------------------------------------------------------
-- Sheet "Đặc tả Lương – KPI", mục T04: "Thu nhập chịu thuế = Tổng thu nhập −
-- phần tiền OT trả cao hơn giờ làm việc bình thường (được miễn)". Đây là quy
-- định tại Điều 4 Thông tư 111/2013/TT-BTC, không phải suy luận của BA.
--
-- Hệ thống đang đánh dấu TOÀN BỘ tiền tăng ca là chịu thuế, nên người làm
-- thêm nhiều bị tính dư thuế. Ví dụ tăng ca ngày thường hệ số 150%: nếu một
-- giờ thường trả 100.000đ thì giờ tăng ca trả 150.000đ, trong đó 100.000đ
-- chịu thuế còn 50.000đ được miễn — tức 1/3 khoản đó nằm ngoài diện thuế.
--
-- Cách khai: HR nhập ĐÚNG hệ số mà công ty trả (1.5 / 2 / 3), engine tự suy
-- ra phần miễn = số tiền × (hệ số − 1) ÷ hệ số. Bắt HR tự tính tỷ lệ miễn là
-- mời thêm một chỗ nhập sai.
-- ============================================================================

alter table public.payroll_components
  add column if not exists ot_multiplier numeric(5, 2)
    check (ot_multiplier is null or ot_multiplier >= 1);

comment on column public.payroll_components.ot_multiplier is
  'Hệ số làm thêm giờ (1.5 / 2 / 3). Có giá trị thì phần vượt trên 100% được miễn thuế TNCN theo T04. NULL = khoản thường, chịu thuế toàn bộ.';

-- Gắn hệ số cho các khoản tăng ca đã seed sẵn. Mức theo Điều 98 BLLĐ 2019.
--
-- Lưu ý dành cho người vận hành: sheet đặc tả (L04/L05) ghi công thức hiện tại
-- của khách dùng hệ số 1 và 2 — THẤP HƠN mức tối thiểu luật định 150%/200%/
-- 300%. Chỗ này giữ đúng luật; nếu khách xác nhận trả khác thì sửa cả công
-- thức của khoản lẫn `ot_multiplier` cho khớp nhau.
update public.payroll_components set ot_multiplier = 1.5 where code = 'OT_WEEKDAY';
update public.payroll_components set ot_multiplier = 2   where code = 'OT_WEEKEND';
update public.payroll_components set ot_multiplier = 3   where code = 'OT_HOLIDAY';

-- Phụ cấp ca đêm 30% KHÔNG gắn hệ số: đó là khoản phụ trội cho giờ làm ban
-- đêm, không phải tiền làm thêm giờ, nên chịu thuế bình thường.
