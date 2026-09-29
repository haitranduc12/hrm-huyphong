-- Workforce mobility modules adapted from the nhan-su reference template.
-- These tables are additive: they do not alter the existing HRM workflows.

create table if not exists public.workforce_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  prefecture text,
  industry text,
  contact_name text,
  phone text,
  created_at timestamptz not null default now()
);

create table if not exists public.workforce_unions (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  region text,
  contact_name text,
  phone text,
  created_at timestamptz not null default now()
);

create table if not exists public.recruitment_orders (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  company_id uuid references public.workforce_companies(id) on delete set null,
  union_id uuid references public.workforce_unions(id) on delete set null,
  industry text not null,
  quantity integer not null default 1 check (quantity > 0),
  gender_requirement text not null default 'ANY' check (gender_requirement in ('MALE','FEMALE','ANY')),
  salary_jpy integer check (salary_jpy is null or salary_jpy >= 0),
  interview_date date,
  status text not null default 'RECRUITING' check (status in ('RECRUITING','FILLED','CLOSED')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.overseas_workers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  full_name text not null,
  date_of_birth date,
  gender text check (gender is null or gender in ('MALE','FEMALE')),
  hometown text,
  phone text,
  program text not null default 'TECHNICAL_INTERN' check (program in ('TECHNICAL_INTERN','SPECIFIED_SKILLED','ENGINEER')),
  industry text,
  japanese_level text not null default 'NONE' check (japanese_level in ('NONE','N5','N4','N3','JFT_BASIC')),
  status text not null default 'SCREENING' check (status in ('SCREENING','TRAINING','WAITING_INTERVIEW','PASSED','POST_PASS_TRAINING','COE','VISA','WAITING_DEPARTURE','WORKING_ABROAD','RETURNED','FAILED','WITHDRAWN')),
  order_id uuid references public.recruitment_orders(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.worker_documents (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.overseas_workers(id) on delete cascade,
  document_type text not null check (document_type in ('PASSPORT','COE','VISA','JAPANESE_CERTIFICATE','HEALTH_CHECK','CONTRACT')),
  document_number text not null,
  issue_date date,
  expiry_date date,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.worker_status_logs (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.overseas_workers(id) on delete cascade,
  status text not null,
  changed_at timestamptz not null default now(),
  note text,
  changed_by uuid references public.profiles(id) on delete set null
);

create index if not exists overseas_workers_status_idx on public.overseas_workers(status);
create index if not exists overseas_workers_order_idx on public.overseas_workers(order_id);
create index if not exists worker_documents_expiry_idx on public.worker_documents(expiry_date);
create index if not exists worker_status_logs_worker_idx on public.worker_status_logs(worker_id, changed_at desc);

alter table public.workforce_companies enable row level security;
alter table public.workforce_unions enable row level security;
alter table public.recruitment_orders enable row level security;
alter table public.overseas_workers enable row level security;
alter table public.worker_documents enable row level security;
alter table public.worker_status_logs enable row level security;

create policy workforce_companies_admin on public.workforce_companies for all to authenticated using (public.can('users')) with check (public.can('users'));
create policy workforce_unions_admin on public.workforce_unions for all to authenticated using (public.can('users')) with check (public.can('users'));
create policy recruitment_orders_admin on public.recruitment_orders for all to authenticated using (public.can('users')) with check (public.can('users'));
create policy overseas_workers_admin on public.overseas_workers for all to authenticated using (public.can('users')) with check (public.can('users'));
create policy worker_documents_admin on public.worker_documents for all to authenticated using (public.can('users')) with check (public.can('users'));
create policy worker_status_logs_admin on public.worker_status_logs for all to authenticated using (public.can('users')) with check (public.can('users'));

