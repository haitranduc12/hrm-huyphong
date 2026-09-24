// ============================================================================
// Bảng lương.
// ----------------------------------------------------------------------------
// Bản trước tính lương ngay trong render bằng một công thức cứng áp cho tất cả
// mọi người, và tính lại từ đầu mỗi lần mở trang — nên bảng lương tháng trước
// đổi theo cấu hình hôm nay. Bản này:
//
//   1. Lương gốc tính theo cơ chế riêng của từng người (tháng/giờ/ngày/khoán/
//      hoa hồng), các khoản cộng trừ chạy qua bộ máy ở `lib/payroll.ts`.
//   2. Kỳ lương có vòng đời DRAFT → CALCULATED → APPROVED → PAID. Duyệt xong
//      là số liệu đóng băng xuống `payslips`, không tính lại nữa.
//   3. Mỗi dòng tiền có câu giải thích, nên kế toán trả lời được câu hỏi
//      "sao tháng này ít hơn" mà không phải mở Excel.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { endOfMonth, format, startOfMonth } from 'date-fns';
import {
  Calculator, CheckCircle2, FileSpreadsheet, LockKeyhole, Pencil, Receipt,
  RotateCcw, Scale, ShieldAlert, SlidersHorizontal, TriangleAlert, Users, Wallet,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ErrorState } from '@/components/ui/ErrorState';
import { MonthNav } from '@/components/ui/MonthNav';
import { TableSkeleton } from '@/components/ui/Skeleton';
import { WorkflowStrip } from '@/components/WorkflowStrip';
import { PaySchemeModal } from '@/components/payroll/PaySchemeModal';
import { ComponentCatalog } from '@/components/payroll/ComponentCatalog';
import { PayslipBreakdown } from '@/components/payroll/PayslipBreakdown';
import { MonthlyInputsTab } from '@/components/payroll/MonthlyInputsTab';
import { useToast } from '@/contexts/ToastContext';
import { useConfirm } from '@/contexts/ConfirmContext';
import { useAuth } from '@/contexts/AuthContext';
import { useAppSettings } from '@/contexts/SettingsContext';
import { useRealtimeSync } from '@/hooks/useRealtimeSync';
import { hasAdminFunction } from '@/lib/permissions';
import { formatVND, toDateString } from '@/lib/utils';
import {
  computePayslip, itemsForPeriod, payBasisLabel, payProfileForPeriod, summarisePeriod,
  type AssignedPayItem, type ComputedPayslip,
} from '@/lib/payroll';
import {
  ensurePayrollRun, loadPayrollWorkspace, persistPayslips, setRunStatus,
  type PayrollWorkspace,
} from '@/lib/payrollData';
import { DEFAULT_PAYROLL_SETTINGS, toPayrollParams } from '@/lib/payrollSettings';
import { PayrollParamsTab } from '@/components/payroll/PayrollParamsTab';
import type { Profile } from '@/types';

type Tab = 'register' | 'schemes' | 'inputs' | 'catalog' | 'params';

const TABS: Array<{ id: Tab; label: string; icon: typeof Wallet }> = [
  { id: 'register', label: 'Bảng lương', icon: Wallet },
  { id: 'schemes', label: 'Cơ chế lương', icon: Users },
  { id: 'inputs', label: 'Số liệu tháng', icon: SlidersHorizontal },
  { id: 'catalog', label: 'Danh mục khoản', icon: Receipt },
  { id: 'params', label: 'Tham số lương', icon: Scale },
];

const RUN_STATUS_LABEL = {
  DRAFT: 'Bản nháp',
  CALCULATED: 'Đã tính',
  APPROVED: 'Đã duyệt',
  PAID: 'Đã chi trả',
} as const;

interface PayrollRow {
  profile: Profile;
  computed: ComputedPayslip;
  hasScheme: boolean;
  /** Đọc từ phiếu đã đóng băng thay vì tính lại. */
  frozen: boolean;
}

export function AdminPayroll() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { profile } = useAuth();
  const { toast } = useToast();
  const confirm = useConfirm();
  const settings = useAppSettings();

  const [monthStart, setMonthStart] = useState(() => startOfMonth(new Date()));
  const [tab, setTab] = useState<Tab>('register');
  const [data, setData] = useState<PayrollWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [schemeTarget, setSchemeTarget] = useState<Profile | null>(null);
  const [detailUserId, setDetailUserId] = useState<string | null>(null);

  const monthStartStr = toDateString(monthStart);
  const monthEndStr = toDateString(endOfMonth(monthStart));
  const monthLabel = format(monthStart, 'MM/yyyy');
  const canView = hasAdminFunction(profile, 'admin.payroll');

  const loadData = async (silent = false) => {
    if (!canView) { setLoading(false); return; }
    if (!silent) setLoading(true);
    setData(await loadPayrollWorkspace(monthStartStr, monthEndStr));
    setLoading(false);
  };

  useEffect(() => { void loadData(); }, [monthStartStr, canView]); // eslint-disable-line react-hooks/exhaustive-deps

  useRealtimeSync(
    [
      { table: 'attendance' }, { table: 'leave_requests' }, { table: 'timesheet_periods' },
      { table: 'employee_pay_profiles' }, { table: 'employee_pay_items' },
      { table: 'payroll_components' }, { table: 'payroll_inputs' }, { table: 'payroll_runs' },
    ],
    () => loadData(true),
    { enabled: canView, channelKey: 'payroll' },
  );

  // Tham số tính lương lấy từ `payroll_settings` (module lương, chỉ Admin/CEO
  // ghi được), ghép thêm giờ chuẩn mỗi ngày từ cấu hình hệ thống — con số đó
  // dùng chung với Bảng công nên vẫn thuộc về cấu hình.
  const params = useMemo(
    () => toPayrollParams(data?.payrollSettings ?? DEFAULT_PAYROLL_SETTINGS, settings),
    [data?.payrollSettings, settings],
  );

  // --------------------------------------------------------------------------
  // Tính bảng lương
  // --------------------------------------------------------------------------
  const rows: PayrollRow[] = useMemo(() => {
    if (!data) return [];

    const componentById = new Map(data.components.map((component) => [component.id, component]));
    // Kỳ đã duyệt thì hiển thị đúng con số đã chốt, KHÔNG tính lại. Đây là
    // điểm khác căn bản so với bản cũ: lương đã trả không đổi theo cấu hình.
    const frozen = data.run?.status === 'APPROVED' || data.run?.status === 'PAID';

    if (frozen && data.payslips.length > 0) {
      const linesBySlip = new Map<string, typeof data.payslipLines>();
      for (const line of data.payslipLines) {
        const list = linesBySlip.get(line.payslip_id) ?? [];
        list.push(line);
        linesBySlip.set(line.payslip_id, list);
      }

      return data.payslips.map((slip) => {
        const owner = data.profiles.find((item) => item.id === slip.user_id);
        const lines = (linesBySlip.get(slip.id) ?? []).map((line) => ({
          code: line.code, name: line.name, kind: line.kind,
          quantity: line.quantity, rate: line.rate, amount: Number(line.amount),
          taxable: line.taxable, insurable: line.insurable, detail: line.detail ?? '',
        }));

        return {
          profile: owner ?? ({ id: slip.user_id, name: slip.employee_name, department: slip.department } as Profile),
          hasScheme: true,
          frozen: true,
          computed: {
            payBasis: slip.pay_basis,
            stats: {
              workDays: Number(slip.work_days), leaveDays: Number(slip.leave_days),
              paidDays: Number(slip.paid_days), workHours: Number(slip.work_hours), missingCheckout: 0,
            },
            standardDays: Number(slip.standard_days),
            hourlyRate: 0,
            insuranceBase: 0,
            lines,
            gross: Number(slip.gross_pay),
            taxableIncome: Number(slip.taxable_income),
            insuranceEmployee: Number(slip.insurance_employee),
            insuranceEmployer: Number(slip.insurance_employer),
            personalIncomeTax: Number(slip.personal_income_tax),
            taxSteps: [],
            otherDeductions: Number(slip.other_deductions),
            netPay: Number(slip.net_pay),
            snapshot: slip.snapshot,
            warnings: [],
          },
        };
      });
    }

    return data.profiles.map((person) => {
      const payProfile = payProfileForPeriod(
        data.payProfiles.filter((item) => item.user_id === person.id),
        monthEndStr,
      );

      const assigned: AssignedPayItem[] = data.items
        .filter((item) => item.user_id === person.id)
        .map((item) => ({ item, component: componentById.get(item.component_id) }))
        .filter((entry): entry is AssignedPayItem => !!entry.component);

      const inputs: Record<string, number> = {};
      for (const input of data.inputs) {
        if (input.user_id === person.id) inputs[input.code] = Number(input.quantity);
      }

      const stats = summarisePeriod(
        data.attendance.filter((record) => record.user_id === person.id),
        data.leaves.filter((leave) => leave.user_id === person.id),
        monthStart,
        params.hoursPerDay,
      );

      return {
        profile: person,
        hasScheme: !!payProfile,
        frozen: false,
        computed: computePayslip({
          profile: person,
          payProfile,
          items: itemsForPeriod(assigned, monthStartStr, monthEndStr),
          inputs,
          stats,
          settings: params,
        }),
      };
    });
  }, [data, monthStartStr, monthEndStr, settings]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedUserId = searchParams.get('user');
  const visibleRows = selectedUserId
    ? rows.filter((row) => row.profile.id === selectedUserId)
    : rows;

  const totals = useMemo(() => ({
    gross: visibleRows.reduce((sum, row) => sum + row.computed.gross, 0),
    insurance: visibleRows.reduce((sum, row) => sum + row.computed.insuranceEmployee, 0),
    tax: visibleRows.reduce((sum, row) => sum + row.computed.personalIncomeTax, 0),
    other: visibleRows.reduce((sum, row) => sum + row.computed.otherDeductions, 0),
    net: visibleRows.reduce((sum, row) => sum + row.computed.netPay, 0),
    employer: visibleRows.reduce((sum, row) => sum + row.computed.insuranceEmployer, 0),
  }), [visibleRows]);

  const allWarnings = useMemo(
    () => [...new Set(rows.flatMap((row) => row.computed.warnings))],
    [rows],
  );
  const missingSchemeCount = rows.filter((row) => !row.hasScheme && row.computed.stats.paidDays > 0).length;

  const runStatus = data?.run?.status ?? 'DRAFT';
  const isFrozen = runStatus === 'APPROVED' || runStatus === 'PAID';
  const detailRow = detailUserId ? rows.find((row) => row.profile.id === detailUserId) : null;

  // --------------------------------------------------------------------------
  // Vòng đời kỳ lương
  // --------------------------------------------------------------------------
  const handleCalculate = async () => {
    if (!data) return;
    setBusy(true);
    const { run, error } = await ensurePayrollRun(monthStartStr, profile?.id ?? null);
    if (error || !run) {
      setBusy(false);
      toast('Không tạo được kỳ lương: ' + (error ?? 'lỗi không rõ'), 'error');
      return;
    }

    const persistError = await persistPayslips(
      run,
      rows.filter((row) => row.hasScheme).map((row) => ({ profile: row.profile, computed: row.computed })),
    );
    if (persistError) {
      setBusy(false);
      toast('Ghi phiếu lương thất bại: ' + persistError, 'error');
      return;
    }

    if (run.status === 'DRAFT') {
      const statusError = await setRunStatus(run.id, 'CALCULATED', profile?.id ?? null);
      if (statusError) {
        setBusy(false);
        toast('Không chuyển được trạng thái kỳ: ' + statusError, 'error');
        return;
      }
    }

    setBusy(false);
    toast(`Đã tính và lưu ${rows.filter((row) => row.hasScheme).length} phiếu lương tháng ${monthLabel}.`, 'success');
    void loadData(true);
  };

  const handleApprove = async () => {
    if (!data?.run) return;
    const ok = await confirm({
      title: `Duyệt bảng lương tháng ${monthLabel}?`,
      message:
        `Tổng thực chi ${formatVND(totals.net)} cho ${visibleRows.length} nhân sự. ` +
        'Sau khi duyệt, số liệu đóng băng: đổi cấu hình hay chấm công cũng không làm đổi ' +
        'phiếu lương này nữa. Muốn sửa phải mở lại kỳ.',
      confirmLabel: 'Duyệt bảng lương',
    });
    if (!ok) return;

    setBusy(true);
    const error = await setRunStatus(data.run.id, 'APPROVED', profile?.id ?? null);
    setBusy(false);
    if (error) {
      toast('Duyệt thất bại: ' + error, 'error');
      return;
    }
    toast('Đã duyệt bảng lương. Nhân viên xem được phiếu của mình.', 'success');
    void loadData(true);
  };

  const handleMarkPaid = async () => {
    if (!data?.run) return;
    setBusy(true);
    const error = await setRunStatus(data.run.id, 'PAID', profile?.id ?? null);
    setBusy(false);
    if (error) {
      toast('Cập nhật thất bại: ' + error, 'error');
      return;
    }
    toast('Đã đánh dấu kỳ lương là đã chi trả.', 'success');
    void loadData(true);
  };

  const handleReopen = async () => {
    if (!data?.run) return;
    const ok = await confirm({
      title: `Mở lại kỳ lương tháng ${monthLabel}?`,
      message:
        'Phiếu lương hiện tại sẽ hết hiệu lực và nhân viên không xem được nữa cho tới khi ' +
        'bạn tính và duyệt lại. Chỉ làm khi thực sự cần sửa số liệu đã chốt.',
      confirmLabel: 'Mở lại kỳ',
      danger: true,
    });
    if (!ok) return;

    setBusy(true);
    const error = await setRunStatus(data.run.id, 'DRAFT', profile?.id ?? null);
    setBusy(false);
    if (error) {
      toast('Mở lại thất bại: ' + error, 'error');
      return;
    }
    toast('Đã mở lại kỳ lương.', 'success');
    void loadData(true);
  };

  // --------------------------------------------------------------------------
  const handleExport = async () => {
    setExporting(true);
    try {
      const XLSX = await import('xlsx');
      // Mỗi khoản một cột: kế toán đối chiếu được từng khoản thay vì chỉ thấy
      // ba con số tổng như bản cũ.
      const codes = [...new Set(
        visibleRows.flatMap((row) => row.computed.lines.map((line) => `${line.kind}|${line.code}|${line.name}`)),
      )];
      const earningCols = codes.filter((key) => key.startsWith('EARNING|'));
      const deductionCols = codes.filter((key) => key.startsWith('DEDUCTION|'));
      const nameOf = (key: string) => key.split('|')[2];

      const header = [
        'STT', 'Mã NV', 'Họ tên', 'Bộ phận', 'Cơ chế', 'Ngày công', 'Ngày phép', 'Giờ làm',
        ...earningCols.map(nameOf),
        'TỔNG THU NHẬP',
        ...deductionCols.map(nameOf),
        'TỔNG KHẤU TRỪ', 'THỰC NHẬN',
      ];

      const amountFor = (row: PayrollRow, key: string) => {
        const [, code] = key.split('|');
        return row.computed.lines.find((line) => line.code === code)?.amount ?? 0;
      };

      const sheet: (string | number)[][] = [
        [`BẢNG LƯƠNG THÁNG ${monthLabel}`],
        [`Trạng thái kỳ: ${RUN_STATUS_LABEL[runStatus]}${isFrozen ? ' (số liệu đã đóng băng)' : ' (bản xem trước)'}`],
        [
          `Bảo hiểm NLĐ: BHXH ${params.socialInsuranceRate}% + BHYT ${params.healthInsuranceRate}% + ` +
          `BHTN ${params.unemploymentInsuranceRate}%. Thuế TNCN lũy tiến 7 bậc, giảm trừ bản thân ` +
          `${formatVND(params.taxPersonalDeduction)}, mỗi người phụ thuộc ${formatVND(params.taxDependentDeduction)}.`,
        ],
        [],
        header,
        ...visibleRows.map((row, index) => [
          index + 1,
          row.profile.employee_code ?? '',
          row.profile.name,
          row.profile.department ?? '',
          payBasisLabel(row.computed.payBasis),
          row.computed.stats.workDays,
          row.computed.stats.leaveDays,
          row.computed.stats.workHours,
          ...earningCols.map((key) => amountFor(row, key)),
          row.computed.gross,
          ...deductionCols.map((key) => amountFor(row, key)),
          row.computed.insuranceEmployee + row.computed.personalIncomeTax + row.computed.otherDeductions,
          row.computed.netPay,
        ]),
        [],
        [
          '', '', 'TỔNG CỘNG', '', '', '', '', '',
          ...earningCols.map((key) => visibleRows.reduce((sum, row) => sum + amountFor(row, key), 0)),
          totals.gross,
          ...deductionCols.map((key) => visibleRows.reduce((sum, row) => sum + amountFor(row, key), 0)),
          totals.insurance + totals.tax + totals.other,
          totals.net,
        ],
        [],
        [`Chi phí bảo hiểm doanh nghiệp đóng thêm: ${formatVND(totals.employer)}`],
        [`Tổng chi phí nhân sự: ${formatVND(totals.gross + totals.employer)}`],
      ];

      const worksheet = XLSX.utils.aoa_to_sheet(sheet);
      worksheet['!cols'] = header.map((_, index) =>
        index === 2 ? { wch: 24 } : index < 5 ? { wch: 14 } : { wch: 16 });
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Bảng lương');
      XLSX.writeFile(workbook, `bang-luong-${format(monthStart, 'yyyy-MM')}.xlsx`);
      toast(`Đã xuất bảng lương tháng ${monthLabel}.`, 'success');
    } catch (error) {
      toast('Xuất Excel thất bại: ' + (error instanceof Error ? error.message : String(error)), 'error');
    }
    setExporting(false);
  };

  // --------------------------------------------------------------------------
  if (!canView) {
    return (
      <Card>
        <CardContent>
          <p className="flex items-start gap-2.5 py-4 text-sm leading-relaxed text-slate-500">
            <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-500" />
            Bảng lương chỉ dành cho <strong className="text-slate-700">Admin / CEO</strong>. Dữ liệu lương
            không mở theo quyền lẻ — kể cả người được cấp quyền Chấm công cũng không xem được.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return <div className="rounded-2xl border border-slate-200 bg-white p-5"><TableSkeleton rows={6} /></div>;
  }
  if (data?.error) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white">
        <ErrorState message={data.error} onRetry={() => loadData()} />
      </div>
    );
  }
  if (data && !data.engineReady) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <Calculator className="mx-auto h-11 w-11 text-slate-300" />
          <h2 className="mt-3 text-lg font-bold text-slate-800">Chưa bật bộ máy tính lương</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-slate-500">
            Cần chạy migration{' '}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">
              supabase/migrations/20260921090000_payroll_engine.sql
            </code>{' '}
            trên Supabase. Migration tạo danh mục khoản lương, cơ chế lương từng người và bảng phiếu
            lương, đồng thời chuyển dữ liệu từ bảng lương cũ sang.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <WorkflowStrip
        title="Luồng bảng lương"
        steps={['Thiết lập cơ chế lương', 'Nhập số liệu tháng', 'Tính lương', 'Duyệt và chi trả']}
        activeStep={runStatus === 'PAID' ? 3 : runStatus === 'APPROVED' ? 3 : runStatus === 'CALCULATED' ? 2 : 0}
      />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">Bảng lương tháng {monthLabel}</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            Mỗi nhân sự tính theo cơ chế riêng: lương tháng, lương giờ, lương ngày, khoán sản phẩm
            hoặc hoa hồng doanh số.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 no-print">
          <MonthNav value={monthStart} onChange={setMonthStart} />
          <RunStatusBadge status={runStatus} />
        </div>
      </div>

      {/* --- Thanh hành động theo trạng thái kỳ --- */}
      <div className="flex flex-wrap items-center gap-2 no-print">
        {!isFrozen && (
          <Button onClick={handleCalculate} disabled={busy || rows.length === 0}>
            <Calculator className="h-4 w-4" />
            {busy ? 'Đang xử lý…' : runStatus === 'DRAFT' ? 'Tính lương' : 'Tính lại'}
          </Button>
        )}
        {runStatus === 'CALCULATED' && (
          <Button variant="success" onClick={handleApprove} disabled={busy || !data?.timesheetLocked}>
            <CheckCircle2 className="h-4 w-4" /> Duyệt bảng lương
          </Button>
        )}
        {runStatus === 'APPROVED' && (
          <Button variant="success" onClick={handleMarkPaid} disabled={busy}>
            <Wallet className="h-4 w-4" /> Đánh dấu đã chi trả
          </Button>
        )}
        {isFrozen && (
          <Button variant="outline" onClick={handleReopen} disabled={busy}>
            <RotateCcw className="h-4 w-4" /> Mở lại kỳ
          </Button>
        )}
        <Button variant="outline" onClick={handleExport} disabled={exporting || visibleRows.length === 0}>
          <FileSpreadsheet className="h-4 w-4" />
          {exporting ? 'Đang xuất…' : 'Xuất Excel'}
        </Button>
      </div>

      {runStatus === 'CALCULATED' && !data?.timesheetLocked && (
        <Banner tone="amber" icon={<LockKeyhole className="mt-0.5 h-4.5 w-4.5 flex-shrink-0" />}>
          Kỳ công tháng này chưa khóa nên chưa duyệt được bảng lương. Khóa kỳ công ở trang Bảng công
          trước — duyệt lương khi chấm công còn sửa được là chốt trên số liệu đang chạy.
        </Banner>
      )}

      {/* --- Tab --- */}
      <div className="flex flex-wrap gap-1 border-b border-slate-200 no-print">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${
              tab === id
                ? 'border-indigo-600 text-indigo-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      {tab === 'catalog' && data && (
        <ComponentCatalog
          components={data.components}
          params={params}
          onChanged={() => loadData(true)}
        />
      )}

      {tab === 'params' && data && (
        <PayrollParamsTab
          settings={data.payrollSettings}
          actorId={profile?.id ?? null}
          onSaved={() => loadData(true)}
        />
      )}

      {tab === 'inputs' && data && (
        <MonthlyInputsTab
          profiles={data.profiles}
          components={data.components}
          inputs={data.inputs}
          monthStart={monthStartStr}
          actorId={profile?.id ?? null}
          readOnly={isFrozen}
          onChanged={() => loadData(true)}
        />
      )}

      {tab === 'schemes' && data && (
        <SchemesTab rows={rows} onEdit={setSchemeTarget} />
      )}

      {tab === 'register' && (
        <>
          {selectedUserId && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3">
              <p className="text-sm font-bold text-indigo-900">
                Đang lọc theo một nhân sự được chọn từ Danh bạ.
              </p>
              <Button variant="outline" size="sm" onClick={() => setSearchParams({})}>
                Xem toàn bộ bảng lương
              </Button>
            </div>
          )}

          {missingSchemeCount > 0 && (
            <Banner tone="amber" icon={<TriangleAlert className="mt-0.5 h-4.5 w-4.5 flex-shrink-0" />}>
              {missingSchemeCount} nhân sự có ngày công nhưng <strong>chưa thiết lập cơ chế lương</strong> —
              thực nhận đang hiện 0đ. Sang tab <strong>Cơ chế lương</strong> để thiết lập.
            </Banner>
          )}

          {allWarnings.length > 0 && (
            <details className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
              <summary className="cursor-pointer text-sm font-bold text-amber-900">
                {allWarnings.length} cảnh báo cần xem lại
              </summary>
              <ul className="mt-2 space-y-1.5">
                {allWarnings.map((warning) => (
                  <li key={warning} className="text-xs leading-relaxed text-amber-800">• {warning}</li>
                ))}
              </ul>
            </details>
          )}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <SummaryCard label="Tổng thu nhập" value={formatVND(totals.gross)} />
            <SummaryCard label="Bảo hiểm + thuế" value={formatVND(totals.insurance + totals.tax)} tone="red" />
            <SummaryCard label="Tổng thực chi" value={formatVND(totals.net)} tone="indigo" />
            <SummaryCard
              label="Chi phí doanh nghiệp"
              value={formatVND(totals.gross + totals.employer)}
              hint="Gồm bảo hiểm phần công ty đóng"
            />
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[920px]">
                  <thead>
                    <tr className="border-b border-slate-100 bg-[#FCFAF8]">
                      <Th align="left" className="px-6">Nhân sự</Th>
                      <Th align="left">Cơ chế</Th>
                      <Th align="center">Công</Th>
                      <Th align="right">Thu nhập</Th>
                      <Th align="right">Khấu trừ</Th>
                      <Th align="right" className="px-6">Thực nhận</Th>
                      <th className="w-12 px-4 py-4 no-print" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {visibleRows.map((row) => {
                      const deductions =
                        row.computed.insuranceEmployee + row.computed.personalIncomeTax + row.computed.otherDeductions;
                      return (
                        <tr
                          key={row.profile.id}
                          className="group cursor-pointer transition-colors hover:bg-[#FCFAF8]"
                          onClick={() => setDetailUserId(row.profile.id)}
                        >
                          <td className="px-6 py-4">
                            <div className="flex min-w-0 items-center gap-3">
                              <Avatar name={row.profile.name} url={row.profile.avatar_url} size="sm" />
                              <div className="min-w-0">
                                <p className="truncate text-sm font-bold text-slate-800">{row.profile.name}</p>
                                <p className="text-[10px] font-medium uppercase tracking-tighter text-slate-400">
                                  {row.profile.department || 'CHƯA CÓ BỘ PHẬN'}
                                </p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            {row.hasScheme ? (
                              <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">
                                {payBasisLabel(row.computed.payBasis)}
                              </span>
                            ) : (
                              <span className="text-[10px] font-bold uppercase text-red-400">CHƯA THIẾT LẬP</span>
                            )}
                          </td>
                          <td className="px-3 py-4 text-center text-xs font-bold tabular-nums text-slate-800">
                            {row.computed.stats.paidDays}
                            <span className="ml-0.5 text-[9px] text-slate-300">
                              ({row.computed.stats.workDays}+{row.computed.stats.leaveDays})
                            </span>
                          </td>
                          <td className="px-4 py-4 text-right text-xs font-bold tabular-nums text-slate-800">
                            {formatVND(row.computed.gross)}
                          </td>
                          <td className="px-4 py-4 text-right text-xs font-medium tabular-nums text-red-500">
                            −{formatVND(deductions)}
                          </td>
                          <td className="px-6 py-4 text-right text-sm font-bold tabular-nums text-slate-900">
                            {formatVND(row.computed.netPay)}
                          </td>
                          <td className="px-4 py-4 text-center no-print">
                            <button
                              onClick={(event) => { event.stopPropagation(); setSchemeTarget(row.profile); }}
                              className="rounded p-1.5 text-slate-300 transition-colors hover:bg-indigo-50 hover:text-indigo-600"
                              aria-label={`Sửa cơ chế lương của ${row.profile.name}`}
                              disabled={isFrozen}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="border-t border-slate-200 bg-[#FCFAF8] font-bold">
                    <tr>
                      <td className="px-6 py-5 text-[10px] font-bold uppercase tracking-widest text-slate-900" colSpan={3}>
                        {selectedUserId ? 'TỔNG PHIẾU LƯƠNG' : `TỔNG QUỸ LƯƠNG (${visibleRows.length} NHÂN SỰ)`}
                      </td>
                      <td className="px-4 py-5 text-right text-xs tabular-nums text-slate-800">{formatVND(totals.gross)}</td>
                      <td className="px-4 py-5 text-right text-xs tabular-nums text-red-700">
                        −{formatVND(totals.insurance + totals.tax + totals.other)}
                      </td>
                      <td className="px-6 py-5 text-right text-base tabular-nums text-indigo-700">{formatVND(totals.net)}</td>
                      <td className="no-print" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardContent>
          </Card>
          <p className="px-1 text-xs text-slate-400">Bấm vào một dòng để xem chi tiết từng khoản trong phiếu lương.</p>
        </>
      )}

      {/* --- Modal --- */}
      <PaySchemeModal
        open={!!schemeTarget}
        target={schemeTarget}
        current={schemeTarget && data
          ? payProfileForPeriod(data.payProfiles.filter((item) => item.user_id === schemeTarget.id), monthEndStr)
          : null}
        components={data?.components ?? []}
        assignedItems={data?.items.filter((item) => item.user_id === schemeTarget?.id) ?? []}
        params={params}
        defaultEffectiveFrom={monthStartStr}
        actorId={profile?.id ?? null}
        onClose={() => setSchemeTarget(null)}
        onSaved={() => loadData(true)}
      />

      <Modal
        open={!!detailRow}
        onClose={() => setDetailUserId(null)}
        title={`Phiếu lương ${monthLabel} — ${detailRow?.profile.name ?? ''}`}
        size="lg"
      >
        {detailRow && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MiniStat label="Cơ chế" value={payBasisLabel(detailRow.computed.payBasis)} />
              <MiniStat label="Ngày công" value={`${detailRow.computed.stats.workDays} ngày`} />
              <MiniStat label="Ngày phép" value={`${detailRow.computed.stats.leaveDays} ngày`} />
              <MiniStat label="Giờ làm" value={`${detailRow.computed.stats.workHours} giờ`} />
            </div>
            <PayslipBreakdown
              lines={detailRow.computed.lines}
              netPay={detailRow.computed.netPay}
              warnings={detailRow.computed.warnings}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab cơ chế lương
// ---------------------------------------------------------------------------
function SchemesTab({ rows, onEdit }: { rows: PayrollRow[]; onEdit: (profile: Profile) => void }) {
  const withoutScheme = rows.filter((row) => !row.hasScheme);

  return (
    <div className="space-y-4">
      {withoutScheme.length > 0 && (
        <Banner tone="amber" icon={<TriangleAlert className="mt-0.5 h-4.5 w-4.5 flex-shrink-0" />}>
          {withoutScheme.length} nhân sự chưa có cơ chế lương. Họ sẽ không xuất hiện trong bảng lương
          đã chốt cho tới khi được thiết lập.
        </Banner>
      )}
      <Card>
        <CardContent className="p-0">
          <ul className="divide-y divide-slate-50">
            {rows.map((row) => (
              <li key={row.profile.id} className="flex items-center gap-3 px-5 py-3.5">
                <Avatar name={row.profile.name} url={row.profile.avatar_url} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-slate-800">{row.profile.name}</p>
                  <p className="text-xs text-slate-500">
                    {row.hasScheme ? (
                      <>
                        {payBasisLabel(row.computed.payBasis)} ·{' '}
                        {row.computed.lines.filter((line) => line.kind !== 'EMPLOYER_COST').length - 4} khoản riêng
                      </>
                    ) : (
                      <span className="font-bold text-red-500">Chưa thiết lập cơ chế lương</span>
                    )}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => onEdit(row.profile)}>
                  <Pencil className="h-3.5 w-3.5" /> {row.hasScheme ? 'Sửa' : 'Thiết lập'}
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mảnh giao diện nhỏ
// ---------------------------------------------------------------------------
function RunStatusBadge({ status }: { status: keyof typeof RUN_STATUS_LABEL }) {
  const tones = {
    DRAFT: 'bg-slate-100 text-slate-600',
    CALCULATED: 'bg-blue-50 text-blue-700',
    APPROVED: 'bg-emerald-50 text-emerald-700',
    PAID: 'bg-indigo-50 text-indigo-700',
  };
  return (
    <span className={`rounded-full px-3 py-1.5 text-xs font-bold ${tones[status]}`}>
      {RUN_STATUS_LABEL[status]}
    </span>
  );
}

function SummaryCard({
  label, value, tone = 'slate', hint,
}: {
  label: string; value: string; tone?: 'slate' | 'red' | 'indigo'; hint?: string;
}) {
  const colors = { slate: 'text-slate-900', red: 'text-red-600', indigo: 'text-indigo-700' };
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{label}</p>
        <p className={`mt-1.5 text-lg font-extrabold tabular-nums ${colors[tone]}`}>{value}</p>
        {hint && <p className="mt-0.5 text-[10px] text-slate-400">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2.5">
      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{label}</p>
      <p className="mt-0.5 truncate text-sm font-bold text-slate-800">{value}</p>
    </div>
  );
}

function Th({
  children, align, className = '',
}: {
  children?: React.ReactNode; align: 'left' | 'center' | 'right'; className?: string;
}) {
  const alignment = { left: 'text-left', center: 'text-center', right: 'text-right' }[align];
  return (
    <th className={`${alignment} px-4 py-4 text-[10px] font-bold uppercase tracking-widest text-slate-400 ${className}`}>
      {children}
    </th>
  );
}

function Banner({
  tone, icon, children,
}: {
  tone: 'amber' | 'emerald'; icon: React.ReactNode; children: React.ReactNode;
}) {
  const tones = {
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  };
  return (
    <div className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm leading-relaxed ${tones[tone]}`}>
      {icon}
      <span>{children}</span>
    </div>
  );
}
