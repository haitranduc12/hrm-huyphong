-- ============================================================================
-- Tự động duyệt chấm công đến từ máy chấm công vật lý.
-- ----------------------------------------------------------------------------
-- Quyết định nghiệp vụ: dữ liệu chấm công tới đây chỉ còn lấy từ máy chấm
-- công (vân tay/khuôn mặt), không dùng luồng GPS/tự khai của nhân viên nữa —
-- theo đó màn "Duyệt chấm công" (/admin/attendance) bị bỏ khỏi menu/route.
--
-- NHƯNG: `ingest_attendance_device_events()` (migration 20260926100000) đang
-- ghi `approved_by_lead = false` cho MỌI bản ghi lấy từ máy — bản ghi đó vẫn
-- cần một người vào đúng màn "Duyệt chấm công" bấm duyệt tay thì
-- `payrollData.ts` mới đếm ngày công đó vào lương (`.eq('approved_by_lead',
-- true)`). Bỏ màn duyệt mà không sửa hàm này thì KHÔNG CÒN CÁCH NÀO đặt cờ đó
-- thành true nữa — lương của TẤT CẢ mọi người sẽ vĩnh viễn tính ra ~0 ngày
-- công mà không có lỗi hay cảnh báo nào hiện ra, vì về mặt kỹ thuật câu truy
-- vấn vẫn chạy đúng, chỉ là không còn dữ liệu nào thoả điều kiện.
--
-- Sửa: dữ liệu do CHÍNH máy chấm công ghi (check_in_method = 'DEVICE') coi là
-- đã xác thực đủ tin cậy (đã qua vân tay/khuôn mặt tại máy) — tự động
-- `approved_by_lead = true`, không cần người duyệt tay nữa. Áp dụng cho cả
-- nhánh tạo mới (dòng công đầu tiên trong ngày) lẫn nhánh cập nhật (máy gửi
-- thêm sự kiện check-out sau).
--
-- Toàn bộ phần còn lại của hàm giữ NGUYÊN VẸN so với bản gốc — chỉ đổi đúng 2
-- chỗ liên quan approved_by_lead, không đổi logic ánh xạ nhân viên/gộp giờ.
-- ============================================================================

create or replace function public.ingest_attendance_device_events(
  bridge_token text,
  events jsonb
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  selected_token public.attendance_device_tokens%rowtype;
  selected_device public.attendance_devices%rowtype;
  sync_id uuid;
  received_count integer := 0;
  inserted_count integer := 0;
  processed_count integer := 0;
  unmapped_count integer := 0;
  work_item record;
  existing_attendance public.attendance%rowtype;
  first_punch timestamptz;
  last_punch timestamptz;
  explicit_out timestamptz;
  event_count integer;
  local_date date;
begin
  if bridge_token is null or length(bridge_token) < 20 then
    raise exception 'Khoa bridge khong hop le.' using errcode = '28000';
  end if;
  if jsonb_typeof(events) <> 'array' then
    raise exception 'events phai la JSON array.' using errcode = '22023';
  end if;

  select t.* into selected_token
  from public.attendance_device_tokens t
  join public.attendance_devices d on d.id = t.device_id
  where t.token_hash = encode(digest(bridge_token, 'sha256'), 'hex')
    and t.revoked_at is null
    and (t.expires_at is null or t.expires_at > now())
    and d.is_active
  limit 1;
  if selected_token.id is null then
    raise exception 'Khoa bridge sai, het han hoac da bi thu hoi.' using errcode = '28000';
  end if;
  select * into selected_device from public.attendance_devices where id = selected_token.device_id;

  received_count := jsonb_array_length(events);
  if received_count > 5000 then
    raise exception 'Moi lan dong bo toi da 5000 su kien.' using errcode = '54000';
  end if;
  insert into public.attendance_device_sync_runs(device_id, received_count)
  values (selected_device.id, received_count) returning id into sync_id;

  with payload as (
    select * from jsonb_to_recordset(events) as item(
      external_id text, device_user_id text, punched_at timestamptz,
      punch_type text, verify_mode text, raw_payload jsonb
    )
  ), inserted as (
    insert into public.attendance_device_events(
      device_id, external_id, device_user_id, punched_at, punch_type, verify_mode, raw_payload
    )
    select selected_device.id,
      trim(p.external_id), trim(p.device_user_id), p.punched_at,
      case when upper(coalesce(p.punch_type, 'AUTO')) in ('AUTO','IN','OUT','BREAK_OUT','BREAK_IN')
        then upper(coalesce(p.punch_type, 'AUTO')) else 'AUTO' end,
      nullif(trim(p.verify_mode), ''), coalesce(p.raw_payload, '{}'::jsonb)
    from payload p
    where nullif(trim(p.external_id), '') is not null
      and nullif(trim(p.device_user_id), '') is not null
      and p.punched_at is not null
    on conflict (device_id, external_id) do nothing
    returning id
  ) select count(*) into inserted_count from inserted;

  -- Mapping khai bao uu tien; neu chua co thi thu dung employee_code trung ma tren may.
  update public.attendance_device_events e
  set profile_id = coalesce(m.profile_id, p.id),
      processing_error = case when coalesce(m.profile_id, p.id) is null then 'UNMAPPED_USER' else null end
  from (select e2.id, e2.device_user_id from public.attendance_device_events e2
        where e2.device_id = selected_device.id and e2.processed_at is null) pending
  left join public.attendance_device_mappings m
    on m.device_id = selected_device.id and m.device_user_id = pending.device_user_id
  left join public.profiles p
    on lower(p.employee_code) = lower(pending.device_user_id) and p.is_active
  where e.id = pending.id;

  select count(*) into unmapped_count
  from public.attendance_device_events
  where device_id = selected_device.id and processed_at is null and profile_id is null;

  for work_item in
    select distinct e.profile_id,
      (e.punched_at at time zone selected_device.timezone)::date as work_date
    from public.attendance_device_events e
    where e.device_id = selected_device.id and e.processed_at is null and e.profile_id is not null
  loop
    local_date := work_item.work_date;
    select min(e.punched_at), max(e.punched_at),
      max(e.punched_at) filter (where e.punch_type in ('OUT', 'BREAK_OUT')),
      count(*)
    into first_punch, last_punch, explicit_out, event_count
    from public.attendance_device_events e
    where e.device_id = selected_device.id and e.profile_id = work_item.profile_id
      and (e.punched_at at time zone selected_device.timezone)::date = local_date;

    select * into existing_attendance
    from public.attendance a
    where a.user_id = work_item.profile_id and a.date = local_date
    for update;

    if existing_attendance.id is null then
      insert into public.attendance(
        user_id, date, check_in_time, check_out_time, status, approved_by_lead,
        location_id, check_in_method, anomaly_flags
      ) values (
        work_item.profile_id, local_date, first_punch,
        case when explicit_out is not null then explicit_out
             when event_count >= 2 and last_punch > first_punch then last_punch else null end,
        case when explicit_out is not null or (event_count >= 2 and last_punch > first_punch)
             then 'completed' else 'active' end,
        -- Đã sửa: true — dữ liệu từ máy chấm công không cần duyệt tay nữa.
        true, selected_device.location_id, 'DEVICE', '{}'
      );
    elsif coalesce(existing_attendance.check_in_method, 'DEVICE') = 'DEVICE' then
      update public.attendance
      set check_in_time = least(coalesce(check_in_time, first_punch), first_punch),
          check_out_time = case
            when explicit_out is not null then greatest(coalesce(check_out_time, explicit_out), explicit_out)
            when event_count >= 2 and last_punch > first_punch then greatest(coalesce(check_out_time, last_punch), last_punch)
            else check_out_time end,
          status = case when explicit_out is not null or (event_count >= 2 and last_punch > first_punch)
            then 'completed' else status end,
          location_id = coalesce(location_id, selected_device.location_id),
          check_in_method = 'DEVICE',
          -- Đã sửa: dữ liệu máy cập nhật thêm (vd check-out) cũng tự duyệt.
          approved_by_lead = true
      where id = existing_attendance.id;
    elsif (explicit_out is not null or event_count >= 2) and last_punch > existing_attendance.check_in_time then
      -- Neu nhan vien check-in bang GPS, may vat ly co the bo sung checkout.
      update public.attendance
      set check_out_time = greatest(coalesce(check_out_time, last_punch), last_punch), status = 'completed'
      where id = existing_attendance.id;
    end if;

    update public.attendance_device_events
    set processed_at = now(), processing_error = null
    where device_id = selected_device.id and profile_id = work_item.profile_id
      and (punched_at at time zone selected_device.timezone)::date = local_date
      and processed_at is null;
    get diagnostics processed_count = row_count;
  end loop;

  -- processed_count phai la tong, tinh lai de tranh gia tri cua vong lap cuoi.
  select count(*) into processed_count from public.attendance_device_events
  where device_id = selected_device.id and received_at >= (select started_at from public.attendance_device_sync_runs where id = sync_id)
    and processed_at is not null;

  update public.attendance_device_tokens set last_used_at = now() where id = selected_token.id;
  update public.attendance_devices
  set last_seen_at = now(), last_sync_at = now(),
      last_sync_status = case when unmapped_count > 0 then 'PARTIAL' else 'SUCCESS' end,
      last_sync_message = case when unmapped_count > 0
        then unmapped_count || ' ma nhan vien chua duoc anh xa.' else inserted_count || ' su kien moi.' end,
      updated_at = now()
  where id = selected_device.id;
  update public.attendance_device_sync_runs
  set finished_at = now(), status = case when unmapped_count > 0 then 'PARTIAL' else 'SUCCESS' end,
      inserted_count = ingest_attendance_device_events.inserted_count,
      processed_count = ingest_attendance_device_events.processed_count,
      unmapped_count = ingest_attendance_device_events.unmapped_count,
      message = case when unmapped_count > 0 then 'Co ma nhan vien chua anh xa.' else 'Dong bo thanh cong.' end
  where id = sync_id;

  return jsonb_build_object(
    'sync_id', sync_id, 'received', received_count, 'inserted', inserted_count,
    'processed', processed_count, 'unmapped', unmapped_count,
    'status', case when unmapped_count > 0 then 'PARTIAL' else 'SUCCESS' end
  );
exception when others then
  if sync_id is not null then
    update public.attendance_device_sync_runs
    set finished_at = now(), status = 'ERROR', message = sqlerrm where id = sync_id;
    update public.attendance_devices
    set last_sync_at = now(), last_sync_status = 'ERROR', last_sync_message = sqlerrm, updated_at = now()
    where id = selected_device.id;
  end if;
  raise;
end;
$$;

revoke all on function public.ingest_attendance_device_events(text, jsonb) from public;
grant execute on function public.ingest_attendance_device_events(text, jsonb) to anon, authenticated;

-- Hồi tố: các bản ghi CŨ đã lấy từ máy chấm công (check_in_method = 'DEVICE')
-- trước migration này, đang kẹt ở approved_by_lead = false vì màn duyệt sắp
-- bị xoá — duyệt luôn cho khỏi mất công dữ liệu tháng đã qua.
update public.attendance
set approved_by_lead = true
where check_in_method = 'DEVICE' and approved_by_lead = false;
