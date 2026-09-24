import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarDays, Copy, Plus, TriangleAlert, Trash2, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { useConfirm } from '@/contexts/ConfirmContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { describeDbError, describeDbErrorOrNull } from '@/lib/dbError';
import {
  WEEKLY_HOUR_LIMIT, addDays, fetchShiftTypes, formatHours, shiftCoversDate, startOfWeek, weekDays, weeklyHours,
} from '@/lib/shifts';
import { toDateString } from '@/lib/utils';
import type { Profile, Shift, ShiftTypeConfig } from '@/types';

/**
 * Lịch ca cả tuần: hàng là nhân viên, cột là ngày.
 *
 * Đây là thứ trước đây không có. Trang duyệt ca chỉ là danh sách phẳng, nên
 * quản lý bấm Duyệt mà không biết ngày đó đã có bao nhiêu người — duyệt mù.
 */
export function ShiftWeekGrid() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const [staff, setStaff] = useState<Profile[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [types, setTypes] = useState<ShiftTypeConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [assignTarget, setAssignTarget] = useState<{ user: Profile; dateKey: string; label: string } | null>(null);

  const days = useMemo(() => weekDays(anchor), [anchor]);
  const typeHours = useMemo(() => new Map(types.map((t) => [t.code, Number(t.hours)])), [types]);
  const typeByCode = useMemo(() => new Map(types.map((t) => [t.code, t])), [types]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);

  const load = async () => {
    setLoading(true);
    const from = days[0].key;
    const to = days[6].key;

    const [typeResult, staffResult, shiftResult] = await Promise.all([
      fetchShiftTypes(),
      supabase.from('profiles').select('*').eq('is_active', true).order('name'),
      // Lấy mọi ca GIAO với tuần đang xem, không chỉ ca bắt đầu trong tuần —
      // một đơn "cả tháng" phải hiện ở mọi tuần nó phủ.
      supabase.from('shifts').select('*').lte('start_date', to).gte('end_date', from),
    ]);

    const firstError = typeResult.error ?? describeDbErrorOrNull(staffResult.error) ?? describeDbErrorOrNull(shiftResult.error) ?? null;
    setLoadError(firstError);
    setTypes(typeResult.data);
    setStaff((staffResult.data || []) as Profile[]);
    setShifts((shiftResult.data || []) as Shift[]);
    setLoading(false);
  };

  /** Ca của một người trong một ngày. */
  const cellShifts = (userId: string, dateKey: string) =>
    shifts.filter((s) => s.user_id === userId && s.status !== 'rejected' && shiftCoversDate(s, dateKey));

  /** Số người theo từng loại ca trong một ngày — dòng tổng ở chân bảng. */
  const countByType = (dateKey: string, typeCode: string) =>
    new Set(
      shifts
        .filter((s) => s.status === 'approved' && s.shift_type === typeCode && shiftCoversDate(s, dateKey))
        .map((s) => s.user_id),
    ).size;

  const assign = async (typeCode: string) => {
    if (!assignTarget || !profile) return;
    setBusy(true);
    // Quản lý xếp ca thì duyệt luôn — không có lý do bắt chính mình duyệt lại.
    const { error } = await supabase.from('shifts').insert({
      user_id: assignTarget.user.id,
      start_date: assignTarget.dateKey,
      end_date: assignTarget.dateKey,
      shift_type: typeCode,
      status: 'approved',
      approved_by: profile.id,
      assigned_by: profile.id,
    } as never);
    setBusy(false);

    if (error) {
      // Trigger phía database trả về nguyên văn lý do trùng ca / trùng nghỉ phép.
      toast(describeDbError(error), 'error');
      return;
    }
    toast(`Đã xếp ${typeByCode.get(typeCode)?.label} cho ${assignTarget.user.name}.`, 'success');
    setAssignTarget(null);
    load();
  };

  const removeShift = async (shift: Shift, userName: string) => {
    const type = typeByCode.get(shift.shift_type);
    const ok = await confirm({
      title: 'Gỡ ca này?',
      message: `${type?.label ?? shift.shift_type} của ${userName}. Nếu là đơn nhiều ngày, toàn bộ đơn sẽ bị xóa.`,
      confirmLabel: 'Gỡ ca',
      danger: true,
    });
    if (!ok) return;

    const { error } = await supabase.from('shifts').delete().eq('id', shift.id);
    if (error) {
      toast('Gỡ ca thất bại: ' + describeDbError(error), 'error');
      return;
    }
    toast('Đã gỡ ca.', 'success');
    load();
  };

  /** Nhân bản toàn bộ ca đã duyệt của tuần trước sang tuần đang xem. */
  const copyPreviousWeek = async () => {
    if (!profile) return;

    const prevMonday = addDays(anchor, -7);
    const prevDays = weekDays(prevMonday);

    const { data, error } = await supabase
      .from('shifts')
      .select('*')
      .eq('status', 'approved')
      .lte('start_date', prevDays[6].key)
      .gte('end_date', prevDays[0].key);

    if (error) {
      toast('Không đọc được lịch tuần trước: ' + describeDbError(error), 'error');
      return;
    }

    // Trải phẳng theo từng ngày rồi dịch sang tuần này, để đơn nhiều ngày cũng
    // sao chép đúng vị trí thứ trong tuần.
    const rows: { user_id: string; start_date: string; end_date: string; shift_type: string; status: string; approved_by: string; assigned_by: string }[] = [];
    for (let i = 0; i < 7; i++) {
      const sourceKey = prevDays[i].key;
      const targetKey = days[i].key;
      for (const shift of (data || []) as Shift[]) {
        if (!shiftCoversDate(shift, sourceKey)) continue;
        // Bỏ qua nếu tuần này người đó đã có ca cùng loại vào ngày đó.
        if (cellShifts(shift.user_id, targetKey).some((s) => s.shift_type === shift.shift_type)) continue;
        rows.push({
          user_id: shift.user_id,
          start_date: targetKey,
          end_date: targetKey,
          shift_type: shift.shift_type,
          status: 'approved',
          approved_by: profile.id,
          assigned_by: profile.id,
        });
      }
    }

    if (rows.length === 0) {
      toast('Tuần trước không có ca nào để sao chép, hoặc tuần này đã có đủ.', 'warning');
      return;
    }

    const ok = await confirm({
      title: `Sao chép ${rows.length} ca từ tuần trước?`,
      message: 'Các ca đã tồn tại trong tuần này sẽ được giữ nguyên, không bị ghi đè.',
      confirmLabel: 'Sao chép',
    });
    if (!ok) return;

    setBusy(true);
    // Chèn từng dòng: trigger chống trùng chạy theo từng bản ghi, chèn cả mảng
    // sẽ hỏng toàn bộ chỉ vì một xung đột.
    let inserted = 0;
    const failures: string[] = [];
    for (const row of rows) {
      const { error: rowError } = await supabase.from('shifts').insert(row as never);
      if (rowError) failures.push(describeDbError(rowError));
      else inserted++;
    }
    setBusy(false);

    if (inserted > 0) toast(`Đã sao chép ${inserted} ca.`, 'success');
    if (failures.length > 0) {
      toast(`${failures.length} ca bị bỏ qua do xung đột. ${failures[0]}`, 'warning');
    }
    load();
  };

  const isThisWeek = toDateString(startOfWeek(new Date())) === days[0].key;

  return (
    <div className="space-y-4">
      {/* Điều hướng tuần */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setAnchor(addDays(anchor, -7))}
            className="p-2 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors"
            aria-label="Tuần trước"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => setAnchor(addDays(anchor, 7))}
            className="p-2 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors"
            aria-label="Tuần sau"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <div className="min-w-0">
          <p className="font-display text-base font-bold text-slate-800">
            {days[0].label} — {days[6].label}
          </p>
          <p className="text-xs text-slate-400">
            {isThisWeek ? 'Tuần này' : days[0].date.toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' })}
          </p>
        </div>

        {!isThisWeek && (
          <Button variant="outline" size="sm" onClick={() => setAnchor(startOfWeek(new Date()))}>
            <CalendarDays className="w-4 h-4" />
            Về tuần này
          </Button>
        )}

        <Button variant="outline" size="sm" onClick={copyPreviousWeek} disabled={busy} className="ml-auto">
          <Copy className="w-4 h-4" />
          Sao chép tuần trước
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-5 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : loadError ? (
            <ErrorState message={loadError} onRetry={load} />
          ) : staff.length === 0 ? (
            <EmptyState title="Chưa có nhân sự" description="Thêm người dùng để bắt đầu xếp ca." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse min-w-[820px]">
                <thead>
                  <tr className="bg-slate-50/70">
                    <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3 sticky left-0 bg-slate-50/70 z-10 min-w-[180px]">
                      Nhân viên
                    </th>
                    {days.map((d) => (
                      <th key={d.key} className="text-center text-xs font-semibold px-2 py-3 min-w-[92px]">
                        <span className="block text-slate-600">{d.weekdayLabel}</span>
                        <span className="block text-[11px] font-normal text-slate-400">{d.label}</span>
                      </th>
                    ))}
                    <th className="text-center text-xs font-semibold text-slate-500 uppercase tracking-wider px-3 py-3 min-w-[90px]">
                      Tổng giờ
                    </th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-50">
                  {staff.map((person) => {
                    const personShifts = shifts.filter((s) => s.user_id === person.id);
                    const { approved, pending } = weeklyHours(personShifts, days, typeHours);
                    const over = approved > WEEKLY_HOUR_LIMIT;

                    return (
                      <tr key={person.id} className="hover:bg-slate-50/40 transition-colors">
                        <td className="px-4 py-2.5 sticky left-0 bg-white z-10">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={person.name} url={person.avatar_url} size="sm" />
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-slate-800 truncate">{person.name}</p>
                              {person.department && <p className="text-xs text-slate-400 truncate">{person.department}</p>}
                            </div>
                          </div>
                        </td>

                        {days.map((d) => {
                          const cell = cellShifts(person.id, d.key);
                          return (
                            <td key={d.key} className="px-1.5 py-2 align-top">
                              <div className="space-y-1">
                                {cell.map((shift) => {
                                  const type = typeByCode.get(shift.shift_type);
                                  return (
                                    <button
                                      key={shift.id}
                                      onClick={() => removeShift(shift, person.name)}
                                      title={`${type?.label} ${type?.start_time?.slice(0, 5)}–${type?.end_time?.slice(0, 5)}${shift.status === 'pending' ? ' · chờ duyệt' : ''} — bấm để gỡ`}
                                      className={`w-full text-[11px] font-medium px-1.5 py-1 rounded-lg transition-opacity hover:opacity-70 ${type?.color ?? 'bg-slate-100 text-slate-700'} ${shift.status === 'pending' ? 'ring-1 ring-dashed ring-amber-400' : ''}`}
                                    >
                                      {type?.label ?? shift.shift_type}
                                    </button>
                                  );
                                })}

                                <button
                                  onClick={() => setAssignTarget({ user: person, dateKey: d.key, label: `${d.weekdayLabel} ${d.label}` })}
                                  className="w-full flex items-center justify-center py-1 rounded-lg text-slate-300 hover:text-blue-500 hover:bg-blue-50 transition-colors"
                                  aria-label={`Xếp ca cho ${person.name} ngày ${d.label}`}
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          );
                        })}

                        <td className="px-3 py-2.5 text-center">
                          <span className={`text-sm font-semibold ${over ? 'text-red-600' : 'text-slate-700'}`}>
                            {formatHours(approved)}
                          </span>
                          {pending > 0 && (
                            <span className="block text-[11px] text-amber-600">+{formatHours(pending)} chờ</span>
                          )}
                          {over && (
                            <span className="flex items-center justify-center gap-1 text-[10px] text-red-600 mt-0.5">
                              <TriangleAlert className="w-3 h-3" />
                              vượt {WEEKLY_HOUR_LIMIT}h
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>

                {/* Dòng tổng: bao nhiêu người mỗi ca mỗi ngày — câu trả lời trực
                    tiếp cho "phân bổ đã hợp lý chưa". */}
                <tfoot className="bg-slate-50/70 border-t-2 border-slate-200">
                  {types.map((type) => (
                    <tr key={type.code}>
                      <td className="px-4 py-2 sticky left-0 bg-slate-50/70 z-10">
                        <span className="flex items-center gap-2 text-xs font-medium text-slate-600">
                          <span className={`w-2 h-2 rounded-full ${type.dot}`} />
                          {type.label}
                          <span className="text-slate-400 font-normal">
                            {type.start_time.slice(0, 5)}–{type.end_time.slice(0, 5)}
                          </span>
                        </span>
                      </td>
                      {days.map((d) => {
                        const count = countByType(d.key, type.code);
                        return (
                          <td key={d.key} className="px-2 py-2 text-center">
                            <span className={`text-sm font-semibold ${count === 0 ? 'text-slate-300' : 'text-slate-700'}`}>
                              {count}
                            </span>
                          </td>
                        );
                      })}
                      <td />
                    </tr>
                  ))}
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Xếp ca trực tiếp */}
      <Modal
        open={!!assignTarget}
        onClose={() => setAssignTarget(null)}
        title={`Xếp ca — ${assignTarget?.user.name ?? ''}`}
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            Ngày <strong className="text-slate-700">{assignTarget?.label}</strong>. Ca do quản lý xếp
            được duyệt ngay, không cần nhân viên đăng ký.
          </p>

          <div className="space-y-2">
            {types.map((type) => (
              <button
                key={type.code}
                onClick={() => assign(type.code)}
                disabled={busy}
                className="w-full flex items-center gap-3 p-3 rounded-xl border border-slate-200 hover:border-blue-300 hover:bg-blue-50/50 transition-colors text-left disabled:opacity-50"
              >
                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${type.dot}`} />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-slate-800">{type.label}</span>
                  <span className="block text-xs text-slate-500">
                    {type.start_time.slice(0, 5)} – {type.end_time.slice(0, 5)} · {formatHours(Number(type.hours))}
                  </span>
                </span>
              </button>
            ))}
          </div>

          <Button type="button" variant="outline" onClick={() => setAssignTarget(null)} className="w-full">
            <X className="w-4 h-4" />
            Hủy
          </Button>
        </div>
      </Modal>
    </div>
  );
}
