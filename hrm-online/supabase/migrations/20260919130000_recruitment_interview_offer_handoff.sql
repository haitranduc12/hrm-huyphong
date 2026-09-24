-- REC-04, REC-08..REC-13: khép kín ATS từ đăng tuyển đến bàn giao onboarding.
-- Tách dữ liệu lịch/đánh giá/offer khỏi candidate để có lịch sử và audit rõ ràng.

create table if not exists public.recruitment_job_postings (
  id uuid primary key default gen_random_uuid(),
  requisition_id uuid not null references public.recruitment_requisitions(id) on delete cascade,
  channel text not null,
  title text not null,
  public_url text,
  cost numeric(14,2) check (cost is null or cost >= 0),
  status text not null default 'DRAFT' check (status in ('DRAFT','PUBLISHED','CLOSED')),
  published_at timestamptz,
  closed_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.recruitment_interviews (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.recruitment_candidates(id) on delete cascade,
  round integer not null check (round in (1,2)),
  scheduled_at timestamptz not null,
  interviewer_id uuid references public.profiles(id) on delete set null,
  mode text not null default 'OFFLINE' check (mode in ('OFFLINE','ONLINE','PHONE')),
  location_or_link text,
  status text not null default 'SCHEDULED' check (status in ('SCHEDULED','COMPLETED','CANCELLED','NO_SHOW')),
  score numeric(5,2) check (score is null or score between 0 and 100),
  recommendation text check (recommendation is null or recommendation in ('PASS','HOLD','FAIL')),
  feedback text,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (candidate_id, round)
);

create table if not exists public.recruitment_offers (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null unique references public.recruitment_candidates(id) on delete cascade,
  proposed_salary numeric(14,2) not null check (proposed_salary >= 0),
  start_date date not null,
  status text not null default 'DRAFT' check (status in ('DRAFT','SENT','ACCEPTED','DECLINED','WITHDRAWN')),
  sent_at timestamptz,
  responded_at timestamptz,
  note text,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.recruitment_onboarding_handoffs (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null unique references public.recruitment_candidates(id) on delete restrict,
  planned_start_date date not null,
  status text not null default 'PENDING' check (status in ('PENDING','ACCOUNT_CREATED','ONBOARDING_STARTED','CANCELLED')),
  handoff_note text,
  employee_user_id uuid references public.profiles(id) on delete set null,
  handed_off_by uuid references public.profiles(id) on delete set null default auth.uid(),
  handed_off_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists recruitment_postings_req_idx on public.recruitment_job_postings(requisition_id, status);
create index if not exists recruitment_interviews_candidate_idx on public.recruitment_interviews(candidate_id, scheduled_at);
create index if not exists recruitment_handoffs_status_idx on public.recruitment_onboarding_handoffs(status, planned_start_date);

alter table public.recruitment_job_postings enable row level security;
alter table public.recruitment_interviews enable row level security;
alter table public.recruitment_offers enable row level security;
alter table public.recruitment_onboarding_handoffs enable row level security;

create policy recruitment_postings_read on public.recruitment_job_postings for select to authenticated
  using (public.can('users') or exists (
    select 1 from public.recruitment_requisitions r
    where r.id = requisition_id and (r.requested_by = auth.uid() or r.hiring_manager_id = auth.uid())
  ));
create policy recruitment_postings_manage on public.recruitment_job_postings for all to authenticated
  using (public.can('users')) with check (public.can('users'));

create policy recruitment_interviews_read on public.recruitment_interviews for select to authenticated
  using (public.can('users') or interviewer_id = auth.uid() or exists (
    select 1 from public.recruitment_candidates c join public.recruitment_requisitions r on r.id = c.requisition_id
    where c.id = candidate_id and (r.requested_by = auth.uid() or r.hiring_manager_id = auth.uid())
  ));
create policy recruitment_interviews_manage on public.recruitment_interviews for all to authenticated
  using (public.can('users') or interviewer_id = auth.uid())
  with check (public.can('users') or interviewer_id = auth.uid());

create policy recruitment_offers_read on public.recruitment_offers for select to authenticated
  using (public.can('users') or exists (
    select 1 from public.recruitment_candidates c join public.recruitment_requisitions r on r.id = c.requisition_id
    where c.id = candidate_id and (r.requested_by = auth.uid() or r.hiring_manager_id = auth.uid())
  ));
create policy recruitment_offers_manage on public.recruitment_offers for all to authenticated
  using (public.can('users')) with check (public.can('users'));

create policy recruitment_handoffs_read on public.recruitment_onboarding_handoffs for select to authenticated
  using (public.can('users') or employee_user_id = auth.uid());
create policy recruitment_handoffs_manage on public.recruitment_onboarding_handoffs for all to authenticated
  using (public.can('users')) with check (public.can('users'));

grant select, insert, update, delete on public.recruitment_job_postings to authenticated;
grant select, insert, update, delete on public.recruitment_interviews to authenticated;
grant select, insert, update, delete on public.recruitment_offers to authenticated;
grant select, insert, update, delete on public.recruitment_onboarding_handoffs to authenticated;

-- Chuyển bước có kiểm soát thay vì cho phép nhảy tùy ý trên trình duyệt.
create or replace function public.transition_recruitment_candidate(
  target_id uuid,
  target_stage text,
  reason text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare current_stage text;
begin
  if not public.can('users') then
    raise exception 'Không có quyền cập nhật ứng viên.' using errcode = '42501';
  end if;
  select stage into current_stage from public.recruitment_candidates where id = target_id for update;
  if current_stage is null then raise exception 'Ứng viên không tồn tại.' using errcode = 'P0002'; end if;
  if current_stage in ('HIRED','REJECTED','WITHDRAWN') then
    raise exception 'Hồ sơ đã kết thúc, không thể chuyển bước.' using errcode = '23514';
  end if;
  if target_stage = 'REJECTED' and length(trim(coalesce(reason, ''))) < 3 then
    raise exception 'Loại ứng viên phải có lý do.' using errcode = '23514';
  end if;
  if target_stage = 'HIRED' and not exists (
    select 1 from public.recruitment_offers where candidate_id = target_id and status = 'ACCEPTED'
  ) then
    raise exception 'Chỉ xác nhận trúng tuyển sau khi ứng viên chấp nhận offer.' using errcode = '23514';
  end if;
  if target_stage = 'OFFER' and not exists (
    select 1 from public.recruitment_interviews where candidate_id = target_id and status = 'COMPLETED' and recommendation = 'PASS'
  ) then
    raise exception 'Cần ít nhất một kết quả phỏng vấn đạt trước khi gửi offer.' using errcode = '23514';
  end if;
  update public.recruitment_candidates
  set stage = target_stage,
      rejection_reason = case when target_stage = 'REJECTED' then trim(reason) else null end,
      test_due_at = case when target_stage = 'TEST' then now() + interval '24 hours' else test_due_at end,
      updated_at = now()
  where id = target_id;
end;
$$;

grant execute on function public.transition_recruitment_candidate(uuid, text, text) to authenticated;

-- Bàn giao chỉ được tạo khi offer đã chấp nhận và hồ sơ đã ở trạng thái HIRED.
create or replace function public.handoff_hired_candidate(
  target_candidate uuid,
  target_start_date date,
  target_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare handoff_id uuid;
begin
  if not public.can('users') then raise exception 'Không có quyền bàn giao onboarding.' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.recruitment_candidates c
    join public.recruitment_offers o on o.candidate_id = c.id
    where c.id = target_candidate and c.stage = 'HIRED' and o.status = 'ACCEPTED'
  ) then raise exception 'Ứng viên chưa đủ điều kiện bàn giao onboarding.' using errcode = '23514'; end if;
  insert into public.recruitment_onboarding_handoffs(candidate_id, planned_start_date, handoff_note)
  values (target_candidate, target_start_date, nullif(trim(target_note), ''))
  on conflict (candidate_id) do update
    set planned_start_date = excluded.planned_start_date, handoff_note = excluded.handoff_note, updated_at = now()
  returning id into handoff_id;
  return handoff_id;
end;
$$;

grant execute on function public.handoff_hired_candidate(uuid, date, text) to authenticated;
