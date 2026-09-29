-- Đồng bộ luồng Cơ cấu tổ chức và Hồ sơ tài khoản.
-- Hồ sơ chỉ nhận phân công hợp lệ từ cùng một nguồn dữ liệu tổ chức:
-- đơn vị đang hoạt động -> vị trí thuộc đúng đơn vị -> quản lý cùng đơn vị
-- hoặc một đơn vị cấp trên.

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
  if not exists (select 1 from public.profiles where id = target_user and is_active) then
    raise exception 'Nhân sự không tồn tại hoặc đã bị vô hiệu hóa.' using errcode = 'P0002';
  end if;
  if target_user = target_manager then
    raise exception 'Nhân viên không thể là quản lý trực tiếp của chính mình.' using errcode = '23514';
  end if;
  if target_unit is null and (target_position is not null or target_manager is not null) then
    raise exception 'Phải chọn đơn vị trước khi gán vị trí hoặc quản lý trực tiếp.' using errcode = '23514';
  end if;
  if target_unit is not null and not exists (
    select 1 from public.organization_units where id = target_unit and is_active
  ) then
    raise exception 'Đơn vị không tồn tại hoặc đã ngừng hoạt động.' using errcode = '23514';
  end if;

  -- Tuyến quản lý của nhân sự không được tạo vòng lặp.
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
    select unit_id into position_unit
    from public.job_positions
    where id = target_position and is_active;
    if position_unit is null or position_unit is distinct from target_unit then
      raise exception 'Vị trí không thuộc đơn vị đang chọn hoặc đã ngừng hoạt động.' using errcode = '23514';
    end if;
  end if;

  if target_manager is not null and not exists (
    with recursive ancestors as (
      select id, parent_id from public.organization_units where id = target_unit
      union all
      select u.id, u.parent_id
      from public.organization_units u
      join ancestors a on a.parent_id = u.id
    )
    select 1
    from public.profiles manager
    where manager.id = target_manager
      and manager.is_active
      and manager.unit_id in (select id from ancestors)
  ) then
    raise exception 'Quản lý trực tiếp phải thuộc cùng đơn vị hoặc một đơn vị cấp trên.' using errcode = '23514';
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
end;
$$;

revoke all on function public.assign_employee_organization(uuid, text, uuid, uuid, uuid, date, text) from public;
grant execute on function public.assign_employee_organization(uuid, text, uuid, uuid, uuid, date, text) to authenticated;
