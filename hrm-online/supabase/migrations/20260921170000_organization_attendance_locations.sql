-- Gán điểm chấm công theo cơ cấu tổ chức.
-- Một địa điểm có thể phục vụ nhiều đơn vị; nếu không gán địa điểm cho
-- đơn vị nào thì địa điểm đó vẫn dùng chung (tương thích dữ liệu cũ).

create table if not exists public.organization_unit_work_locations (
  unit_id uuid not null references public.organization_units(id) on delete cascade,
  location_id uuid not null references public.work_locations(id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (unit_id, location_id)
);

create index if not exists organization_unit_work_locations_location_idx
  on public.organization_unit_work_locations(location_id);

alter table public.organization_unit_work_locations enable row level security;

drop policy if exists organization_unit_work_locations_read on public.organization_unit_work_locations;
create policy organization_unit_work_locations_read
  on public.organization_unit_work_locations for select to authenticated
  using (true);

drop policy if exists organization_unit_work_locations_manage on public.organization_unit_work_locations;
create policy organization_unit_work_locations_manage
  on public.organization_unit_work_locations for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.organization_unit_work_locations to authenticated;

-- GPS được kiểm tra theo đơn vị của nhân viên. Nếu đơn vị (hoặc đơn vị cha)
-- đã có cấu hình điểm chấm công, chỉ các điểm đó mới hợp lệ. Nếu chưa có cấu
-- hình, hệ thống tạm thời dùng toàn bộ điểm đang hoạt động để không làm gián
-- đoạn dữ liệu cũ; Admin có thể thu hẹp phạm vi bất cứ lúc nào.
create or replace function public.guard_attendance_geofence()
returns trigger language plpgsql set search_path = public as $$
declare
  enabled boolean := false;
  employee_unit uuid;
  has_unit_assignments boolean := false;
  nearest record;
begin
  if tg_op <> 'INSERT' or new.check_in_time is null then return new; end if;

  select coalesce(f.enabled, false) into enabled
  from public.feature_flags f where f.key = 'geofence_attendance';
  if not enabled then return new; end if;

  if new.check_in_latitude is null or new.check_in_longitude is null then
    raise exception 'Cần cấp quyền GPS để chấm công tại địa điểm được phép.' using errcode = '23514';
  end if;

  select p.unit_id into employee_unit
  from public.profiles p where p.id = new.user_id;

  if employee_unit is not null then
    with recursive unit_tree(id) as (
      select employee_unit
      union all
      select ou.parent_id
      from public.organization_units ou
      join unit_tree t on t.id = ou.id
      where ou.parent_id is not null
    )
    select exists (
      select 1
      from public.organization_unit_work_locations m
      join unit_tree t on t.id = m.unit_id
    ) into has_unit_assignments;
  end if;

  with recursive unit_tree(id) as (
    select employee_unit
    where employee_unit is not null
    union all
    select ou.parent_id
    from public.organization_units ou
    join unit_tree t on t.id = ou.id
    where ou.parent_id is not null
  )
  select l.id, l.name, l.radius_meters,
    6371000 * acos(least(1, greatest(-1,
      cos(radians(new.check_in_latitude::double precision))
      * cos(radians(l.latitude::double precision))
      * cos(radians(l.longitude::double precision) - radians(new.check_in_longitude::double precision))
      + sin(radians(new.check_in_latitude::double precision))
      * sin(radians(l.latitude::double precision))
    ))) as distance_meters
  into nearest
  from public.work_locations l
  where l.is_active and l.latitude is not null and l.longitude is not null
    and (
      not has_unit_assignments
      or exists (
        select 1
        from public.organization_unit_work_locations m
        join unit_tree t on t.id = m.unit_id
        where m.location_id = l.id
      )
    )
  order by distance_meters
  limit 1;

  if nearest.id is null then
    if has_unit_assignments then
      raise exception 'Đơn vị của bạn chưa có điểm chấm công GPS đang hoạt động.' using errcode = '23514';
    end if;
    raise exception 'Chưa có địa điểm GPS hoạt động. Quản trị viên cần cấu hình trước khi chấm công.' using errcode = '23514';
  end if;
  if nearest.distance_meters > nearest.radius_meters then
    raise exception 'Bạn đang ở ngoài phạm vi chấm công của địa điểm gần nhất (% cách % m).',
      nearest.name, round(nearest.distance_meters) using errcode = '23514';
  end if;

  new.location_id := nearest.id;
  new.check_in_method := coalesce(new.check_in_method, 'GPS');
  new.anomaly_flags := array_remove(coalesce(new.anomaly_flags, '{}'), 'OUT_OF_GEOFENCE');
  return new;
end;
$$;

drop trigger if exists attendance_geofence_guard on public.attendance;
create trigger attendance_geofence_guard
before insert on public.attendance
for each row execute function public.guard_attendance_geofence();

