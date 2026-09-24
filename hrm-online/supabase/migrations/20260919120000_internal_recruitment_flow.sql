-- REC-01..REC-13 từ biên bản 05/09: yêu cầu tuyển nội bộ, SLA 24 giờ,
-- phê duyệt có lý do và pipeline ứng viên tách khỏi đơn hàng cung ứng lao động.

create table if not exists public.recruitment_requisitions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default ('REQ-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6))),
  title text not null check (length(trim(title)) >= 3),
  unit_id uuid references public.organization_units(id) on delete set null,
  position_id uuid references public.job_positions(id) on delete set null,
  requested_by uuid not null references public.profiles(id) on delete restrict default auth.uid(),
  hiring_manager_id uuid not null references public.profiles(id) on delete restrict,
  headcount integer not null default 1 check (headcount > 0),
  employment_type text not null default 'FULL_TIME' check (employment_type in ('FULL_TIME','PART_TIME','CONTRACT','INTERN')),
  reason text not null check (length(trim(reason)) >= 5),
  salary_min numeric(14,2),
  salary_max numeric(14,2),
  desired_start_date date,
  status text not null default 'SUBMITTED' check (status in ('DRAFT','SUBMITTED','APPROVED','REJECTED','OPEN','CLOSED','CANCELLED')),
  submitted_at timestamptz,
  review_due_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (salary_min is null or salary_min >= 0),
  check (salary_max is null or salary_max >= coalesce(salary_min, 0))
);

create table if not exists public.recruitment_candidates (
  id uuid primary key default gen_random_uuid(),
  requisition_id uuid not null references public.recruitment_requisitions(id) on delete cascade,
  full_name text not null check (length(trim(full_name)) >= 2),
  email text,
  phone text,
  source text,
  stage text not null default 'APPLIED' check (stage in ('APPLIED','HR_SCREENING','MANAGER_SCREENING','INTERVIEW_1','INTERVIEW_2','TEST','OFFER','HIRED','REJECTED','WITHDRAWN')),
  test_due_at timestamptz,
  consent_at timestamptz,
  rejection_reason text,
  note text,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (stage <> 'REJECTED' or nullif(trim(rejection_reason), '') is not null)
);

create unique index if not exists recruitment_candidate_email_unique
  on public.recruitment_candidates(requisition_id, lower(email)) where email is not null;
create unique index if not exists recruitment_candidate_phone_unique
  on public.recruitment_candidates(requisition_id, phone) where phone is not null;
create index if not exists recruitment_requisition_status_sla_idx on public.recruitment_requisitions(status, review_due_at);
create index if not exists recruitment_candidate_req_stage_idx on public.recruitment_candidates(requisition_id, stage);

alter table public.recruitment_requisitions enable row level security;
alter table public.recruitment_candidates enable row level security;

-- Cho phép chạy lại migration sau một lần chạy dở hoặc đã chạy trước đó.
drop policy if exists recruitment_requisitions_read on public.recruitment_requisitions;
drop policy if exists recruitment_requisitions_create on public.recruitment_requisitions;
drop policy if exists recruitment_requisitions_manage on public.recruitment_requisitions;
drop policy if exists recruitment_candidates_read on public.recruitment_candidates;
drop policy if exists recruitment_candidates_manage on public.recruitment_candidates;

create policy recruitment_requisitions_read on public.recruitment_requisitions for select to authenticated
  using (public.can('users') or requested_by = auth.uid() or hiring_manager_id = auth.uid());
create policy recruitment_requisitions_create on public.recruitment_requisitions for insert to authenticated
  with check (
    (public.can('projects') or public.can('users'))
    and requested_by = auth.uid()
    and hiring_manager_id = auth.uid()
    and status in ('DRAFT','SUBMITTED')
  );
create policy recruitment_requisitions_manage on public.recruitment_requisitions for update to authenticated
  using (public.can('users')) with check (public.can('users'));

create policy recruitment_candidates_read on public.recruitment_candidates for select to authenticated
  using (public.can('users') or exists (
    select 1 from public.recruitment_requisitions r
    where r.id = requisition_id and (r.requested_by = auth.uid() or r.hiring_manager_id = auth.uid())
  ));
create policy recruitment_candidates_manage on public.recruitment_candidates for all to authenticated
  using (public.can('users')) with check (public.can('users'));

grant select, insert, update on public.recruitment_requisitions to authenticated;
grant select, insert, update, delete on public.recruitment_candidates to authenticated;

create or replace function public.review_recruitment_requisition(target_id uuid, decision text, note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can('users') then raise exception 'Không có quyền duyệt yêu cầu tuyển dụng.' using errcode = '42501'; end if;
  if decision not in ('APPROVED','REJECTED') then raise exception 'Quyết định không hợp lệ.' using errcode = '23514'; end if;
  if decision = 'REJECTED' and length(trim(coalesce(note, ''))) < 3 then raise exception 'Từ chối phải có lý do.' using errcode = '23514'; end if;
  update public.recruitment_requisitions set status = decision, reviewed_by = auth.uid(), reviewed_at = now(), review_note = nullif(trim(note), ''), updated_at = now()
  where id = target_id and status = 'SUBMITTED';
  if not found then raise exception 'Yêu cầu đã được xử lý hoặc không tồn tại.' using errcode = '23514'; end if;
end;
$$;

grant execute on function public.review_recruitment_requisition(uuid, text, text) to authenticated;
