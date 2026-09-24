// ============================================================================
// Tính toán cho biểu đồ Gantt.
// ----------------------------------------------------------------------------
// Tách khỏi component để phần số học có thể đọc và sửa riêng — chỗ dễ sai nhất
// của Gantt là lệch một ngày, mà lỗi đó nhìn vào JSX không thấy được.
// ============================================================================

import type { Task } from '@/types';
import { getTodayString, toDateString } from './utils';

/** Mốc thời gian của một tác vụ trên trục ngày. */
export interface GanttBar {
  task: Task;
  /** Chỉ số cột bắt đầu, tính từ 0 so với `from`. */
  offset: number;
  /** Số ngày thanh chiếm, luôn ≥ 1 — tác vụ trong ngày vẫn phải thấy được. */
  span: number;
  overdue: boolean;
}

export interface GanttRange {
  from: string;
  to: string;
  /** Toàn bộ ngày trong khoảng, dùng để vẽ lưới và nhãn. */
  days: { key: string; date: Date; isWeekend: boolean; isToday: boolean }[];
}

/** Số ngày từ `a` đến `b`, cả hai là chuỗi yyyy-mm-dd. */
export function daysBetween(a: string, b: string): number {
  // Ép về giữa trưa UTC để chênh lệch giờ mùa hè không làm lệch một ngày.
  const ms = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))
           - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  return Math.round(ms / 86400000);
}

export function addDaysToKey(key: string, days: number): string {
  const d = new Date(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10));
  d.setDate(d.getDate() + days);
  return toDateString(d);
}

/**
 * Hai đầu của một tác vụ, đã xử lý các trường hợp khai thiếu:
 *  - chỉ có hạn chót  → coi như làm gọn trong một ngày
 *  - chỉ có ngày bắt đầu → cũng một ngày
 *  - không khai gì   → không vẽ được, trả về null
 */
export function taskSpan(task: Task): { start: string; end: string } | null {
  const start = task.start_date ?? task.due_date;
  const end = task.due_date ?? task.start_date;
  if (!start || !end) return null;
  // Dữ liệu cũ có thể ngược đầu dù DB đã có ràng buộc; đừng vẽ thanh âm.
  return start <= end ? { start, end } : { start: end, end: start };
}

/**
 * Khoảng thời gian cần vẽ. Lấy bao trọn mọi tác vụ, cộng thêm khoảng đệm hai
 * bên để thanh không dính sát mép, và luôn bao gồm hôm nay để vạch "hôm nay"
 * có chỗ đứng.
 */
export function ganttRange(tasks: Task[], padDays = 2): GanttRange | null {
  const spans = tasks.map(taskSpan).filter((s): s is { start: string; end: string } => !!s);
  const today = getTodayString();
  if (spans.length === 0) return null;

  let from = spans[0].start;
  let to = spans[0].end;
  for (const s of spans) {
    if (s.start < from) from = s.start;
    if (s.end > to) to = s.end;
  }
  if (today < from) from = today;
  if (today > to) to = today;

  from = addDaysToKey(from, -padDays);
  to = addDaysToKey(to, padDays);

  const total = daysBetween(from, to) + 1;
  const days = Array.from({ length: total }, (_, i) => {
    const key = addDaysToKey(from, i);
    const date = new Date(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10));
    const dow = date.getDay();
    return { key, date, isWeekend: dow === 0 || dow === 6, isToday: key === today };
  });

  return { from, to, days };
}

export function ganttBars(tasks: Task[], range: GanttRange): GanttBar[] {
  const today = getTodayString();
  return tasks.reduce<GanttBar[]>((acc, task) => {
    const span = taskSpan(task);
    if (!span) return acc;
    acc.push({
      task,
      offset: daysBetween(range.from, span.start),
      span: Math.max(1, daysBetween(span.start, span.end) + 1),
      overdue: task.status !== 'done' && !!task.due_date && task.due_date < today,
    });
    return acc;
  }, []);
}

/** Màu thanh theo trạng thái. Quá hạn thắng mọi trạng thái khác. */
export function barColor(bar: GanttBar): string {
  if (bar.overdue) return 'bg-red-500';
  switch (bar.task.status) {
    case 'done':        return 'bg-emerald-500';
    case 'in_review':   return 'bg-amber-500';
    case 'in_progress': return 'bg-blue-500';
    default:            return 'bg-slate-400';
  }
}

/** Tác vụ không khai ngày nào — không vẽ được, nhưng phải nói ra. */
export function tasksWithoutDates(tasks: Task[]): Task[] {
  return tasks.filter((t) => !taskSpan(t));
}
