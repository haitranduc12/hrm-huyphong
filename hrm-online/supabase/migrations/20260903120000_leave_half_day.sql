-- Support half-day leave requests used by the leave module.

alter table public.leave_requests
  add column if not exists half_day boolean not null default false;

comment on column public.leave_requests.half_day is
  'True only for a half-day request contained within one working day.';
