// ============================================================================
// Thiết lập cơ chế lương cho MỘT người.
// ----------------------------------------------------------------------------
// Đây là chỗ thay thế cho modal cũ chỉ có hai ô "lương cơ bản" và "phụ cấp".
// Một người ở đây được chọn cách tính lương gốc, mức đóng bảo hiểm, cách khấu
// trừ thuế, và gán từng khoản cộng/trừ riêng kèm giá trị hoặc công thức của
// riêng họ.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, TriangleAlert, Wallet } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { Avatar } from '@/components/ui/Avatar';
import { useToast } from '@/contexts/ToastContext';
import { formatVND } from '@/lib/utils';
import { payBasisLabel, sampleFormulaScope } from '@/lib/payroll';
import { validateFormula } from '@/lib/payrollFormula';
import { deletePayItem, savePayItem, savePayProfile } from '@/lib/payrollData';
import type {
  EmployeePayItem,
  EmployeePayProfile,
  PayBasis,
  PayComponent,
  Profile,
  TaxMode,
} from '@/types';
import type { PayrollParams } from '@/lib/payrollSettings';

const PAY_BASES: Array<{ value: PayBasis; hint: string }> = [
  { value: 'MONTHLY', hint: 'Lương tháng ÷ ngày công chuẩn × ngày công thực tế. Nhân viên chính thức.' },
  { value: 'HOURLY', hint: 'Đơn giá giờ × giờ làm lấy từ chấm công. Part-time, thời vụ.' },
  { value: 'DAILY', hint: 'Đơn giá ngày × số ngày công. Lao động công nhật.' },
  { value: 'PIECE', hint: 'Không có lương cứng. Thu nhập hoàn toàn từ khoản khoán sản phẩm.' },
  { value: 'COMMISSION', hint: 'Lương cứng thấp + hoa hồng doanh số. Nhân viên kinh doanh.' },
];

const BASE_AMOUNT_LABEL: Record<PayBasis, string> = {
  MONTHLY: 'Lương tháng (VND)',
  HOURLY: 'Đơn giá một giờ (VND)',
  DAILY: 'Đơn giá một ngày công (VND)',
  PIECE: 'Lương cứng tối thiểu, để 0 nếu ăn khoán hoàn toàn (VND)',
  COMMISSION: 'Lương cứng hằng tháng (VND)',
};

const TAX_MODES: Array<{ value: TaxMode; label: string; hint: string }> = [
  { value: 'PROGRESSIVE', label: 'Lũy tiến 7 bậc', hint: 'Hợp đồng từ 3 tháng trở lên.' },
  { value: 'FLAT', label: 'Khấu trừ thẳng theo %', hint: 'Hợp đồng dưới 3 tháng, cộng tác viên.' },
  { value: 'NONE', label: 'Không khấu trừ', hint: 'Người đã tự quyết toán hoặc được miễn.' },
];

interface PaySchemeModalProps {
  /** Tham số lương, dùng dựng bộ biến mẫu khi kiểm tra công thức. */
  params: PayrollParams;
  open: boolean;
  target: Profile | null;
  /** Bản ghi cơ chế đang áp dụng cho kỳ đang xem, nếu có. */
  current: EmployeePayProfile | null;
  components: PayComponent[];
  assignedItems: EmployeePayItem[];
  /** Ngày đầu tháng đang xem — mặc định cho ngày hiệu lực. */
  defaultEffectiveFrom: string;
  actorId: string | null;
  onClose: () => void;
  onSaved: () => void;
}

interface ItemDraft {
  id?: string;
  componentId: string;
  amount: string;
  formula: string;
  effectiveFrom: string;
  note: string;
}

const digitsOnly = (value: string) => value.replace(/[^\d]/g, '');

export function PaySchemeModal({
  open, target, current, components, assignedItems, params,
  defaultEffectiveFrom, actorId, onClose, onSaved,
}: PaySchemeModalProps) {
  const { toast } = useToast();

  const [basis, setBasis] = useState<PayBasis>('MONTHLY');
  const [baseAmount, setBaseAmount] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(defaultEffectiveFrom);
  const [insuranceEnabled, setInsuranceEnabled] = useState(true);
  const [insuranceBase, setInsuranceBase] = useState('');
  const [dependents, setDependents] = useState('0');
  const [taxMode, setTaxMode] = useState<TaxMode>('PROGRESSIVE');
  const [flatRate, setFlatRate] = useState('10');
  const [standardDays, setStandardDays] = useState('');
  const [note, setNote] = useState('');
  const [drafts, setDrafts] = useState<ItemDraft[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Nạp lại mỗi lần mở cho người khác. Không dùng `key` ở phía cha vì modal
  // cần giữ trạng thái khi người dùng cuộn trong lúc đang sửa.
  useEffect(() => {
    if (!open) return;
    setBasis(current?.pay_basis ?? 'MONTHLY');
    setBaseAmount(current ? String(Number(current.base_amount)) : '');
    setEffectiveFrom(current?.effective_from ?? defaultEffectiveFrom);
    setInsuranceEnabled(current?.insurance_enabled ?? true);
    setInsuranceBase(current?.insurance_base != null ? String(Number(current.insurance_base)) : '');
    setDependents(String(current?.dependents ?? 0));
    setTaxMode(current?.tax_mode ?? 'PROGRESSIVE');
    setFlatRate(String(current?.flat_tax_rate ?? 10));
    setStandardDays(current?.standard_days_override != null ? String(Number(current.standard_days_override)) : '');
    setNote(current?.note ?? '');
    setDrafts(assignedItems.map((item) => ({
      id: item.id,
      componentId: item.component_id,
      amount: item.amount != null ? String(Number(item.amount)) : '',
      formula: item.formula ?? '',
      effectiveFrom: item.effective_from,
      note: item.note ?? '',
    })));
    setRemovedIds([]);
  }, [open, target?.id, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const componentById = useMemo(
    () => new Map(components.map((component) => [component.id, component])),
    [components],
  );

  // Biến mẫu để kiểm tra công thức ngay lúc gõ, gồm cả mã số liệu tháng của
  // các khoản đang hoạt động — nếu không, công thức đúng vẫn báo "không có biến".
  const formulaScope = useMemo(() => {
    const inputCodes = components
      .map((component) => component.input_code)
      .filter((code): code is string => !!code);
    const componentCodes = components.map((component) => component.code);
    return sampleFormulaScope(params, [...inputCodes, ...componentCodes]);
  }, [components, params]);

  const availableComponents = components.filter(
    (component) => component.is_active && !drafts.some((draft) => draft.componentId === component.id),
  );

  const addDraft = () => {
    const next = availableComponents[0];
    if (!next) {
      toast('Đã gán hết các khoản đang hoạt động.', 'warning');
      return;
    }
    setDrafts((list) => [...list, {
      componentId: next.id,
      amount: '',
      formula: '',
      effectiveFrom: effectiveFrom,
      note: '',
    }]);
  };

  const updateDraft = (index: number, patch: Partial<ItemDraft>) => {
    setDrafts((list) => list.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  };

  const removeDraft = (index: number) => {
    setDrafts((list) => {
      const draft = list[index];
      if (draft?.id) setRemovedIds((ids) => [...ids, draft.id as string]);
      return list.filter((_, i) => i !== index);
    });
  };

  // Chặn lưu khi công thức hỏng: phát hiện lúc chạy lương thì đã muộn.
  const formulaErrors = drafts.map((draft) => {
    const source = draft.formula.trim();
    if (!source) return null;
    return validateFormula(source, formulaScope);
  });
  const hasFormulaError = formulaErrors.some(Boolean);

  const parsedBase = Number(baseAmount || '0');
  const preview = useMemo(() => {
    const days = Number(standardDays) || params.standardWorkDays || 26;
    const hours = params.hoursPerDay || 8;
    switch (basis) {
      case 'HOURLY': return `${formatVND(parsedBase)}/giờ`;
      case 'DAILY': return `${formatVND(parsedBase)}/ngày · ${formatVND(parsedBase / hours)}/giờ`;
      case 'PIECE': return 'Thu nhập theo sản lượng nghiệm thu';
      default:
        return `${formatVND(parsedBase / days)}/ngày · ${formatVND(parsedBase / days / hours)}/giờ`;
    }
  }, [basis, parsedBase, standardDays, params]);

  const handleSave = async () => {
    if (!target) return;
    if (basis !== 'PIECE' && parsedBase <= 0) {
      toast('Nhập đơn giá lương hợp lệ.', 'warning');
      return;
    }
    if (hasFormulaError) {
      toast('Còn công thức chưa hợp lệ — sửa trước khi lưu.', 'warning');
      return;
    }

    setSaving(true);
    const profileError = await savePayProfile({
      user_id: target.id,
      effective_from: effectiveFrom,
      pay_basis: basis,
      base_amount: parsedBase,
      insurance_base: insuranceBase ? Number(insuranceBase) : null,
      insurance_enabled: insuranceEnabled,
      dependents: Number(dependents) || 0,
      tax_mode: taxMode,
      flat_tax_rate: Number(flatRate) || 10,
      standard_days_override: standardDays ? Number(standardDays) : null,
      note: note.trim() || null,
      created_by: actorId,
    });

    if (profileError) {
      setSaving(false);
      toast('Lưu cơ chế lương thất bại: ' + profileError, 'error');
      return;
    }

    for (const id of removedIds) {
      const error = await deletePayItem(id);
      if (error) {
        setSaving(false);
        toast('Xóa khoản thất bại: ' + error, 'error');
        return;
      }
    }

    for (const draft of drafts) {
      const error = await savePayItem({
        ...(draft.id ? { id: draft.id } : {}),
        user_id: target.id,
        component_id: draft.componentId,
        amount: draft.amount ? Number(draft.amount) : null,
        formula: draft.formula.trim() || null,
        effective_from: draft.effectiveFrom,
        note: draft.note.trim() || null,
        created_by: actorId,
      });
      if (error) {
        setSaving(false);
        toast('Lưu khoản lương thất bại: ' + error, 'error');
        return;
      }
    }

    setSaving(false);
    toast(`Đã lưu cơ chế lương cho ${target.name}.`, 'success');
    onSaved();
    onClose();
  };

  const basisHint = PAY_BASES.find((entry) => entry.value === basis)?.hint ?? '';

  return (
    <Modal open={open} onClose={onClose} title="Cơ chế lương" size="xl">
      {target && (
        <div className="space-y-5">
          <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3">
            <Avatar name={target.name} url={target.avatar_url} size="md" />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-slate-800">{target.name}</p>
              <p className="text-xs text-slate-500">{target.department || 'Chưa có bộ phận'}</p>
            </div>
          </div>

          {/* --- Lương gốc --- */}
          <section className="space-y-3">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Lương gốc</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Select
                  label="Hình thức trả lương"
                  value={basis}
                  onChange={(e) => setBasis(e.target.value as PayBasis)}
                >
                  {PAY_BASES.map((entry) => (
                    <option key={entry.value} value={entry.value}>{payBasisLabel(entry.value)}</option>
                  ))}
                </Select>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{basisHint}</p>
              </div>
              <div>
                <Input
                  label={BASE_AMOUNT_LABEL[basis]}
                  inputMode="numeric"
                  placeholder="VD: 15000000"
                  value={baseAmount}
                  onChange={(e) => setBaseAmount(digitsOnly(e.target.value))}
                />
                {parsedBase > 0 && (
                  <p className="mt-1.5 text-xs text-slate-500">
                    {formatVND(parsedBase)} — quy đổi {preview}
                  </p>
                )}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Áp dụng từ ngày"
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
              <Input
                label={`Ngày công chuẩn riêng (trống = ${params.standardWorkDays} theo công ty)`}
                inputMode="numeric"
                placeholder={String(params.standardWorkDays)}
                value={standardDays}
                onChange={(e) => setStandardDays(digitsOnly(e.target.value))}
              />
            </div>
            <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-800">
              Đổi lương là tạo bản ghi mới theo ngày hiệu lực. Các tháng đã chạy lương trước
              ngày này giữ nguyên mức cũ.
            </p>
          </section>

          {/* --- Bảo hiểm & thuế --- */}
          <section className="space-y-3">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Bảo hiểm và thuế</h3>
            <label className="flex items-start gap-2.5 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={insuranceEnabled}
                onChange={(e) => setInsuranceEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300"
              />
              <span>
                Tham gia bảo hiểm bắt buộc
                <span className="block text-xs text-slate-500">
                  BHXH {params.socialInsuranceRate}% + BHYT {params.healthInsuranceRate}% +
                  BHTN {params.unemploymentInsuranceRate}% = {(
                    params.socialInsuranceRate + params.healthInsuranceRate + params.unemploymentInsuranceRate
                  ).toFixed(1)}% phần người lao động đóng.
                </span>
              </span>
            </label>
            {insuranceEnabled && (
              <Input
                label="Mức lương đóng bảo hiểm (trống = theo lương hợp đồng)"
                inputMode="numeric"
                placeholder="VD: 8000000"
                value={insuranceBase}
                onChange={(e) => setInsuranceBase(digitsOnly(e.target.value))}
              />
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Select label="Cách tính thuế TNCN" value={taxMode} onChange={(e) => setTaxMode(e.target.value as TaxMode)}>
                  {TAX_MODES.map((mode) => (
                    <option key={mode.value} value={mode.value}>{mode.label}</option>
                  ))}
                </Select>
                <p className="mt-1.5 text-xs text-slate-500">
                  {TAX_MODES.find((mode) => mode.value === taxMode)?.hint}
                </p>
              </div>
              {taxMode === 'FLAT' ? (
                <Input
                  label="Tỷ lệ khấu trừ (%)"
                  inputMode="decimal"
                  value={flatRate}
                  onChange={(e) => setFlatRate(e.target.value.replace(/[^\d.]/g, ''))}
                />
              ) : (
                <div>
                  <Input
                    label="Số người phụ thuộc"
                    inputMode="numeric"
                    value={dependents}
                    onChange={(e) => setDependents(digitsOnly(e.target.value))}
                  />
                  <p className="mt-1.5 text-xs text-slate-500">
                    Giảm trừ {formatVND(params.taxDependentDeduction)}/người, cộng với{' '}
                    {formatVND(params.taxPersonalDeduction)} cho bản thân.
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* --- Khoản riêng --- */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                Khoản cộng / trừ riêng ({drafts.length})
              </h3>
              <Button variant="outline" size="sm" onClick={addDraft} disabled={availableComponents.length === 0}>
                <Plus className="h-3.5 w-3.5" /> Thêm khoản
              </Button>
            </div>

            {drafts.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500">
                Chưa gán khoản nào. Người này chỉ nhận lương gốc, bảo hiểm và thuế.
              </p>
            ) : (
              <div className="space-y-3">
                {drafts.map((draft, index) => {
                  const component = componentById.get(draft.componentId);
                  const error = formulaErrors[index];
                  return (
                    <div key={draft.id ?? `new-${index}`} className="rounded-xl border border-slate-200 p-3">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <Select
                            value={draft.componentId}
                            onChange={(e) => updateDraft(index, { componentId: e.target.value })}
                          >
                            {components
                              .filter((item) => item.is_active || item.id === draft.componentId)
                              .map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.kind === 'DEDUCTION' ? '− ' : item.kind === 'EMPLOYER_COST' ? '◦ ' : '+ '}
                                  {item.name}
                                </option>
                              ))}
                          </Select>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeDraft(index)}
                          className="mt-1 rounded p-2 text-slate-300 transition-colors hover:bg-red-50 hover:text-red-600"
                          aria-label="Bỏ khoản này"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>

                      {component && (
                        <p className="mt-2 text-xs text-slate-500">
                          {describeCalcType(component)}
                          {component.note ? ` — ${component.note}` : ''}
                        </p>
                      )}

                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <Input
                          label={component?.calc_type === 'PERCENT' ? 'Tỷ lệ riêng (%)' : 'Giá trị riêng (VND)'}
                          inputMode="decimal"
                          placeholder={
                            component ? `Mặc định ${formatComponentDefault(component)}` : 'Theo mặc định'
                          }
                          value={draft.amount}
                          onChange={(e) => updateDraft(index, {
                            amount: component?.calc_type === 'PERCENT'
                              ? e.target.value.replace(/[^\d.]/g, '')
                              : digitsOnly(e.target.value),
                          })}
                        />
                        <Input
                          label="Áp dụng từ"
                          type="date"
                          value={draft.effectiveFrom}
                          onChange={(e) => updateDraft(index, { effectiveFrom: e.target.value })}
                        />
                      </div>

                      <div className="mt-3">
                        <Input
                          label="Công thức riêng (trống = dùng công thức chung của khoản)"
                          placeholder={component?.formula || 'VD: HOURLY_RATE * 1.5 * OT_WEEKDAY_HOURS'}
                          value={draft.formula}
                          onChange={(e) => updateDraft(index, { formula: e.target.value })}
                          error={error ?? undefined}
                          className="font-mono text-xs"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <details className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <summary className="cursor-pointer text-xs font-bold text-slate-600">
                Biến dùng được trong công thức
              </summary>
              <div className="mt-2.5 grid gap-x-4 gap-y-1 text-xs text-slate-600 sm:grid-cols-2">
                <VariableHint name="BASE" desc="Lương gốc đã tính theo ngày công" />
                <VariableHint name="GROSS" desc="Tổng thu nhập tới khoản đang tính" />
                <VariableHint name="HOURLY_RATE" desc="Đơn giá một giờ" />
                <VariableHint name="DAILY_RATE" desc="Đơn giá một ngày" />
                <VariableHint name="PAID_DAYS" desc="Ngày công + ngày phép hưởng lương" />
                <VariableHint name="WORK_HOURS" desc="Giờ làm thực tế trong tháng" />
                <VariableHint name="STANDARD_DAYS" desc="Ngày công chuẩn" />
                <VariableHint name="INSURANCE_BASE" desc="Mức lương đóng bảo hiểm" />
                <VariableHint name="DEPENDENTS" desc="Số người phụ thuộc" />
                {components
                  .filter((component) => component.input_code)
                  .map((component) => (
                    <VariableHint
                      key={component.id}
                      name={component.input_code as string}
                      desc={`Số liệu tháng cho "${component.name}"`}
                    />
                  ))}
              </div>
              <p className="mt-2.5 text-xs leading-relaxed text-slate-500">
                Hàm dùng được: <code className="font-mono">MIN, MAX, ROUND, FLOOR, CEIL, ABS, IF</code>.
                Ví dụ hoa hồng bậc thang:{' '}
                <code className="font-mono text-slate-700">IF(REVENUE &gt; 500000000, REVENUE * 0.05, REVENUE * 0.03)</code>
              </p>
            </details>
          </section>

          <Textarea
            label="Ghi chú"
            rows={2}
            placeholder="VD: Tăng lương theo quyết định ngày 01/09/2026"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          {hasFormulaError && (
            <p className="flex items-start gap-2 text-xs text-red-600">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              Còn công thức chưa hợp lệ. Sửa xong mới lưu được — công thức hỏng sẽ làm khoản đó
              bị bỏ qua khi chạy lương.
            </p>
          )}

          <div className="flex gap-3 pt-1">
            <Button variant="outline" onClick={onClose} className="flex-1" disabled={saving}>Hủy</Button>
            <Button onClick={handleSave} className="flex-1" disabled={saving || hasFormulaError}>
              {saving ? 'Đang lưu…' : (<><Wallet className="h-4 w-4" /> Lưu cơ chế lương</>)}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function VariableHint({ name, desc }: { name: string; desc: string }) {
  return (
    <p>
      <code className="font-mono font-bold text-slate-700">{name}</code>
      <span className="text-slate-400"> — {desc}</span>
    </p>
  );
}

function formatComponentDefault(component: PayComponent): string {
  const amount = Number(component.default_amount);
  return component.calc_type === 'PERCENT' ? `${amount}%` : formatVND(amount);
}

function describeCalcType(component: PayComponent): string {
  switch (component.calc_type) {
    case 'FIXED':
      return component.prorate ? 'Số tiền cố định, chia theo ngày công' : 'Số tiền cố định trọn tháng';
    case 'PER_DAY': return 'Đơn giá × số ngày công';
    case 'PER_HOUR': return `Đơn giá × số giờ nhập ở mã ${component.input_code}`;
    case 'PER_UNIT': return `Đơn giá × sản lượng nhập ở mã ${component.input_code}`;
    case 'PERCENT': return `Phần trăm trên ${component.base_code}`;
    case 'FORMULA': return `Công thức: ${component.formula}`;
    default: return '';
  }
}
