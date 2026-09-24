-- Mẫu quyền theo vị trí/chức danh.
-- profiles.permissions vẫn được giữ làm quyền ngoại lệ cho từng tài khoản;
-- quyền của vị trí là lớp mặc định, tự áp dụng khi nhân sự được gán vị trí.

create table if not exists public.job_position_permissions (
  position_id uuid not null references public.job_positions(id) on delete cascade,
  permission_code text not null check (permission_code = any(array[
    'users','projects','reports','attendance','shifts','leave','training','settings'
  ]::text[])),
  created_at timestamptz not null default now(),
  primary key (position_id, permission_code)
);

create index if not exists job_position_permissions_code_idx
  on public.job_position_permissions(permission_code);

alter table public.job_position_permissions enable row level security;

drop policy if exists job_position_permissions_read on public.job_position_permissions;
create policy job_position_permissions_read
  on public.job_position_permissions for select to authenticated
  using (
    public.is_admin()
    or position_id = (select p.position_id from public.profiles p where p.id = auth.uid())
  );

drop policy if exists job_position_permissions_manage on public.job_position_permissions;
create policy job_position_permissions_manage
  on public.job_position_permissions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.job_position_permissions to authenticated;

-- Mở rộng điểm kiểm tra quyền chung để mọi RLS/policy hiện hữu hiểu quyền
-- theo vị trí. Admin/CEO vẫn toàn quyền; teamlead vẫn giữ quyền vận hành cũ.
-- Giữ nguyên tên tham số `perm` của hàm can(text) đang có trong hệ thống.
-- PostgreSQL không cho CREATE OR REPLACE đổi tên tham số đầu vào.
create or replace function public.can(perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.is_active
      and (
        p.role in ('admin', 'ceo')
        or perm = any(coalesce(p.permissions, '{}'))
        or (p.role = 'teamlead' and perm = any(array['projects','attendance','shifts','leave']::text[]))
        or exists (
          select 1
          from public.job_position_permissions jpp
          where jpp.position_id = p.position_id
            and jpp.permission_code = perm
        )
      )
  );
$$;

revoke all on function public.can(text) from public;
grant execute on function public.can(text) to authenticated;
