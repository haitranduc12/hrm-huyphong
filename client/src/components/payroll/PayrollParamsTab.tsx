// ============================================================================
// Tham số tính lương — sống trong module lương, không phải Cấu hình hệ thống.
// ----------------------------------------------------------------------------
// Trước đây thuế suất và tỷ lệ bảo hiểm nằm ở trang Cấu hình hệ thống. Trang
// đó mở cho quyền lẻ `settings`, trong khi Bảng lương là dữ liệu nhạy cảm — nên
// một người bị cấm XEM bảng lương vẫn SỬA được thuế suất của cả công ty.
// Chuyển về đây thì quyền sửa khớp đúng với quyền xem kết quả.
//
// Giờ chuẩn mỗi ngày KHÔNG ở đây: Bảng công dùng nó làm ngưỡng đủ giờ công nên
// nó là thiết lập vận hành dùng chung, vẫn thuộc Cấu hình hệ thống.
// ============================================================================

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, Info, Save, TriangleAlert } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { useAppSettings } from '@/contexts/SettingsContext';
import { formatVND } from '@/lib/utils';
import { savePitBrackets, type PitBracket } from '@/lib/payrollSettings';
import { savePayrollSettings, type PayrollSettings } from '@/lib/payrollSettings';
import { Select } from '@/components/ui/Input';

const REGION_HINT: Record<string, string> = {
  I: 'Hà Nội, TP.HCM và các quận nội thành lân cận.',
  II: 'Thành phố trực thuộc tỉnh và một số huyện ngoại thành.',
  III: 'Các thành phố, thị xã còn lại.',
  IV: 'Địa bàn còn lại.',
};

interface PayrollParamsTabProps {
  settings: PayrollSettings;
  brackets: PitBracket[];
  actorId: string | null;
  /** Kỳ đã duyệt vẫn sửa được tham số — chỉ kỳ sau mới chịu ảnh hưởng. */
  onSaved: () => void;
}

export function PayrollParamsTab({ settings, brackets, actorId, onSaved }: PayrollParamsTabProps) {
  const { toast } = useToast();
  const app = useAppSettings();

  const [draft, setDraft] = useState<PayrollSettings>(settings);
  const [bracketDraft, setBracketDraft] = useState<PitBracket[]>(brackets);
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  // Nạp lại khi dữ liệu mới về, nhưng không đè lúc người dùng đang sửa dở.
  useEffect(() => {
    if (!touched) {
      setDraft(settings);
      setBracketDraft(brackets);
    }
  }, [settings, brackets, touched]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(settings)
      || JSON.stringify(bracketDraft) !== JSON.stringify(brackets),
    [draft, settings, bracketDraft, brackets],
  );

  const updateBracket = (index: number, patch: Partial<PitBracket>) => {
    setTouched(true);
    setBracketDraft((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  // Bậc phải tăng dần, nếu không thuật toán lũy tiến sẽ bỏ qua bậc bị đảo và
  // tính thiếu thuế mà không báo gì.
  const bracketsOutOfOrder = bracketDraft.some((row, index) => {
    if (index === 0 || row.upperBound == null) return false;
    const previous = bracketDraft[index - 1].upperBound;
    return previous != null && row.upperBound <= previous;
  });
  const lastBracketOpen = bracketDraft.length > 0
    && bracketDraft[bracketDraft.length - 1].upperBound == null;

  const update = (patch: Partial<PayrollSettings>) => {
    setTouched(true);
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  // Hiện tổng ngay để người chỉnh thấy hậu quả: sửa lẻ từng dòng rất dễ ra
  // tổng khác 10,5% mà không nhận ra.
  const employeeTotal =
    draft.socialInsuranceRate + draft.healthInsuranceRate + draft.unemploymentInsuranceRate;
  const employerTotal =
    draft.employerSocialRate + draft.employerHealthRate + draft.employerUnemploymentRate;
  const offStatutory = Math.abs(employeeTotal - 10.5) > 0.01;

  const save = async () => {
    if (bracketsOutOfOrder) {
      toast('Các bậc thuế phải tăng dần — sửa lại trước khi lưu.', 'warning');
      return;
    }
    if (!lastBracketOpen) {
      toast('Bậc cuối phải để trống cận trên, nếu không thu nhập rất cao sẽ không bị tính thuế.', 'warning');
      return;
    }

    setSaving(true);
    const { error } = await savePayrollSettings(draft, actorId);
    if (!error) {
      const bracketResult = await savePitBrackets(bracketDraft);
      if (bracketResult.error) {
        setSaving(false);
        toast('Lưu biểu thuế thất bại: ' + bracketResult.error, 'error');
        return;
      }
    }
    setSaving(false);

    if (error) {
      toast('Lưu tham số lương thất bại: ' + error, 'error');
      return;
    }
    setTouched(false);
    toast('Đã lưu tham số lương.', 'success');
    onSaved();
  };

  return (
    <div className="space-y-5 pb-24">
      <div className="flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-3">
        <Info className="mt-0.5 h-5 w-5 flex-shrink-0 text-blue-600" />
        <p className="text-sm leading-relaxed text-blue-900">
          Chỉ người được cấp chức năng <strong>Bảng lương</strong> (Admin/CEO mặc định) sửa được các tham số này.
          Thay đổi áp dụng cho các kỳ <strong>chưa duyệt</strong>; kỳ đã duyệt giữ nguyên vì số
          liệu đã đóng băng vào phiếu lương.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Ngày công chuẩn</CardTitle>
        </CardHeader>
        <CardContent>
          <NumberField
            label="Ngày công chuẩn / tháng"
            hint={
              <>
                Mẫu số cho người hưởng <strong>lương tháng</strong>: lương ÷ ngày công chuẩn × ngày
                công thực tế. Người hưởng lương giờ, lương ngày hay khoán sản phẩm không dùng số
                này. Từng nhân sự có thể đặt riêng ở tab Cơ chế lương.
              </>
            }
            value={draft.standardWorkDays}
            min={1} max={31} step={0.5}
            suffix={`Đơn giá giờ = lương tháng ÷ ${draft.standardWorkDays} ngày ÷ ${app.standardHoursPerDay} giờ`}
            onChange={(v) => update({ standardWorkDays: v })}
          />
          <p className="mt-2 text-xs leading-relaxed text-slate-400">
            Số giờ làm chuẩn mỗi ngày ({app.standardHoursPerDay} giờ) đặt ở{' '}
            <strong className="text-slate-500">Thiết lập công & chấm công</strong> vì Bảng công cũng dùng nó
            làm ngưỡng đủ giờ công.
          </p>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Mức nền theo quy định</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs leading-relaxed text-slate-500">
            Hai con số này là gốc để suy ra các trần bên dưới. Khai ở đây thay vì để kế toán tự nhân
            tay, và để hệ thống cảnh báo được khi mức lương đóng bảo hiểm của ai đó tụt dưới lương
            tối thiểu vùng.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              label="Mức lương cơ sở (VND)"
              hint="Trần đóng BHXH & BHYT = 20 lần số này. Trần đoàn phí công đoàn = 10%."
              value={draft.baseSalaryLevel}
              min={0} max={100000000} step={100000}
              suffix={`Trần BHXH/BHYT tương ứng: ${formatVND(draft.baseSalaryLevel * 20)}`}
              onChange={(v) => update({ baseSalaryLevel: v })}
            />
            <NumberField
              label="Lương tối thiểu vùng (VND)"
              hint="Trần đóng BHTN = 20 lần số này. Mức đóng bảo hiểm thấp hơn số này là sai quy định."
              value={draft.regionalMinimumWage}
              min={0} max={100000000} step={100000}
              suffix={`Trần BHTN tương ứng: ${formatVND(draft.regionalMinimumWage * 20)}`}
              onChange={(v) => update({ regionalMinimumWage: v })}
            />
          </div>
          <div className="sm:max-w-xs">
            <Select
              label="Vùng lương tối thiểu"
              value={draft.regionCode}
              onChange={(e) => update({ regionCode: e.target.value as PayrollSettings['regionCode'] })}
            >
              {(['I', 'II', 'III', 'IV'] as const).map((code) => (
                <option key={code} value={code}>Vùng {code}</option>
              ))}
            </Select>
            <p className="mt-1.5 text-xs text-slate-500">{REGION_HINT[draft.regionCode]}</p>
          </div>

          {/* Trần khai tay lệch với mức nền là dấu hiệu một trong hai chỗ quên
              cập nhật khi quy định đổi. */}
          {(draft.insuranceSalaryCap !== draft.baseSalaryLevel * 20
            || draft.unemploymentSalaryCap !== draft.regionalMinimumWage * 20) && (
            <div className="flex items-start gap-2.5 rounded-lg bg-amber-50 px-3.5 py-2.5 text-xs leading-relaxed text-amber-800">
              <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <p>
                Trần đang khai bên dưới không khớp mức nền × 20. Nếu công ty không có thỏa thuận
                riêng thì một trong hai chỗ đang lỗi thời.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Bảo hiểm bắt buộc</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs leading-relaxed text-slate-500">
            Tính trên mức lương đóng bảo hiểm của từng người (đặt ở tab Cơ chế lương) chứ không
            phải lương thực nhận tháng đó. Đây là nơi duy nhất khai tỷ lệ bảo hiểm — cả phần người
            lao động lẫn phần doanh nghiệp.
          </p>

          <p className="text-xs font-semibold text-slate-600">Phần người lao động trích đóng</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField label="BHXH (%)" hint="Luật định 8%." value={draft.socialInsuranceRate}
              min={0} max={100} step={0.1} onChange={(v) => update({ socialInsuranceRate: v })} />
            <NumberField label="BHYT (%)" hint="Luật định 1,5%." value={draft.healthInsuranceRate}
              min={0} max={100} step={0.1} onChange={(v) => update({ healthInsuranceRate: v })} />
            <NumberField label="BHTN (%)" hint="Luật định 1%." value={draft.unemploymentInsuranceRate}
              min={0} max={100} step={0.1} onChange={(v) => update({ unemploymentInsuranceRate: v })} />
          </div>

          <div
            className={`flex items-start gap-2.5 rounded-lg px-3.5 py-2.5 text-xs leading-relaxed ${
              offStatutory ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800'
            }`}
          >
            {offStatutory
              ? <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
              : <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" />}
            <p>
              Tổng người lao động đóng: <strong>{employeeTotal.toFixed(1)}%</strong>
              {offStatutory
                ? ' — khác mức 10,5% theo quy định hiện hành. Chỉ đặt khác khi công ty có thỏa thuận riêng.'
                : ' — đúng mức quy định hiện hành.'}
            </p>
          </div>

          <div className="border-t border-slate-100 pt-4">
            <p className="mb-3 text-xs leading-relaxed text-slate-500">
              Phần <strong>doanh nghiệp</strong> đóng thêm. Không trừ vào lương nhân viên — chỉ
              cộng vào tổng chi phí nhân sự hiển thị ở Bảng lương.
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <NumberField label="BHXH doanh nghiệp (%)" hint="Luật định 17,5%." value={draft.employerSocialRate}
                min={0} max={100} step={0.1} onChange={(v) => update({ employerSocialRate: v })} />
              <NumberField label="BHYT doanh nghiệp (%)" hint="Luật định 3%." value={draft.employerHealthRate}
                min={0} max={100} step={0.1} onChange={(v) => update({ employerHealthRate: v })} />
              <NumberField label="BHTN doanh nghiệp (%)" hint="Luật định 1%." value={draft.employerUnemploymentRate}
                min={0} max={100} step={0.1} onChange={(v) => update({ employerUnemploymentRate: v })} />
            </div>
            <p className="mt-2.5 text-xs text-slate-500">
              Tổng doanh nghiệp đóng: <strong className="text-slate-700">{employerTotal.toFixed(1)}%</strong>
              {' '}· Tổng cả hai phía:{' '}
              <strong className="text-slate-700">{(employeeTotal + employerTotal).toFixed(1)}%</strong>
            </p>
          </div>

          <div className="grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2">
            <NumberField
              label="Trần đóng BHXH & BHYT (VND)"
              hint="20 lần mức lương cơ sở. Phần lương vượt trần không phải đóng."
              value={draft.insuranceSalaryCap}
              min={0} max={1000000000} step={1000000}
              suffix={formatVND(draft.insuranceSalaryCap)}
              onChange={(v) => update({ insuranceSalaryCap: v })}
            />
            <NumberField
              label="Trần đóng BHTN (VND)"
              hint="20 lần lương tối thiểu vùng. Khác trần BHXH nên để riêng."
              value={draft.unemploymentSalaryCap}
              min={0} max={1000000000} step={1000000}
              suffix={formatVND(draft.unemploymentSalaryCap)}
              onChange={(v) => update({ unemploymentSalaryCap: v })}
            />
          </div>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Thuế thu nhập cá nhân</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              label="Giảm trừ bản thân (VND/tháng)"
              hint="Áp dụng cho mọi người tính thuế lũy tiến."
              value={draft.taxPersonalDeduction}
              min={0} max={100000000} step={500000}
              suffix={formatVND(draft.taxPersonalDeduction)}
              onChange={(v) => update({ taxPersonalDeduction: v })}
            />
            <NumberField
              label="Giảm trừ mỗi người phụ thuộc (VND/tháng)"
              hint="Số người phụ thuộc đặt riêng từng nhân sự ở tab Cơ chế lương."
              value={draft.taxDependentDeduction}
              min={0} max={100000000} step={100000}
              suffix={formatVND(draft.taxDependentDeduction)}
              onChange={(v) => update({ taxDependentDeduction: v })}
            />
          </div>

          {/* Biểu thuế khai trong database chứ không nằm cứng trong code:
              giảm trừ gia cảnh vốn đã sửa được, để riêng bậc thuế phải chờ
              deploy mới đổi được là không nhất quán. */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-bold text-slate-600">Biểu thuế lũy tiến từng phần</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              Mỗi bậc chỉ đánh trên <strong>phần</strong> thu nhập nằm trong bậc đó. Bậc cuối để
              trống cận trên. Sửa ở đây chỉ nên làm khi quy định thay đổi.
            </p>

            <div className="overflow-x-auto">
              <table className="mt-3 w-full min-w-[440px] text-xs">
                <thead>
                  <tr className="text-left text-slate-400">
                    <th className="pb-1.5 font-semibold">Bậc</th>
                    <th className="pb-1.5 font-semibold">Từ</th>
                    <th className="pb-1.5 font-semibold">Đến (trống = trở lên)</th>
                    <th className="pb-1.5 font-semibold">Thuế suất %</th>
                  </tr>
                </thead>
                <tbody className="text-slate-600">
                  {bracketDraft.map((bracket, index) => {
                    const lower = index === 0 ? 0 : bracketDraft[index - 1].upperBound ?? 0;
                    return (
                      <tr key={bracket.step} className="border-t border-slate-200/70">
                        <td className="py-1.5 pr-2">{index + 1}</td>
                        <td className="py-1.5 pr-2 tabular-nums text-slate-500">{formatVND(lower)}</td>
                        <td className="py-1.5 pr-2">
                          <input
                            inputMode="numeric"
                            placeholder="trở lên"
                            value={bracket.upperBound == null ? '' : String(bracket.upperBound)}
                            onChange={(e) => {
                              const digits = e.target.value.replace(/[^\d]/g, '');
                              updateBracket(index, { upperBound: digits ? Number(digits) : null });
                            }}
                            className="h-8 w-36 rounded-lg border border-slate-200 bg-white px-2 text-right tabular-nums outline-none focus:border-indigo-500"
                          />
                        </td>
                        <td className="py-1.5">
                          <input
                            inputMode="decimal"
                            value={String(bracket.rate)}
                            onChange={(e) => {
                              const clean = e.target.value.replace(/[^\d.]/g, '');
                              updateBracket(index, { rate: Number(clean) || 0 });
                            }}
                            className="h-8 w-20 rounded-lg border border-slate-200 bg-white px-2 text-right tabular-nums outline-none focus:border-indigo-500"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {bracketsOutOfOrder && (
              <p className="mt-2.5 flex items-start gap-1.5 text-xs text-amber-700">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                Các bậc phải tăng dần. Bậc bị đảo sẽ bị thuật toán lũy tiến bỏ qua, tính thiếu thuế.
              </p>
            )}
            {!lastBracketOpen && (
              <p className="mt-2.5 flex items-start gap-1.5 text-xs text-amber-700">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                Bậc cuối phải để trống cận trên, nếu không phần thu nhập vượt bậc cuối sẽ không bị
                tính thuế.
              </p>
            )}

            <p className="mt-2.5 text-xs leading-relaxed text-slate-500">
              Nhân sự ký hợp đồng dưới 3 tháng chuyển sang khấu trừ thẳng theo tỷ lệ, đặt riêng ở
              trang Cơ chế lương.
            </p>
          </div>
        </CardContent>
      </Card>

      {dirty && (
        <div className="fixed bottom-0 left-0 right-0 z-30 border-t border-slate-200 bg-white/90 px-4 py-3 shadow-lg backdrop-blur-md print:hidden">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 lg:pl-64">
            <p className="text-sm text-slate-600">Có thay đổi chưa lưu</p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => { setTouched(false); setDraft(settings); }}
                disabled={saving}
              >
                Hoàn tác
              </Button>
              <Button theme="admin" onClick={save} disabled={saving}>
                <Save className="h-4 w-4" />
                {saving ? 'Đang lưu…' : 'Lưu tham số'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Ô nhập số có kiểm tra biên. Giữ giá trị dạng CHUỖI khi đang gõ: ép về số ngay
 * mỗi lần onChange sẽ khiến xoá hết ô là nhảy về 0, không gõ tiếp được.
 */
function NumberField({
  label, hint, value, min, max, step = 1, suffix, onChange,
}: {
  label: string;
  hint: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  const invalid =
    draft.trim() === '' || Number.isNaN(Number(draft)) || Number(draft) < min || Number(draft) > max;

  return (
    <div>
      <Input
        label={label}
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= min && n <= max) onChange(n);
        }}
      />
      <p className={`mt-1 text-xs leading-relaxed ${invalid ? 'text-red-600' : 'text-slate-500'}`}>
        {invalid ? `Nhập số trong khoảng ${min}–${max}.` : hint}
      </p>
      {!invalid && suffix && <p className="mt-0.5 text-xs font-medium text-slate-600">{suffix}</p>}
    </div>
  );
}
