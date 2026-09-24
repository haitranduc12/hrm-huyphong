import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart, Bar, PieChart, Pie, Cell, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { FolderKanban, Users, CheckCircle2, TrendingUp, Fingerprint, LogOut, UserX, CalendarOff, Info, ClipboardList, ArrowRight, Inbox, RotateCcw } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';
import { useAuth } from '@/contexts/AuthContext';
import { hasPermission } from '@/lib/permissions';
import { supabase } from '@/lib/supabase';
import { describeDbError } from '@/lib/dbError';
import { getTodayString, toDateString } from '@/lib/utils';
import type { Attendance, LeaveRequest, Profile, Project, Task } from '@/types';

interface KPIData {
  totalProjects: number;
  activeProjects: number;
  totalStaff: number;
  completionRate: number;
}

/** Tình hình đi làm của ngày hôm nay. */
interface TodayAttendance {
  /** Số người đã check-in hôm nay. */
  checkedIn: number;
  /** Đang trong ca — đã check-in, chưa check-out. */
  working: number;
  /** Đã check-out. */
  finished: number;
  /** Đang nghỉ phép đã được duyệt — không tính là vắng mặt. */
  onLeave: number;
  /** Vắng mặt thật: chưa check-in và cũng không có đơn nghỉ phép được duyệt. */
  absent: number;
  /** Tổng nhân sự đang hoạt động, dùng làm mẫu số. */
  headcount: number;
}

const DAILY_TREND_DAYS = 14;

/** Công việc giao theo ngày của hôm nay, gom theo trạng thái. */
interface TodayAssignments {
  total: number;
  pending: number;
  submitted: number;
  approved: number;
  rejected: number;
}

export function AdminDashboard() {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kpis, setKpis] = useState<KPIData>({ totalProjects: 0, activeProjects: 0, totalStaff: 0, completionRate: 0 });
  const [taskStatusData, setTaskStatusData] = useState<{ name: string; value: number; color: string }[]>([]);
  const [weeklyTaskData, setWeeklyTaskData] = useState<{ day: string; tasks: number }[]>([]);
  const [topStaff, setTopStaff] = useState<{ id: string; name: string; completed: number; total: number; avatar_url: string | null }[]>([]);
  const [hrHealth, setHrHealth] = useState<{ name: string; value: number; color: string }[]>([]);
  const [today, setToday] = useState<TodayAttendance>({ checkedIn: 0, working: 0, finished: 0, onLeave: 0, absent: 0, headcount: 0 });
  const [todayAsg, setTodayAsg] = useState<TodayAssignments>({ total: 0, pending: 0, submitted: 0, approved: 0, rejected: 0 });
  const [dailyHeadcount, setDailyHeadcount] = useState<{ label: string; date: string; count: number }[]>([]);

  /**
   * RLS chỉ cho đọc chấm công của người khác khi có quyền 'attendance'
   * (att_select). Thiếu quyền thì truy vấn vẫn thành công nhưng chỉ trả về bản
   * ghi của chính mình — con số sẽ sai mà không có lỗi nào báo. Nên phải ẩn hẳn
   * phần này thay vì hiện số liệu không đáng tin.
   */
  const canSeeAttendance = hasPermission(profile, 'attendance');

  useEffect(() => {
    void loadDashboardData();
  }, [canSeeAttendance]);

  const loadDashboardData = async () => {
    setLoading(true);

    // Chỉ lấy chấm công trong khoảng đang vẽ, không kéo cả bảng về.
    const since = new Date();
    since.setDate(since.getDate() - (DAILY_TREND_DAYS - 1));
    const sinceStr = toDateString(since);

    const [
      { data: projects, error: projErr },
      { data: profiles, error: profErr },
      { data: tasks, error: taskErr },
      { data: attendance, error: attErr },
      { data: leaveToday },
      { data: asgToday },
    ] = await Promise.all([
      supabase.from('projects').select('*'),
      supabase.from('profiles').select('*').eq('is_active', true),
      supabase.from('tasks').select('*'),
      canSeeAttendance
        ? supabase.from('attendance').select('user_id, date, status').gte('date', sinceStr)
        : Promise.resolve({ data: [], error: null }),
      // Đơn nghỉ phép đã duyệt còn hiệu lực trong hôm nay — cần để tách "nghỉ có
      // phép" khỏi "vắng mặt". Ai cũng đọc được đơn của chính mình nên truy vấn
      // này không cần quyền đặc biệt; thiếu quyền `leave` thì chỉ thấy đơn của
      // mình, và khi đó khối chấm công cũng đã bị ẩn.
      canSeeAttendance
        ? supabase
            .from('leave_requests')
            .select('*')
            .eq('status', 'approved')
            .lte('start_date', getTodayString())
            .gte('end_date', getTodayString())
        : Promise.resolve({ data: [], error: null }),
      // Công việc giao hôm nay — nguồn của khối "Công việc hôm nay".
      canSeeAttendance
        ? supabase.from('daily_assignments').select('status').eq('work_date', getTodayString())
        : Promise.resolve({ data: [], error: null }),
    ]);

    const firstError = projErr ?? profErr ?? taskErr ?? attErr;
    setLoadError(firstError ? describeDbError(firstError) : null);

    const projectList = (projects || []) as Project[];
    const profileList = (profiles || []) as Profile[];
    const taskList = (tasks || []) as Task[];

    setKpis({
      totalProjects: projectList.length,
      activeProjects: projectList.filter((p) => p.status === 'active').length,
      totalStaff: profileList.filter((p) => p.role === 'staff').length,
      completionRate: taskList.length > 0
        ? Math.round((taskList.filter((t) => t.status === 'done').length / taskList.length) * 100)
        : 0,
    });

    // Task status distribution
    const statusCounts = {
      todo: taskList.filter((t) => t.status === 'todo').length,
      in_progress: taskList.filter((t) => t.status === 'in_progress').length,
      in_review: taskList.filter((t) => t.status === 'in_review').length,
      done: taskList.filter((t) => t.status === 'done').length,
    };
    setTaskStatusData([
      { name: 'Cần làm', value: statusCounts.todo, color: '#94a3b8' },
      { name: 'Đang làm', value: statusCounts.in_progress, color: '#3b82f6' },
      { name: 'Đang duyệt', value: statusCounts.in_review, color: '#f59e0b' },
      { name: 'Hoàn thành', value: statusCounts.done, color: '#10b981' },
    ]);

    // Weekly completed tasks (last 7 days)
    const days: { day: string; tasks: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = toDateString(date);
      const count = taskList.filter((t) => t.status === 'done' && t.updated_at.slice(0, 10) === dateStr).length;
      days.push({ day: date.toLocaleDateString('vi-VN', { weekday: 'short' }), tasks: count });
    }
    setWeeklyTaskData(days);

    // Top staff by completed tasks
    const staffStats = profileList
      .filter((p) => p.role === 'staff')
      .map((p) => {
        const userTasks = taskList.filter((t) => t.assignee_id === p.id);
        return {
          // Giữ id làm khóa: nhiều nhân viên có thể trùng tên.
          id: p.id,
          name: p.name,
          avatar_url: p.avatar_url,
          completed: userTasks.filter((t) => t.status === 'done').length,
          total: userTasks.length,
        };
      })
      .sort((a, b) => b.completed - a.completed || b.total - a.total)
      .slice(0, 5);
    setTopStaff(staffStats);

    // HR Health stats
    const high = staffStats.filter(s => s.total > 0 && (s.completed / s.total) >= 0.8).length;
    const stable = staffStats.filter(s => s.total > 0 && (s.completed / s.total) >= 0.5 && (s.completed / s.total) < 0.8).length;
    const low = staffStats.filter(s => s.total > 0 && (s.completed / s.total) < 0.5).length;
    setHrHealth([
      { name: 'Năng suất cao', value: high, color: '#10b981' },
      { name: 'Ổn định', value: stable, color: '#3b82f6' },
      { name: 'Cần hỗ trợ', value: low, color: '#f59e0b' },
    ].filter(d => d.value > 0));

    // ---- Chấm công: số liệu THẬT từ bảng attendance ------------------------
    const attList = (attendance || []) as Pick<Attendance, 'user_id' | 'date' | 'status'>[];
    const todayStr = getTodayString();
    // Nhân sự đang hoạt động = mẫu số. profileList đã lọc is_active = true.
    const headcount = profileList.length;

    const todayRecords = attList.filter((a) => a.date === todayStr);
    // Một người về lý thuyết chỉ có một bản ghi mỗi ngày (UNIQUE user_id, date),
    // nhưng đếm theo user duy nhất để số liệu đúng kể cả khi dữ liệu bị trùng.
    const todayUsers = new Set(todayRecords.map((a) => a.user_id));
    const workingUsers = new Set(todayRecords.filter((a) => a.status === 'active').map((a) => a.user_id));

    // Người nghỉ phép hợp lệ KHÔNG phải người vắng mặt. Trước khi có module
    // nghỉ phép, ô "Chưa check-in" gộp chung cả hai — con số đó đã sai.
    const onLeaveUsers = new Set(
      ((leaveToday || []) as LeaveRequest[]).filter((leave) => !leave.is_cancelled).map((leave) => leave.user_id),
    );
    const absentUsers = profileList.filter((p) => !todayUsers.has(p.id) && !onLeaveUsers.has(p.id));

    setToday({
      checkedIn: todayUsers.size,
      working: workingUsers.size,
      finished: todayUsers.size - workingUsers.size,
      onLeave: profileList.filter((p) => onLeaveUsers.has(p.id)).length,
      absent: absentUsers.length,
      headcount,
    });

    const asgList = (asgToday || []) as { status: string }[];
    setTodayAsg({
      total: asgList.length,
      pending: asgList.filter((a) => a.status === 'pending').length,
      submitted: asgList.filter((a) => a.status === 'submitted').length,
      approved: asgList.filter((a) => a.status === 'approved').length,
      rejected: asgList.filter((a) => a.status === 'rejected').length,
    });

    // Số người đi làm theo từng ngày, 14 ngày gần nhất.
    const byDate = new Map<string, Set<string>>();
    for (const a of attList) {
      if (!byDate.has(a.date)) byDate.set(a.date, new Set());
      byDate.get(a.date)!.add(a.user_id);
    }

    const trend: { label: string; date: string; count: number }[] = [];
    for (let i = DAILY_TREND_DAYS - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = toDateString(d);
      trend.push({
        label: d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }),
        date: key,
        count: byDate.get(key)?.size ?? 0,
      });
    }
    setDailyHeadcount(trend);

    setLoading(false);
  };

  if (!loading && loadError) {
    return (
      <Card><ErrorState message={loadError} onRetry={loadDashboardData} /></Card>
    );
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Điện thoại xếp 2 cột: các con số đều ngắn, xếp 1 cột mỗi hàng khiến
          khối "Chấm công hôm nay" bị đẩy xuống quá xa dưới màn hình đầu. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        {/* Các chỉ số "+2 / +1 / +5%" trước đây là số cố định viết cứng trong
            code, không tính từ dữ liệu nào. Đã bỏ — thà không có còn hơn hiển
            thị một con số sai mà người xem tưởng là thật. */}
        <KPICard label="Tổng dự án" value={kpis.totalProjects} icon={<FolderKanban className="w-5 h-5" />} color="blue" />
        <KPICard label="Dự án đang hoạt động" value={kpis.activeProjects} icon={<TrendingUp className="w-5 h-5" />} color="emerald" />
        <KPICard label="Tổng nhân sự" value={kpis.totalStaff} icon={<Users className="w-5 h-5" />} color="violet" />
        <KPICard label="Tỷ lệ hoàn thành" value={`${kpis.completionRate}%`} icon={<CheckCircle2 className="w-5 h-5" />} color="amber" />
      </div>

      {/* ---- Vận hành hôm nay ---------------------------------------------- */}
      {canSeeAttendance ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>
                Chấm công hôm nay
                <span className="ml-2 text-xs font-normal text-slate-400">
                  {new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                <AttendanceStat
                  label="Đã check-in"
                  value={today.checkedIn}
                  total={today.headcount}
                  icon={<Fingerprint className="w-5 h-5" />}
                  tone="blue"
                />
                <AttendanceStat
                  label="Đang làm việc"
                  value={today.working}
                  icon={<TrendingUp className="w-5 h-5" />}
                  tone="emerald"
                />
                <AttendanceStat
                  label="Đã tan ca"
                  value={today.finished}
                  icon={<LogOut className="w-5 h-5" />}
                  tone="slate"
                />
                <AttendanceStat
                  label="Nghỉ phép"
                  value={today.onLeave}
                  icon={<CalendarOff className="w-5 h-5" />}
                  tone="violet"
                />
                <AttendanceStat
                  label="Vắng mặt"
                  value={today.absent}
                  icon={<UserX className="w-5 h-5" />}
                  tone="amber"
                />
              </div>

              {today.headcount > 0 && (
                <div className="mt-5">
                  <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
                    <span>Tỷ lệ đi làm</span>
                    <span className="font-semibold text-slate-700">
                      {Math.round((today.checkedIn / today.headcount) * 100)}%
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-blue-500 to-emerald-500 transition-all duration-500"
                      style={{ width: `${Math.min((today.checkedIn / today.headcount) * 100, 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Công việc hôm nay</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-500">Tổng việc giao</span>
                  <span className="text-sm font-bold text-slate-800">{todayAsg.total}</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
                    <p className="text-xs text-slate-500 mb-1">Chờ làm</p>
                    <p className="text-lg font-bold text-slate-700">{todayAsg.pending}</p>
                  </div>
                  <div className="p-3 rounded-xl bg-amber-50 border border-amber-100">
                    <p className="text-xs text-amber-600 mb-1">Đã gửi</p>
                    <p className="text-lg font-bold text-amber-700">{todayAsg.submitted}</p>
                  </div>
                  <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-100">
                    <p className="text-xs text-emerald-600 mb-1">Đã xong</p>
                    <p className="text-lg font-bold text-emerald-700">{todayAsg.approved}</p>
                  </div>
                  <div className="p-3 rounded-xl bg-red-50 border border-red-100">
                    <p className="text-xs text-red-600 mb-1">Làm lại</p>
                    <p className="text-lg font-bold text-red-700">{todayAsg.rejected}</p>
                  </div>
                </div>
                <Link to="/admin/assignments" className="flex items-center justify-center gap-2 text-xs text-blue-600 hover:underline pt-2">
                  Xem chi tiết điều phối <ArrowRight className="w-3 h-3" />
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card>
          <CardContent>
            <p className="flex items-start gap-2.5 text-sm text-slate-500 leading-relaxed">
              <Info className="w-4.5 h-4.5 text-slate-400 flex-shrink-0 mt-0.5" />
              Bạn chưa có quyền <strong className="text-slate-600">Chấm công</strong> nên phần thống kê
              đi làm được ẩn đi. Hiển thị số liệu ở đây sẽ chỉ tính riêng bản ghi của bạn, không phản
              ánh đúng toàn công ty.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ---- Công việc giao hôm nay ------------------------------------------ */}
      {canSeeAttendance && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <CardTitle>
                Công việc giao hôm nay
                <span className="ml-2 text-xs font-normal text-slate-400">{todayAsg.total} phân công</span>
              </CardTitle>
              <Link
                to="/admin/assignments"
                className="text-sm font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1"
              >
                Mở Giao việc <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {todayAsg.total === 0 ? (
              <p className="flex items-center gap-2.5 text-sm text-slate-400">
                <ClipboardList className="w-5 h-5" />
                Hôm nay chưa giao công việc nào — bấm "Mở Giao việc" để phân công cho nhân viên.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <AttendanceStat label="Cần làm" value={todayAsg.pending} icon={<ClipboardList className="w-5 h-5" />} tone="slate" />
                  <AttendanceStat label="Chờ xác nhận" value={todayAsg.submitted} icon={<Inbox className="w-5 h-5" />} tone="amber" />
                  <AttendanceStat label="Đã xác nhận" value={todayAsg.approved} icon={<CheckCircle2 className="w-5 h-5" />} tone="emerald" />
                  <AttendanceStat label="Cần làm lại" value={todayAsg.rejected} icon={<RotateCcw className="w-5 h-5" />} tone="violet" />
                </div>
                <div className="mt-5">
                  <div className="flex items-center justify-between text-xs text-slate-500 mb-1.5">
                    <span>Tiến độ xác nhận</span>
                    <span className="font-semibold text-slate-700">
                      {todayAsg.approved}/{todayAsg.total} ({Math.round((todayAsg.approved / todayAsg.total) * 100)}%)
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-500"
                      style={{ width: `${Math.min((todayAsg.approved / todayAsg.total) * 100, 100)}%` }}
                    />
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Weekly tasks bar chart */}
        <Card>
          <CardHeader>
            <CardTitle>Tác vụ hoàn thành theo tuần</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={weeklyTaskData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} allowDecimals={false} />
<Tooltip
                  contentStyle={{ borderRadius: '16px', border: '1px solid #e2e8f0', fontSize: '13px', boxShadow: '0 12px 32px -4px rgba(15,23,42,0.15)', padding: '8px 12px' }}
                  cursor={{ fill: '#f8fafc' }}
                />
                <Bar dataKey="tasks" fill="#3b82f6" radius={[6, 6, 0, 0]} name="Tác vụ" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Task status pie chart */}
        <Card>
          <CardHeader>
            <CardTitle>Sức khỏe nhân sự (Hiệu suất)</CardTitle>
          </CardHeader>
          <CardContent>
            {hrHealth.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-20">Chưa đủ dữ liệu hiệu suất</p>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={hrHealth}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={90}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {hrHealth.map((entry, i) => (
                      <Cell key={i} fill={entry.color} stroke="none" />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ borderRadius: '16px', border: 'none', fontSize: '13px', boxShadow: '0 12px 32px -4px rgba(15,23,42,0.15)' }}
                  />
                  <Legend
                    verticalAlign="bottom"
                    iconType="circle"
                    wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Check-in trend + Top staff */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Biểu đồ này trước đây vẽ từ `Math.sin()` — số liệu bịa hoàn toàn,
            không đọc bảng attendance lần nào. Giờ đếm số người duy nhất có bản
            ghi chấm công theo từng ngày. */}
        <Card>
          <CardHeader>
            <CardTitle>
              Số người đi làm theo ngày
              <span className="ml-2 text-xs font-normal text-slate-400">{DAILY_TREND_DAYS} ngày gần nhất</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!canSeeAttendance ? (
              <p className="text-sm text-slate-400 text-center py-16">
                Cần quyền Chấm công để xem thống kê này.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={dailyHeadcount}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis
                    tick={{ fontSize: 12, fill: '#64748b' }}
                    axisLine={false}
                    tickLine={false}
                    allowDecimals={false}
                    domain={[0, Math.max(today.headcount, 1)]}
                  />
                  <Tooltip
                    contentStyle={{ borderRadius: '16px', border: '1px solid #e2e8f0', fontSize: '13px', boxShadow: '0 12px 32px -4px rgba(15,23,42,0.15)', padding: '8px 12px' }}
                    formatter={(value) => [`${value ?? 0}/${today.headcount} người`, 'Đi làm']}
                  />
                  <Line
                    type="monotone"
                    dataKey="count"
                    stroke="#10b981"
                    strokeWidth={3}
                    dot={{ fill: '#10b981', r: 3 }}
                    activeDot={{ r: 5 }}
                    name="Số người"
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top 5 nhân viên hiệu suất cao</CardTitle>
          </CardHeader>
          <CardContent>
            {topStaff.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">Chưa có dữ liệu</p>
            ) : (
              <div className="space-y-3">
                {topStaff.map((staff, i) => (
                  <div key={staff.id} className="flex items-center gap-3">
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                      i === 0 ? 'bg-amber-100 text-amber-700' :
                      i === 1 ? 'bg-slate-200 text-slate-600' :
                      i === 2 ? 'bg-orange-100 text-orange-700' :
                      'bg-slate-100 text-slate-500'
                    }`}>
                      {i + 1}
                    </span>
                    <Avatar name={staff.name} url={staff.avatar_url} size="sm" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">{staff.name}</p>
                      <p className="text-xs text-slate-500">{staff.completed}/{staff.total} tác vụ hoàn thành</p>
                    </div>
                    <div className="w-24 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 rounded-full"
                        style={{ width: `${staff.total > 0 ? (staff.completed / staff.total) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function KPICard({ label, value, icon, color }: {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  color: 'blue' | 'emerald' | 'violet' | 'amber';
}) {
  const tones = {
    blue: 'bg-indigo-50 text-indigo-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    violet: 'bg-violet-50 text-violet-700',
    amber: 'bg-amber-50 text-amber-700',
  };
  return (
    <Card className={`${tones[color]} overflow-hidden`}>
      <CardContent className="flex items-center justify-between gap-4 py-5 px-5">
        <div className="flex items-center gap-3 min-w-0">
          <div className="opacity-80 flex-shrink-0">
          {icon}
          </div>
          <p className="text-sm font-medium leading-tight">{label}</p>
        </div>
        <p className="text-3xl font-bold leading-none flex-shrink-0">{value}</p>
      </CardContent>
    </Card>
  );
}

/** Ô số liệu trong khối "Chấm công hôm nay". */
function AttendanceStat({ label, value, total, icon, tone }: {
  label: string;
  value: number;
  total?: number;
  icon: React.ReactNode;
  tone: 'blue' | 'emerald' | 'slate' | 'violet' | 'amber';
}) {
  return (
    <div className="flex flex-col items-center text-center group">
      <div className="w-10 h-10 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-center mb-3 group-hover:border-indigo-200 group-hover:text-indigo-600 transition-colors text-slate-400">
        {icon}
      </div>
      <p className="text-xl font-display font-bold text-slate-900 leading-none">{value}</p>
      <p className="text-[9px] font-bold text-slate-400 mt-2 uppercase tracking-widest leading-tight">{label}</p>
      {total !== undefined && <p className="text-[9px] font-bold text-slate-300 mt-0.5 uppercase">/ {total} TOTAL</p>}
    </div>
  );
}
