-- Vai trò mở rộng cho toàn hệ thống.
-- Cột profiles.role vẫn giữ 4 role kỹ thuật cũ để tương thích; access_role_code
-- là vai trò nghiệp vụ do Admin cấu hình trong phần Cấu hình hệ thống.

create table if not exists public.system_access_roles (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,49}$'),
  name text not null,
  description text,
  permissions text[] not null default '{}',
  is_system boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (permissions <@ array[
    'users','projects','reports','attendance','shifts','leave','training','settings'
  ]::text[])
);

insert into public.system_access_roles(code, name, description, permissions, is_system, sort_order)
values
  ('staff', 'Nhân viên', 'Chỉ sử dụng các chức năng nhân viên được giao.', '{}', true, 10),
  ('teamlead', 'Trưởng nhóm', 'Quản lý nhóm và các nghiệp vụ được phân công.', '{projects,attendance,shifts,leave}', true, 20),
  ('admin', 'Admin', 'Quản trị toàn bộ hệ thống.', '{users,projects,reports,attendance,shifts,leave,training,settings}', true, 1),
  ('ceo', 'CEO', 'Điều hành toàn bộ hệ thống.', '{users,projects,reports,attendance,shifts,leave,training,settings}', true, 2)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  permissions = excluded.permissions,
  is_system = excluded.is_system,
  updated_at = now();

alter table public.profiles add column if not exists access_role_code text;
update public.profiles
set access_role_code = case when role in ('admin','ceo','teamlead','staff') then role else 'staff' end
where access_role_code is null;
alter table public.profiles alter column access_role_code set default 'staff';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_access_role_code_fkey'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_access_role_code_fkey
      foreign key (access_role_code) references public.system_access_roles(code)
      on update cascade on delete set default;
  end if;
end;
$$;

-- Nếu migration đã từng chạy với bản đầu tiên (SET NULL), chuẩn hóa lại để
-- xoá vai trò luôn đưa hồ sơ về mã mặc định `staff`.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'profiles_access_role_code_fkey'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles drop constraint profiles_access_role_code_fkey;
    alter table public.profiles
      add constraint profiles_access_role_code_fkey
      foreign key (access_role_code) references public.system_access_roles(code)
      on update cascade on delete set default;
  end if;
end;
$$;

create index if not exists profiles_access_role_idx on public.profiles(access_role_code);

alter table public.system_access_roles enable row level security;
drop policy if exists system_access_roles_read on public.system_access_roles;
create policy system_access_roles_read on public.system_access_roles for select to authenticated
  using (is_active or public.is_admin());
drop policy if exists system_access_roles_manage on public.system_access_roles;
create policy system_access_roles_manage on public.system_access_roles for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.system_access_roles to authenticated;

-- Quyền hiệu lực = Admin/CEO hoặc quyền riêng tài khoản hoặc quyền của
-- vai trò nghiệp vụ hoặc quyền theo vị trí chức danh hoặc quyền Teamlead cũ.
create or replace function public.can(perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.profiles p
    left join public.system_access_roles ar on ar.code = p.access_role_code and ar.is_active
    where p.id = auth.uid() and p.is_active
      and (
        p.role in ('admin','ceo')
        or perm = any(coalesce(p.permissions, '{}'))
        or perm = any(coalesce(ar.permissions, '{}'))
        or (p.role = 'teamlead' and perm = any(array['projects','attendance','shifts','leave']::text[]))
        or exists (
          select 1 from public.job_position_permissions jpp
          where jpp.position_id = p.position_id and jpp.permission_code = perm
        )
      )
  );
$$;
revoke all on function public.can(text) from public;
grant execute on function public.can(text) to authenticated;

-- Bổ sung access_role_code vào hàng rào chống tự leo thang quyền.
create or replace function public.guard_profile_privilege_changes()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor public.profiles%rowtype;
  changes_access boolean;
  changes_privilege boolean;
begin
  if auth.uid() is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select * into actor from public.profiles where id = auth.uid();
  if actor.id is null or not actor.is_active then
    raise exception 'Tài khoản không còn quyền thao tác.' using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    if actor.role not in ('admin','ceo') then
      raise exception 'Chỉ Admin/CEO được xóa trực tiếp hồ sơ tài khoản.' using errcode = '42501';
    end if;
    if old.id = actor.id then
      raise exception 'Không thể tự xóa tài khoản đang đăng nhập.' using errcode = '42501';
    end if;
    return old;
  end if;

  changes_access := new.role is distinct from old.role
    or new.access_role_code is distinct from old.access_role_code
    or new.permissions is distinct from old.permissions
    or new.is_active is distinct from old.is_active;
  changes_privilege := changes_access
    or new.must_change_password is distinct from old.must_change_password;

  if old.id = actor.id and changes_access then
    raise exception 'Không thể tự thay đổi vai trò, quyền hoặc trạng thái tài khoản.' using errcode = '42501';
  end if;
  if old.id = actor.id then return new; end if;
  if actor.role in ('admin','ceo') then return new; end if;
  if public.can('users') and old.role = 'staff' and not changes_privilege then return new; end if;
  raise exception 'Bạn không có quyền thay đổi tài khoản này.' using errcode = '42501';
end;
$$;

drop trigger if exists profile_privilege_changes_guard on public.profiles;
create trigger profile_privilege_changes_guard
before update or delete on public.profiles
for each row execute function public.guard_profile_privilege_changes();
