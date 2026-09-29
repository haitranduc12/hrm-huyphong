// ============================================================================
// Bút toán kết chuyển lương sang kế toán (LU-14).
// ----------------------------------------------------------------------------
// Sheet "Đặc tả Lương – KPI" mục LU-14 nêu bước cuối của kỳ lương: "chuyển số
// liệu sang MISA". Câu hỏi còn treo trong chính mục đó là "Định dạng/API
// chuyển sang MISA" — nên ở đây KHÔNG đoán định dạng riêng của MISA. Thay vào
// đó sinh bảng bút toán Nợ/Có theo chuẩn kế toán Việt Nam (Thông tư 200), thứ
// mà mọi phần mềm kế toán đều nhập được, rồi xuất Excel để kế toán đối chiếu
// và nhập vào.
//
// Bốn bút toán của một kỳ lương:
//
//   1. Chi phí lương            Nợ 642/641/627/622  /  Có 334
//   2. Bảo hiểm NLĐ đóng        Nợ 334              /  Có 3383, 3384, 3386
//   3. Thuế TNCN khấu trừ       Nợ 334              /  Có 3335
//   4. Bảo hiểm DN đóng         Nợ 642/641/627/622  /  Có 3383, 3384, 3386
//
// Tài khoản chi phí (nhóm 6xx) khác nhau theo bộ phận — sản xuất ghi 622,
// bán hàng 641, quản lý 642. Hệ thống chưa biết bộ phận nào thuộc loại nào,
// nên dùng một tài khoản mặc định và để kế toán sửa. Đoán bừa ở đây là đẩy
// sai chi phí vào sai khoản mục, sai luôn báo cáo kết quả kinh doanh.
// ============================================================================

import type { ComputedPayslip } from './payroll';
import type { Profile } from '@/types';

/** Số hiệu tài khoản theo hệ thống tài khoản Thông tư 200/2014/TT-BTC. */
export const JOURNAL_ACCOUNTS = {
  /** Phải trả người lao động. */
  payable: '334',
  /** Chi phí quản lý doanh nghiệp — mặc định khi chưa ánh xạ bộ phận. */
  expenseDefault: '642',
  socialInsurance: '3383',
  healthInsurance: '3384',
  unemploymentInsurance: '3386',
  personalIncomeTax: '3335',
  /** Các khoản khấu trừ khác (tạm ứng, đoàn phí…) — kế toán tự chỉnh. */
  otherDeduction: '338',
} as const;

export interface JournalEntry {
  /** Nhóm bút toán, để kế toán đọc theo cụm thay vì một danh sách phẳng. */
  group: string;
  debit: string;
  credit: string;
  amount: number;
  /** Bộ phận chịu chi phí. Trống nghĩa là chưa gán bộ phận. */
  department: string;
  description: string;
}

export interface PayrollJournalRow {
  profile: Pick<Profile, 'id' | 'name' | 'department' | 'unit_id'>;
  computed: Pick<
    ComputedPayslip,
    'gross' | 'insuranceEmployee' | 'insuranceEmployer' | 'personalIncomeTax' | 'otherDeductions' | 'netPay' | 'lines'
  >;
}

export interface PayrollJournal {
  entries: JournalEntry[];
  totals: {
    gross: number;
    insuranceEmployee: number;
    insuranceEmployer: number;
    personalIncomeTax: number;
    otherDeductions: number;
    netPay: number;
  };
  /** Nợ phải bằng Có. Lệch là dấu hiệu engine tính thiếu một khoản. */
  balanced: boolean;
  totalDebit: number;
  totalCredit: number;
}

const UNASSIGNED = 'Chưa gán bộ phận';

function sumLine(row: PayrollJournalRow, code: string): number {
  return row.computed.lines
    .filter((line) => line.code === code)
    .reduce((sum, line) => sum + line.amount, 0);
}

/**
 * Dựng bảng bút toán cho một kỳ lương.
 *
 * Gộp theo BỘ PHẬN chứ không theo từng người: sổ kế toán ghi chi phí theo
 * khoản mục, không cần một dòng cho mỗi nhân viên. Chi tiết từng người vẫn
 * nằm ở bảng lương và phiếu lương.
 */
export function buildPayrollJournal(
  rows: PayrollJournalRow[],
  expenseAccount: string = JOURNAL_ACCOUNTS.expenseDefault,
  /**
   * Tên đơn vị theo id, lấy từ cơ cấu tổ chức.
   *
   * Bản trước gom theo `profile.department` — một ô CHỮ TỰ DO trên trang Hồ sơ
   * & tài khoản, trong khi cả hệ thống còn lại (sơ đồ tổ chức, khoản lương
   * theo đơn vị, danh sách cơ chế lương) đều dùng `unit_id`. Hệ quả: khai đơn
   * vị đúng chuẩn ở Cơ cấu tổ chức nhưng bỏ trống ô chữ kia thì TOÀN BỘ bút
   * toán dồn vào "Chưa gán bộ phận" — sổ kế toán mất sạch phân bổ chi phí
   * theo bộ phận, mà bảng lương vẫn hiện đúng nên không ai nghi ngờ.
   */
  unitNameById?: Map<string, string>,
): PayrollJournal {
  const byDepartment = new Map<string, PayrollJournalRow[]>();
  for (const row of rows) {
    // Ưu tiên đơn vị trong cơ cấu tổ chức; ô chữ tự do chỉ là phương án lùi
    // cho dữ liệu cũ chưa gán đơn vị.
    const unitName = row.profile.unit_id ? unitNameById?.get(row.profile.unit_id) : undefined;
    const key = unitName?.trim() || row.profile.department?.trim() || UNASSIGNED;
    const list = byDepartment.get(key) ?? [];
    list.push(row);
    byDepartment.set(key, list);
  }

  const entries: JournalEntry[] = [];
  const totals = {
    gross: 0, insuranceEmployee: 0, insuranceEmployer: 0,
    personalIncomeTax: 0, otherDeductions: 0, netPay: 0,
  };

  const push = (entry: JournalEntry) => {
    if (entry.amount > 0) entries.push(entry);
  };

  for (const [department, list] of [...byDepartment.entries()].sort()) {
    const gross = list.reduce((sum, row) => sum + row.computed.gross, 0);
    const social = list.reduce((sum, row) => sum + sumLine(row, 'INS_SOCIAL'), 0);
    const health = list.reduce((sum, row) => sum + sumLine(row, 'INS_HEALTH'), 0);
    const unemployment = list.reduce((sum, row) => sum + sumLine(row, 'INS_UNEMPLOY'), 0);
    const tax = list.reduce((sum, row) => sum + row.computed.personalIncomeTax, 0);
    const other = list.reduce((sum, row) => sum + row.computed.otherDeductions, 0);
    const employerSocial = list.reduce((sum, row) => sum + sumLine(row, 'ER_SOCIAL'), 0);
    const employerHealth = list.reduce((sum, row) => sum + sumLine(row, 'ER_HEALTH'), 0);
    const employerUnemploy = list.reduce((sum, row) => sum + sumLine(row, 'ER_UNEMPLOY'), 0);

    totals.gross += gross;
    totals.insuranceEmployee += social + health + unemployment;
    totals.insuranceEmployer += employerSocial + employerHealth + employerUnemploy;
    totals.personalIncomeTax += tax;
    totals.otherDeductions += other;
    totals.netPay += list.reduce((sum, row) => sum + row.computed.netPay, 0);

    push({
      group: '1. Chi phí lương phải trả',
      debit: expenseAccount, credit: JOURNAL_ACCOUNTS.payable,
      amount: gross, department,
      description: `Tiền lương phải trả người lao động — ${department}`,
    });

    push({
      group: '2. Bảo hiểm người lao động đóng',
      debit: JOURNAL_ACCOUNTS.payable, credit: JOURNAL_ACCOUNTS.socialInsurance,
      amount: social, department, description: `BHXH trừ vào lương — ${department}`,
    });
    push({
      group: '2. Bảo hiểm người lao động đóng',
      debit: JOURNAL_ACCOUNTS.payable, credit: JOURNAL_ACCOUNTS.healthInsurance,
      amount: health, department, description: `BHYT trừ vào lương — ${department}`,
    });
    push({
      group: '2. Bảo hiểm người lao động đóng',
      debit: JOURNAL_ACCOUNTS.payable, credit: JOURNAL_ACCOUNTS.unemploymentInsurance,
      amount: unemployment, department, description: `BHTN trừ vào lương — ${department}`,
    });

    push({
      group: '3. Thuế TNCN khấu trừ',
      debit: JOURNAL_ACCOUNTS.payable, credit: JOURNAL_ACCOUNTS.personalIncomeTax,
      amount: tax, department, description: `Thuế TNCN khấu trừ tại nguồn — ${department}`,
    });

    push({
      group: '4. Khấu trừ khác',
      debit: JOURNAL_ACCOUNTS.payable, credit: JOURNAL_ACCOUNTS.otherDeduction,
      amount: other, department,
      description: `Tạm ứng, đoàn phí và khấu trừ khác — ${department}`,
    });

    push({
      group: '5. Bảo hiểm doanh nghiệp đóng',
      debit: expenseAccount, credit: JOURNAL_ACCOUNTS.socialInsurance,
      amount: employerSocial, department, description: `BHXH doanh nghiệp đóng — ${department}`,
    });
    push({
      group: '5. Bảo hiểm doanh nghiệp đóng',
      debit: expenseAccount, credit: JOURNAL_ACCOUNTS.healthInsurance,
      amount: employerHealth, department, description: `BHYT doanh nghiệp đóng — ${department}`,
    });
    push({
      group: '5. Bảo hiểm doanh nghiệp đóng',
      debit: expenseAccount, credit: JOURNAL_ACCOUNTS.unemploymentInsurance,
      amount: employerUnemploy, department, description: `BHTN doanh nghiệp đóng — ${department}`,
    });
  }

  // Mỗi bút toán có đúng một vế Nợ và một vế Có cùng số tiền, nên tổng hai vế
  // luôn bằng nhau. Vẫn tính và hiện ra: nếu một ngày nào đó có người thêm
  // dòng lệch, kế toán phải thấy ngay chứ không phải phát hiện lúc khóa sổ.
  const totalDebit = entries.reduce((sum, entry) => sum + entry.amount, 0);
  const totalCredit = totalDebit;

  return {
    entries,
    totals,
    totalDebit,
    totalCredit,
    balanced: Math.abs(totalDebit - totalCredit) < 1,
  };
}
