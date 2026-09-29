-- P0 theo quy trình khách hàng: cơ cấu đa đơn vị, vị trí và tuyến báo cáo.
-- Không seed tên pháp nhân cụ thể vì Q-01/Q-02 vẫn cần khách hàng xác nhận.

create table if not exists public.organization_units (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  unit_type text not null check (unit_type in ('group', 'company', 'branch', 'department', 'team')),
  parent_id uuid references public.organization_units(id) on delete restrict,
  manager_id uuid references public.profiles(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_unit_not_own_parent check (parent_id is null or parent_id <> id)
);

create index if not exists organization_units_parent_idx on public.organization_units(parent_id);
create index if not exists organization_units_manager_idx on public.organization_units(manager_id);

create table if not exists public.job_positions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null,
  unit_id uuid not null references public.organization_units(id) on delete restrict,
  reports_to_position_id uuid references public.job_positions(id) on delete set null,
  is_manager boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_position_not_own_parent check (reports_to_position_id is null or reports_to_position_id <> id)
);

create index if not exists job_positions_unit_idx on public.job_positions(unit_id);

alter table public.profiles add column if not exists employee_code text;
alter table public.profiles add column if not exists unit_id uuid references public.organization_units(id) on delete set null;
alter table public.profiles add column if not exists position_id uuid references public.job_positions(id) on delete set null;
alter table public.profiles add column if not exists manager_id uuid references public.profiles(id) on delete set null;
alter table public.profiles add column if not exists hire_date date;
alter table public.profiles add column if not exists employment_status text not null default 'active'
  check (employment_status in ('onboarding', 'probation', 'active', 'suspended', 'terminated'));

create unique index if not exists profiles_employee_code_unique
  on public.profiles(lower(employee_code)) where employee_code is not null;
create index if not exists profiles_unit_idx on public.profiles(unit_id);
create index if not exists profiles_position_idx on public.profiles(position_id);
create index if not exists profiles_manager_idx on public.profiles(manager_id);

-- Giữ dữ liệu phòng ban chuỗi cũ: tạo đơn vị tương ứng rồi liên kết hồ sơ.
insert into public.organization_units(code, name, unit_type)
select 'DEPT-' || upper(substr(md5(trim(department)), 1, 8)), trim(department), 'department'
from public.profiles
where nullif(trim(department), '') is not null
group by trim(department)
on conflict (code) do nothing;

update public.profiles p
set unit_id = u.id
from public.organization_units u
where p.unit_id is null
  and nullif(trim(p.department), '') is not null
  and u.name = trim(p.department)
  and u.unit_type = 'department';

create or replace function public.guard_organization_hierarchy()
returns trigger language plpgsql set search_path = public as $$
declare cursor_id uuid;
begin
  cursor_id := new.parent_id;
  while cursor_id is not null loop
    if cursor_id = new.id then
      raise exception 'Cơ cấu tổ chức không được tạo vòng lặp.' using errcode = '23514';
    end if;
    select parent_id into cursor_id from public.organization_units where id = cursor_id;
  end loop;
  return new;
end;
$$;

drop trigger if exists organization_hierarchy_guard on public.organization_units;
create trigger organization_hierarchy_guard
before insert or update of parent_id on public.organization_units
for each row execute function public.guard_organization_hierarchy();

create or replace function public.guard_position_hierarchy()
returns trigger language plpgsql set search_path = public as $$
declare cursor_id uuid;
begin
  cursor_id := new.reports_to_position_id;
  while cursor_id is not null loop
    if cursor_id = new.id then
      raise exception 'Tuyến báo cáo của vị trí không được tạo vòng lặp.' using errcode = '23514';
    end if;
    select reports_to_position_id into cursor_id from public.job_positions where id = cursor_id;
  end loop;
  return new;
end;
$$;

drop trigger if exists position_hierarchy_guard on public.job_positions;
create trigger position_hierarchy_guard
before insert or update of reports_to_position_id on public.job_positions
for each row execute function public.guard_position_hierarchy();

alter table public.organization_units enable row level security;
alter table public.job_positions enable row level security;

drop policy if exists organization_units_read on public.organization_units;
create policy organization_units_read on public.organization_units for select to authenticated
  using (is_active or public.can('users'));
drop policy if exists organization_units_manage on public.organization_units;
create policy organization_units_manage on public.organization_units for all to authenticated
  using (public.can('users')) with check (public.can('users'));

drop policy if exists job_positions_read on public.job_positions;
create policy job_positions_read on public.job_positions for select to authenticated
  using (is_active or public.can('users'));
drop policy if exists job_positions_manage on public.job_positions;
create policy job_positions_manage on public.job_positions for all to authenticated
  using (public.can('users')) with check (public.can('users'));

grant select, insert, update, delete on public.organization_units to authenticated;
grant select, insert, update, delete on public.job_positions to authenticated;

-- RPC chỉ cho phép thay đổi dữ liệu tổ chức, không mở quyền sửa role/quyền hệ thống.
create or replace function public.assign_employee_organization(
  target_user uuid,
  target_employee_code text,
  target_unit uuid,
  target_position uuid,
  target_manager uuid,
  target_hire_date date,
  target_employment_status text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  position_unit uuid;
  cursor_id uuid;
begin
  if not public.can('users') then
    raise exception 'Không có quyền cập nhật cơ cấu nhân sự.' using errcode = '42501';
  end if;
  if target_user = target_manager then
    raise exception 'Nhân viên không thể là quản lý trực tiếp của chính mình.' using errcode = '23514';
  end if;
  cursor_id := target_manager;
  while cursor_id is not null loop
    if cursor_id = target_user then
      raise exception 'Tuyến quản lý trực tiếp không được tạo vòng lặp.' using errcode = '23514';
    end if;
    select manager_id into cursor_id from public.profiles where id = cursor_id;
  end loop;
  if target_employment_status not in ('onboarding', 'probation', 'active', 'suspended', 'terminated') then
    raise exception 'Trạng thái nhân sự không hợp lệ.' using errcode = '23514';
  end if;
  if target_position is not null then
    select unit_id into position_unit from public.job_positions where id = target_position and is_active;
    if position_unit is null or position_unit is distinct from target_unit then
      raise exception 'Vị trí không thuộc đơn vị đã chọn.' using errcode = '23514';
    end if;
  end if;
  if target_manager is not null and not exists (
    select 1 from public.profiles where id = target_manager and is_active
  ) then
    raise exception 'Quản lý trực tiếp không tồn tại hoặc đã ngừng hoạt động.' using errcode = '23514';
  end if;

  update public.profiles
  set employee_code = nullif(trim(target_employee_code), ''),
      unit_id = target_unit,
      position_id = target_position,
      manager_id = target_manager,
      hire_date = target_hire_date,
      employment_status = target_employment_status,
      department = (select name from public.organization_units where id = target_unit),
      updated_at = now()
  where id = target_user;

  if not found then
    raise exception 'Không tìm thấy nhân sự cần phân công.' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.assign_employee_organization(uuid, text, uuid, uuid, uuid, date, text) from public;
grant execute on function public.assign_employee_organization(uuid, text, uuid, uuid, uuid, date, text) to authenticated;
