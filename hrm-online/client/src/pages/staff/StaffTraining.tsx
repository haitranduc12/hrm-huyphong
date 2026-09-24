import { useEffect, useState } from 'react';
import { BookOpen, CheckCircle2, ExternalLink, PlayCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { useToast } from '@/contexts/ToastContext';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtimeSync } from '@/hooks/useRealtimeSync';
import { supabase } from '@/lib/supabase';
import { describeDbError } from '@/lib/dbError';
import { createTrainingVideoUrl } from '@/lib/training';
import type { TrainingCourse, TrainingEnrollment, TrainingEnrollmentStatus } from '@/types';

const statusConfig: Record<TrainingEnrollmentStatus, { label: string; color: string }> = {
  enrolled: { label: 'Chưa bắt đầu', color: 'bg-slate-100 text-slate-600' },
  in_progress: { label: 'Đang học', color: 'bg-blue-100 text-blue-700' },
  completed: { label: 'Hoàn thành', color: 'bg-emerald-100 text-emerald-700' },
};

export function StaffTraining() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [courses, setCourses] = useState<TrainingCourse[]>([]);
  const [enrollments, setEnrollments] = useState<TrainingEnrollment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [videoUrls, setVideoUrls] = useState<Record<string, string>>({});

  const load = async (silent = false) => {
    if (!profile) return;
    if (!silent) setLoading(true);
    const [{ data: courseData, error: courseError }, { data: enrollmentData, error: enrollmentError }] = await Promise.all([
      supabase.from('training_courses').select('*').eq('status', 'published').order('deadline', { ascending: true, nullsFirst: false }),
      supabase.from('training_enrollments').select('*, course:training_courses(*)').eq('user_id', profile.id),
    ]);
    const error = courseError || enrollmentError;
    setLoadError(error ? 'Không tải được dữ liệu đào tạo: ' + describeDbError(error) : null);
    setCourses((courseData || []) as TrainingCourse[]);
    const nextEnrollments = (enrollmentData || []) as TrainingEnrollment[];
    setEnrollments(nextEnrollments);
    const nextUrls: Record<string, string> = {};
    for (const course of (courseData || []) as TrainingCourse[]) {
      if (course.video_path) {
        const signed = await createTrainingVideoUrl(course.video_path);
        if (signed.url) nextUrls[course.id] = signed.url;
      }
    }
    setVideoUrls(nextUrls);
    setLoading(false);
  };

  useEffect(() => { load(); }, [profile]);
  useRealtimeSync(profile ? [{ table: 'training_courses' }, { table: 'training_enrollments', filter: `user_id=eq.${profile.id}` }] : [], () => load(true), { enabled: !!profile, channelKey: `staff-training-${profile?.id ?? 'anonymous'}` });

  const enrollmentFor = (courseId: string) => enrollments.find((item) => item.course_id === courseId);
  const enroll = async (course: TrainingCourse) => {
    const { error } = await supabase.from('training_enrollments').insert({ course_id: course.id, user_id: profile?.id, status: 'enrolled', progress: 0 });
    if (error) toast('Đăng ký thất bại: ' + describeDbError(error), 'error'); else { toast('Đã thêm khóa học vào lộ trình.', 'success'); void load(true); }
  };
  const updateProgress = async (enrollment: TrainingEnrollment, progress: number) => {
    const status: TrainingEnrollmentStatus = progress === 100 ? 'completed' : progress > 0 ? 'in_progress' : 'enrolled';
    const { error } = await supabase.from('training_enrollments').update({ progress, status, completed_at: progress === 100 ? new Date().toISOString() : null }).eq('id', enrollment.id);
    if (error) toast('Cập nhật tiến độ thất bại: ' + describeDbError(error), 'error'); else void load(true);
  };

  return <div className="space-y-5"><div><h2 className="font-display text-xl font-bold text-slate-800">Đào tạo của tôi</h2><p className="text-sm text-slate-500 mt-1">Theo dõi các khóa học và lộ trình phát triển cá nhân.</p></div>{loading ? <Card><CardContent><p className="text-sm text-slate-400 py-10 text-center">Đang tải lộ trình...</p></CardContent></Card> : loadError ? <Card><ErrorState message={loadError} onRetry={() => load()} /></Card> : courses.length === 0 ? <Card><EmptyState icon={<BookOpen className="w-8 h-8" />} title="Chưa có khóa học mới" description="Các khóa học được công ty mở sẽ xuất hiện ở đây." /></Card> : <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">{courses.map((course) => { const enrollment = enrollmentFor(course.id); const status = enrollment ? statusConfig[enrollment.status] : null; return <Card key={course.id}><CardContent>{videoUrls[course.id] && <video controls preload="metadata" className="mb-4 aspect-video w-full rounded-xl bg-slate-900" src={videoUrls[course.id]} /> }<div className="flex items-start justify-between gap-3"><div className="w-11 h-11 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center"><BookOpen className="w-5 h-5" /></div>{status ? <Badge className={status.color}>{status.label}</Badge> : <Badge className="bg-amber-100 text-amber-700">Chưa đăng ký</Badge>}</div><h3 className="font-display text-base font-bold text-slate-800 mt-4">{course.title}</h3><p className="text-sm text-slate-500 mt-1 line-clamp-2">{course.description || 'Chưa có mô tả.'}</p><div className="flex flex-wrap gap-3 text-xs text-slate-500 mt-4"><span>{course.category}</span><span>{course.duration_hours} giờ</span>{course.instructor && <span>{course.instructor}</span>}{course.deadline && <span>Hạn {course.deadline}</span>}</div>{enrollment ? <div className="mt-4"><div className="flex justify-between text-xs text-slate-500 mb-1"><span>Tiến độ</span><strong className="text-slate-700">{enrollment.progress}%</strong></div><input aria-label={`Tiến độ ${course.title}`} type="range" min="0" max="100" step="10" value={enrollment.progress} onChange={(e) => updateProgress(enrollment, Number(e.target.value))} className="w-full accent-emerald-600" /></div> : null}<div className="flex gap-2 mt-4 pt-4 border-t border-slate-100">{enrollment ? <Button onClick={() => updateProgress(enrollment, enrollment.progress === 100 ? 0 : 100)} theme="staff" className="flex-1">{enrollment.progress === 100 ? <><PlayCircle className="w-4 h-4" />Học lại</> : <><CheckCircle2 className="w-4 h-4" />Đánh dấu hoàn thành</>}</Button> : <Button onClick={() => enroll(course)} theme="staff" className="flex-1"><PlayCircle className="w-4 h-4" />Đăng ký học</Button>}{course.resource_url && <a href={course.resource_url} target="_blank" rel="noreferrer" className="h-10 px-3 inline-flex items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50" aria-label="Mở tài liệu"><ExternalLink className="w-4 h-4" /></a>}</div></CardContent></Card>; })}</div>}</div>;
}
