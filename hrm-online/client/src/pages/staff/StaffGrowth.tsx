import { useEffect, useState } from 'react';
import { CheckCircle2, Rocket, Target } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSync } from '@/hooks/useRealtimeSync';
import { describeDbError } from '@/lib/dbError';
import { supabase } from '@/lib/supabase';

interface Process { id: string; title: string; process_type: string; target_date: string | null; status: string }
interface Item { id: string; process_id: string; title: string; due_date: string | null; completed: boolean }
interface Goal { id: string; title: string; description: string | null; target_value: number; current_value: number; weight: number; status: string; cycle?: { name: string } }

export function StaffGrowth() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [processes, setProcesses] = useState<Process[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    if (!profile) return;
    setLoading(true); setError('');
    const [processResult, goalResult] = await Promise.all([
      supabase.from('employee_lifecycle_processes').select('*, employee_checklist_items(*)').eq('user_id', profile.id).order('created_at', { ascending: false }),
      supabase.from('performance_goals').select('*, cycle:performance_cycles(name)').eq('user_id', profile.id).order('created_at', { ascending: false }),
    ]);
    const firstError = processResult.error || goalResult.error;
    if (firstError) setError(`Tính năng phát triển cá nhân chưa được khởi tạo. ${describeDbError(firstError)}`);
    const rawProcesses = (processResult.data || []) as (Process & { employee_checklist_items?: Item[] })[];
    setProcesses(rawProcesses); setItems(rawProcesses.flatMap((process) => process.employee_checklist_items || [])); setGoals((goalResult.data || []) as unknown as Goal[]); setLoading(false);
  };
  useEffect(() => { void load(); }, [profile?.id]);
  useRealtimeSync(profile ? [
    { table: 'employee_lifecycle_processes', filter: `user_id=eq.${profile.id}` },
    { table: 'employee_checklist_items' },
    { table: 'performance_goals', filter: `user_id=eq.${profile.id}` },
  ] : [], () => load(), { enabled: !!profile, channelKey: `staff-growth-${profile?.id || 'none'}` });

  const toggleItem = async (item: Item) => {
    const { error: updateError } = await supabase.from('employee_checklist_items').update({ completed: !item.completed, completed_at: !item.completed ? new Date().toISOString() : null }).eq('id', item.id);
    if (updateError) toast('Không cập nhật được checklist: ' + describeDbError(updateError), 'error'); else await load();
  };
  const updateGoal = async (goal: Goal, current: number) => {
    const { error: updateError } = await supabase.from('performance_goals').update({ current_value: current, status: current >= goal.target_value ? 'COMPLETED' : 'ACTIVE' }).eq('id', goal.id);
    if (updateError) toast('Không cập nhật được tiến độ mục tiêu: ' + describeDbError(updateError), 'error'); else await load();
  };

  if (loading) return <Card><CardContent><p className="py-14 text-center text-sm text-slate-400">Đang tải lộ trình phát triển…</p></CardContent></Card>;
  if (error) return <Card><ErrorState message={error} onRetry={load} /></Card>;
  return <div className="space-y-6">
    <div><h1 className="text-2xl font-bold text-slate-800">Lộ trình & mục tiêu</h1><p className="text-sm text-slate-500 mt-1">Theo dõi checklist hội nhập và tiến độ KPI/OKR của bạn.</p></div>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <Card><CardHeader><CardTitle className="flex items-center gap-2"><Rocket className="w-5 h-5 text-indigo-600" />Checklist nhân sự</CardTitle></CardHeader><CardContent>{processes.map((process) => { const list = items.filter((item) => item.process_id === process.id); return <div key={process.id} className="mb-5 last:mb-0"><div className="flex items-center justify-between"><p className="font-medium text-slate-800">{process.title}</p><Badge className={process.process_type === 'ONBOARDING' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}>{process.process_type === 'ONBOARDING' ? 'Onboarding' : 'Offboarding'}</Badge></div><div className="mt-3 space-y-2">{list.map((item) => <button key={item.id} onClick={() => void toggleItem(item)} className="w-full flex items-center gap-2 rounded-lg p-2 text-left hover:bg-slate-50"><CheckCircle2 className={`w-4 h-4 ${item.completed ? 'text-emerald-600' : 'text-slate-300'}`} /><span className={`text-sm ${item.completed ? 'line-through text-slate-400' : 'text-slate-700'}`}>{item.title}</span></button>)}</div></div>})}{processes.length === 0 && <EmptyState title="Chưa có checklist" description="Checklist hội nhập hoặc bàn giao sẽ xuất hiện tại đây." />}</CardContent></Card>
      <Card><CardHeader><CardTitle className="flex items-center gap-2"><Target className="w-5 h-5 text-indigo-600" />KPI / OKR của tôi</CardTitle></CardHeader><CardContent><div className="space-y-4">{goals.map((goal) => { const pct = Math.min(Math.round(goal.current_value / Math.max(goal.target_value, 1) * 100), 100); return <div key={goal.id} className="rounded-xl border border-slate-200 p-4"><div className="flex items-start justify-between"><div><p className="font-medium text-slate-800">{goal.title}</p><p className="text-xs text-slate-500">{goal.cycle?.name || 'Chu kỳ đánh giá'} · Trọng số {goal.weight}%</p></div><Badge className={pct >= 100 ? 'bg-emerald-50 text-emerald-700' : 'bg-indigo-50 text-indigo-700'}>{pct}%</Badge></div>{goal.description && <p className="text-sm text-slate-500 mt-3">{goal.description}</p>}<input aria-label={`Tiến độ ${goal.title}`} type="range" min="0" max={goal.target_value} value={goal.current_value} onChange={(e) => void updateGoal(goal, Number(e.target.value))} className="w-full mt-4 accent-indigo-600" /></div>})}{goals.length === 0 && <EmptyState title="Chưa có mục tiêu" description="KPI/OKR được giao sẽ xuất hiện tại đây." />}</div></CardContent></Card>
    </div>
  </div>;
}
