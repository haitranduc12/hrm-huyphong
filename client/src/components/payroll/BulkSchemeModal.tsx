// ============================================================================
// Thiết lập cơ chế lương cho NHIỀU người cùng lúc.
// ----------------------------------------------------------------------------
// Một tổ công nhân mười mấy người cùng một đơn giá ngày là chuyện thường. Mở
// từng phiếu gõ lại mười mấy lần vừa lâu, vừa gần như chắc chắn có một người
// bị gõ lệch mà không ai đối chiếu ra.
//
// Màn này CỐ Ý hẹp: chỉ đặt những thứ thường giống nhau cả tổ — cách trả
// lương, mức, ngày hiệu lực, mức đóng bảo hiểm, cách tính thuế. Những thứ
// thuộc về từng người (số người phụ thuộc, khoản cộng/trừ riêng) không có ở
// đây, vì đặt hàng loạt cho chúng gần như luôn là sai.
//
// Ghi theo ngày hiệu lực như bản lẻ: đây là TẠO BẢN GHI MỚI, không sửa đè bản
// cũ, nên các tháng đã chạy lương giữ nguyên mức cũ.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { TriangleAlert, Users } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { formatVND } from '@/lib/utils';
import { payBasisLabel } from '@/lib/payroll';
import { savePayProfile } from '@/lib/payrollData';
import type { PayBasis, Profile, TaxMode } from '@/types';
import type { PayrollParams } from '@/lib/payrollSettings';

const PAY_BASES: PayBasis[] = ['MONTHLY', 'HOURLY', 'DAILY', 'PIECE', 'COMMISSION'];

const BASE_LABEL: Record<PayBasis, string> = {
  MONTHLY: 'Lương tháng (VND)',
  HOURLY: 'Đơn giá một giờ (VND)',
  DAILY: 'Đơn giá một ngày công (VND)',
  PIECE: 'Lương cứng tối thiểu (VND)',
  COMMISSION: 'Lương cứng hằng tháng (VND)',
};

const TAX_MODES: Array<{ value: TaxMode; label: string }> = [
  { value: 'PROGRESSIVE', label: 'Lũy tiến 7 bậc' },
  { value: 'FLAT', label: 'Khấu trừ thẳng theo %' },
  { value: 'NONE', label: 'Không khấu trừ' },
];

const digitsOnly = (value: string) => value.replace(/[^\d]/g, '');

interface BulkSchemeModalProps {
  open: boolean;
  targets: Profile[];
  params: PayrollParams;
  defaultEffectiveFrom: string;
  actorId: string | null;
  onClose: () => void;
  onSaved: () => void;
}

export function BulkSchemeModal({
  open, targets, params, defaultEffectiveFrom, actorId, onClose, onSaved,
}: BulkSchemeModalProps) {
  const { toast } = useToast();

  const [basis, setBasis] = useState<PayBasis>('MONTHLY');
  const [baseAmount, setBaseAmount] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(defaultEffectiveFrom);
  const [insuranceEnabled, setInsuranceEnabled] = useState(true);
  const [insuranceBase, setInsuranceBase] = useState('');
  const [taxMode, setTaxMode] = useState<TaxMode>('PROGRESSIVE');
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!open) return;
    setBasis('MONTHLY');
    setBaseAmount('');
    setEffectiveFrom(defaultEffectiveFrom);
    setInsuranceEnabled(true);
    setInsuranceBase('');
    setTaxMode('PROGRESSIVE');
    setProgress(0);
  }, [open, defaultEffectiveFrom]);

  const parsedBase = Number(baseAmount || '0');
  const effectiveInsuranceBase = Number(insuranceBase || '0') || parsedBase;

  const monthlyCost = useMemo(() => {
    if (basis !== 'MONTHLY' || parsedBase <= 0) return null;
    return parsedBase * targets.length;
  }, [basis, parsedBase, targets.length]);

  const save = async () => {
    if (basis !== 'PIECE' && parsedBase <= 0) {
      toast('Nhập đơn giá lương hợp lệ.', 'warning');
      return;
    }

    setSaving(true);
    setProgress(0);

    // Ghi tuần tự để đếm được đúng số người đã xong. Lỗi giữa chừng thì DỪNG
    // và nói rõ đã ghi tới ai — im lặng bỏ qua sẽ để lại một tổ nửa có nửa
    // không mà không ai biết.
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const error = await savePayProfile({
        user_id: target.id,
        effective_from: effectiveFrom,
        pay_basis: basis,
        base_amount: parsedBase,
        insurance_enabled: insuranceEnabled,
        insurance_base: insuranceBase ? Number(insuranceBase) : null,
        dependents: 0,
        tax_mode: taxMode,
        flat_tax_rate: taxMode === 'FLAT' ? 10 : undefined,
        standard_days_override: null,
        note: `Thiết lập hàng loạt cho ${targets.length} nhân sự.`,
        created_by: actorId,
      });

      if (error) {
        setSaving(false);
        toast(
          `Dừng ở ${target.name}: ${error}. Đã lưu xong ${index} nhân sự trước đó.`,
          'error',
        );
        onSaved();
        return;
      }
      setProgress(index + 1);
    }

    setSaving(false);
    toast(`Đã thiết lập cơ chế lương cho ${targets.length} nhân sự.`, 'success');
    onSaved();
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Thiết lập cơ chế lương hàng loạt" size="lg">
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-xl bg-indigo-50 px-4 py-3">
          <Users className="mt-0.5 h-5 w-5 flex-shrink-0 text-indigo-600" />
          <div className="min-w-0">
            <p className="text-sm font-bold text-indigo-900">
              Áp cho {targets.length} nhân sự
            </p>
            <p className="mt-0.5 truncate text-xs text-indigo-800">
              {targets.slice(0, 5).map((person) => person.name).join(', ')}
              {targets.length > 5 && ` và ${targets.length - 5} người nữa`}
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Select label="Hình thức trả lương" value={basis} onChange={(e) => setBasis(e.target.value as PayBasis)}>
              {PAY_BASES.map((value) => (
                <option key={value} value={value}>{payBasisLabel(value)}</option>
              ))}
            </Select>
          </div>
          <div>
            <Input
              label={BASE_LABEL[basis]}
              inputMode="numeric"
              placeholder="VD: 15000000"
              value={baseAmount}
              onChange={(e) => setBaseAmount(digitsOnly(e.target.value))}
            />
            {monthlyCost != null && (
              <p className="mt-1.5 text-xs text-slate-500">
                Tổng lương tháng của nhóm: <strong className="text-slate-700">{formatVND(monthlyCost)}</strong>
              </p>
            )}
          </div>
        </div>

        <Input
          label="Áp dụng từ ngày"
          type="date"
          value={effectiveFrom}
          onChange={(e) => setEffectiveFrom(e.target.value)}
        />

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
              Người lao động đóng{' '}
              {(params.socialInsuranceRate + params.healthInsuranceRate + params.unemploymentInsuranceRate).toFixed(1)}%.
            </span>
          </span>
        </label>

        {insuranceEnabled && (
          <div>
            <Input
              label="Mức lương đóng bảo hiểm"
              inputMode="numeric"
              placeholder={parsedBase > 0 ? String(parsedBase) : 'VD: 8000000'}
              value={insuranceBase}
              onChange={(e) => setInsuranceBase(digitsOnly(e.target.value))}
            />
            {effectiveInsuranceBase > 0 ? (
              <p className="mt-1.5 text-xs text-slate-500">
                Sẽ đóng trên <strong className="text-slate-700">{formatVND(effectiveInsuranceBase)}</strong>
                {!insuranceBase && ' (lấy theo lương gốc vì đang để trống)'}
                {effectiveInsuranceBase < params.regionalMinimumWage && (
                  <span className="text-amber-700">
                    {' '}— thấp hơn lương tối thiểu vùng {formatVND(params.regionalMinimumWage)}
                  </span>
                )}
              </p>
            ) : (
              <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-700">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                Chưa xác định được mức đóng — hình thức trả lương này không có mức cứng để suy ra.
              </p>
            )}
          </div>
        )}

        <Select label="Cách tính thuế TNCN" value={taxMode} onChange={(e) => setTaxMode(e.target.value as TaxMode)}>
          {TAX_MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>{mode.label}</option>
          ))}
        </Select>

        <p className="rounded-lg bg-slate-50 px-3.5 py-2.5 text-xs leading-relaxed text-slate-600">
          <strong className="text-slate-700">Không đặt hàng loạt:</strong> số người phụ thuộc và các
          khoản cộng/trừ riêng — hai thứ này khác nhau theo từng người, đặt chung gần như luôn sai.
          Mở phiếu từng người ở nút <em>Sửa</em> để khai.
        </p>

        <p className="rounded-lg bg-blue-50 px-3.5 py-2.5 text-xs leading-relaxed text-blue-800">
          Đây là tạo bản ghi mới theo ngày hiệu lực, không sửa đè bản cũ. Các tháng đã chạy lương
          trước ngày này giữ nguyên mức cũ.
        </p>

        <div className="flex items-center justify-end gap-2">
          {saving && (
            <span className="mr-auto text-xs text-slate-500">
              Đang lưu {progress}/{targets.length}…
            </span>
          )}
          <Button variant="secondary" onClick={onClose} disabled={saving}>Hủy</Button>
          <Button theme="admin" onClick={save} disabled={saving || targets.length === 0}>
            {saving ? 'Đang lưu…' : `Áp cho ${targets.length} nhân sự`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
