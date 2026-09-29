import { Check, ChevronRight } from 'lucide-react';

interface WorkflowStripProps {
  title: string;
  steps: string[];
  activeStep: number;
  tone?: 'admin' | 'staff';
}

/**
 * Thanh tiến trình dùng chung cho các luồng nghiệp vụ nhiều bước.
 * Lấy cách trình bày timeline từ mẫu nhân sự và trạng thái phê duyệt từ Nexus.
 */
export function WorkflowStrip({ title, steps, activeStep, tone = 'admin' }: WorkflowStripProps) {
  const activeColor = tone === 'staff' ? 'bg-emerald-600 border-emerald-600' : 'bg-indigo-600 border-indigo-600';
  const currentText = tone === 'staff' ? 'text-emerald-700' : 'text-indigo-700';
  const progress = steps.length > 1 ? Math.min(100, Math.max(0, (activeStep / (steps.length - 1)) * 100)) : 100;

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white/95 px-4 py-4 shadow-card sm:px-5" aria-label={title}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{title}</p>
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${tone === 'staff' ? 'bg-emerald-50 text-emerald-700' : 'bg-indigo-50 text-indigo-700'}`}>
          Bước {Math.min(activeStep + 1, steps.length)}/{steps.length}
        </span>
      </div>
      <div className="mb-3 h-1 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${tone === 'staff' ? 'bg-emerald-500' : 'bg-indigo-500'}`}
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="scrollbar-none flex items-center gap-1 overflow-x-auto pb-1">
        {steps.map((step, index) => {
          const completed = index < activeStep;
          const current = index === activeStep;
          return (
            <div key={step} className="flex shrink-0 items-center">
              <div className="flex items-center gap-2">
                <span className={`flex h-7 w-7 items-center justify-center rounded-full border text-[10px] font-bold transition-colors ${completed || current ? `${activeColor} text-white shadow-sm` : 'border-slate-200 bg-slate-50 text-slate-400'}`}>
                  {completed ? <Check className="h-3.5 w-3.5" /> : index + 1}
                </span>
                <span className={`text-xs font-semibold ${current ? currentText : completed ? 'text-slate-700' : 'text-slate-400'}`} aria-current={current ? 'step' : undefined}>{step}</span>
              </div>
              {index < steps.length - 1 && <ChevronRight className="mx-2 h-3.5 w-3.5 text-slate-300" />}
            </div>
          );
        })}
      </div>
    </section>
  );
}
