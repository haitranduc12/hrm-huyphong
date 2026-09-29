-- Khóa lỗ hổng leo thang quyền trong luồng quản trị tài khoản.
-- Service role của API có auth.uid() = null và được phép thực hiện các thao tác
-- đã kiểm tra ở server; người dùng trực tiếp luôn chịu guard này.

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
    if actor.role not in ('admin', 'ceo') then
      raise exception 'Chỉ Admin/CEO được xóa trực tiếp hồ sơ tài khoản.' using errcode = '42501';
    end if;
    if old.id = actor.id then
      raise exception 'Không thể tự xóa tài khoản đang đăng nhập.' using errcode = '42501';
    end if;
    return old;
  end if;

  changes_access := new.role is distinct from old.role
    or new.permissions is distinct from old.permissions
    or new.is_active is distinct from old.is_active;
  changes_privilege := changes_access
    or new.must_change_password is distinct from old.must_change_password;

  -- Mọi vai trò được tự cập nhật thông tin hồ sơ cá nhân, nhưng không tự đổi
  -- quyền, vai trò, trạng thái hay cờ mật khẩu.
  if old.id = actor.id then
    if changes_access then
      raise exception 'Không thể tự thay đổi vai trò, quyền hoặc trạng thái tài khoản.' using errcode = '42501';
    end if;
    return new;
  end if;

  if actor.role in ('admin', 'ceo') then
    return new;
  end if;

  -- Người được ủy quyền quản lý User chỉ sửa thông tin cơ bản của nhân viên;
  -- việc cấp quyền/vai trò vẫn thuộc Admin/CEO.
  if 'users' = any(coalesce(actor.permissions, '{}')) and old.role = 'staff' and not changes_privilege then
    return new;
  end if;

  raise exception 'Bạn không có quyền thay đổi tài khoản này.' using errcode = '42501';
end;
$$;

drop trigger if exists profile_privilege_changes_guard on public.profiles;
create trigger profile_privilege_changes_guard
before update or delete on public.profiles
for each row execute function public.guard_profile_privilege_changes();
