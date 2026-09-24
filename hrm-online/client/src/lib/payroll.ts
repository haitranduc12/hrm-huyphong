// ============================================================================
// Bộ máy tính lương.
// ----------------------------------------------------------------------------
// Thay cho công thức cứng viết thẳng trong AdminPayroll.tsx trước đây, nơi mọi
// nhân sự đều bị ép qua đúng một cách tính:
//
//   lương_cơ_bản / 26 * (ngày_công + ngày_phép) + phụ_cấp - 8% - 5%
//
// Cách tính đó sai với phần lớn người trong một công ty thật: nhân viên part
// time ăn lương giờ, thợ ăn khoán sản phẩm, sales ăn hoa hồng, và thuế TNCN
// không phải 5% phẳng mà là biểu lũy tiến bảy bậc.
//
// Ở đây lương gốc được tính theo cơ chế của từng người (`pay_basis`), rồi các
// khoản cộng/trừ chạy lần lượt theo `sort_order`. Mỗi khoản tính xong sẽ trở
// thành BIẾN cho khoản sau, nên HR ghép được những cách tính khá phức tạp mà
// không cần ai sửa code.
//
// Đọc kèm:
//   - `payrollFormula.ts`  bộ đánh giá biểu thức (không dùng eval)
//   - migration 20260921090000_payroll_engine.sql
// ============================================================================

import type { PayrollParams } from './payrollSettings';
import { evaluateFormula, FormulaError } from './payrollFormula';
import type {
  Attendance,
  EmployeePayItem,
  EmployeePayProfile,
  LeaveRequest,
  PayBasis,
  PayComponent,
  PayComponentKind,
  Profile,
} from '@/types';

// ---------------------------------------------------------------------------
// Thuế thu nhập cá nhân
// ---------------------------------------------------------------------------

/**
 * Biểu thuế lũy tiến từng phần, Phụ lục 01 Thông tư 111/2013/TT-BTC.
 * `upTo` tính trên THU NHẬP TÍNH THUẾ tháng (đã trừ bảo hiểm và giảm trừ).
 */
export const PIT_BRACKETS: ReadonlyArray<{ upTo: number; rate: number }> = [
  { upTo: 5_000_000, rate: 0.05 },
  { upTo: 10_000_000, rate: 0.1 },
  { upTo: 18_000_000, rate: 0.15 },
  { upTo: 32_000_000, rate: 0.2 },
  { upTo: 52_000_000, rate: 0.25 },
  { upTo: 80_000_000, rate: 0.3 },
  { upTo: Number.POSITIVE_INFINITY, rate: 0.35 },
];

export interface TaxBreakdownStep {
  /** Phần thu nhập rơi vào bậc này. */
  amount: number;
  rate: number;
  tax: number;
}

/**
 * Thuế lũy tiến từng phần. "Từng phần" nghĩa là mỗi bậc chỉ đánh trên PHẦN thu
 * nhập nằm trong bậc đó, không phải áp một thuế suất cho toàn bộ thu nhập —
 * nhầm chỗ này là tính dư thuế cho nhân viên rất nhiều.
 */
export function progressiveIncomeTax(taxableIncome: number): {
  tax: number;
  steps: TaxBreakdownStep[];
} {
  if (taxableIncome <= 0) return { tax: 0, steps: [] };

  const steps: TaxBreakdownStep[] = [];
  let tax = 0;
  let lowerBound = 0;

  for (const bracket of PIT_BRACKETS) {
    if (taxableIncome <= lowerBound) break;
    const portion = Math.min(taxableIncome, bracket.upTo) - lowerBound;
    if (portion > 0) {
      const stepTax = portion * bracket.rate;
      steps.push({ amount: portion, rate: bracket.rate, tax: stepTax });
      tax += stepTax;
    }
    lowerBound = bracket.upTo;
  }

  return { tax: Math.round(tax), steps };
}

// ---------------------------------------------------------------------------
// Tổng hợp công và phép trong kỳ
// ---------------------------------------------------------------------------

export interface PeriodStats {
  workDays: number;
  leaveDays: number;
  /** Ngày công + ngày phép hưởng lương. Cơ sở để chia lương theo ngày. */
  paidDays: number;
  /** Giờ làm thực tế cộng dồn từ check-in/check-out. */
  workHours: number;
  /** Ngày có check-in nhưng thiếu check-out — giờ công của ngày đó tính là 0. */
  missingCheckout: number;
}

/**
 * Gộp chấm công và nghỉ phép của MỘT người trong MỘT tháng.
 *
 * Ngày phép đếm theo khoảng ngày chứ không lấy thẳng cột `days`: một đơn nghỉ
 * có thể vắt qua hai tháng, phải tách đúng phần rơi vào tháng đang tính.
 */
export function summarisePeriod(
  attendance: Attendance[],
  leaves: LeaveRequest[],
  monthStart: Date,
  hoursPerDay: number,
): PeriodStats {
  const withCheckIn = attendance.filter((record) => record.check_in_time);
  const workDays = new Set(withCheckIn.map((record) => record.date)).size;

  let workHours = 0;
  let missingCheckout = 0;

  for (const record of withCheckIn) {
    if (!record.check_out_time) {
      missingCheckout += 1;
      continue;
    }
    const start = new Date(record.check_in_time as string).getTime();
    const end = new Date(record.check_out_time).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    // Chặn trên bằng 24h: dữ liệu chấm công lỗi (quên check-out hôm trước rồi
    // được sửa tay) từng tạo ra những ca dài hàng trăm giờ.
    workHours += Math.min((end - start) / 3_600_000, 24);
  }

  const year = monthStart.getFullYear();
  const month = monthStart.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let leaveDays = 0;

  for (const leave of leaves) {
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(year, month, day);
      // Nghỉ phép chỉ tính ngày thường; cuối tuần vốn đã không phải ngày công.
      if (date.getDay() === 0 || date.getDay() === 6) continue;
      const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (iso >= leave.start_date && iso <= leave.end_date) {
        leaveDays += leave.half_day ? 0.5 : 1;
      }
    }
  }

  return {
    workDays,
    leaveDays,
    paidDays: workDays + leaveDays,
    // Người ăn lương tháng không chấm giờ đủ tin cậy thì vẫn cần một con số
    // giờ để quy đổi tăng ca — lấy ngày công nhân giờ chuẩn khi chưa có giờ.
    workHours: workHours > 0 ? Math.round(workHours * 100) / 100 : workDays * hoursPerDay,
    missingCheckout,
  };
}

// ---------------------------------------------------------------------------
// Tính một phiếu lương
// ---------------------------------------------------------------------------

export interface ComputedLine {
  code: string;
  name: string;
  kind: PayComponentKind;
  quantity: number | null;
  rate: number | null;
  amount: number;
  taxable: boolean;
  insurable: boolean;
  /** Câu giải thích để phiếu lương tự nói được vì sao ra con số này. */
  detail: string;
}

export interface ComputedPayslip {
  payBasis: PayBasis;
  stats: PeriodStats;
  standardDays: number;
  hourlyRate: number;
  insuranceBase: number;
  lines: ComputedLine[];
  /** Tổng thu nhập trước khấu trừ. */
  gross: number;
  taxableIncome: number;
  insuranceEmployee: number;
  insuranceEmployer: number;
  personalIncomeTax: number;
  taxSteps: TaxBreakdownStep[];
  /** Khấu trừ ngoài bảo hiểm và thuế (tạm ứng, đoàn phí...). */
  otherDeductions: number;
  netPay: number;
  /** Tham số đã dùng — ghi vào `payslips.snapshot` khi chốt kỳ. */
  snapshot: Record<string, unknown>;
  /** Vấn đề cần người xử lý: thiếu cơ chế lương, công thức hỏng... */
  warnings: string[];
}

/** Mã khoản mà engine tự sinh, không đến từ `payroll_components`. */
export const SYSTEM_CODES = {
  base: 'BASE',
  socialInsurance: 'INS_SOCIAL',
  healthInsurance: 'INS_HEALTH',
  unemploymentInsurance: 'INS_UNEMPLOY',
  personalIncomeTax: 'PIT',
} as const;

const PAY_BASIS_LABEL: Record<PayBasis, string> = {
  MONTHLY: 'Lương tháng',
  HOURLY: 'Lương giờ',
  DAILY: 'Lương ngày',
  PIECE: 'Khoán sản phẩm',
  COMMISSION: 'Lương cứng + hoa hồng',
};

export function payBasisLabel(basis: PayBasis): string {
  return PAY_BASIS_LABEL[basis] ?? basis;
}

export interface AssignedPayItem {
  item: EmployeePayItem;
  component: PayComponent;
}

export interface ComputePayslipArgs {
  profile: Profile;
  payProfile: EmployeePayProfile | null;
  /** Khoản đã gán cho người này VÀ còn hiệu lực trong tháng đang tính. */
  items: AssignedPayItem[];
  /** Số liệu biến động tháng: mã → số lượng. */
  inputs: Readonly<Record<string, number>>;
  stats: PeriodStats;
  settings: PayrollParams;
}

function round(value: number): number {
  return Math.round(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(value);
}

/**
 * Lương gốc theo cơ chế. Đây là chỗ bốn kiểu trả lương tách nhau ra.
 */
function computeBasePay(
  basis: PayBasis,
  baseAmount: number,
  stats: PeriodStats,
  standardDays: number,
): { amount: number; quantity: number; rate: number; detail: string } {
  switch (basis) {
    case 'HOURLY':
      return {
        amount: baseAmount * stats.workHours,
        quantity: stats.workHours,
        rate: baseAmount,
        detail: `${formatNumber(baseAmount)}đ/giờ × ${formatNumber(stats.workHours)} giờ làm thực tế`,
      };

    case 'DAILY':
      return {
        amount: baseAmount * stats.paidDays,
        quantity: stats.paidDays,
        rate: baseAmount,
        detail: `${formatNumber(baseAmount)}đ/ngày × ${formatNumber(stats.paidDays)} ngày công`,
      };

    case 'PIECE':
      // Người ăn khoán không có lương cứng: toàn bộ thu nhập đến từ khoản
      // PIECE_RATE nhân với sản lượng nghiệm thu.
      return {
        amount: 0,
        quantity: 0,
        rate: 0,
        detail: 'Không có lương cứng — thu nhập tính theo sản lượng khoán',
      };

    case 'MONTHLY':
    case 'COMMISSION':
    default: {
      const amount = (baseAmount / standardDays) * stats.paidDays;
      const label = basis === 'COMMISSION' ? 'Lương cứng' : 'Lương tháng';
      return {
        amount,
        quantity: stats.paidDays,
        rate: baseAmount / standardDays,
        detail:
          `${label} ${formatNumber(baseAmount)}đ ÷ ${formatNumber(standardDays)} ngày công chuẩn ` +
          `× ${formatNumber(stats.paidDays)} ngày hưởng lương`,
      };
    }
  }
}

/** Đơn giá giờ, dùng cho mọi công thức tăng ca và phụ cấp ca đêm. */
function computeHourlyRate(
  basis: PayBasis,
  baseAmount: number,
  standardDays: number,
  hoursPerDay: number,
): number {
  switch (basis) {
    case 'HOURLY':
      return baseAmount;
    case 'DAILY':
      return baseAmount / Math.max(hoursPerDay, 1);
    case 'PIECE':
      // Không có đơn giá giờ để quy đổi; tăng ca của thợ khoán phải trả bằng
      // khoản riêng chứ không nhân từ lương cứng.
      return 0;
    default:
      return baseAmount / Math.max(standardDays, 1) / Math.max(hoursPerDay, 1);
  }
}

/**
 * Tính một dòng khoản lương. Trả về `null` kèm cảnh báo nếu công thức hỏng —
 * một khoản sai không được làm hỏng cả phiếu lương.
 */
function computeComponentLine(
  assigned: AssignedPayItem,
  scope: Record<string, number>,
  stats: PeriodStats,
  standardDays: number,
  inputs: Readonly<Record<string, number>>,
  warnings: string[],
  employeeName: string,
): ComputedLine | null {
  const { component, item } = assigned;
  // Giá trị riêng của người này thắng giá trị mặc định của công ty.
  const amount = item.amount ?? component.default_amount;
  const formula = item.formula?.trim() || component.formula?.trim() || '';

  let value = 0;
  let quantity: number | null = null;
  let rate: number | null = null;
  let detail = '';

  switch (component.calc_type) {
    case 'FIXED': {
      value = amount;
      rate = amount;
      detail = component.prorate
        ? `${formatNumber(amount)}đ/tháng, chia theo ${formatNumber(stats.paidDays)}/${formatNumber(standardDays)} ngày công`
        : `${formatNumber(amount)}đ trọn tháng`;
      break;
    }

    case 'PER_DAY': {
      quantity = stats.paidDays;
      rate = amount;
      value = amount * stats.paidDays;
      detail = `${formatNumber(amount)}đ/ngày × ${formatNumber(stats.paidDays)} ngày`;
      break;
    }

    case 'PER_HOUR':
    case 'PER_UNIT': {
      const code = component.input_code ?? '';
      quantity = inputs[code] ?? 0;
      rate = amount;
      value = amount * quantity;
      const unit = component.calc_type === 'PER_HOUR' ? 'giờ' : 'đơn vị';
      detail = `${formatNumber(amount)}đ × ${formatNumber(quantity)} ${unit} (${code})`;
      break;
    }

    case 'PERCENT': {
      const baseCode = (component.base_code ?? '').toUpperCase();
      const baseValue = scope[baseCode];
      if (baseValue === undefined) {
        warnings.push(
          `${employeeName}: khoản "${component.name}" tính % trên "${baseCode}" nhưng chưa có giá trị đó ` +
            `tại thời điểm tính. Đặt sort_order lớn hơn khoản gốc.`,
        );
        return null;
      }
      rate = amount;
      quantity = baseValue;
      value = (baseValue * amount) / 100;
      detail = `${formatNumber(amount)}% × ${formatNumber(baseValue)}đ (${baseCode})`;
      break;
    }

    case 'FORMULA': {
      try {
        const result = evaluateFormula(formula, scope);
        value = result.value;
        detail = formula;
      } catch (error) {
        const reason = error instanceof FormulaError ? error.message : String(error);
        warnings.push(`${employeeName}: công thức khoản "${component.name}" lỗi — ${reason}`);
        return null;
      }
      break;
    }

    default:
      return null;
  }

  // Chia theo ngày công. Chỉ áp cho khoản trả trọn tháng: khoản đã nhân theo
  // giờ/ngày/sản lượng thì bản thân nó đã phản ánh khối lượng làm việc rồi,
  // chia thêm lần nữa là trừ hai lần.
  if (component.prorate && component.calc_type === 'FIXED' && standardDays > 0) {
    value = (value / standardDays) * stats.paidDays;
  }

  return {
    code: component.code,
    name: component.name,
    kind: component.kind,
    quantity,
    rate,
    amount: round(value),
    taxable: component.taxable,
    insurable: component.insurable,
    detail,
  };
}

/**
 * Tính trọn một phiếu lương.
 *
 * Thứ tự cố ý: lương gốc → các khoản cộng (theo `sort_order`) → bảo hiểm →
 * thuế → các khoản trừ. Bảo hiểm phải xong trước thuế vì tiền bảo hiểm được
 * trừ khỏi thu nhập tính thuế; các khoản trừ khác đứng sau cùng vì chúng
 * không ảnh hưởng nghĩa vụ thuế.
 */
export function computePayslip(args: ComputePayslipArgs): ComputedPayslip {
  const { profile, payProfile, items, inputs, stats, settings } = args;
  const warnings: string[] = [];
  const lines: ComputedLine[] = [];

  const basis: PayBasis = payProfile?.pay_basis ?? 'MONTHLY';
  const baseAmount = Number(payProfile?.base_amount ?? 0);
  const hoursPerDay = Math.max(settings.hoursPerDay || 8, 1);
  const standardDays = Math.max(
    Number(payProfile?.standard_days_override ?? settings.standardWorkDays) || 26,
    1,
  );

  if (!payProfile) {
    warnings.push(`${profile.name}: chưa thiết lập cơ chế lương — phiếu đang là 0đ.`);
  } else if (baseAmount <= 0 && basis !== 'PIECE') {
    warnings.push(`${profile.name}: cơ chế "${payBasisLabel(basis)}" nhưng đơn giá đang là 0.`);
  }

  // --- Lương gốc ------------------------------------------------------------
  const base = computeBasePay(basis, baseAmount, stats, standardDays);
  const hourlyRate = computeHourlyRate(basis, baseAmount, standardDays, hoursPerDay);

  lines.push({
    code: SYSTEM_CODES.base,
    name: basis === 'PIECE' ? 'Lương khoán (không có lương cứng)' : 'Lương theo công',
    kind: 'EARNING',
    quantity: base.quantity,
    rate: round(base.rate),
    amount: round(base.amount),
    taxable: true,
    insurable: true,
    detail: base.detail,
  });

  // --- Phạm vi biến cho công thức -------------------------------------------
  // Mọi số liệu tháng đều thành biến, cộng thêm mã của các khoản đã tính xong.
  const scope: Record<string, number> = {
    BASE: round(base.amount),
    GROSS: round(base.amount), // tổng thu nhập TỚI THỜI ĐIỂM đang tính
    HOURLY_RATE: hourlyRate,
    DAILY_RATE: basis === 'DAILY' ? baseAmount : baseAmount / standardDays,
    MONTHLY_RATE: baseAmount,
    WORK_DAYS: stats.workDays,
    LEAVE_DAYS: stats.leaveDays,
    PAID_DAYS: stats.paidDays,
    STANDARD_DAYS: standardDays,
    WORK_HOURS: stats.workHours,
    HOURS_PER_DAY: hoursPerDay,
    DEPENDENTS: payProfile?.dependents ?? 0,
  };

  for (const [code, quantity] of Object.entries(inputs)) {
    scope[code.toUpperCase()] = quantity;
  }

  // Mức đóng bảo hiểm: lấy mức khai báo riêng nếu có, nếu không thì lấy lương
  // theo hợp đồng (KHÔNG phải lương thực nhận tháng này) — nghỉ nửa tháng
  // không làm giảm mức đóng bảo hiểm.
  const contractualBase =
    basis === 'MONTHLY' || basis === 'COMMISSION' ? baseAmount : round(base.amount);
  const declaredInsuranceBase = payProfile?.insurance_base ?? null;
  const rawInsuranceBase = Number(declaredInsuranceBase ?? contractualBase);
  scope.INSURANCE_BASE = rawInsuranceBase;

  // --- Các khoản cộng -------------------------------------------------------
  const sorted = [...items].sort((a, b) => a.component.sort_order - b.component.sort_order);

  const earningItems = sorted.filter((entry) => entry.component.kind === 'EARNING');
  for (const assigned of earningItems) {
    const line = computeComponentLine(
      assigned, scope, stats, standardDays, inputs, warnings, profile.name,
    );
    if (!line) continue;
    lines.push(line);
    scope[line.code] = line.amount;
    scope.GROSS = round(scope.GROSS + line.amount);
  }

  const gross = lines
    .filter((line) => line.kind === 'EARNING')
    .reduce((sum, line) => sum + line.amount, 0);

  // --- Bảo hiểm bắt buộc ----------------------------------------------------
  // Hai trần khác nhau: BHXH/BHYT theo lương cơ sở, BHTN theo lương tối thiểu
  // vùng. Bản cũ không có trần nào, nên người lương cao bị trừ vượt quy định.
  const insuranceEnabled = payProfile?.insurance_enabled ?? true;
  const cappedSocialBase = Math.min(rawInsuranceBase, settings.insuranceSalaryCap);
  const cappedUnemployBase = Math.min(rawInsuranceBase, settings.unemploymentSalaryCap);

  let insuranceEmployee = 0;
  if (insuranceEnabled && rawInsuranceBase > 0) {
    const social = round((cappedSocialBase * settings.socialInsuranceRate) / 100);
    const health = round((cappedSocialBase * settings.healthInsuranceRate) / 100);
    const unemployment = round((cappedUnemployBase * settings.unemploymentInsuranceRate) / 100);

    lines.push({
      code: SYSTEM_CODES.socialInsurance,
      name: `BHXH (${settings.socialInsuranceRate}%)`,
      kind: 'DEDUCTION', quantity: null, rate: settings.socialInsuranceRate,
      amount: social, taxable: false, insurable: false,
      detail: `${settings.socialInsuranceRate}% × ${formatNumber(cappedSocialBase)}đ mức đóng`,
    });
    lines.push({
      code: SYSTEM_CODES.healthInsurance,
      name: `BHYT (${settings.healthInsuranceRate}%)`,
      kind: 'DEDUCTION', quantity: null, rate: settings.healthInsuranceRate,
      amount: health, taxable: false, insurable: false,
      detail: `${settings.healthInsuranceRate}% × ${formatNumber(cappedSocialBase)}đ mức đóng`,
    });
    lines.push({
      code: SYSTEM_CODES.unemploymentInsurance,
      name: `BHTN (${settings.unemploymentInsuranceRate}%)`,
      kind: 'DEDUCTION', quantity: null, rate: settings.unemploymentInsuranceRate,
      amount: unemployment, taxable: false, insurable: false,
      detail: `${settings.unemploymentInsuranceRate}% × ${formatNumber(cappedUnemployBase)}đ mức đóng`,
    });

    insuranceEmployee = social + health + unemployment;
  }

  scope.INSURANCE_EMPLOYEE = insuranceEmployee;

  // --- Thuế thu nhập cá nhân ------------------------------------------------
  // Chỉ phần thu nhập có cờ `taxable` mới vào diện chịu thuế: tiền ăn ca trong
  // mức miễn, công tác phí… đứng ngoài.
  const taxableEarnings = lines
    .filter((line) => line.kind === 'EARNING' && line.taxable)
    .reduce((sum, line) => sum + line.amount, 0);

  const dependents = payProfile?.dependents ?? 0;
  const personalRelief = settings.taxPersonalDeduction;
  const dependentRelief = dependents * settings.taxDependentDeduction;
  const taxMode = payProfile?.tax_mode ?? 'PROGRESSIVE';

  let taxableIncome = 0;
  let personalIncomeTax = 0;
  let taxSteps: TaxBreakdownStep[] = [];
  let taxDetail = '';

  if (taxMode === 'NONE') {
    taxDetail = 'Không khấu trừ thuế tại nguồn';
  } else if (taxMode === 'FLAT') {
    // Hợp đồng dưới 3 tháng: khấu trừ thẳng trên tổng thu nhập chịu thuế,
    // KHÔNG có giảm trừ gia cảnh.
    const rate = payProfile?.flat_tax_rate ?? 10;
    taxableIncome = taxableEarnings;
    personalIncomeTax = round((taxableEarnings * rate) / 100);
    taxDetail = `Khấu trừ ${rate}% trên ${formatNumber(taxableEarnings)}đ (hợp đồng dưới 3 tháng)`;
  } else {
    taxableIncome = Math.max(0, taxableEarnings - insuranceEmployee - personalRelief - dependentRelief);
    const result = progressiveIncomeTax(taxableIncome);
    personalIncomeTax = result.tax;
    taxSteps = result.steps;
    taxDetail =
      `(${formatNumber(taxableEarnings)} − ${formatNumber(insuranceEmployee)} bảo hiểm ` +
      `− ${formatNumber(personalRelief)} bản thân` +
      (dependents > 0 ? ` − ${formatNumber(dependentRelief)} cho ${dependents} người phụ thuộc` : '') +
      `) = ${formatNumber(taxableIncome)}đ, lũy tiến ${result.steps.length} bậc`;
  }

  if (personalIncomeTax > 0 || taxMode !== 'NONE') {
    lines.push({
      code: SYSTEM_CODES.personalIncomeTax,
      name: 'Thuế thu nhập cá nhân',
      kind: 'DEDUCTION', quantity: null, rate: null,
      amount: personalIncomeTax, taxable: false, insurable: false,
      detail: taxDetail,
    });
  }

  scope.PIT = personalIncomeTax;
  scope.TAXABLE_INCOME = taxableIncome;

  // --- Khấu trừ khác --------------------------------------------------------
  let otherDeductions = 0;
  for (const assigned of sorted.filter((entry) => entry.component.kind === 'DEDUCTION')) {
    const line = computeComponentLine(
      assigned, scope, stats, standardDays, inputs, warnings, profile.name,
    );
    if (!line) continue;
    lines.push(line);
    scope[line.code] = line.amount;
    otherDeductions += line.amount;
  }

  // --- Chi phí doanh nghiệp -------------------------------------------------
  // Không trừ của nhân viên; chỉ để biết một người thực sự tốn bao nhiêu.
  //
  // Bảo hiểm phần doanh nghiệp tính NGAY TẠI ĐÂY từ cấu hình, giống hệt cách
  // phần người lao động được tính ở trên. Trước đây ba khoản ER_* là component
  // phải gán tay cho từng người, nên cùng một nghĩa vụ bảo hiểm lại có hai nơi
  // khai báo tỷ lệ và hai cách vận hành.
  let insuranceEmployer = 0;
  if (insuranceEnabled && rawInsuranceBase > 0) {
    const employerParts: Array<[string, string, number, number]> = [
      ['ER_SOCIAL', 'BHXH doanh nghiệp đóng', settings.employerSocialRate, cappedSocialBase],
      ['ER_HEALTH', 'BHYT doanh nghiệp đóng', settings.employerHealthRate, cappedSocialBase],
      ['ER_UNEMPLOY', 'BHTN doanh nghiệp đóng', settings.employerUnemploymentRate, cappedUnemployBase],
    ];

    for (const [code, name, rate, base] of employerParts) {
      if (rate <= 0) continue;
      const amount = round((base * rate) / 100);
      lines.push({
        code, name: `${name} (${rate}%)`, kind: 'EMPLOYER_COST',
        quantity: null, rate, amount, taxable: false, insurable: false,
        detail: `${rate}% × ${formatNumber(base)}đ mức đóng`,
      });
      scope[code] = amount;
      insuranceEmployer += amount;
    }
  }

  // Khoản chi phí doanh nghiệp KHÁC do HR tự định nghĩa (kinh phí công đoàn,
  // phúc lợi...) vẫn chạy qua component như trước.
  for (const assigned of sorted.filter((entry) => entry.component.kind === 'EMPLOYER_COST')) {
    const line = computeComponentLine(
      assigned, scope, stats, standardDays, inputs, warnings, profile.name,
    );
    if (!line) continue;
    lines.push(line);
    scope[line.code] = line.amount;
    insuranceEmployer += line.amount;
  }

  const netPay = gross - insuranceEmployee - personalIncomeTax - otherDeductions;

  if (netPay < 0) {
    warnings.push(
      `${profile.name}: thực nhận đang ÂM ${formatNumber(Math.abs(netPay))}đ — ` +
        'khoản khấu trừ vượt quá thu nhập, cần rà lại tạm ứng và khấu trừ khác.',
    );
  }

  return {
    payBasis: basis,
    stats,
    standardDays,
    hourlyRate: round(hourlyRate),
    insuranceBase: rawInsuranceBase,
    lines,
    gross: round(gross),
    taxableIncome: round(taxableIncome),
    insuranceEmployee: round(insuranceEmployee),
    insuranceEmployer: round(insuranceEmployer),
    personalIncomeTax: round(personalIncomeTax),
    taxSteps,
    otherDeductions: round(otherDeductions),
    netPay: round(netPay),
    snapshot: {
      pay_basis: basis,
      base_amount: baseAmount,
      standard_days: standardDays,
      hours_per_day: hoursPerDay,
      hourly_rate: round(hourlyRate),
      insurance_base: rawInsuranceBase,
      insurance_enabled: insuranceEnabled,
      insurance_cap_applied: rawInsuranceBase > settings.insuranceSalaryCap,
      social_insurance_rate: settings.socialInsuranceRate,
      health_insurance_rate: settings.healthInsuranceRate,
      unemployment_insurance_rate: settings.unemploymentInsuranceRate,
      employer_social_rate: settings.employerSocialRate,
      employer_health_rate: settings.employerHealthRate,
      employer_unemployment_rate: settings.employerUnemploymentRate,
      tax_mode: taxMode,
      flat_tax_rate: payProfile?.flat_tax_rate ?? null,
      dependents,
      personal_relief: personalRelief,
      dependent_relief: dependentRelief,
      tax_steps: taxSteps,
      inputs,
      computed_at: new Date().toISOString(),
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Chọn bản ghi có hiệu lực
// ---------------------------------------------------------------------------

/**
 * Cơ chế lương áp dụng cho kỳ: bản ghi mới nhất có `effective_from` không vượt
 * quá ngày cuối kỳ. Nhờ vậy tăng lương giữa chừng không làm sai lệch các tháng
 * đã qua — lịch sử lương giữ nguyên thay vì bị ghi đè như bảng cũ.
 */
export function payProfileForPeriod(
  profiles: EmployeePayProfile[],
  periodEnd: string,
): EmployeePayProfile | null {
  const eligible = profiles
    .filter((item) => item.effective_from <= periodEnd)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  return eligible[0] ?? null;
}

/** Khoản còn hiệu lực trong kỳ (đã bắt đầu, chưa kết thúc). */
export function itemsForPeriod(
  items: AssignedPayItem[],
  periodStart: string,
  periodEnd: string,
): AssignedPayItem[] {
  return items.filter(({ item, component }) => {
    if (!component.is_active) return false;
    if (item.effective_from > periodEnd) return false;
    if (item.effective_to && item.effective_to < periodStart) return false;
    return true;
  });
}

/**
 * Bộ biến mẫu để kiểm tra công thức lúc HR đang gõ, trước khi có dữ liệu thật.
 */
export function sampleFormulaScope(
  settings: PayrollParams,
  extraCodes: string[] = [],
): Record<string, number> {
  const standardDays = settings.standardWorkDays || 26;
  const hoursPerDay = settings.hoursPerDay || 8;
  const monthly = 15_000_000;

  const scope: Record<string, number> = {
    BASE: monthly,
    GROSS: monthly,
    HOURLY_RATE: monthly / standardDays / hoursPerDay,
    DAILY_RATE: monthly / standardDays,
    MONTHLY_RATE: monthly,
    WORK_DAYS: standardDays,
    LEAVE_DAYS: 0,
    PAID_DAYS: standardDays,
    STANDARD_DAYS: standardDays,
    WORK_HOURS: standardDays * hoursPerDay,
    HOURS_PER_DAY: hoursPerDay,
    DEPENDENTS: 1,
    INSURANCE_BASE: monthly,
    INSURANCE_EMPLOYEE: monthly * 0.105,
    PIT: 0,
    TAXABLE_INCOME: 0,
  };

  for (const code of extraCodes) {
    if (scope[code] === undefined) scope[code] = 1;
  }
  return scope;
}
