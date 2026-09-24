-- Hồ sơ lương theo nhân sự. Admin/CEO quản lý; nhân viên chỉ đọc dòng của mình.

create table if not exists public.salary_profiles (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  base_salary numeric(15, 2) not null default 0 check (base_salary >= 0),
  allowance numeric(15, 2) not null default 0 check (allowance >= 0),
  note text,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists salary_profiles_updated_by_idx
  on public.salary_profiles(updated_by);

create or replace function public.touch_salary_profiles_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists salary_profiles_touch_updated_at on public.salary_profiles;
create trigger salary_profiles_touch_updated_at
before update on public.salary_profiles
for each row execute function public.touch_salary_profiles_updated_at();

alter table public.salary_profiles enable row level security;

drop policy if exists salary_profiles_read on public.salary_profiles;
create policy salary_profiles_read
on public.salary_profiles
for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists salary_profiles_manage on public.salary_profiles;
create policy salary_profiles_manage
on public.salary_profiles
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

grant select, insert, update, delete on public.salary_profiles to authenticated;

