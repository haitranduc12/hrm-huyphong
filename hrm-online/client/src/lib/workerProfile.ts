// ============================================================================
// Hồ sơ người lao động của CHÍNH MÌNH.
// ----------------------------------------------------------------------------
// Dùng cho trang hồ sơ cá nhân. Hàng rào bảo mật thật nằm ở RLS (migration
// 20260921100000): nhân viên chỉ đọc được dòng có `user_id = auth.uid()`.
// Điều kiện lọc ở đây là lớp thứ hai và giúp truy vấn tự nói rõ ý định.
// ============================================================================

import { supabase } from './supabase';
import type {
  JapaneseLevel, OverseasWorker, WorkerDocument, WorkerDocumentType,
  WorkerProgram, WorkerStatus, WorkerStatusLog,
} from '@/types';

export const WORKER_PROGRAM_LABEL: Record<WorkerProgram, string> = {
  TECHNICAL_INTERN: 'Thực tập sinh kỹ năng',
  SPECIFIED_SKILLED: 'Kỹ năng đặc định',
  ENGINEER: 'Kỹ sư',
};

export const JAPANESE_LEVEL_LABEL: Record<JapaneseLevel, string> = {
  NONE: 'Chưa có',
  N5: 'N5',
  N4: 'N4',
  N3: 'N3',
  JFT_BASIC: 'JFT-Basic',
};

export const WORKER_STATUS_LABEL: Record<WorkerStatus, { label: string; color: string }> = {
  SCREENING: { label: 'Sơ tuyển', color: 'bg-slate-100 text-slate-700' },
  TRAINING: { label: 'Đào tạo', color: 'bg-sky-50 text-sky-700' },
  WAITING_INTERVIEW: { label: 'Chờ phỏng vấn', color: 'bg-indigo-50 text-indigo-700' },
  PASSED: { label: 'Trúng tuyển', color: 'bg-emerald-50 text-emerald-700' },
  POST_PASS_TRAINING: { label: 'Đào tạo sau trúng tuyển', color: 'bg-teal-50 text-teal-700' },
  COE: { label: 'Làm COE', color: 'bg-amber-50 text-amber-700' },
  VISA: { label: 'Chờ Visa', color: 'bg-orange-50 text-orange-700' },
  WAITING_DEPARTURE: { label: 'Chờ xuất cảnh', color: 'bg-rose-50 text-rose-700' },
  WORKING_ABROAD: { label: 'Đang làm việc tại Nhật', color: 'bg-green-50 text-green-700' },
  RETURNED: { label: 'Đã về nước', color: 'bg-stone-100 text-stone-700' },
  FAILED: { label: 'Không đạt', color: 'bg-red-50 text-red-700' },
  WITHDRAWN: { label: 'Đã dừng', color: 'bg-slate-100 text-slate-500' },
};

export const WORKER_DOCUMENT_LABEL: Record<WorkerDocumentType, string> = {
  PASSPORT: 'Hộ chiếu',
  COE: 'COE (Tư cách lưu trú)',
  VISA: 'Visa',
  JAPANESE_CERTIFICATE: 'Chứng chỉ tiếng Nhật',
  HEALTH_CHECK: 'Khám sức khỏe',
  CONTRACT: 'Hợp đồng',
};

/** Thứ tự các giai đoạn, để vẽ tiến trình theo đúng đường đi thực tế. */
export const WORKER_STAGE_ORDER: WorkerStatus[] = [
  'SCREENING', 'TRAINING', 'WAITING_INTERVIEW', 'PASSED', 'POST_PASS_TRAINING',
  'COE', 'VISA', 'WAITING_DEPARTURE', 'WORKING_ABROAD', 'RETURNED',
];

export interface OwnWorkerProfile {
  worker: OverseasWorker | null;
  documents: WorkerDocument[];
  logs: WorkerStatusLog[];
  /** Migration chưa chạy — UI im lặng bỏ qua thay vì báo lỗi đỏ. */
  supported: boolean;
}

const EMPTY: OwnWorkerProfile = { worker: null, documents: [], logs: [], supported: false };

export async function fetchOwnWorkerProfile(userId: string): Promise<OwnWorkerProfile> {
  if (!supabase) return EMPTY;

  const workerRes = await supabase
    .from('overseas_workers')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  // Cột `user_id` chưa tồn tại hoặc RLS chưa mở: coi như tính năng chưa bật.
  if (workerRes.error) return EMPTY;

  const worker = (workerRes.data as OverseasWorker | null) ?? null;
  if (!worker) return { ...EMPTY, supported: true };

  const [documentRes, logRes] = await Promise.all([
    supabase.from('worker_documents').select('*').eq('worker_id', worker.id).order('expiry_date', { nullsFirst: false }),
    supabase.from('worker_status_logs').select('*').eq('worker_id', worker.id).order('changed_at', { ascending: false }),
  ]);

  return {
    worker,
    documents: (documentRes.data || []) as WorkerDocument[],
    logs: (logRes.data || []) as WorkerStatusLog[],
    supported: true,
  };
}

export type ExpiryState = 'none' | 'valid' | 'soon' | 'expired';

/** Giấy tờ sắp hết hạn tính từ 60 ngày — đủ thời gian để kịp làm lại visa. */
export const EXPIRY_WARNING_DAYS = 60;

export function expiryState(expiryDate: string | null): { state: ExpiryState; days: number | null } {
  if (!expiryDate) return { state: 'none', days: null };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(`${expiryDate}T00:00:00`);
  if (Number.isNaN(expiry.getTime())) return { state: 'none', days: null };

  const days = Math.round((expiry.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return { state: 'expired', days };
  if (days <= EXPIRY_WARNING_DAYS) return { state: 'soon', days };
  return { state: 'valid', days };
}
