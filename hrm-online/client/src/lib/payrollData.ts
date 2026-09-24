// ============================================================================
// Truy cập dữ liệu cho module lương.
// ----------------------------------------------------------------------------
// Tách khỏi component để trang AdminPayroll chỉ lo hiển thị, và để phần tính
// lương có thể kiểm chứng độc lập (xem `__tests__/payroll.check.ts`).
// ============================================================================

import { supabase } from './supabase';
import { describeDbError } from './dbError';
import type {
  Attendance,
  EmployeePayItem,
  EmployeePayProfile,
  LeaveRequest,
  PayComponent,
  PayrollInput,
  PayrollRun,
  PayrollRunStatus,
  Payslip,
  PayslipLine,
  Profile,
} from '@/types';
import type { ComputedPayslip } from './payroll';
import { fetchPayrollSettings, DEFAULT_PAYROLL_SETTINGS, type PayrollSettings } from './payrollSettings';

/** Dữ liệu cần để dựng bảng lương một tháng. */
export interface PayrollWorkspace {
  profiles: Profile[];
  components: PayComponent[];
  payProfiles: EmployeePayProfile[];
  items: EmployeePayItem[];
  inputs: PayrollInput[];
  attendance: Attendance[];
  leaves: LeaveRequest[];
  run: PayrollRun | null;
  payslips: Payslip[];
  payslipLines: PayslipLine[];
  payrollSettings: PayrollSettings;
  timesheetLocked: boolean;
  /** Migration chưa chạy — UI hiện hướng dẫn thay vì báo lỗi khó hiểu. */
  engineReady: boolean;
  error: string | null;
}

const EMPTY: PayrollWorkspace = {
  profiles: [], components: [], payProfiles: [], items: [], inputs: [],
  attendance: [], leaves: [], run: null, payslips: [], payslipLines: [],
  payrollSettings: DEFAULT_PAYROLL_SETTINGS,
  timesheetLocked: false, engineReady: false, error: null,
};

/**
 * Nạp toàn bộ dữ liệu một kỳ lương trong một lượt.
 *
 * Chấm công chỉ lấy bản ĐÃ HOÀN TẤT và ĐÃ ĐƯỢC QUẢN LÝ DUYỆT: công chưa duyệt
 * không được phép chảy vào tiền lương. Nghỉ không lương bị loại khỏi ngày
 * hưởng lương ngay từ query.
 */
export async function loadPayrollWorkspace(
  monthStartStr: string,
  monthEndStr: string,
): Promise<PayrollWorkspace> {
  if (!supabase) return { ...EMPTY, error: 'Chưa kết nối Supabase.' };

  const [
    payrollSettings,
    profilesRes, componentsRes, payProfilesRes, itemsRes, inputsRes,
    attendanceRes, leavesRes, runRes, periodRes,
  ] = await Promise.all([
    // Tham số lương nằm ở bảng riêng `payroll_settings` (chỉ Admin/CEO ghi
    // được), không phải `app_settings` vốn mở cho quyền lẻ `settings`.
    fetchPayrollSettings(),
    supabase.from('profiles').select('*').eq('is_active', true).order('name'),
    supabase.from('payroll_components').select('*').order('sort_order'),
    supabase.from('employee_pay_profiles').select('*').lte('effective_from', monthEndStr),
    supabase.from('employee_pay_items').select('*'),
    supabase.from('payroll_inputs').select('*').eq('month_start', monthStartStr),
    supabase
      .from('attendance')
      .select('id, user_id, date, check_in_time, check_out_time, status, approved_by_lead, created_at')
      .eq('status', 'completed')
      .eq('approved_by_lead', true)
      .gte('date', monthStartStr)
      .lte('date', monthEndStr),
    supabase
      .from('leave_requests')
      .select('*')
      .eq('status', 'approved')
      .neq('leave_type', 'unpaid')
      .lte('start_date', monthEndStr)
      .gte('end_date', monthStartStr),
    supabase.from('payroll_runs').select('*').eq('month_start', monthStartStr).maybeSingle(),
    supabase.from('timesheet_periods').select('status').eq('month_start', monthStartStr).maybeSingle(),
  ]);

  // Bảng của bộ máy lương chưa tồn tại nghĩa là migration chưa chạy. Đây là
  // tình huống cấu hình, không phải lỗi dữ liệu — báo riêng để UI hướng dẫn.
  const engineReady = !componentsRes.error;

  const blockingError =
    profilesRes.error ?? attendanceRes.error ?? leavesRes.error ?? null;

  let payslips: Payslip[] = [];
  let payslipLines: PayslipLine[] = [];
  const run = (runRes.data as PayrollRun | null) ?? null;

  if (run) {
    const slipRes = await supabase.from('payslips').select('*').eq('run_id', run.id);
    payslips = (slipRes.data || []) as Payslip[];
    if (payslips.length > 0) {
      const linesRes = await supabase
        .from('payslip_lines')
        .select('*')
        .in('payslip_id', payslips.map((slip) => slip.id))
        .order('sequence');
      payslipLines = (linesRes.data || []) as PayslipLine[];
    }
  }

  return {
    profiles: (profilesRes.data || []) as Profile[],
    components: (componentsRes.data || []) as PayComponent[],
    payProfiles: (payProfilesRes.data || []) as EmployeePayProfile[],
    items: (itemsRes.data || []) as EmployeePayItem[],
    inputs: (inputsRes.data || []) as PayrollInput[],
    attendance: (attendanceRes.data || []) as Attendance[],
    leaves: ((leavesRes.data || []) as LeaveRequest[]).filter((leave) => !leave.is_cancelled),
    run,
    payslips,
    payslipLines,
    payrollSettings,
    timesheetLocked: periodRes.data?.status === 'LOCKED',
    engineReady,
    error: blockingError ? describeDbError(blockingError) : null,
  };
}

// ---------------------------------------------------------------------------
// Ghi dữ liệu
// ---------------------------------------------------------------------------

export async function saveComponent(
  component: Partial<PayComponent> & { code: string; name: string },
): Promise<string | null> {
  if (!supabase) return 'Chưa kết nối Supabase.';
  const { error } = component.id
    ? await supabase.from('payroll_components').update(component).eq('id', component.id)
    : await supabase.from('payroll_components').insert(component);
  return error ? describeDbError(error) : null;
}

export async function deleteComponent(id: string): Promise<string | null> {
  if (!supabase) return 'Chưa kết nối Supabase.';
  const { error } = await supabase.from('payroll_components').delete().eq('id', id);
  return error ? describeDbError(error) : null;
}

export async function savePayProfile(
  payProfile: Partial<EmployeePayProfile> & { user_id: string; effective_from: string },
): Promise<string | null> {
  if (!supabase) return 'Chưa kết nối Supabase.';
  // Cùng người + cùng ngày hiệu lực là sửa lại bản ghi đó, không tạo bản trùng.
  const { error } = await supabase
    .from('employee_pay_profiles')
    .upsert(payProfile, { onConflict: 'user_id,effective_from' });
  return error ? describeDbError(error) : null;
}

export async function savePayItem(
  item: Partial<EmployeePayItem> & { user_id: string; component_id: string; effective_from: string },
): Promise<string | null> {
  if (!supabase) return 'Chưa kết nối Supabase.';
  const { error } = item.id
    ? await supabase.from('employee_pay_items').update(item).eq('id', item.id)
    : await supabase.from('employee_pay_items').insert(item);
  return error ? describeDbError(error) : null;
}

export async function deletePayItem(id: string): Promise<string | null> {
  if (!supabase) return 'Chưa kết nối Supabase.';
  const { error } = await supabase.from('employee_pay_items').delete().eq('id', id);
  return error ? describeDbError(error) : null;
}

export async function savePayrollInput(
  input: { user_id: string; month_start: string; code: string; quantity: number; created_by?: string | null },
): Promise<string | null> {
  if (!supabase) return 'Chưa kết nối Supabase.';
  const { error } = await supabase
    .from('payroll_inputs')
    .upsert(input, { onConflict: 'user_id,month_start,code' });
  return error ? describeDbError(error) : null;
}

// ---------------------------------------------------------------------------
// Kỳ chạy lương
// ---------------------------------------------------------------------------

export async function ensurePayrollRun(
  monthStart: string,
  createdBy: string | null,
): Promise<{ run: PayrollRun | null; error: string | null }> {
  if (!supabase) return { run: null, error: 'Chưa kết nối Supabase.' };

  const existing = await supabase
    .from('payroll_runs').select('*').eq('month_start', monthStart).maybeSingle();
  if (existing.data) return { run: existing.data as PayrollRun, error: null };

  const { data, error } = await supabase
    .from('payroll_runs')
    .insert({ month_start: monthStart, created_by: createdBy })
    .select()
    .single();
  return { run: (data as PayrollRun) ?? null, error: error ? describeDbError(error) : null };
}

export async function setRunStatus(
  runId: string,
  status: PayrollRunStatus,
  actorId: string | null,
): Promise<string | null> {
  if (!supabase) return 'Chưa kết nối Supabase.';
  const patch: Record<string, unknown> = { status };
  if (status === 'APPROVED') patch.approved_by = actorId;
  const { error } = await supabase.from('payroll_runs').update(patch).eq('id', runId);
  return error ? describeDbError(error) : null;
}

export interface PayslipToPersist {
  profile: Profile;
  computed: ComputedPayslip;
}

/**
 * Ghi kết quả tính xuống database — đây là bước "đóng băng".
 *
 * Xóa hết phiếu cũ của kỳ rồi ghi lại: tính lại một kỳ là thay toàn bộ, không
 * phải vá từng dòng. Trigger `payslips_immutable` chặn thao tác này khi kỳ đã
 * duyệt, nên không có đường nào sửa lén số liệu đã chốt.
 */
export async function persistPayslips(
  run: PayrollRun,
  entries: PayslipToPersist[],
): Promise<string | null> {
  if (!supabase) return 'Chưa kết nối Supabase.';

  const { error: clearError } = await supabase.from('payslips').delete().eq('run_id', run.id);
  if (clearError) return describeDbError(clearError);

  if (entries.length === 0) return null;

  const { data: inserted, error: insertError } = await supabase
    .from('payslips')
    .insert(entries.map(({ profile, computed }) => ({
      run_id: run.id,
      user_id: profile.id,
      employee_name: profile.name,
      employee_code: profile.employee_code ?? null,
      department: profile.department ?? null,
      pay_basis: computed.payBasis,
      work_days: computed.stats.workDays,
      leave_days: computed.stats.leaveDays,
      paid_days: computed.stats.paidDays,
      standard_days: computed.standardDays,
      work_hours: computed.stats.workHours,
      gross_pay: computed.gross,
      taxable_income: computed.taxableIncome,
      insurance_employee: computed.insuranceEmployee,
      insurance_employer: computed.insuranceEmployer,
      personal_income_tax: computed.personalIncomeTax,
      other_deductions: computed.otherDeductions,
      net_pay: computed.netPay,
      snapshot: computed.snapshot,
    })))
    .select('id, user_id');

  if (insertError) return describeDbError(insertError);

  const slipIdByUser = new Map((inserted || []).map((row) => [row.user_id as string, row.id as string]));
  const lines = entries.flatMap(({ profile, computed }) => {
    const payslipId = slipIdByUser.get(profile.id);
    if (!payslipId) return [];
    return computed.lines.map((line, index) => ({
      payslip_id: payslipId,
      sequence: index,
      code: line.code,
      name: line.name,
      kind: line.kind,
      quantity: line.quantity,
      rate: line.rate,
      amount: line.amount,
      taxable: line.taxable,
      insurable: line.insurable,
      detail: line.detail,
    }));
  });

  if (lines.length === 0) return null;
  const { error: lineError } = await supabase.from('payslip_lines').insert(lines);
  return lineError ? describeDbError(lineError) : null;
}
