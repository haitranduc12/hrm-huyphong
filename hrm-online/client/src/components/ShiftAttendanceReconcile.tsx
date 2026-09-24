import { useEffect, useMemo, useState } from 'react';
import { describeDbErrorOrNull } from '@/lib/dbError';
import { ChevronLeft, ChevronRight, CalendarDays, CheckCircle2, Clock, UserX } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { supabase } from '@/lib/supabase';
import {
  addDays, fetchShiftTypes, formatLateness, lateMinutes, shiftCoversDate, startOfWeek, weekDays,
} from '@/lib/shifts';
import { formatTime, toDateString } from '@/lib/utils';
import type { Attendance, Profile, Shift, ShiftTypeConfig } from '@/types';

interface Row {
  key: string;
  person: Profile;
  dateKey: string;
  dateLabel: string;
  type: ShiftTypeConfig;
  checkIn: string | null;
}

/**
 * Đối chiếu ca đã xếp với chấm công thực tế.
 *
 * Trước đây hai module này hoàn toàn rời nhau: nhân viên đăng ký ca sáng 08:00
 * rồi check-in lúc 09:15 mà hệ thống không hề biết. Có giờ ca trong
 * `shift_types` rồi mới so được.
 */
export function ShiftAttendanceReconcile() {
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const days = useMemo(() => weekDays(anchor), [anchor]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);

  const load = async () => {
    setLoading(true);
    const from = days[0].key;
    const to = days[6].key;

    const [typeResult, staffResult, shiftResult, attResult] = await Promise.all([
      fetchShiftTypes(),
      supabase.from('profiles').select('*').eq('is_active', true),
      supabase.from('shifts').select('*').eq('status', 'approved').lte('start_date', to).gte('end_date', from),
      supabase.from('attendance').select('user_id, date, check_in_time').gte('date', from).lte('date', to),
    ]);

    const firstError =
      typeResult.error ?? describeDbErrorOrNull(staffResult.error) ?? describeDbErrorOrNull(shiftResult.error) ?? describeDbErrorOrNull(attResult.error) ?? null;

    if (firstError) {
      setLoadError(firstError);
      setRows([]);
      setLoading(false);
      return;
    }
    setLoadError(null);

    const typeByCode = new Map(typeResult.data.map((t) => [t.code, t]));
    const staffById = new Map(((staffResult.data || []) as Profile[]).map((p) => [p.id, p]));
    const attendance = (attResult.data || []) as Pick<Attendance, 'user_id' | 'date' | 'check_in_time'>[];
    const attByKey = new Map(attendance.map((a) => [`${a.user_id}|${a.date}`, a.check_in_time]));

    // Trải phẳng theo từng ngày: một đơn nhiều ngày sinh ra nhiều dòng đối chiếu.
    const result: Row[] = [];
    for (const day of days) {
      for (const shift of (shiftResult.data || []) as Shift[]) {
        if (!shiftCoversDate(shift, day.key)) continue;
        const person = staffById.get(shift.user_id);
        const type = typeByCode.get(shift.shift_type);
        if (!person || !type) continue;
        result.push({
          key: `${shift.id}|${day.key}`,
          person,
          dateKey: day.key,
          dateLabel: `${day.weekdayLabel} ${day.label}`,
          type,
          checkIn: attByKey.get(`${shift.user_id}|${day.key}`) ?? null,
        });
      }
    }

    setRows(result);
    setLoading(false);
  };

  const today = toDateString(new Date());
  // Ngày chưa tới thì chưa thể kết luận vắng mặt.
  const past = rows.filter((r) => r.dateKey <= today);

  const summary = {
    total: past.length,
    onTime: past.filter((r) => r.checkIn && lateMinutes(r.type.start_time, r.checkIn) <= 5).length,
    late: past.filter((r) => r.checkIn && lateMinutes(r.type.start_time, r.checkIn) > 5).length,
    absent: past.filter((r) => !r.checkIn).length,
  };

  const isThisWeek = toDateString(startOfWeek(new Date())) === days[0].key;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <button onClick={() => setAnchor(addDays(anchor, -7))} className="p-2 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors" aria-label="Tuần trước">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button onClick={() => setAnchor(addDays(anchor, 7))} className="p-2 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors" aria-label="Tuần sau">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <p className="font-display text-base font-bold text-slate-800">{days[0].label} — {days[6].label}</p>
        {!isThisWeek && (
          <Button variant="outline" size="sm" onClick={() => setAnchor(startOfWeek(new Date()))}>
            <CalendarDays className="w-4 h-4" />
            Về tuần này
          </Button>
        )}
      </div>

      {!loading && !loadError && past.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Đúng giờ" value={summary.onTime} total={summary.total} icon={<CheckCircle2 className="w-4.5 h-4.5" />} tone="emerald" />
          <Stat label="Đi muộn" value={summary.late} total={summary.total} icon={<Clock className="w-4.5 h-4.5" />} tone="amber" />
          <Stat label="Không đến" value={summary.absent} total={summary.total} icon={<UserX className="w-4.5 h-4.5" />} tone="red" />
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-5 space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
          ) : loadError ? (
            <ErrorState message={loadError} onRetry={load} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<CalendarDays className="w-8 h-8" />}
              title="Chưa có ca nào trong tuần này"
              description="Xếp ca ở tab Lịch tuần để bắt đầu đối chiếu với chấm công."
            />
          ) : (
            <div className="divide-y divide-slate-50">
              {rows.map((row) => {
                const future = row.dateKey > today;
                const late = row.checkIn ? formatLateness(lateMinutes(row.type.start_time, row.checkIn)) : null;

                return (
                  <div key={row.key} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-slate-50/70 transition-colors">
                    <Avatar name={row.person.name} url={row.person.avatar_url} size="sm" />

                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">{row.person.name}</p>
                      <p className="text-xs text-slate-500">
                        {row.dateLabel} · {row.type.label} {row.type.start_time.slice(0, 5)}–{row.type.end_time.slice(0, 5)}
                      </p>
                    </div>

                    <div className="text-right">
                      {future ? (
                        <span className="text-xs text-slate-400">Chưa tới</span>
                      ) : row.checkIn ? (
                        <>
                          <p className="text-sm font-medium text-slate-700">{formatTime(row.checkIn)}</p>
                          <Badge
                            className={
                              late!.tone === 'late'
                                ? 'bg-amber-100 text-amber-700'
                                : late!.tone === 'early'
                                  ? 'bg-blue-100 text-blue-700'
                                  : 'bg-emerald-100 text-emerald-700'
                            }
                          >
                            {late!.text}
                          </Badge>
                        </>
                      ) : (
                        <Badge className="bg-red-100 text-red-700">Không check-in</Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, total, icon, tone }: {
  label: string;
  value: number;
  total: number;
  icon: React.ReactNode;
  tone: 'emerald' | 'amber' | 'red';
}) {
  const tones = {
    emerald: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600',
    red: 'bg-red-50 text-red-600',
  };
  const percent = total > 0 ? Math.round((value / total) * 100) : 0;

  return (
    <div className="flex items-center gap-3 p-3.5 rounded-2xl border border-slate-100 bg-white">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${tones[tone]}`}>{icon}</div>
      <div className="min-w-0">
        <p className="font-display text-xl font-extrabold text-slate-800 leading-none">
          {value}
          <span className="text-sm font-semibold text-slate-400"> · {percent}%</span>
        </p>
        <p className="text-xs text-slate-500 mt-1">{label}</p>
      </div>
    </div>
  );
}
