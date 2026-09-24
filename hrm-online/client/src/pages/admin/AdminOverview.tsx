// ============================================================================
// Tổng quan điều hành — bức tranh danh mục dự án cho CEO/admin.
// ----------------------------------------------------------------------------
// Bốn khối: KPI tổng thể · Sức khỏe từng dự án (xếp dự án cần xử lý lên trước)
// · Điểm cần xử lý (rủi ro gom từ mọi dự án) · Mốc quan trọng sắp tới.
// CEO là isFullAdmin nên RLS cho đọc toàn bộ — không cần backend riêng.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
} from 'recharts';
import {
  FolderKanban, AlertTriangle, CalendarClock, Inbox, TrendingUp, ArrowRight,
  CalendarOff, Clock, Building2, Bell, Flag, ChevronRight, ShieldCheck,
  ClipboardList, UserCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useRealtimeSync } from '@/hooks/useRealtimeSync';
import { useAuth } from '@/contexts/AuthContext';
import { hasAdminFunction } from '@/lib/permissions';
import { supabase } from '@/lib/supabase';
import { describeDbErrorOrNull } from '@/lib/dbError';
import { PROJECT_STATUS_CONFIG, formatDate } from '@/lib/utils';
import { formatEventTime } from '@/lib/projectEvents';
import {
  buildMilestones, buildPortfolio, collectRisks, HEALTH_CONFIG, isLiveProject,
  type HealthLevel, type Milestone, type ProjectHealth,
} from '@/lib/portfolio';
import type { Project, Profile, ProjectMember, Task, ProjectEvent } from '@/types';

interface Pending { leave: number; shifts: number; assignments: number }

export function AdminOverview() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const allowed = hasAdminFunction(profile, 'admin.overview');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [events, setEvents] = useState<ProjectEvent[]>([]);
  const [pending, setPending] = useState<Pending>({ leave: 0, shifts: 0, assignments: 0 });

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    const [projRes, taskRes, memRes, profRes, evRes, lvRes, shRes, asgRes] = await Promise.all([
      supabase.from('projects').select('*'),
      supabase.from('tasks').select('id, project_id, status, due_date, priority'),
      supabase.from('project_members').select('id, project_id, user_id, role'),
      supabase.from('profiles').select('*').eq('is_active', true),
      supabase.from('project_events').select('*, project:projects(id,name)').gte('start_at', new Date().toISOString()).order('start_at', { ascending: true }),
      supabase.from('leave_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('shifts').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('daily_assignments').select('id', { count: 'exact', head: true }).eq('status', 'submitted'),
    ]);

    setLoadError(
      describeDbErrorOrNull(projRes.error) ?? describeDbErrorOrNull(taskRes.error) ?? describeDbErrorOrNull(memRes.error),
    );
    setProjects((projRes.data || []) as Project[]);
    setTasks((taskRes.data || []) as Task[]);
    setMembers((memRes.data || []) as ProjectMember[]);
    setProfiles((profRes.data || []) as Profile[]);
    setEvents((evRes.data || []) as ProjectEvent[]);
    setPending({ leave: lvRes.count ?? 0, shifts: shRes.count ?? 0, assignments: asgRes.count ?? 0 });
    setLoading(false);
  };

  useEffect(() => { if (allowed) void load(); else setLoading(false); }, [allowed]);

  useRealtimeSync(
    [
      { table: 'projects' },
      { table: 'tasks' },
      { table: 'project_events' },
      { table: 'leave_requests' },
      { table: 'shifts' },
      { table: 'daily_assignments' },
    ],
    () => load(true),
    { channelKey: 'overview' },
  );

  const profilesById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const portfolio = useMemo(
    () => buildPortfolio(projects, tasks, members, profilesById),
    [projects, tasks, members, profilesById],
  );
  const risks = useMemo(() => collectRisks(portfolio), [portfolio]);
  const milestones = useMemo(() => buildMilestones(events, projects, tasks), [events, projects, tasks]);

  const live = portfolio.filter((ph) => isLiveProject(ph.project));
  const needAttention = live.filter((ph) => ph.health !== 'good').length;
  const overdueTasksTotal = live.reduce((s, ph) => s + ph.overdueTasks, 0);
  const pendingTotal = pending.leave + pending.shifts + pending.assignments;

  // Phân bố sức khỏe cho donut.
  const healthDist = useMemo(() => {
    const counts: Record<HealthLevel, number> = { good: 0, warning: 0, critical: 0 };
    for (const ph of live) counts[ph.health]++;
    return (['critical', 'warning', 'good'] as HealthLevel[])
      .map((k) => ({ name: HEALTH_CONFIG[k].label, value: counts[k], color: HEALTH_CONFIG[k].chart }))
      .filter((d) => d.value > 0);
  }, [live]);

  if (!allowed) {
    return (
      <div className="max-w-xl">
        <Card>
          <CardContent className="flex items-start gap-3 pt-6">
            <AlertTriangle className="w-6 h-6 text-amber-500 flex-shrink-0" />
            <div>
              <p className="font-medium text-slate-800">Chỉ Quản trị viên và Ban giám đốc</p>
              <p className="text-sm text-slate-500 mt-1">
                Tổng quan điều hành tổng hợp dữ liệu toàn bộ dự án của công ty nên không mở theo quyền lẻ.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
        <Skeleton className="h-96" />
      </div>
    );
  }
  if (loadError) return <ErrorState message={loadError} onRetry={load} />;

  return (
    <div className="space-y-6">
      {/* ============ KPI ============ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard icon={<FolderKanban className="w-5 h-5" />} gradient="from-blue-500 to-indigo-500"
          value={live.length} label="Dự án đang triển khai" />
        <KpiCard icon={<AlertTriangle className="w-5 h-5" />} gradient="from-amber-500 to-orange-500"
          value={needAttention} label="Dự án cần chú ý" tone={needAttention > 0 ? 'amber' : undefined} />
        <KpiCard icon={<Flag className="w-5 h-5" />} gradient="from-red-500 to-rose-500"
          value={overdueTasksTotal} label="Tác vụ quá hạn" tone={overdueTasksTotal > 0 ? 'red' : undefined} />
        <KpiCard icon={<Inbox className="w-5 h-5" />} gradient="from-violet-500 to-purple-500"
          value={pendingTotal} label="Đơn / việc chờ duyệt" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ============ Sức khỏe dự án ============ */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>
                <span className="inline-flex items-center gap-2"><TrendingUp className="w-5 h-5 text-blue-600" />Sức khỏe dự án</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {live.length === 0 ? (
                <EmptyState icon={<FolderKanban className="w-8 h-8" />} title="Chưa có dự án đang triển khai"
                  description="Tạo dự án ở trang Quản lý Dự án để theo dõi tại đây." />
              ) : (
                <div className="divide-y divide-slate-50">
                  {portfolio.filter((ph) => isLiveProject(ph.project)).map((ph) => (
                    <ProjectHealthRow key={ph.project.id} ph={ph} onClick={() => navigate(`/admin/projects/${ph.project.id}`)} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ============ Cột phải: donut + rủi ro + mốc ============ */}
        <div className="space-y-6">
          {/* Donut sức khỏe */}
          <Card>
            <CardHeader><CardTitle>Phân bố sức khỏe</CardTitle></CardHeader>
            <CardContent>
              {healthDist.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-6">Chưa có dữ liệu</p>
              ) : (
                <div className="flex items-center gap-4">
                  <div className="w-32 h-32 flex-shrink-0 relative">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={healthDist} dataKey="value" innerRadius={38} outerRadius={58} paddingAngle={2} startAngle={90} endAngle={-270}>
                          {healthDist.map((d, i) => <Cell key={i} fill={d.color} />)}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                      <span className="text-2xl font-extrabold text-slate-800">{live.length}</span>
                      <span className="text-[10px] text-slate-400 -mt-0.5">dự án</span>
                    </div>
                  </div>
                  <div className="flex-1 space-y-2">
                    {healthDist.map((d) => (
                      <div key={d.name} className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-2 text-slate-600">
                          <span className="w-2.5 h-2.5 rounded-full" style={{ background: d.color }} />{d.name}
                        </span>
                        <span className="font-semibold text-slate-800">{d.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Điểm cần xử lý */}
          <Card>
            <CardHeader>
              <CardTitle>
                <span className="inline-flex items-center gap-2"><AlertTriangle className="w-5 h-5 text-amber-500" />Điểm cần xử lý</span>
                {risks.length > 0 && <span className="ml-2 text-xs font-normal text-slate-400">{risks.length}</span>}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {/* Đơn chờ duyệt tồn đọng */}
              {pendingTotal > 0 && (
                <div className="px-5 py-3 border-b border-slate-50 flex flex-wrap gap-x-4 gap-y-1.5">
                  {pending.assignments > 0 && <PendingChip icon={<ShieldCheck className="w-3.5 h-3.5" />} label={`${pending.assignments} việc chờ xác nhận`} to="/admin/assignments" navigate={navigate} />}
                  {pending.leave > 0 && <PendingChip icon={<CalendarOff className="w-3.5 h-3.5" />} label={`${pending.leave} đơn nghỉ phép`} to="/admin/leave" navigate={navigate} />}
                  {pending.shifts > 0 && <PendingChip icon={<Clock className="w-3.5 h-3.5" />} label={`${pending.shifts} đăng ký ca`} to="/admin/shifts" navigate={navigate} />}
                </div>
              )}
              {risks.length === 0 && pendingTotal === 0 ? (
                <div className="flex flex-col items-center text-center py-8 px-5">
                  <div className="w-12 h-12 rounded-full bg-emerald-50 flex items-center justify-center mb-2"><ShieldCheck className="w-6 h-6 text-emerald-600" /></div>
                  <p className="text-sm font-medium text-slate-700">Mọi thứ đang ổn</p>
                  <p className="text-xs text-slate-400">Không có dự án nào cần xử lý gấp.</p>
                </div>
              ) : (
                <div className="divide-y divide-slate-50 max-h-80 overflow-y-auto">
                  {risks.slice(0, 12).map((r, i) => (
                    <button key={i} onClick={() => navigate(`/admin/projects/${r.projectId}`)}
                      className="w-full flex items-start gap-2.5 px-5 py-2.5 hover:bg-slate-50/70 transition-colors text-left">
                      <span className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${HEALTH_CONFIG[r.level].dot}`} />
                      <span className="flex-1 min-w-0">
                        <span className="text-sm text-slate-700">{r.message}</span>
                        <span className="block text-xs text-slate-400 truncate">{r.projectName}</span>
                      </span>
                      <ChevronRight className="w-4 h-4 text-slate-300 flex-shrink-0 mt-0.5" />
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Mốc quan trọng sắp tới */}
          <Card>
            <CardHeader>
              <CardTitle>
                <span className="inline-flex items-center gap-2"><CalendarClock className="w-5 h-5 text-blue-600" />Mốc quan trọng sắp tới</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {milestones.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-8">Không có mốc nào sắp tới</p>
              ) : (
                <div className="divide-y divide-slate-50">
                  {milestones.map((m, i) => <MilestoneRow key={i} m={m} />)}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function KpiCard({ icon, gradient, value, label, tone }: {
  icon: React.ReactNode; gradient: string; value: number; label: string; tone?: 'amber' | 'red';
}) {
  const cardTone = tone === 'red'
    ? 'bg-rose-50 text-rose-700'
    : tone === 'amber'
      ? 'bg-amber-50 text-amber-700'
      : gradient.includes('violet')
        ? 'bg-violet-50 text-violet-700'
        : 'bg-indigo-50 text-indigo-700';
  return (
    <Card className={`${cardTone} overflow-hidden`}>
      <CardContent className="flex items-center justify-between gap-4 py-5 px-5">
        <div className="flex items-center gap-3 min-w-0">
          <span className="opacity-80 flex-shrink-0">{icon}</span>
          <p className="text-sm font-medium leading-tight">{label}</p>
        </div>
        <p className="text-3xl font-bold leading-none flex-shrink-0">{value}</p>
      </CardContent>
    </Card>
  );
}

function ProjectHealthRow({ ph, onClick }: { ph: ProjectHealth; onClick: () => void }) {
  const cfg = HEALTH_CONFIG[ph.health];
  const status = PROJECT_STATUS_CONFIG[ph.project.status];
  const progressPct = Math.round(ph.progress * 100);
  const timePct = Math.round(ph.timeElapsed * 100);
  const behind = ph.timeElapsed - ph.progress >= 0.2;

  return (
    <button onClick={onClick} className="w-full text-left px-6 py-5 hover:bg-indigo-50/40 transition-colors border-b border-slate-100 last:border-0 group">
      <div className="flex items-start gap-4">
        <div className="w-1 h-10 bg-slate-200 group-hover:bg-indigo-600 transition-colors mt-1" />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-3 mb-2">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">PRJ-{ph.project.id.slice(0,4).toUpperCase()}</span>
            <span className="text-sm font-bold text-slate-800 truncate">{ph.project.name}</span>
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-widest ${cfg.color}`}>{cfg.label}</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[10px] font-bold text-slate-400 uppercase tracking-tighter">
                <span>Tiến độ vận hành</span>
                <span>{progressPct}%</span>
              </div>
              <div className="relative h-1 bg-slate-100 rounded-full overflow-hidden">
                <div className={`absolute inset-y-0 left-0 ${behind ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${progressPct}%` }} />
                <div className="absolute inset-y-0 w-0.5 bg-slate-400/50" style={{ left: `${timePct}%` }} />
              </div>
            </div>
            
            <div className="flex items-center gap-6 text-[10px] font-bold text-slate-400 uppercase tracking-tight">
              <div className="flex items-center gap-1.5">
                <ClipboardList className="w-3 h-3" />
                <span>{ph.doneTasks}/{ph.totalTasks} TASKS</span>
              </div>
              <div className="flex items-center gap-1.5">
                <UserCircle className="w-3 h-3" />
                <span>{ph.lead?.name.toUpperCase() || 'NO LEAD'}</span>
              </div>
              {ph.daysLeft !== null && (
                <div className={`flex items-center gap-1.5 ${ph.daysLeft < 0 ? 'text-red-500' : ''}`}>
                  <Clock className="w-3 h-3" />
                  <span>{ph.daysLeft < 0 ? `OVERDUE ${Math.abs(ph.daysLeft)}D` : `DUE IN ${ph.daysLeft}D`}</span>
                </div>
              )}
            </div>
          </div>
        </div>
        <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-indigo-600 transition-colors mt-2" />
      </div>
    </button>
  );
}

function MilestoneRow({ m }: { m: Milestone }) {
  const icon = m.kind === 'deadline' ? <Flag className="w-4 h-4" /> : m.kind === 'meeting' ? <Building2 className="w-4 h-4" /> : <Bell className="w-4 h-4" />;
  const color = m.kind === 'deadline' ? 'bg-red-100 text-red-700' : m.kind === 'meeting' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700';
  const soon = m.daysUntil <= 3;
  return (
    <div className="flex items-start gap-3 px-5 py-3">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${color}`}>{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-800 truncate">{m.title}</p>
        <p className="text-xs text-slate-500 truncate">{m.projectName}</p>
        <p className="text-xs text-slate-400 mt-0.5">{formatEventTime(m.at)}</p>
      </div>
      <span className={`text-xs font-semibold whitespace-nowrap ${soon ? 'text-red-600' : 'text-slate-500'}`}>
        {m.daysUntil === 0 ? 'Hôm nay' : `${m.daysUntil}n nữa`}
      </span>
    </div>
  );
}

function PendingChip({ icon, label, to, navigate }: {
  icon: React.ReactNode; label: string; to: string; navigate: (to: string) => void;
}) {
  return (
    <button onClick={() => navigate(to)} className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-blue-600 transition-colors">
      <span className="text-slate-400">{icon}</span>{label}
    </button>
  );
}
