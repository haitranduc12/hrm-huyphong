// ============================================================================
// Dịch lỗi Postgres/PostgREST sang câu tiếng Việt nói rõ phải làm gì.
// ----------------------------------------------------------------------------
// Mặc định supabase-js trả nguyên văn lỗi Postgres, ví dụ:
//   "new row violates row-level security policy for table \"projects\""
// Người dùng đọc câu đó không biết phải sửa ở đâu. Tệ hơn, nó nghe như lỗi hệ
// thống trong khi thực chất là tài khoản thiếu quyền — hai việc cần xử lý khác
// hẳn nhau.
// ============================================================================

import type { PostgrestError } from '@supabase/supabase-js';

/** Nhãn tiếng Việt của quyền, dùng để ghép vào câu gợi ý. */
const QUYEN_THEO_BANG: Record<string, string> = {
  projects: 'Quản lý Dự án',
  project_members: 'Quản lý Dự án',
  tasks: 'Quản lý Dự án',
  task_worklogs: 'Quản lý Dự án',
  project_documents: 'Quản lý Dự án',
  profiles: 'Quản lý User',
  attendance: 'Chấm công',
  daily_assignments: 'Chấm công',
  shifts: 'Ca làm việc',
  shift_types: 'Ca làm việc',
  leave_requests: 'Nghỉ phép',
  annual_leave_quota: 'Nghỉ phép',
};

function tenBang(message: string): string | null {
  // Postgres nhét tên bảng vào trong dấu ngoặc kép của thông báo.
  const m = message.match(/for table "([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * Bản trả `null` khi không có lỗi, để ghép được vào chuỗi `??` khi gom lỗi từ
 * nhiều truy vấn chạy song song:
 *     const loi = describeDbErrorOrNull(a.error) ?? describeDbErrorOrNull(b.error);
 */
export function describeDbErrorOrNull(
  error: PostgrestError | Error | null | undefined,
): string | null {
  return error ? describeDbError(error) : null;
}

/**
 * `error` nhận kiểu rộng vì chỗ gọi có khi bắt được lỗi mạng chứ không phải
 * PostgrestError.
 */
export function describeDbError(error: PostgrestError | Error | null | undefined): string {
  if (!error) return 'Lỗi không xác định.';

  const message = error.message ?? '';
  const code = (error as PostgrestError).code ?? '';

  // -- Thiếu quyền: RLS chặn ------------------------------------------------
  if (code === '42501' || /row-level security/i.test(message)) {
    const bang = tenBang(message);
    const quyen = bang ? QUYEN_THEO_BANG[bang] : undefined;
    return quyen
      ? `Tài khoản của bạn không có quyền "${quyen}" nên thao tác bị từ chối. Nhờ quản trị viên cấp quyền trong trang Quản lý User, rồi đăng xuất và đăng nhập lại.`
      : 'Tài khoản của bạn không đủ quyền cho thao tác này. Nhờ quản trị viên cấp quyền, rồi đăng xuất và đăng nhập lại.';
  }

  // -- Phiên hết hạn: token cũ vẫn gửi đi nhưng đã bị từ chối ---------------
  if (code === 'PGRST301' || /jwt expired/i.test(message)) {
    return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
  }

  // -- Trùng dữ liệu --------------------------------------------------------
  if (code === '23505') {
    // UNIQUE constraint Postgres tự sinh có message kỹ thuật khó hiểu
    // ("duplicate key value violates unique constraint ...") — dịch sang câu
    // chung. Nhưng trigger của hệ thống cũng dùng mã này khi RAISE EXCEPTION
    // (ví dụ "Đã có đơn nghỉ phép trùng ngày 01/03 → 02/03") — message đó đã
    // viết tiếng Việt, nói rõ trùng cái gì, nên PHẢI giữ nguyên văn thay vì
    // che bằng câu chung.
    if (/duplicate key|unique constraint|already exists/i.test(message)) {
      return 'Dữ liệu đã tồn tại. Kiểm tra lại xem bản ghi này đã được tạo trước đó chưa.';
    }
    return message;
  }

  // -- Tham chiếu tới bản ghi không còn ------------------------------------
  if (code === '23503') {
    return 'Bản ghi liên quan không còn tồn tại (có thể vừa bị người khác xóa). Tải lại trang rồi thử lại.';
  }

  // -- Vi phạm ràng buộc kiểm tra ------------------------------------------
  if (code === '23514') {
    return `Dữ liệu không hợp lệ theo ràng buộc của hệ thống. (${message})`;
  }

  // -- Mất mạng -------------------------------------------------------------
  if (/failed to fetch|networkerror/i.test(message)) {
    return 'Không kết nối được tới máy chủ. Kiểm tra kết nối mạng rồi thử lại.';
  }

  // Không nhận ra thì trả nguyên văn — che lỗi lạ đi còn khó chẩn đoán hơn.
  return message || 'Lỗi không xác định.';
}
