// Kiểm chứng engine lương. Chạy: npm run check:payroll
import { evaluateFormula } from '../payrollFormula';
import { computePayslip, progressiveIncomeTax, summarisePeriod } from '../payroll';
import { DEFAULT_PAYROLL_SETTINGS, toPayrollParams } from '../payrollSettings';
import type { EmployeePayProfile, PayComponent, EmployeePayItem, Profile } from '@/types';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`}`);
}

// --- Bộ đánh giá biểu thức --------------------------------------------------
const scope = { HOURLY_RATE: 100000, OT_WEEKDAY_HOURS: 10, REVENUE: 600_000_000, BASE: 15_000_000 };
check('nhân cơ bản', evaluateFormula('HOURLY_RATE * 1.5 * OT_WEEKDAY_HOURS', scope).value, 1_500_000);
check('ưu tiên toán tử', evaluateFormula('2 + 3 * 4', scope).value, 14);
check('ngoặc', evaluateFormula('(2 + 3) * 4', scope).value, 20);
check('MAX', evaluateFormula('MAX(BASE * 0.1, 2000000)', scope).value, 2_000_000);
check('IF bậc thang', evaluateFormula('IF(REVENUE > 500000000, REVENUE * 0.05, REVENUE * 0.03)', scope).value, 30_000_000);
check('ternary', evaluateFormula('REVENUE > 1000000000 ? 1 : 2', scope).value, 2);
check('gạch dưới trong số', evaluateFormula('1_000_000 + 1', scope).value, 1_000_001);
check('âm đơn', evaluateFormula('-BASE + 20000000', scope).value, 5_000_000);

function expectError(label: string, expr: string) {
  try {
    evaluateFormula(expr, scope);
    console.log(`FAIL  ${label} — đáng lẽ phải lỗi`);
    failures += 1;
  } catch {
    console.log(`PASS  ${label}`);
  }
}
expectError('chặn biến lạ', 'window.alert');
expectError('chặn chuỗi/eval', 'constructor("return 1")()');
expectError('chia 0', 'BASE / 0');
expectError('thiếu ngoặc', 'MAX(1, 2');

// --- Thuế lũy tiến ----------------------------------------------------------
// Thu nhập tính thuế 20tr: 5tr*5% + 5tr*10% + 8tr*15% + 2tr*20% = 250k+500k+1.2tr+400k
check('thuế 20tr', progressiveIncomeTax(20_000_000).tax, 2_350_000);
check('thuế 5tr', progressiveIncomeTax(5_000_000).tax, 250_000);
check('thuế 0', progressiveIncomeTax(0).tax, 0);
check('thuế âm', progressiveIncomeTax(-1_000_000).tax, 0);
// 100tr: 250k+500k+1.2tr+2.8tr+5tr+8.4tr+7tr = 25.15tr
check('thuế 100tr', progressiveIncomeTax(100_000_000).tax, 25_150_000);

// --- Tính phiếu lương -------------------------------------------------------
const profile = { id: 'u1', name: 'Nguyễn Văn A', department: 'Kinh doanh' } as Profile;
const settings = toPayrollParams(
  { ...DEFAULT_PAYROLL_SETTINGS, standardWorkDays: 26 },
  { standardHoursPerDay: 8 },
);

function payProfile(over: Partial<EmployeePayProfile>): EmployeePayProfile {
  return {
    id: 'p1', user_id: 'u1', effective_from: '2026-01-01', pay_basis: 'MONTHLY',
    base_amount: 20_000_000, insurance_base: null, insurance_enabled: true, dependents: 0,
    tax_mode: 'PROGRESSIVE', flat_tax_rate: 10, standard_days_override: null, note: null,
    created_by: null, created_at: '', updated_at: '', ...over,
  };
}

const stats = { workDays: 26, leaveDays: 0, paidDays: 26, workHours: 208, missingCheckout: 0 };

// Lương tháng đủ công, không phụ cấp, không người phụ thuộc.
const monthly = computePayslip({
  profile, payProfile: payProfile({}), items: [], inputs: {}, stats, settings,
});
check('gross lương tháng đủ công', monthly.gross, 20_000_000);
check('bảo hiểm 10.5%', monthly.insuranceEmployee, 2_100_000);
// TNCT = 20tr - 2.1tr - 11tr = 6.9tr -> 5tr*5% + 1.9tr*10% = 250k + 190k = 440k
check('thu nhập tính thuế', monthly.taxableIncome, 6_900_000);
check('thuế TNCN', monthly.personalIncomeTax, 440_000);
check('thực nhận', monthly.netPay, 20_000_000 - 2_100_000 - 440_000);

// Nghỉ không lương nửa tháng: lương theo công giảm, mức đóng bảo hiểm KHÔNG giảm.
const halfMonth = computePayslip({
  profile, payProfile: payProfile({}), items: [], inputs: {},
  stats: { workDays: 13, leaveDays: 0, paidDays: 13, workHours: 104, missingCheckout: 0 },
  settings,
});
check('nửa tháng công', halfMonth.gross, 10_000_000);
check('bảo hiểm giữ nguyên mức đóng', halfMonth.insuranceEmployee, 2_100_000);

// Người phụ thuộc kéo thuế xuống.
const withDependents = computePayslip({
  profile, payProfile: payProfile({ dependents: 2 }), items: [], inputs: {}, stats, settings,
});
// TNCT = 20tr - 2.1tr - 11tr - 8.8tr < 0 -> 0
check('2 người phụ thuộc thì hết thuế', withDependents.personalIncomeTax, 0);

// Bảo hiểm phần doanh nghiệp: engine tự tính, không cần gán khoản nào.
const erLines = monthly.lines.filter((l) => l.kind === 'EMPLOYER_COST');
check('3 dòng chi phí doanh nghiệp', erLines.length, 3);
check('BHXH doanh nghiệp 17.5%', erLines.find((l) => l.code === 'ER_SOCIAL')?.amount, Math.round(20_000_000 * 0.175));
check('BHYT doanh nghiệp 3%', erLines.find((l) => l.code === 'ER_HEALTH')?.amount, 600_000);
check('BHTN doanh nghiệp 1%', erLines.find((l) => l.code === 'ER_UNEMPLOY')?.amount, 200_000);
check('tổng chi phí doanh nghiệp', monthly.insuranceEmployer, Math.round(20_000_000 * 0.215));
check('không trừ vào thực nhận', monthly.netPay, 20_000_000 - 2_100_000 - 440_000);

// Không tham gia bảo hiểm thì doanh nghiệp cũng không tốn phần đóng.
const noIns = computePayslip({
  profile, payProfile: payProfile({ insurance_enabled: false }), items: [], inputs: {}, stats, settings,
});
check('tắt bảo hiểm thì DN không đóng', noIns.insuranceEmployer, 0);

// Lương giờ.
const hourly = computePayslip({
  profile,
  payProfile: payProfile({ pay_basis: 'HOURLY', base_amount: 60_000, insurance_enabled: false }),
  items: [], inputs: {},
  stats: { workDays: 20, leaveDays: 0, paidDays: 20, workHours: 152, missingCheckout: 0 },
  settings,
});
check('lương giờ', hourly.gross, 60_000 * 152);
check('không đóng bảo hiểm', hourly.insuranceEmployee, 0);

// Trần đóng bảo hiểm với lương rất cao.
const highEarner = computePayslip({
  profile, payProfile: payProfile({ base_amount: 200_000_000 }), items: [], inputs: {}, stats, settings,
});
// BHXH+BHYT trên trần 46.8tr = 9.5%; BHTN trên trần 99.2tr = 1%
check('trần bảo hiểm', highEarner.insuranceEmployee,
  Math.round(46_800_000 * 0.095) + Math.round(99_200_000 * 0.01));

// Hoa hồng theo công thức bậc thang + tăng ca.
const component = (over: Partial<PayComponent>): PayComponent => ({
  id: 'c', code: 'X', name: 'X', kind: 'EARNING', calc_type: 'FIXED', default_amount: 0,
  input_code: null, base_code: null, formula: null, taxable: true, insurable: false,
  prorate: false, sort_order: 100, is_active: true, is_system: false, note: null,
  created_at: '', updated_at: '', ...over,
});
const item = (componentId: string, over: Partial<EmployeePayItem> = {}): EmployeePayItem => ({
  id: 'i', user_id: 'u1', component_id: componentId, amount: null, formula: null,
  effective_from: '2026-01-01', effective_to: null, note: null, created_by: null,
  created_at: '', updated_at: '', ...over,
});

const otComponent = component({
  id: 'c1', code: 'OT_WEEKDAY', name: 'Tăng ca 150%', calc_type: 'FORMULA',
  input_code: 'OT_WEEKDAY_HOURS', formula: 'HOURLY_RATE * 1.5 * OT_WEEKDAY_HOURS', sort_order: 210,
});
const commissionComponent = component({
  id: 'c2', code: 'COMMISSION', name: 'Hoa hồng', calc_type: 'FORMULA',
  formula: 'IF(REVENUE > 500000000, REVENUE * 0.05, REVENUE * 0.03)', sort_order: 320,
});

const sales = computePayslip({
  profile,
  payProfile: payProfile({ pay_basis: 'COMMISSION', base_amount: 8_000_000 }),
  items: [
    { item: item('c1'), component: otComponent },
    { item: item('c2'), component: commissionComponent },
  ],
  inputs: { OT_WEEKDAY_HOURS: 10, REVENUE: 600_000_000 },
  stats, settings,
});
// hourly rate = 8tr/26/8 = 38461.538..
const expectedOt = Math.round((8_000_000 / 26 / 8) * 1.5 * 10);
check('tăng ca theo công thức', sales.lines.find((l) => l.code === 'OT_WEEKDAY')?.amount, expectedOt);
check('hoa hồng bậc thang', sales.lines.find((l) => l.code === 'COMMISSION')?.amount, 30_000_000);
check('gross sales', sales.gross, 8_000_000 + expectedOt + 30_000_000);

// Khoản % trên khoản đứng sau nó -> cảnh báo, không làm sập phiếu.
const badPercent = component({
  id: 'c3', code: 'BAD', name: 'Sai thứ tự', calc_type: 'PERCENT', base_code: 'NOT_YET',
  default_amount: 10, sort_order: 10,
});
const withBad = computePayslip({
  profile, payProfile: payProfile({}), items: [{ item: item('c3'), component: badPercent }],
  inputs: {}, stats, settings,
});
check('khoản lỗi không làm sập phiếu', withBad.gross, 20_000_000);
check('có cảnh báo', withBad.warnings.length > 0, true);

// Công thức hỏng cũng chỉ cảnh báo.
const brokenFormula = component({
  id: 'c4', code: 'BROKEN', name: 'Công thức hỏng', calc_type: 'FORMULA',
  formula: 'KHONG_CO_BIEN_NAY * 2', sort_order: 400,
});
const withBroken = computePayslip({
  profile, payProfile: payProfile({}), items: [{ item: item('c4'), component: brokenFormula }],
  inputs: {}, stats, settings,
});
check('công thức hỏng vẫn ra phiếu', withBroken.gross, 20_000_000);
check('cảnh báo công thức hỏng', withBroken.warnings.some((w) => w.includes('Công thức hỏng')), true);

// Thiếu cơ chế lương.
const noProfile = computePayslip({ profile, payProfile: null, items: [], inputs: {}, stats, settings });
check('không có cơ chế lương thì 0đ', noProfile.netPay, 0);
check('cảnh báo thiếu cơ chế', noProfile.warnings.length > 0, true);

// Tiền ăn ca không chịu thuế.
const mealComponent = component({
  id: 'c5', code: 'ALLOW_MEAL', name: 'Tiền ăn ca', calc_type: 'FIXED',
  default_amount: 730_000, taxable: false, prorate: true, sort_order: 120,
});
const withMeal = computePayslip({
  profile, payProfile: payProfile({}), items: [{ item: item('c5'), component: mealComponent }],
  inputs: {}, stats, settings,
});
check('ăn ca vào gross', withMeal.gross, 20_730_000);
check('ăn ca không làm tăng thuế', withMeal.personalIncomeTax, monthly.personalIncomeTax);

// Thuế khoán 10% cho hợp đồng ngắn hạn.
const flat = computePayslip({
  profile, payProfile: payProfile({ tax_mode: 'FLAT', flat_tax_rate: 10, insurance_enabled: false }),
  items: [], inputs: {}, stats, settings,
});
check('thuế khoán 10%', flat.personalIncomeTax, 2_000_000);

// --- Tổng hợp công ----------------------------------------------------------
const att = [
  { id: 'a1', user_id: 'u1', date: '2026-09-01', check_in_time: '2026-09-01T01:00:00Z', check_out_time: '2026-09-01T10:00:00Z' },
  { id: 'a2', user_id: 'u1', date: '2026-09-02', check_in_time: '2026-09-02T01:00:00Z', check_out_time: null },
  { id: 'a3', user_id: 'u1', date: '2026-09-01', check_in_time: '2026-09-01T01:00:00Z', check_out_time: '2026-09-01T10:00:00Z' },
] as any[];
const leaveReqs = [{ user_id: 'u1', start_date: '2026-09-07', end_date: '2026-09-08', half_day: false }] as any[];
const summary = summarisePeriod(att, leaveReqs, new Date(2026, 8, 1), 8);
check('ngày công đếm theo ngày duy nhất', summary.workDays, 2);
check('giờ làm', summary.workHours, 18);
check('thiếu check-out', summary.missingCheckout, 1);
check('ngày phép trong tháng', summary.leaveDays, 2);

console.log(failures === 0 ? '\nTất cả kiểm chứng đều đạt.' : `\n${failures} kiểm chứng KHÔNG đạt.`);
process.exit(failures === 0 ? 0 : 1);
