import { useEffect, useState } from 'react';
import { Plus, CalendarDays, ChevronLeft, ChevronRight, Edit3, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input, Select } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { useConfirm } from '@/contexts/ConfirmContext';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtimeSync } from '@/hooks/useRealtimeSync';
import { supabase } from '@/lib/supabase';
import { describeDbError } from '@/lib/dbError';
import { SHIFT_TYPE_CONFIG, SHIFT_STATUS_CONFIG, formatDate, getTodayString, toDateString } from '@/lib/utils';
import { fetchApproverIds, notifyUsers } from '@/lib/assignments';
import type { LeaveRequest, Shift, ShiftType } from '@/types';

export function StaffShifts() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
const [modalOpen, setModalOpen] = useState(false);
  const [editingShift, setEditingShift] = useState<Shift | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // getTodayString() lấy ngày theo múi giờ máy. Dùng toISOString() ở đây sẽ ra
  // ngày hôm qua trong khoảng 00:00–07:00 giờ Việt Nam.
  const [form, setForm] = useState({
    start_date: getTodayString(),
    end_date: getTodayString(),
    shift_type: 'morning' as ShiftType,
  });
  const [calendarMonth, setCalendarMonth] = useState(new Date());

  useEffect(() => {
    if (profile) loadShifts();
  }, [profile]);

  // Admin duyệt hoặc từ chối đơn ca thì nhân viên thấy ngay.
  useRealtimeSync(
    profile ? [{ table: 'shifts', filter: `user_id=eq.${profile.id}` }] : [],
    () => loadShifts(true),
    { enabled: !!profile },
  );

  const loadShifts = async (silent = false) => {
    if (!silent) setLoading(true);
    const { data, error } = await supabase
      .from('shifts')
      .select('*')
      .eq('user_id', profile?.id)
      .order('created_at', { ascending: false });
    setLoadError(error ? describeDbError(error) : null);
    setShifts((data || []) as Shift[]);
    setLoading(false);
  };

const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Chỉ đăng ký cho hôm nay trở đi — đăng ký ca cho ngày đã qua là vô nghĩa,
    // và làm sai lệch cả báo cáo phân bổ lẫn đối chiếu chấm công.
    if (form.start_date < getTodayString()) {
      toast('Chỉ đăng ký được ca từ hôm nay trở đi.', 'warning');
      return;
    }
    if (form.end_date < form.start_date) {
      toast('Ngày kết thúc phải sau ngày bắt đầu', 'warning');
      return;
    }
    setSubmitting(true);

    let overlapQuery = supabase
      .from('shifts')
      .select('id, start_date, end_date, status')
      .eq('user_id', profile?.id)
      .in('status', ['pending', 'approved'])
      .lte('start_date', form.end_date)
      .gte('end_date', form.start_date);
    if (editingShift) overlapQuery = overlapQuery.neq('id', editingShift.id);
    const { data: overlaps, error: overlapError } = await overlapQuery;
    if (overlapError) {
      setSubmitting(false);
      toast('Không kiểm tra được lịch ca hiện tại: ' + describeDbError(overlapError), 'error');
      return;
    }
    if ((overlaps || []).length > 0) {
      setSubmitting(false);
      toast('Khoảng ngày này đang trùng với một ca chờ duyệt hoặc đã duyệt.', 'warning');
      return;
    }

    const { data: leaveConflicts, error: leaveError } = await supabase
      .from('leave_requests')
      .select('*')
      .eq('user_id', profile?.id)
      .eq('status', 'approved')
      .lte('start_date', form.end_date)
      .gte('end_date', form.start_date);
    if (leaveError) {
      setSubmitting(false);
      toast('Không kiểm tra được lịch nghỉ: ' + describeDbError(leaveError), 'error');
      return;
    }
    if (((leaveConflicts || []) as LeaveRequest[]).some((leave) => !leave.is_cancelled)) {
      setSubmitting(false);
      toast('Không thể đăng ký ca trùng với thời gian nghỉ đã được duyệt.', 'warning');
      return;
    }

    if (editingShift) {
      const { data: updated, error } = await supabase.from('shifts').update({
        start_date: form.start_date,
        end_date: form.end_date,
        shift_type: form.shift_type,
      }).eq('id', editingShift.id).eq('status', 'pending').select('id').maybeSingle();
      if (error) {
        toast('Cập nhật thất bại: ' + describeDbError(error), 'error');
      } else if (!updated) {
        toast('Đơn ca đã được quản lý xử lý nên không thể sửa.', 'warning');
        setModalOpen(false);
        loadShifts();
      } else {
        toast('Cập nhật đăng ký ca thành công!', 'success');
        setModalOpen(false);
        loadShifts();
      }
    } else {
      const { error } = await supabase.from('shifts').insert({
        user_id: profile?.id,
        start_date: form.start_date,
        end_date: form.end_date,
        shift_type: form.shift_type,
        status: 'pending',
      });
      if (error) {
        toast('Đăng ký thất bại: ' + describeDbError(error), 'error');
      } else {
        toast('Đăng ký ca thành công! Chờ quản lý duyệt.', 'success');
        setModalOpen(false);
        loadShifts();

        // Báo cho người duyệt ca — trước đây module ca thiếu bước này, nên
        // nhân viên đăng ký xong quản lý không biết mà duyệt (nghỉ phép và giao
        // việc đều đã báo). Quyền duyệt ca là 'shifts'.
        const dateText = form.start_date === form.end_date
          ? `ngày ${formatDate(form.start_date)}`
          : `${formatDate(form.start_date)} → ${formatDate(form.end_date)}`;
        const managerIds = await fetchApproverIds('shifts');
        await notifyUsers(
          managerIds.filter((id) => id !== profile?.id),
          'Đăng ký ca mới cần duyệt',
          `${profile?.name ?? 'Nhân viên'} đăng ký ca ${SHIFT_TYPE_CONFIG[form.shift_type].label} — ${dateText}.`,
          'shift_requested',
        );
      }
    }
    setSubmitting(false);
  };

  const openCreate = () => {
    setEditingShift(null);
    setForm({
      start_date: getTodayString(),
      end_date: getTodayString(),
      shift_type: 'morning',
    });
    setModalOpen(true);
  };

  const openEdit = (shift: Shift) => {
    setEditingShift(shift);
    setForm({
      start_date: shift.start_date,
      end_date: shift.end_date,
      shift_type: shift.shift_type,
    });
    setModalOpen(true);
  };

  const handleDelete = async (shift: Shift) => {
    const ok = await confirm({
      title: 'Xóa đơn đăng ký ca?',
      message: `Ca ${SHIFT_TYPE_CONFIG[shift.shift_type].label} ${formatDate(shift.start_date)} → ${formatDate(shift.end_date)} sẽ bị gỡ khỏi lịch.`,
      confirmLabel: 'Xóa đơn',
      danger: true,
    });
    if (!ok) return;
    const { data: deleted, error } = await supabase.from('shifts').delete().eq('id', shift.id).eq('status', 'pending').select('id').maybeSingle();
    if (error) {
      toast('Xóa thất bại: ' + describeDbError(error), 'error');
    } else if (!deleted) {
      toast('Đơn ca đã được quản lý xử lý nên không thể xóa.', 'warning');
      loadShifts();
    } else {
      toast('Đã xóa đơn đăng ký ca', 'success');
      loadShifts();
    }
  };

  // Calendar generation
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startWeekday = firstDay.getDay();

  const calendarDays: (number | null)[] = [];
  for (let i = 0; i < startWeekday; i++) calendarDays.push(null);
  for (let d = 1; d <= daysInMonth; d++) calendarDays.push(d);
  while (calendarDays.length % 7 !== 0) calendarDays.push(null);

  const getShiftsForDay = (day: number) => {
    // KHÔNG dùng toISOString() ở đây: nó đổi sang UTC, mà Việt Nam là UTC+7 nên
    // nửa đêm ngày 10 giờ địa phương thành 17:00 ngày 09 giờ UTC — ô số 10 đi
    // tra ngày 09, khiến mọi ca hiện lệch sang ô hôm sau.
    const dateStr = toDateString(new Date(year, month, day));
    return shifts.filter((s) => s.start_date <= dateStr && s.end_date >= dateStr);
  };

  const monthName = calendarMonth.toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Calendar */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Lịch làm việc</CardTitle>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCalendarMonth(new Date(year, month - 1, 1))}
                className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
              >
                <ChevronLeft className="w-4 h-4 text-slate-500" />
              </button>
              <span className="text-sm font-medium text-slate-700 capitalize min-w-[120px] text-center">{monthName}</span>
              <button
                onClick={() => setCalendarMonth(new Date(year, month + 1, 1))}
                className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
              >
                <ChevronRight className="w-4 h-4 text-slate-500" />
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-7 gap-1 mb-2">
            {['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'].map((d) => (
              <div key={d} className="text-center text-xs font-medium text-slate-400 py-2">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {calendarDays.map((day, i) => {
              if (day === null) return <div key={i} />;
              const dayShifts = getShiftsForDay(day);
              const isToday = new Date().toDateString() === new Date(year, month, day).toDateString();
              return (
                <div
                  key={i}
                  className={`min-h-[60px] p-1.5 rounded-lg border ${
                    isToday ? 'border-emerald-300 bg-emerald-50/30' : 'border-slate-100'
                  }`}
                >
                  <span className={`text-xs ${isToday ? 'font-bold text-emerald-700' : 'text-slate-500'}`}>{day}</span>
                  <div className="space-y-0.5 mt-0.5">
                    {dayShifts.map((s) => (
                      <div
                        key={s.id}
                        className={`text-[10px] px-1 py-0.5 rounded ${SHIFT_TYPE_CONFIG[s.shift_type].color} truncate`}
                      >
                        {SHIFT_TYPE_CONFIG[s.shift_type].label}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* My shifts list */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Đơn đăng ký của tôi</CardTitle>
<Button onClick={openCreate} theme="staff" size="sm">
              <Plus className="w-4 h-4" />
              Đăng ký ca
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-48" />
          ) : loadError ? (
            <ErrorState message={loadError} onRetry={loadShifts} />
          ) : shifts.length === 0 ? (
            <EmptyState
              icon={<CalendarDays className="w-8 h-8" />}
              title="Chưa có đơn đăng ký"
              description="Đăng ký ca làm việc để quản lý duyệt."
            />
          ) : (
            <div className="space-y-3">
{shifts.map((shift) => (
                <div key={shift.id} className="flex items-center gap-3 p-3 rounded-xl border border-slate-200 hover:border-slate-300 hover:shadow-soft transition-all duration-200">
                  <div className={`w-2.5 h-2.5 rounded-full ${SHIFT_TYPE_CONFIG[shift.shift_type].dot}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge className={SHIFT_TYPE_CONFIG[shift.shift_type].color}>
                        {SHIFT_TYPE_CONFIG[shift.shift_type].label}
                      </Badge>
                      <Badge className={SHIFT_STATUS_CONFIG[shift.status].color}>
                        {SHIFT_STATUS_CONFIG[shift.status].label}
                      </Badge>
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      {formatDate(shift.start_date)} → {formatDate(shift.end_date)}
                    </p>
                    {shift.reason_reject && (
                      <p className="text-xs text-red-500 mt-1">Lý do từ chối: {shift.reason_reject}</p>
                    )}
                  </div>
                  {shift.status === 'pending' && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => openEdit(shift)}
                        title="Sửa"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(shift)}
                        title="Xóa"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

<Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editingShift ? 'Chỉnh sửa đăng ký ca' : 'Đăng ký ca làm việc'}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Ngày bắt đầu"
              type="date"
              value={form.start_date}
              min={getTodayString()}
              onChange={(e) => {
                const start = e.target.value;
                // Kéo ngày kết thúc theo nếu nó thành vô lý.
                setForm((f) => ({ ...f, start_date: start, end_date: f.end_date < start ? start : f.end_date }));
              }}
              required
            />
            <Input
              label="Ngày kết thúc"
              type="date"
              value={form.end_date}
              min={form.start_date || getTodayString()}
              onChange={(e) => setForm({ ...form, end_date: e.target.value })}
              required
            />
          </div>
          <Select
            label="Loại ca"
            value={form.shift_type}
            onChange={(e) => setForm({ ...form, shift_type: e.target.value as ShiftType })}
          >
            <option value="morning">Ca sáng</option>
            <option value="afternoon">Ca chiều</option>
            <option value="night">Ca tối</option>
            <option value="full">Cả ngày</option>
          </Select>
          <div className="flex gap-3 pt-2">
            <Button type="button" variant="outline" onClick={() => setModalOpen(false)} className="flex-1">Hủy</Button>
<Button type="submit" theme="staff" disabled={submitting} className="flex-1">
              {submitting ? 'Đang gửi...' : editingShift ? 'Lưu thay đổi' : 'Đăng ký'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
