// ============================================================================
// Tham số tính lương — thuộc module lương, KHÔNG phải cấu hình hệ thống.
// ----------------------------------------------------------------------------
// Ban đầu những con số này nằm trong `app_settings`. Hai lý do phải tách:
//
//   1. Hở quyền. Trang Cấu hình mở cho quyền lẻ `settings`, trong khi Bảng
//      lương yêu cầu Admin/CEO. Để chung nghĩa là người bị cấm xem bảng lương
//      vẫn sửa được thuế suất và tỷ lệ bảo hiểm của cả công ty.
//   2. Sai chỗ. Chỉ `lib/payroll.ts` đọc chúng. Thiết lập phục vụ đúng một
//      module thì thuộc về module đó.
//
// `standardHoursPerDay` KHÔNG nằm ở đây: Bảng công dùng nó làm ngưỡng đủ giờ
// công nên nó là thiết lập vận hành dùng chung, payroll chỉ đọc ké.
// Xem `toPayrollParams()` ở cuối file.
// ============================================================================

import { supabase } from './supabase';
import type { AppSettings } from './settings';

export interface PayrollSettings {
  /** Mẫu số cho người hưởng lương tháng. */
  standardWorkDays: number;

  /** Phần người lao động trích đóng (%). */
  socialInsuranceRate: number;
  healthInsuranceRate: number;
  unemploymentInsuranceRate: number;

  /** Phần doanh nghiệp đóng (%). Không trừ vào lương nhân viên. */
  employerSocialRate: number;
  employerHealthRate: number;
  employerUnemploymentRate: number;

  /** Trần tiền lương đóng — BHXH/BHYT và BHTN có trần khác nhau. */
  insuranceSalaryCap: number;
  unemploymentSalaryCap: number;

  /** Giảm trừ gia cảnh khi tính thuế TNCN. */
  taxPersonalDeduction: number;
  taxDependentDeduction: number;
}

export const DEFAULT_PAYROLL_SETTINGS: PayrollSettings = {
  standardWorkDays: 26,
  socialInsuranceRate: 8,
  healthInsuranceRate: 1.5,
  unemploymentInsuranceRate: 1,
  employerSocialRate: 17.5,
  employerHealthRate: 3,
  employerUnemploymentRate: 1,
  insuranceSalaryCap: 46_800_000,
  unemploymentSalaryCap: 99_200_000,
  taxPersonalDeduction: 11_000_000,
  taxDependentDeduction: 4_400_000,
};

/** Tên cột snake_case. Để tùy chọn vì database có thể chưa chạy migration. */
interface PayrollSettingsRow {
  standard_work_days?: number | string | null;
  social_insurance_rate?: number | string | null;
  health_insurance_rate?: number | string | null;
  unemployment_insurance_rate?: number | string | null;
  employer_social_rate?: number | string | null;
  employer_health_rate?: number | string | null;
  employer_unemployment_rate?: number | string | null;
  insurance_salary_cap?: number | string | null;
  unemployment_salary_cap?: number | string | null;
  tax_personal_deduction?: number | string | null;
  tax_dependent_deduction?: number | string | null;
}

/**
 * PostgREST trả `numeric` về dạng chuỗi để không mất độ chính xác với số lớn.
 * Ném thẳng chuỗi vào phép chia lương sẽ ra `NaN` im lặng.
 */
function num(value: number | string | null | undefined, fallback: number): number {
  const parsed = typeof value === 'string' ? parseFloat(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
}

function fromRow(row: PayrollSettingsRow): PayrollSettings {
  const d = DEFAULT_PAYROLL_SETTINGS;
  return {
    standardWorkDays: num(row.standard_work_days, d.standardWorkDays),
    socialInsuranceRate: num(row.social_insurance_rate, d.socialInsuranceRate),
    healthInsuranceRate: num(row.health_insurance_rate, d.healthInsuranceRate),
    unemploymentInsuranceRate: num(row.unemployment_insurance_rate, d.unemploymentInsuranceRate),
    employerSocialRate: num(row.employer_social_rate, d.employerSocialRate),
    employerHealthRate: num(row.employer_health_rate, d.employerHealthRate),
    employerUnemploymentRate: num(row.employer_unemployment_rate, d.employerUnemploymentRate),
    insuranceSalaryCap: num(row.insurance_salary_cap, d.insuranceSalaryCap),
    unemploymentSalaryCap: num(row.unemployment_salary_cap, d.unemploymentSalaryCap),
    taxPersonalDeduction: num(row.tax_personal_deduction, d.taxPersonalDeduction),
    taxDependentDeduction: num(row.tax_dependent_deduction, d.taxDependentDeduction),
  };
}

/**
 * Nạp tham số lương. Không bao giờ ném lỗi — chưa chạy migration thì rơi về
 * mặc định theo quy định hiện hành, bảng lương vẫn tính được.
 *
 * Dùng `select('*')` thay vì liệt kê cột: PostgREST hỏng CẢ câu lệnh khi một
 * cột chưa tồn tại, nên danh sách tường minh sẽ vỡ mỗi lần thêm tham số mới.
 */
export async function fetchPayrollSettings(): Promise<PayrollSettings> {
  if (!supabase) return DEFAULT_PAYROLL_SETTINGS;

  const { data, error } = await supabase.from('payroll_settings').select('*').maybeSingle();
  if (!error && data) return fromRow(data as PayrollSettingsRow);

  // Chưa chạy migration 20260921130000: các tham số này vẫn còn ở `app_settings`
  // (vị trí cũ). Đọc ké chỗ đó thay vì rơi thẳng về mặc định — nếu không, code
  // lên trước migration sẽ âm thầm xoá mọi thiết lập thuế và bảo hiểm mà kế
  // toán đã chỉnh. Tên cột trùng nhau nên `fromRow` dùng lại được nguyên vẹn.
  const legacy = await supabase.from('app_settings').select('*').maybeSingle();
  if (legacy.error || !legacy.data) return DEFAULT_PAYROLL_SETTINGS;

  return fromRow(legacy.data as PayrollSettingsRow);
}

/** Ghi tham số lương. RLS chỉ cho Admin/CEO — khớp với quyền vào Bảng lương. */
export async function savePayrollSettings(
  settings: PayrollSettings,
  updatedBy: string | null,
): Promise<{ error: string | null }> {
  if (!supabase) return { error: 'Chưa kết nối Supabase.' };

  // Bảng một dòng, nhưng PostgREST vẫn đòi điều kiện WHERE cho UPDATE.
  const { error } = await supabase
    .from('payroll_settings')
    .update({
      standard_work_days: settings.standardWorkDays,
      social_insurance_rate: settings.socialInsuranceRate,
      health_insurance_rate: settings.healthInsuranceRate,
      unemployment_insurance_rate: settings.unemploymentInsuranceRate,
      employer_social_rate: settings.employerSocialRate,
      employer_health_rate: settings.employerHealthRate,
      employer_unemployment_rate: settings.employerUnemploymentRate,
      insurance_salary_cap: settings.insuranceSalaryCap,
      unemployment_salary_cap: settings.unemploymentSalaryCap,
      tax_personal_deduction: settings.taxPersonalDeduction,
      tax_dependent_deduction: settings.taxDependentDeduction,
      updated_by: updatedBy,
    })
    .eq('id', true);

  return { error: error ? error.message : null };
}

/**
 * Bộ tham số đầy đủ mà engine cần: tham số lương cộng thêm giờ chuẩn mỗi ngày
 * lấy từ cấu hình hệ thống.
 *
 * Gộp ở đây thay vì để engine tự đọc hai nguồn, nhờ vậy `lib/payroll.ts` không
 * phụ thuộc vào `AppSettings` và kiểm chứng được bằng dữ liệu thuần.
 */
export interface PayrollParams extends PayrollSettings {
  /** Giờ làm chuẩn mỗi ngày — dùng quy đổi đơn giá giờ cho tăng ca. */
  hoursPerDay: number;
}

export function toPayrollParams(
  payroll: PayrollSettings,
  app: Pick<AppSettings, 'standardHoursPerDay'>,
): PayrollParams {
  return { ...payroll, hoursPerDay: app.standardHoursPerDay };
}
