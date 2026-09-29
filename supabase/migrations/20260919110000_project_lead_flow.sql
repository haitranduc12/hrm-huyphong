-- Đồng bộ người phụ trách dự án với thành viên có vai trò lead.
-- Khép kín luồng: tạo/chọn trưởng nhóm → quyền dự án → giao việc/duyệt nhóm.

create or replace function public.sync_project_lead_membership()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.lead_id is not null and not exists (
    select 1 from public.profiles where id = new.lead_id and is_active
  ) then
    raise exception 'Trưởng nhóm dự án không tồn tại hoặc đã ngừng hoạt động.' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and old.lead_id is not null and old.lead_id is distinct from new.lead_id then
    update public.project_members
    set role = 'member', role_code = 'member'
    where project_id = new.id and user_id = old.lead_id and coalesce(role_code, role) = 'lead';
  end if;

  if new.lead_id is not null then
    insert into public.project_members(project_id, user_id, role, role_code)
    values (new.id, new.lead_id, 'lead', 'lead')
    on conflict (project_id, user_id) do update
      set role = 'lead', role_code = 'lead';
  end if;
  return new;
end;
$$;

drop trigger if exists project_lead_membership_sync on public.projects;
create trigger project_lead_membership_sync
after insert or update of lead_id on public.projects
for each row execute function public.sync_project_lead_membership();

-- Sửa dữ liệu lịch sử: mọi lead_id hiện có phải có membership tương ứng.
insert into public.project_members(project_id, user_id, role, role_code)
select p.id, p.lead_id, 'lead', 'lead'
from public.projects p
join public.profiles u on u.id = p.lead_id and u.is_active
where p.lead_id is not null
on conflict (project_id, user_id) do update
  set role = 'lead', role_code = 'lead';
