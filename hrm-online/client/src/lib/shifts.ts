// ============================================================================
// Ca làm việc — loại ca, phép tính giờ, tuần làm việc.
// ============================================================================

import { supabase } from './supabase';
import { describeDbError } from '@/lib/dbError';
import { toDateString } from './utils';
import type { Shift, ShiftTypeConfig } from '@/types';

/**
 * Trần giờ làm việc bình thường theo Bộ luật Lao động 2019, Điều 105:
 * không quá 48 giờ mỗi tuần.
 */
export const WEEKLY_HOUR_LIMIT = 48;

export async function fetchShiftTypes(): Promise<{ data: ShiftTypeConfig[]; error?: string }> {
  const { data, error } = await supabase
    .from('shift_types')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (error) return { data: [], error: describeDbError(error) };
  return { data: (data || []) as ShiftTypeConfig[] };
}

/** Thứ Hai của tuần chứa `date`. Tuần làm việc Việt Nam bắt đầu từ thứ Hai. */
export function startOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const weekday = d.getDay(); // 0 = CN
  const offset = weekday === 0 ? -6 : 1 - weekday;
  d.setDate(d.getDate() + offset);
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Bảy ngày của tuần chứa `date`, từ thứ Hai. */
export function weekDays(date: Date): { date: Date; key: string; label: string; weekdayLabel: string }[] {
  const monday = startOfWeek(date);
  const names = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(monday, i);
    return {
      date: d,
      key: toDateString(d),
      label: d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }),
      weekdayLabel: names[i],
    };
  });
}

/**
 * Một ca có bao trùm ngày này không.
 * Đơn đăng ký lưu theo KHOẢNG (start_date → end_date), nên một đơn có thể phủ
 * nhiều ngày trong lưới.
 */
export function shiftCoversDate(shift: Shift, dateKey: string): boolean {
  return dateKey >= shift.start_date && dateKey <= shift.end_date;
}

/**
 * Tổng giờ của một người trong tuần.
 *
 * Đếm theo TỪNG NGÀY ca phủ, không phải mỗi đơn một lần — đơn "cả tuần ca sáng"
 * là 5 ngày × 4 giờ, không phải 4 giờ.
 * Chỉ tính ca đã duyệt; ca chờ duyệt trả riêng để hiển thị khác màu.
 */
export function weeklyHours(
  shifts: Shift[],
  days: { key: string }[],
  typeHours: Map<string, number>,
): { approved: number; pending: number } {
  let approved = 0;
  let pending = 0;

  for (const day of days) {
    for (const shift of shifts) {
      if (!shiftCoversDate(shift, day.key)) continue;
      const hours = typeHours.get(shift.shift_type) ?? 0;
      if (shift.status === 'approved') approved += hours;
      else if (shift.status === 'pending') pending += hours;
    }
  }

  return { approved, pending };
}

export function formatHours(hours: number): string {
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/** Chênh lệch giữa giờ vào ca và giờ check-in thực tế, tính bằng phút. */
export function lateMinutes(shiftStart: string, checkInIso: string): number {
  const [h, m] = shiftStart.split(':').map(Number);
  const checkIn = new Date(checkInIso);
  const scheduled = new Date(checkIn);
  scheduled.setHours(h, m, 0, 0);
  return Math.round((checkIn.getTime() - scheduled.getTime()) / 60000);
}

export function formatLateness(minutes: number): { text: string; tone: 'ok' | 'late' | 'early' } {
  if (minutes > 5) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return { text: `Muộn ${h > 0 ? `${h}h` : ''}${m}p`, tone: 'late' };
  }
  if (minutes < -30) return { text: `Sớm ${Math.abs(minutes)}p`, tone: 'early' };
  return { text: 'Đúng giờ', tone: 'ok' };
}
