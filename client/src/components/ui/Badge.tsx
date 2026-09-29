import { type ReactNode } from 'react';

interface BadgeProps {
  children: ReactNode;
  className?: string;
}

export function Badge({ children, className = '' }: BadgeProps) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border border-current/15 px-2.5 py-1 text-[11px] font-semibold leading-none shadow-[inset_0_1px_0_rgba(255,255,255,0.3)] ${className}`}>
      {children}
    </span>
  );
}
