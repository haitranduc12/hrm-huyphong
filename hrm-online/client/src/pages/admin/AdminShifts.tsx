import { useEffect, useState } from 'react';
import { Check, X, CalendarDays, LayoutGrid, Inbox, ClipboardCheck } from 'lucide-react';
import { useRealtimeSync } from '@/hooks/useRealtimeSync';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton, TableSkeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { describeDbError } from '@/lib/dbError';
import { SHIFT_TYPE_CONFIG, SHIFT_STATUS_CONFIG, formatDate } from '@/lib/utils';
import { notifyUser } from '@/lib/assignments';
import { ShiftWeekGrid } from '@/components/ShiftWeekGrid';
import { ShiftAttendanceReconcile } from '@/components/ShiftAttendanceReconcile';
import type { Shift, ShiftStatus } from '@/types';
import { WorkflowStrip } from '@/components/WorkflowStrip';

type ShiftView = 'grid' | 'requests' | 'reconcile';

function ViewSwitcher({ view, onChange, pendingCount }: {
  view: ShiftView;
  onChange: (v: ShiftView) => void;
  pendingCount: number;
}) {
  const items: { key: ShiftView; label: string; icon: typeof LayoutGrid }[] = [
    { key: 'grid', label: 'Lịch tuần', icon: LayoutGrid },
    { key: 'requests', label: 'Đơn đăng ký', icon: Inbox },
    { key: 'reconcile', label: 'Đối chiếu chấm công', icon: ClipboardCheck },
  ];

  return (
    <div className="flex flex-wrap gap-1 border-b border-slate-200">
      {items.map((item) => (
        <button
          key={item.key}
          onClick={() => onChange(item.key)}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition-all duration-200 ${
            view === item.key
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-200'
          }`}
        >
          <item.icon className="w-4 h-4" />
          {item.label}
          {item.key === 'requests' && pendingCount > 0 && (
            <span className="ml-0.5 text-[11px] font-bold bg-amber-100 text-amber-700 rounded-full px-1.5 py-0.5">
              {pendingCount}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function AdminShifts() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Mặc định mở lịch tuần — quản lý cần thấy bức tranh trước khi duyệt từng đơn. */
  const [view, setView] = useState<ShiftView>('grid');
  const [pendingCount, setPendingCount] = useState(0);
  const [rejectModal, setRejectModal] = useState<Shift | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [filter, setFilter] = useState<'pending' | 'all' | 'approved' | 'rejected'>('pending');

  useEffect(() => {
    loadShifts();
  }, [filter]);

  useRealtimeSync([{ table: 'shifts' }, { table: 'shift_types' }], () => loadShifts(true));

  const loadShifts = async (silent = false) => {
    if (!silent) setLoading(true);
    // `shifts` có HAI khóa ngoại trỏ về `profiles` (user_id và approved_by), nên
    // `profiles(*)` là mơ hồ và PostgREST trả lỗi PGRST201. Phải chỉ rõ khóa.
    let query = supabase
      .from('shifts')
      .select('*, profile:profiles!user_id(*)')
      .order('created_at', { ascending: false });
    if (filter !== 'all') query = query.eq('status', filter);
    const { data, error } = await query;
    setLoadError(error ? describeDbError(error) : null);
    setShifts((data || []) as Shift[]);
    setLoading(false);

    // Đếm riêng để huy hiệu trên nút "Đơn đăng ký" đúng kể cả khi đang lọc.
    const { count } = await supabase
      .from('shifts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');
    setPendingCount(count ?? 0);
  };

  const handleApprove = async (shift: Shift) => {
    // Kiểm tra lại tại thời điểm duyệt để tránh hai ca được duyệt chồng ngày
    // do hai quản lý xử lý đồng thời hoặc dữ liệu cũ được nhập từ nguồn khác.
    const { data: overlaps, error: overlapError } = await supabase
      .from('shifts')
      .select('id')
      .eq('user_id', shift.user_id)
      .eq('status', 'approved')
      .neq('id', shift.id)
      .lte('start_date', shift.end_date)
      .gte('end_date', shift.start_date)
      .limit(1);
    if (overlapError) {
      toast('Không kiểm tra được lịch ca hiện tại: ' + describeDbError(overlapError), 'error');
      return;
    }
    if ((overlaps || []).length > 0) {
      toast('Không thể duyệt: nhân viên đã có ca được duyệt trùng khoảng ngày này.', 'warning');
      return;
    }

    const { data: updated, error } = await supabase.from('shifts').update({
      status: 'approved',
      approved_by: profile?.id,
      reason_reject: null,
    }).eq('id', shift.id).eq('status', 'pending').select('id').maybeSingle();

    if (error) {
      toast('Duyệt thất bại: ' + describeDbError(error), 'error');
    } else if (!updated) {
      toast('Đơn ca đã được người khác xử lý. Danh sách sẽ được cập nhật lại.', 'warning');
      loadShifts();
    } else {
      await notifyUser(
        shift.user_id,
        'Ca làm việc đã được duyệt',
        `Ca ${SHIFT_TYPE_CONFIG[shift.shift_type].label} (${formatDate(shift.start_date)} → ${formatDate(shift.end_date)}) đã được duyệt.`,
        'shift_approved',
      );
      toast('Đã duyệt ca làm việc', 'success');
      loadShifts();
    }
  };

  const handleReject = async () => {
    if (!rejectModal) return;
    const { data: updated, error } = await supabase.from('shifts').update({
      status: 'rejected',
      reason_reject: rejectReason,
      approved_by: profile?.id,
    }).eq('id', rejectModal.id).eq('status', 'pending').select('id').maybeSingle();

    if (error) {
      toast('Từ chối thất bại: ' + describeDbError(error), 'error');
    } else if (!updated) {
      toast('Đơn ca đã được người khác xử lý. Danh sách sẽ được cập nhật lại.', 'warning');
      setRejectModal(null);
      setRejectReason('');
      loadShifts();
    } else {
      await notifyUser(
        rejectModal.user_id,
        'Ca làm việc bị từ chối',
        `Ca ${SHIFT_TYPE_CONFIG[rejectModal.shift_type].label} (${formatDate(rejectModal.start_date)} → ${formatDate(rejectModal.end_date)}) đã bị từ chối. Lý do: ${rejectReason}`,
        'shift_rejected',
      );
      toast('Đã từ chối ca làm việc', 'warning');
      setRejectModal(null);
      setRejectReason('');
      loadShifts();
    }
  };

  if (view === 'grid') {
    return (
      <div className="space-y-5">
        <WorkflowStrip title="Luồng phân ca" steps={['Đăng ký / phân ca', 'Kiểm tra trùng lịch', 'Quản lý duyệt', 'Đối chiếu chấm công']} activeStep={1} />
        <ViewSwitcher view={view} onChange={setView} pendingCount={pendingCount} />
        <ShiftWeekGrid />
      </div>
    );
  }

  if (view === 'reconcile') {
    return (
      <div className="space-y-5">
        <WorkflowStrip title="Luồng phân ca" steps={['Đăng ký / phân ca', 'Kiểm tra trùng lịch', 'Quản lý duyệt', 'Đối chiếu chấm công']} activeStep={3} />
        <ViewSwitcher view={view} onChange={setView} pendingCount={pendingCount} />
        <ShiftAttendanceReconcile />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <WorkflowStrip title="Luồng phân ca" steps={['Đăng ký / phân ca', 'Kiểm tra trùng lịch', 'Quản lý duyệt', 'Đối chiếu chấm công']} activeStep={2} />
      <ViewSwitcher view={view} onChange={setView} pendingCount={pendingCount} />

      <div className="flex flex-wrap gap-2">
        {([
          { key: 'pending', label: 'Chờ duyệt' },
          { key: 'approved', label: 'Đã duyệt' },
          { key: 'rejected', label: 'Từ chối' },
          { key: 'all', label: 'Tất cả' },
] as { key: typeof filter; label: string }[]).map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-200 ${
              filter === f.key
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 hover:border-slate-300'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-5"><TableSkeleton /></div>
          ) : loadError ? (
            <ErrorState message={loadError} onRetry={loadShifts} />
          ) : shifts.length === 0 ? (
            <EmptyState icon={<CalendarDays className="w-8 h-8" />} title="Không có đơn đăng ký" description="Chưa có đơn đăng ký ca nào trong mục này." />
          ) : (
            <div className="divide-y divide-slate-50">
              {shifts.map((shift) => (
                <div key={shift.id} className="flex items-center gap-4 px-5 py-4 hover:bg-slate-50/50 transition-colors">
                  <Avatar name={shift.profile?.name || ''} url={shift.profile?.avatar_url} size="md" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-800">{shift.profile?.name}</p>
                    <div className="flex items-center gap-3 mt-1">
                      <Badge className={SHIFT_TYPE_CONFIG[shift.shift_type].color}>
                        <span className={`w-1.5 h-1.5 rounded-full ${SHIFT_TYPE_CONFIG[shift.shift_type].dot}`} />
                        {SHIFT_TYPE_CONFIG[shift.shift_type].label}
                      </Badge>
                      <span className="text-xs text-slate-500">{formatDate(shift.start_date)} → {formatDate(shift.end_date)}</span>
                      <Badge className={SHIFT_STATUS_CONFIG[shift.status].color}>
                        {SHIFT_STATUS_CONFIG[shift.status].label}
                      </Badge>
                    </div>
                    {shift.reason_reject && (
                      <p className="text-xs text-red-500 mt-1">Lý do từ chối: {shift.reason_reject}</p>
                    )}
                  </div>
                  {shift.status === 'pending' && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleApprove(shift)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 text-xs font-medium hover:bg-emerald-100 transition-colors"
                      >
                        <Check className="w-3.5 h-3.5" />
                        Duyệt
                      </button>
                      <button
                        onClick={() => { setRejectModal(shift); setRejectReason(''); }}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-medium hover:bg-red-100 transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                        Từ chối
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Modal open={!!rejectModal} onClose={() => setRejectModal(null)} title="Từ chối ca làm việc" size="sm">
        <div className="space-y-4">
          <Textarea
            label="Lý do từ chối"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={3}
            placeholder="Nhập lý do từ chối..."
          />
          <div className="flex gap-3">
            <Button variant="outline" onClick={() => setRejectModal(null)} className="flex-1">Hủy</Button>
            <Button variant="danger" onClick={handleReject} disabled={!rejectReason.trim()} className="flex-1">
              Xác nhận từ chối
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
