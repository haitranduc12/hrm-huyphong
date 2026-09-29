-- Chống gian lận chấm công: lưu độ chính xác/thời điểm GPS và phát hiện
-- các lần di chuyển bất khả thi. Tọa độ vẫn được kiểm tra ở database.

alter table public.attendance add column if not exists gps_accuracy_meters numeric(8,2);
alter table public.attendance add column if not exists gps_captured_at timestamptz;

create index if not exists attendance_user_check_in_time_idx
  on public.attendance(user_id, check_in_time desc);

create or replace function public.guard_attendance_geofence()
returns trigger language plpgsql set search_path = public as $$
declare
  enabled boolean := false;
  employee_unit uuid;
  has_unit_assignments boolean := false;
  nearest record;
  previous record;
  max_accuracy numeric;
  travel_seconds numeric;
  travel_distance numeric;
begin
  if new.check_in_time is null then return new; end if;
  if tg_op = 'UPDATE'
    and old.check_in_time is not distinct from new.check_in_time
    and old.check_in_latitude is not distinct from new.check_in_latitude
    and old.check_in_longitude is not distinct from new.check_in_longitude
    and old.gps_accuracy_meters is not distinct from new.gps_accuracy_meters
    and old.gps_captured_at is not distinct from new.gps_captured_at then
    return new;
  end if;

  select coalesce(f.enabled, false) into enabled
  from public.feature_flags f where f.key = 'geofence_attendance';
  if not enabled then
    new.gps_captured_at := coalesce(new.gps_captured_at, now());
    return new;
  end if;

  if new.check_in_latitude is null or new.check_in_longitude is null then
    raise exception 'Cần cấp quyền GPS để chấm công tại địa điểm được phép.' using errcode = '23514';
  end if;
  if new.gps_accuracy_meters is null or new.gps_accuracy_meters <= 0 then
    raise exception 'Không lấy được độ chính xác GPS. Hãy bật Vị trí chính xác rồi thử lại.' using errcode = '23514';
  end if;
  if new.gps_captured_at is null
    or abs(extract(epoch from (now() - new.gps_captured_at))) > 180 then
    raise exception 'Dữ liệu GPS đã cũ. Hãy lấy lại vị trí và Check-in lại.' using errcode = '23514';
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

  max_accuracy := greatest(50::numeric, least(100::numeric, nearest.radius_meters::numeric));
  if new.gps_accuracy_meters > max_accuracy then
    raise exception 'GPS chưa đủ chính xác (±% m). Hãy đứng nơi thoáng hơn hoặc bật Vị trí chính xác rồi thử lại.',
      round(new.gps_accuracy_meters) using errcode = '23514';
  end if;
  if nearest.distance_meters > nearest.radius_meters then
    raise exception 'Bạn đang ở ngoài phạm vi chấm công của địa điểm gần nhất (% cách % m).',
      nearest.name, round(nearest.distance_meters) using errcode = '23514';
  end if;

  -- Gắn cờ nếu một người di chuyển quá xa trong thời gian không thể xảy ra.
  -- Không tự xóa bản ghi; Admin sẽ thấy cờ để xác minh thủ công.
  select a.check_in_time, a.check_in_latitude, a.check_in_longitude
  into previous
  from public.attendance a
  where a.user_id = new.user_id
    and a.check_in_time is not null
    and a.check_in_latitude is not null
    and a.check_in_longitude is not null
    and a.check_in_time < new.check_in_time
  order by a.check_in_time desc
  limit 1;

  if previous.check_in_time is not null then
    travel_seconds := extract(epoch from (new.check_in_time - previous.check_in_time));
    travel_distance := 6371000 * acos(least(1, greatest(-1,
      cos(radians(previous.check_in_latitude::double precision))
      * cos(radians(new.check_in_latitude::double precision))
      * cos(radians(new.check_in_longitude::double precision) - radians(previous.check_in_longitude::double precision))
      + sin(radians(previous.check_in_latitude::double precision))
      * sin(radians(new.check_in_latitude::double precision))
    )));
    if travel_seconds between 0 and 1800 and travel_distance > 10000 then
      new.anomaly_flags := array_append(coalesce(new.anomaly_flags, '{}'), 'IMPOSSIBLE_TRAVEL');
    end if;
  end if;

  new.location_id := nearest.id;
  new.check_in_method := coalesce(new.check_in_method, 'GPS');
  new.gps_captured_at := coalesce(new.gps_captured_at, now());
  new.anomaly_flags := array_remove(coalesce(new.anomaly_flags, '{}'), 'OUT_OF_GEOFENCE');
  return new;
end;
$$;

drop trigger if exists attendance_geofence_guard on public.attendance;
create trigger attendance_geofence_guard
before insert or update of check_in_time, check_in_latitude, check_in_longitude,
  gps_accuracy_meters, gps_captured_at on public.attendance
for each row execute function public.guard_attendance_geofence();
