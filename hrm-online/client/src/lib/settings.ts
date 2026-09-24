// ============================================================================
// Cấu hình dùng chung toàn hệ thống — đọc/ghi bảng `app_settings`.
// ----------------------------------------------------------------------------
// Trước đây trang Cấu hình ghi vào localStorage: mỗi máy một bản, không ai thấy
// của ai, và KHÔNG chỗ nào đọc lại nên mọi công tắc đều vô nghĩa. Giờ cấu hình
// nằm ở database, có realtime, và các trang thực sự đọc theo.
//
// Bảng chỉ có ĐÚNG MỘT DÒNG (khoá chính `id boolean CHECK (id)`), nên mọi truy
// vấn ở đây không cần điều kiện lọc.
// ============================================================================

import { supabase } from './supabase';
import { APP_SHORT_NAME } from './branding';

export interface AppSettings {
  orgName: string;
  contactEmail: string;
  phone: string;
  /** Bắt buộc quản lý xác nhận hết việc trong ngày mới cho check-out. */
  requireTaskApproval: boolean;
  /** Tự bắn thông báo chuông khi giao/gửi/duyệt việc, duyệt ca, duyệt phép. */
  autoNotify: boolean;
  /**
   * Số giờ làm chuẩn mỗi ngày. Dùng cho HAI việc và cố ý chỉ có MỘT ô nhập:
   * ngưỡng "công đủ giờ" ở Bảng công, và mẫu số quy đổi đơn giá giờ ở Bảng
   * lương (tăng ca, phụ cấp ca đêm). Tách làm hai thiết lập thì sớm muộn hai
   * con số lệch nhau và đơn giá tăng ca sai mà không ai thấy.
   */
  standardHoursPerDay: number;
  /** Hạn mức phép năm mặc định gợi ý khi tạo người dùng mới. */
  defaultAnnualLeave: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  orgName: APP_SHORT_NAME,
  contactEmail: '',
  phone: '',
  requireTaskApproval: true,
  autoNotify: true,
  standardHoursPerDay: 8,
  defaultAnnualLeave: 12,
};

/** Tên cột trong database — snake_case, khác camelCase phía TypeScript. */
interface SettingsRow {
  org_name?: string | null;
  contact_email?: string | null;
  phone?: string | null;
  require_task_approval?: boolean | null;
  auto_notify?: boolean | null;
  standard_hours_per_day?: number | string | null;
  default_annual_leave?: number | string | null;
}

/**
 * Cố ý dùng `*` thay vì liệt kê từng cột.
 *
 * PostgREST trả lỗi cho CẢ câu lệnh khi chỉ một cột trong danh sách chưa tồn
 * tại. Với danh sách cột tường minh, mỗi lần thêm thiết lập mới sẽ có một
 * khoảng thời gian code đã lên mà migration chưa chạy — và trong khoảng đó
 * TOÀN BỘ cấu hình, kể cả tên công ty, âm thầm rơi về mặc định. Lỗi này đã
 * xảy ra hai lần khi mở rộng bảng.
 *
 * `*` không bao giờ hỏng vì cột thiếu; `fromRow` tự lấy giá trị mặc định cho
 * trường nào chưa có trong database.
 */
const COLUMNS = '*';

/**
 * Postgres trả `numeric` về dạng CHUỖI qua PostgREST (để không mất độ chính xác
 * với số lớn). Ném thẳng chuỗi đó vào phép chia lương sẽ ra `NaN` im lặng, nên
 * mọi cột numeric phải đi qua đây.
 */
function num(value: number | string | null | undefined, fallback: number): number {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function fromRow(row: SettingsRow): AppSettings {
  return {
    orgName: row.org_name?.trim() || DEFAULT_SETTINGS.orgName,
    contactEmail: row.contact_email ?? '',
    phone: row.phone ?? '',
    requireTaskApproval: row.require_task_approval ?? DEFAULT_SETTINGS.requireTaskApproval,
    autoNotify: row.auto_notify ?? DEFAULT_SETTINGS.autoNotify,
    standardHoursPerDay: num(row.standard_hours_per_day, DEFAULT_SETTINGS.standardHoursPerDay),
    defaultAnnualLeave: num(row.default_annual_leave, DEFAULT_SETTINGS.defaultAnnualLeave),
  };
}

/**
 * Bản cấu hình mới nhất, dành cho code KHÔNG phải component React (helper
 * trong `lib/`, nơi không gọi hook được). `SettingsProvider` làm tươi giá trị
 * này mỗi lần nạp, kể cả khi realtime báo người khác vừa sửa.
 */
let cached: AppSettings = DEFAULT_SETTINGS;

export function getCachedSettings(): AppSettings {
  return cached;
}

/**
 * Nạp cấu hình. KHÔNG bao giờ ném lỗi: cấu hình được đọc ở tầng ngoài cùng của
 * app, để nó vỡ là trắng toàn bộ giao diện. Chưa chạy migration hoặc mất mạng
 * thì rơi về mặc định — app vẫn chạy đúng như trước khi có bảng này.
 */
export async function fetchSettings(): Promise<AppSettings> {
  if (!supabase) return DEFAULT_SETTINGS;

  const { data, error } = await supabase.from('app_settings').select(COLUMNS).maybeSingle();
  if (error || !data) return DEFAULT_SETTINGS;

  cached = fromRow(data as unknown as SettingsRow);
  return cached;
}

/** Ghi cấu hình. RLS chỉ cho quyền `settings` — người khác nhận lỗi từ Postgres. */
export async function saveSettings(
  settings: AppSettings,
  updatedBy: string | null,
): Promise<{ error: string | null }> {
  if (!supabase) return { error: 'Chưa kết nối Supabase.' };

  const basePatch = {
    org_name: settings.orgName.trim() || DEFAULT_SETTINGS.orgName,
    contact_email: settings.contactEmail.trim() || null,
    phone: settings.phone.trim() || null,
    require_task_approval: settings.requireTaskApproval,
    auto_notify: settings.autoNotify,
    standard_hours_per_day: settings.standardHoursPerDay,
    default_annual_leave: settings.defaultAnnualLeave,
    updated_by: updatedBy,
  };

  // Bảng một dòng, nhưng PostgREST vẫn đòi điều kiện WHERE cho UPDATE.
  const { error } = await supabase.from('app_settings').update(basePatch).eq('id', true);
  return { error: error ? error.message : null };
}
