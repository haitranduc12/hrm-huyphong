// ============================================================================
// Tổng quan điều hành — tính sức khỏe & rủi ro của danh mục dự án.
// ----------------------------------------------------------------------------
// Dành cho CEO/admin (isFullAdmin): gom dữ liệu nhiều bảng thành một bức tranh
// "dự án nào ổn, dự án nào cần xử lý ngay". Mọi phép tính thuần TypeScript,
// không phụ thuộc backend — dễ chỉnh ngưỡng theo cảm nhận điều hành.
// ============================================================================

import type { Project, Profile, ProjectMember, Task, ProjectEvent } from '@/types';

export type HealthLevel = 'good' | 'warning' | 'critical';

export const HEALTH_CONFIG: Record<HealthLevel, { label: string; color: string; dot: string; chart: string }> = {
  good:     { label: 'Ổn định',     color: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500', chart: '#10b981' },
  warning:  { label: 'Cần theo dõi', color: 'bg-amber-100 text-amber-700',    dot: 'bg-amber-500',   chart: '#f59e0b' },
  critical: { label: 'Cần xử lý',    color: 'bg-red-100 text-red-700',        dot: 'bg-red-500',     chart: '#ef4444' },
};

/** Một vấn đề cụ thể để hiện trong "Điểm cần xử lý". */
export interface RiskItem {
  projectId: string;
  projectName: string;
  level: HealthLevel;
  message: string;
}

export interface ProjectHealth {
  project: Project;
  lead: Profile | null;
  memberCount: number;
  totalTasks: number;
  doneTasks: number;
  overdueTasks: number;
  /** Tỷ lệ hoàn thành 0..1. */
  progress: number;
  /** Tỷ lệ thời gian đã trôi qua theo start..end, 0..1. */
  timeElapsed: number;
  /** Số ngày còn tới hạn (âm = đã quá hạn). null nếu không có end_date. */
  daysLeft: number | null;
  health: HealthLevel;
  issues: string[];
}

const DAY = 86400000;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Dự án đang trong guồng — chỉ những dự án này mới tính rủi ro tiến độ. */
export function isLiveProject(p: Project): boolean {
  return p.status === 'active' || p.status === 'planning' || p.status === 'on_hold';
}

export function computeProjectHealth(
  project: Project,
  tasks: Task[],
  members: ProjectMember[],
  leadProfile: Profile | null,
): ProjectHealth {
  const myTasks = tasks.filter((t) => t.project_id === project.id);
  const totalTasks = myTasks.length;
  const doneTasks = myTasks.filter((t) => t.status === 'done').length;
  const today = startOfToday();
  const overdueTasks = myTasks.filter(
    (t) => t.status !== 'done' && t.due_date && new Date(`${t.due_date}T00:00:00`).getTime() < today,
  ).length;

  const progress = totalTasks > 0 ? doneTasks / totalTasks : 0;

  const start = new Date(`${project.start_date}T00:00:00`).getTime();
  const end = new Date(`${project.end_date}T00:00:00`).getTime();
  const timeElapsed = end > start ? Math.min(Math.max((today - start) / (end - start), 0), 1) : 0;
  const daysLeft = Number.isFinite(end) ? Math.round((end - today) / DAY) : null;

  const issues: string[] = [];
  const live = isLiveProject(project);
  const completed = project.status === 'completed' || project.status === 'archived';

  // --- Bắt các dấu hiệu, gom thành issues + xếp mức ---
  let level: HealthLevel = 'good';
  const bump = (to: HealthLevel) => {
    if (to === 'critical') level = 'critical';
    else if (to === 'warning' && level !== 'critical') level = 'warning';
  };

  if (live && daysLeft !== null && daysLeft < 0) {
    issues.push(`Quá hạn ${Math.abs(daysLeft)} ngày mà chưa hoàn thành`);
    bump('critical');
  } else if (live && daysLeft !== null && daysLeft <= 7 && progress < 0.8) {
    issues.push(`Còn ${daysLeft} ngày tới hạn nhưng mới xong ${Math.round(progress * 100)}%`);
    bump('critical');
  } else if (live && daysLeft !== null && daysLeft <= 14 && progress < 0.6) {
    issues.push(`Sắp tới hạn (${daysLeft} ngày), tiến độ ${Math.round(progress * 100)}%`);
    bump('warning');
  }

  if (overdueTasks >= 3) {
    issues.push(`${overdueTasks} tác vụ quá hạn`);
    bump('critical');
  } else if (overdueTasks > 0) {
    issues.push(`${overdueTasks} tác vụ quá hạn`);
    bump('warning');
  }

  // Tiêu thời gian nhanh hơn hẳn tiến độ — dấu hiệu chậm ngầm.
  if (live && totalTasks > 0 && timeElapsed - progress >= 0.3) {
    issues.push(`Đã dùng ${Math.round(timeElapsed * 100)}% thời gian nhưng chỉ xong ${Math.round(progress * 100)}%`);
    bump('warning');
  }

  if (live && !leadProfile) {
    issues.push('Chưa có trưởng nhóm phụ trách');
    bump('warning');
  }
  const memberCount = members.filter((m) => m.project_id === project.id).length;
  if (live && memberCount === 0) {
    issues.push('Chưa có thành viên nào');
    bump('warning');
  }
  if (live && totalTasks === 0) {
    issues.push('Chưa có tác vụ nào được lập');
    bump('warning');
  }

  if (completed) { level = 'good'; issues.length = 0; }

  return {
    project, lead: leadProfile, memberCount, totalTasks, doneTasks, overdueTasks,
    progress, timeElapsed, daysLeft, health: level, issues,
  };
}

/** Bảng sức khỏe toàn danh mục — dự án cần xử lý đứng trước. */
export function buildPortfolio(
  projects: Project[],
  tasks: Task[],
  members: ProjectMember[],
  profilesById: Map<string, Profile>,
): ProjectHealth[] {
  const order: Record<HealthLevel, number> = { critical: 0, warning: 1, good: 2 };
  return projects
    .map((p) => computeProjectHealth(p, tasks, members, p.lead_id ? profilesById.get(p.lead_id) ?? null : null))
    .sort((a, b) => {
      if (order[a.health] !== order[b.health]) return order[a.health] - order[b.health];
      // Cùng mức: dự án còn ít thời gian hơn lên trước.
      return (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999);
    });
}

/** Gom toàn bộ điểm cần xử lý (từ health của từng dự án đang chạy). */
export function collectRisks(portfolio: ProjectHealth[]): RiskItem[] {
  const risks: RiskItem[] = [];
  for (const ph of portfolio) {
    if (!isLiveProject(ph.project)) continue;
    for (const msg of ph.issues) {
      risks.push({ projectId: ph.project.id, projectName: ph.project.name, level: ph.health, message: msg });
    }
  }
  const order: Record<HealthLevel, number> = { critical: 0, warning: 1, good: 2 };
  return risks.sort((a, b) => order[a.level] - order[b.level]);
}

export type MilestoneKind = 'meeting' | 'reminder' | 'deadline';

export interface Milestone {
  kind: MilestoneKind;
  title: string;
  projectName: string;
  at: string; // ISO
  /** Âm = đã qua (không đưa vào danh sách sắp tới). */
  daysUntil: number;
}

/**
 * Mốc quan trọng SẮP TỚI: lịch họp/nhắc nhở (project_events) + hạn chót của
 * các dự án đang chạy. Sắp theo thời gian gần nhất.
 */
export function buildMilestones(
  events: ProjectEvent[],
  projects: Project[],
  tasks: Task[] = [],
  limit = 8,
): Milestone[] {
  const today = startOfToday();
  const out: Milestone[] = [];

  for (const ev of events) {
    const at = new Date(ev.start_at).getTime();
    if (at < today) continue;
    out.push({
      kind: ev.type,
      title: ev.title,
      projectName: ev.project?.name ?? '',
      at: ev.start_at,
      daysUntil: Math.round((at - today) / DAY),
    });
  }

  for (const p of projects) {
    if (!isLiveProject(p)) continue;
    const end = new Date(`${p.end_date}T00:00:00`).getTime();
    if (end < today) continue;
    out.push({
      kind: 'deadline',
      title: 'Hạn chót dự án',
      projectName: p.name,
      at: new Date(end).toISOString(),
      daysUntil: Math.round((end - today) / DAY),
    });
  }

  // Thêm các tác vụ quan trọng (Milestones)
  for (const t of tasks) {
    if (t.status === 'done' || !t.due_date || (t.priority !== 'critical' && t.priority !== 'high')) continue;
    const at = new Date(`${t.due_date}T00:00:00`).getTime();
    if (at < today) continue;
    out.push({
      kind: 'reminder',
      title: `Mốc: ${t.title}`,
      projectName: projects.find(p => p.id === t.project_id)?.name ?? '',
      at: new Date(at).toISOString(),
      daysUntil: Math.round((at - today) / DAY),
    });
  }

  return out.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()).slice(0, limit);
}
