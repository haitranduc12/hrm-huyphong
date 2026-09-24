import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Briefcase, AlertCircle, TrendingUp, Clock, Fingerprint, CalendarDays, ArrowRight, ClipboardList } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';
import { Button } from '@/components/ui/Button';
import { UpcomingEventsCard } from '@/components/UpcomingEventsCard';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtimeSync } from '@/hooks/useRealtimeSync';
import { supabase } from '@/lib/supabase';
import { describeDbErrorOrNull } from '@/lib/dbError';
import { PRIORITY_CONFIG, TASK_STATUSES, PROJECT_STATUS_CONFIG, formatDate, formatTime, isOverdue, toDateString, getTodayString } from '@/lib/utils';
import { ASSIGNMENT_STATUS_CONFIG } from '@/lib/assignments';
import type { Task, Project, Attendance, DailyAssignment } from '@/types';

export function StaffDashboard() {
  const { profile } = useAuth();
  const [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [todayAssignments, setTodayAssignments] = useState<DailyAssignment[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (profile) void loadData();
  }, [profile]);

  // Dashboard là điểm vào đầu ngày: giao việc, chấm công hoặc đổi trạng thái
  // phải hiện lại ngay, không bắt nhân viên F5 mới thấy dữ liệu mới.
  useRealtimeSync(
    profile ? [
      { table: 'project_members', filter: `user_id=eq.${profile.id}` },
      { table: 'tasks', filter: `assignee_id=eq.${profile.id}` },
      { table: 'attendance', filter: `user_id=eq.${profile.id}` },
      { table: 'daily_assignments', filter: `user_id=eq.${profile.id}` },
    ] : [],
    () => loadData(true),
    { enabled: !!profile, channelKey: 'staff-dashboard' },
  );

  const loadData = async (silent = false) => {
    if (!profile) return;
    if (!silent) setLoading(true);

    // Get user's project memberships
const { data: memberships, error: membershipsError } = await supabase
      .from('project_members')
      .select('project_id')
      .eq('user_id', profile.id);

const mList = (memberships || []) as { project_id: string }[];
    const projectIds = mList.map((m: { project_id: string }) => m.project_id);

    // Get tasks assigned to this user
    const { data: userTasks, error: tasksError } = await supabase
      .from('tasks')
      .select('*, project:projects(*)')
      .eq('assignee_id', profile.id)
      .order('due_date', { ascending: true });

    setTasks((userTasks || []) as Task[]);

    // Get projects
    if (projectIds.length > 0) {
      const { data: projectData, error: projectsError } = await supabase
        .from('projects')
        .select('*')
        .in('id', projectIds);
      setProjects((projectData || []) as Project[]);
      setLoadError(
        describeDbErrorOrNull(membershipsError)
          ?? describeDbErrorOrNull(tasksError)
          ?? describeDbErrorOrNull(projectsError),
      );
    } else {
      setProjects([]);
      setLoadError(describeDbErrorOrNull(membershipsError) ?? describeDbErrorOrNull(tasksError));
    }

    // Get attendance history (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const { data: attData, error: attendanceError } = await supabase
      .from('attendance')
      .select('*')
      .eq('user_id', profile.id)
      .gte('date', toDateString(sevenDaysAgo))
      .order('date', { ascending: false });

    setAttendance((attData || []) as Attendance[]);

    // Công việc quản lý giao cho hôm nay — nhắc ngay từ dashboard.
    const { data: asgData, error: assignmentsError } = await supabase
      .from('daily_assignments')
      .select('*')
      .eq('user_id', profile.id)
      .eq('work_date', getTodayString())
      .order('created_at', { ascending: true });
    setTodayAssignments((asgData || []) as DailyAssignment[]);
    setLoadError((current) => current
      ?? describeDbErrorOrNull(attendanceError)
      ?? describeDbErrorOrNull(assignmentsError));

    setLoading(false);
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (loadError) {
    return <Card><ErrorState message={loadError} onRetry={() => loadData()} /></Card>;
  }

  const activeTasks = tasks.filter((t) => t.status !== 'done');
  const overdueTasks = tasks.filter((t) => isOverdue(t.due_date, t.status));
  const completionRate = tasks.length > 0
    ? Math.round((tasks.filter((t) => t.status === 'done').length / tasks.length) * 100)
    : 0;
  const asgApproved = todayAssignments.filter((a) => a.status === 'approved').length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Dashboard tổng quan</h1>
        <p className="text-slate-500 mt-1">Theo dõi công việc, chấm công và tiến độ cá nhân</p>
      </div>

      {/* Lịch họp & nhắc nhở sắp tới — tự ẩn khi không có */}
      <UpcomingEventsCard />

      {/* Công việc quản lý giao hôm nay — việc phải làm trước tiên trong ngày */}
      {todayAssignments.length > 0 && (
        <Card className="border-emerald-200 ring-1 ring-emerald-100">
          <CardHeader>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <CardTitle>
                <span className="inline-flex items-center gap-2">
                  <ClipboardList className="w-5 h-5 text-emerald-600" />
                  Công việc hôm nay
                </span>
                <span className="ml-2 text-xs font-normal text-slate-400">
                  {asgApproved}/{todayAssignments.length} đã xác nhận
                </span>
              </CardTitle>
              <Link to="/staff/attendance">
                <Button theme="staff" size="sm">
                  Vào làm việc <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {todayAssignments.slice(0, 4).map((a) => {
                const cfg = ASSIGNMENT_STATUS_CONFIG[a.status];
                return (
                  <div key={a.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-slate-50/70">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot}`} />
                    <span className={`text-sm flex-1 truncate ${a.status === 'approved' ? 'text-slate-400 line-through' : 'text-slate-700'}`}>
                      {a.title}
                    </span>
                    <Badge className={cfg.color}>{cfg.label}</Badge>
                  </div>
                );
              })}
              {todayAssignments.length > 4 && (
                <p className="text-xs text-slate-400 text-center pt-1">
                  … và {todayAssignments.length - 4} công việc khác
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

{/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card hover className="p-5 bg-indigo-50 text-indigo-700 group">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium flex items-center gap-2"><Briefcase className="w-4 h-4" /> Tác vụ đang làm</p>
            <p className="text-3xl font-bold">{activeTasks.length}</p>
          </div>
          <p className="text-xs mt-2 opacity-70">Công việc cần tiếp tục xử lý</p>
        </Card>

        <Card hover className="p-5 bg-rose-50 text-rose-700 group">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium flex items-center gap-2"><AlertCircle className="w-4 h-4" /> Tác vụ quá hạn</p>
            <p className="text-3xl font-bold">{overdueTasks.length}</p>
          </div>
          <p className="text-xs mt-2 opacity-70">Công việc cần ưu tiên xử lý</p>
        </Card>

        <Card hover className="p-5 bg-emerald-50 text-emerald-700 group">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium flex items-center gap-2"><TrendingUp className="w-4 h-4" /> Tiến độ cá nhân</p>
            <p className="text-3xl font-bold">{completionRate}%</p>
          </div>
          <p className="text-xs mt-2 opacity-70">Tỷ lệ tác vụ đã hoàn thành</p>
        </Card>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card hover className="p-5 flex items-center justify-between group">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 text-white flex items-center justify-center shadow-glow-emerald transition-transform duration-300 group-hover:scale-110">
              <Fingerprint className="w-6 h-6" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-800">Chấm công</p>
              <p className="text-xs text-slate-500">Check-in / Check-out hôm nay</p>
            </div>
          </div>
          <Link to="/staff/attendance">
            <Button theme="staff" size="sm" variant="outline">
              Vào trang <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          </Link>
        </Card>

        <Card hover className="p-5 flex items-center justify-between group">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-orange-500 to-amber-500 text-white flex items-center justify-center shadow-lg transition-transform duration-300 group-hover:scale-110">
              <CalendarDays className="w-6 h-6" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-800">Đăng ký ca</p>
              <p className="text-xs text-slate-500">Đăng ký ca làm việc mới</p>
            </div>
          </div>
          <Link to="/staff/shifts">
            <Button theme="staff" size="sm" variant="outline">
              Vào trang <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          </Link>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* My tasks */}
        <Card>
          <CardHeader>
            <CardTitle>Tác vụ của tôi</CardTitle>
          </CardHeader>
          <CardContent>
            {tasks.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">Chưa có tác vụ nào được giao</p>
            ) : (
              <div className="space-y-2">
{tasks.slice(0, 5).map((task) => {
                  const priority = PRIORITY_CONFIG[task.priority];
                  const overdue = isOverdue(task.due_date, task.status);
                  return (
                    <div key={task.id} className={`p-3 rounded-xl border-l-4 ${priority.border} bg-slate-50/50 hover:bg-slate-50 transition-colors`}>
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-slate-800 flex-1">{task.title}</p>
                        <Badge className={TASK_STATUSES.find((s) => s.value === task.status)?.color || ''}>
                          {TASK_STATUSES.find((s) => s.value === task.status)?.label}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className="text-xs text-slate-400">{task.project?.name}</span>
                        {task.due_date && (
                          <span className={`text-xs ${overdue ? 'text-red-500 font-medium' : 'text-slate-400'}`}>
                            • Hạn: {formatDate(task.due_date)}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
                <Link to="/staff/kanban" className="block text-center text-sm text-emerald-600 hover:text-emerald-700 pt-2">
                  Xem tất cả trên Kanban →
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Attendance history */}
        <Card>
          <CardHeader>
            <CardTitle>Lịch sử chấm công (7 ngày)</CardTitle>
          </CardHeader>
          <CardContent>
            {attendance.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">Chưa có lịch sử chấm công</p>
            ) : (
              <div className="space-y-2">
                {attendance.map((a) => (
                  <div key={a.id} className="flex items-center justify-between p-3 rounded-lg bg-slate-50/50">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-white border border-slate-200 flex items-center justify-center">
                        <Clock className="w-4 h-4 text-slate-400" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-slate-700">{formatDate(a.date)}</p>
                        <p className="text-xs text-slate-400">{formatTime(a.check_in_time)} → {formatTime(a.check_out_time)}</p>
                      </div>
                    </div>
                    <Badge className={a.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}>
                      {a.status === 'completed' ? 'Hoàn thành' : 'Đang làm'}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* My projects */}
      <Card>
        <CardHeader>
          <CardTitle>Dự án đang tham gia</CardTitle>
        </CardHeader>
        <CardContent>
          {projects.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">Chưa tham gia dự án nào</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {projects.map((p) => (
                <div key={p.id} className="p-4 rounded-xl border border-slate-200 hover:shadow-sm transition-shadow">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-semibold text-slate-800">{p.name}</p>
                    <Badge className={PROJECT_STATUS_CONFIG[p.status].color}>
                      {PROJECT_STATUS_CONFIG[p.status].label}
                    </Badge>
                  </div>
                  <p className="text-xs text-slate-500">{p.client || '—'}</p>
                  <p className="text-xs text-slate-400 mt-1">{formatDate(p.start_date)} → {formatDate(p.end_date)}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
