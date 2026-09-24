-- Phân quyền chức năng linh hoạt theo vai trò nghiệp vụ và vị trí tổ chức.
-- Admin/CEO vẫn có toàn quyền ngầm định; các vai trò khác chỉ nhận đúng
-- chức năng được cấp, không cần nâng role kỹ thuật thành admin.

-- Migration này chạy sau các migration lõi, đặc biệt là
-- `20260921130000_payroll_settings.sql`. Kiểm tra trước để khi chạy nhầm thứ
-- tự, Supabase trả về hướng dẫn rõ ràng thay vì lỗi mơ hồ ở cuối file.
do $$
begin
  if to_regclass('public.payroll_settings') is null then
    raise exception 'Thiếu migration 20260921130000_payroll_settings.sql. Hãy chạy migration này trước rồi chạy lại 20260922100000_flexible_function_permissions.sql.';
  end if;
end;
$$;

create table if not exists public.system_function_catalog (
  code text primary key check (code ~ '^admin\.[a-z0-9_]+$'),
  name text not null,
  description text not null default '',
  module_code text not null check (module_code in ('users','projects','reports','attendance','shifts','leave','training','settings')),
  route text not null unique,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.system_function_catalog(code, name, description, module_code, route, sort_order) values
  ('admin.overview', 'Tổng quan điều hành', 'Xem toàn cảnh nhân sự và các cảnh báo cần xử lý.', 'reports', '/admin/overview', 10),
  ('admin.employee_lifecycle', 'Hội nhập & nghỉ việc', 'Quản lý checklist onboarding, offboarding và người hướng dẫn.', 'users', '/admin/employee-lifecycle', 20),
  ('admin.recruitment_orders', 'Đơn hàng cung ứng', 'Quản lý chỉ tiêu và tiến độ cung ứng lao động.', 'users', '/admin/recruitment-orders', 30),
  ('admin.workforce_partners', 'Đối tác tuyển dụng', 'Quản lý doanh nghiệp tiếp nhận, nghiệp đoàn và đơn vị liên kết.', 'users', '/admin/workforce-partners', 40),
  ('admin.workforce', 'Hồ sơ người lao động', 'Quản lý hồ sơ và tiến trình tuyển chọn người lao động.', 'users', '/admin/workforce', 50),
  ('admin.worker_documents', 'Hồ sơ giấy tờ lao động', 'Theo dõi hợp đồng, visa và tài liệu lao động.', 'users', '/admin/worker-documents', 60),
  ('admin.attendance_settings', 'Thiết lập công & chấm công', 'Thiết lập giờ chuẩn, hạn mức nghỉ và quy tắc thời gian.', 'attendance', '/admin/attendance-settings', 70),
  ('admin.timesheet_lock', 'Khóa/mở kỳ bảng công', 'Mở kỳ duyệt, khóa kỳ và chốt dữ liệu bảng công.', 'attendance', '/admin/timesheet', 75),
  ('admin.work_locations', 'Điểm chấm công', 'Quản lý địa điểm GPS, bán kính và Wi-Fi chấm công.', 'settings', '/admin/work-locations', 80),
  ('admin.payroll', 'Bảng lương', 'Tính, duyệt và khóa bảng lương.', 'attendance', '/admin/payroll', 90),
  ('admin.performance_manage', 'Quản lý KPI & đánh giá', 'Tạo chu kỳ, mục tiêu và kết quả hiệu suất.', 'reports', '/admin/performance', 100),
  ('admin.feature_flags', 'Tính năng thử nghiệm', 'Bật hoặc tắt an toàn các chức năng mới.', 'settings', '/admin/feature-flags', 110),
  ('admin.audit', 'Nhật ký hệ thống', 'Truy vết thay đổi dữ liệu và thao tác quản trị.', 'settings', '/admin/audit', 120)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  module_code = excluded.module_code,
  route = excluded.route,
  sort_order = excluded.sort_order,
  is_active = true;

create table if not exists public.system_access_role_functions (
  access_role_code text not null references public.system_access_roles(code) on delete cascade,
  function_code text not null references public.system_function_catalog(code) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (access_role_code, function_code)
);

create table if not exists public.job_position_function_permissions (
  position_id uuid not null references public.job_positions(id) on delete cascade,
  function_code text not null references public.system_function_catalog(code) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (position_id, function_code)
);

alter table public.system_function_catalog enable row level security;
alter table public.system_access_role_functions enable row level security;
alter table public.job_position_function_permissions enable row level security;

drop policy if exists system_function_catalog_read on public.system_function_catalog;
create policy system_function_catalog_read on public.system_function_catalog for select to authenticated
  using (is_active or public.is_admin());
drop policy if exists system_function_catalog_manage on public.system_function_catalog;
create policy system_function_catalog_manage on public.system_function_catalog for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists system_access_role_functions_read on public.system_access_role_functions;
create policy system_access_role_functions_read on public.system_access_role_functions for select to authenticated
  using (public.is_admin() or access_role_code = coalesce((select access_role_code from public.profiles where id = auth.uid()), ''));
drop policy if exists system_access_role_functions_manage on public.system_access_role_functions;
create policy system_access_role_functions_manage on public.system_access_role_functions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists job_position_function_permissions_read on public.job_position_function_permissions;
create policy job_position_function_permissions_read on public.job_position_function_permissions for select to authenticated
  using (
    public.is_admin()
    or position_id = (select position_id from public.profiles where id = auth.uid())
  );
drop policy if exists job_position_function_permissions_manage on public.job_position_function_permissions;
create policy job_position_function_permissions_manage on public.job_position_function_permissions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant select on public.system_function_catalog to authenticated;
grant select, insert, update, delete on public.system_access_role_functions to authenticated;
grant select, insert, update, delete on public.job_position_function_permissions to authenticated;

create or replace function public.can_function(target_function text)
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
        or exists (
          select 1
          from public.system_access_role_functions rf
          join public.system_access_roles ar on ar.code = rf.access_role_code and ar.is_active
          where rf.access_role_code = p.access_role_code
            and rf.function_code = target_function
        )
        or exists (
          select 1
          from public.job_position_function_permissions pf
          where pf.position_id = p.position_id
            and pf.function_code = target_function
        )
      )
  );
$$;

revoke all on function public.can_function(text) from public;
grant execute on function public.can_function(text) to authenticated;

-- Các policy nhạy cảm vẫn giữ quyền module cũ nhưng cho phép cấp chức năng
-- riêng. Các policy này chỉ có hiệu lực sau khi migration được chạy.
drop policy if exists workforce_companies_admin on public.workforce_companies;
create policy workforce_companies_admin on public.workforce_companies for all to authenticated
  using (public.can_function('admin.workforce_partners')) with check (public.can_function('admin.workforce_partners'));
drop policy if exists workforce_unions_admin on public.workforce_unions;
create policy workforce_unions_admin on public.workforce_unions for all to authenticated
  using (public.can_function('admin.workforce_partners')) with check (public.can_function('admin.workforce_partners'));
drop policy if exists recruitment_orders_admin on public.recruitment_orders;
create policy recruitment_orders_admin on public.recruitment_orders for all to authenticated
  using (public.can_function('admin.recruitment_orders')) with check (public.can_function('admin.recruitment_orders'));
drop policy if exists overseas_workers_admin on public.overseas_workers;
create policy overseas_workers_admin on public.overseas_workers for all to authenticated
  using (public.can_function('admin.workforce')) with check (public.can_function('admin.workforce'));
drop policy if exists worker_documents_admin on public.worker_documents;
create policy worker_documents_admin on public.worker_documents for all to authenticated
  using (public.can_function('admin.worker_documents')) with check (public.can_function('admin.worker_documents'));
drop policy if exists worker_status_logs_admin on public.worker_status_logs;
create policy worker_status_logs_admin on public.worker_status_logs for all to authenticated
  using (public.can_function('admin.workforce')) with check (public.can_function('admin.workforce'));

drop policy if exists work_locations_manage on public.work_locations;
create policy work_locations_manage on public.work_locations for all to authenticated
  using (public.can_function('admin.work_locations')) with check (public.can_function('admin.work_locations'));
drop policy if exists organization_unit_work_locations_manage on public.organization_unit_work_locations;
create policy organization_unit_work_locations_manage on public.organization_unit_work_locations for all to authenticated
  using (public.can_function('admin.work_locations')) with check (public.can_function('admin.work_locations'));

drop policy if exists lifecycle_manage on public.employee_lifecycle_processes;
create policy lifecycle_manage on public.employee_lifecycle_processes for all to authenticated
  using (public.can_function('admin.employee_lifecycle')) with check (public.can_function('admin.employee_lifecycle'));
drop policy if exists lifecycle_read on public.employee_lifecycle_processes;
create policy lifecycle_read on public.employee_lifecycle_processes for select to authenticated
  using (user_id = auth.uid() or mentor_id = auth.uid() or public.can_function('admin.employee_lifecycle'));
drop policy if exists checklist_manage on public.employee_checklist_items;
create policy checklist_manage on public.employee_checklist_items for all to authenticated
  using (owner_id = auth.uid() or public.can_function('admin.employee_lifecycle'))
  with check (owner_id = auth.uid() or public.can_function('admin.employee_lifecycle'));
drop policy if exists checklist_read on public.employee_checklist_items;
create policy checklist_read on public.employee_checklist_items for select to authenticated using (
  exists (select 1 from public.employee_lifecycle_processes p where p.id = process_id and
    (p.user_id = auth.uid() or p.mentor_id = auth.uid() or public.can_function('admin.employee_lifecycle')))
);
drop policy if exists cycles_manage on public.performance_cycles;
create policy cycles_manage on public.performance_cycles for all to authenticated
  using (public.can_function('admin.performance_manage')) with check (public.can_function('admin.performance_manage'));
drop policy if exists cycles_read on public.performance_cycles;
create policy cycles_read on public.performance_cycles for select to authenticated
  using (status <> 'DRAFT' or public.can_function('admin.performance_manage'));
drop policy if exists goals_manage on public.performance_goals;
create policy goals_manage on public.performance_goals for all to authenticated
  using (public.can_function('admin.performance_manage')) with check (public.can_function('admin.performance_manage'));
drop policy if exists goals_read on public.performance_goals;
create policy goals_read on public.performance_goals for select to authenticated
  using (user_id = auth.uid() or public.can_function('admin.performance_manage'));
-- Nhân viên được cập nhật tiến độ mục tiêu của chính mình; quyền quản trị vẫn
-- được kiểm soát riêng bởi admin.performance_manage ở policy goals_manage.
drop policy if exists goals_self_update on public.performance_goals;
create policy goals_self_update on public.performance_goals for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
drop policy if exists flags_manage on public.feature_flags;
create policy flags_manage on public.feature_flags for all to authenticated
  using (public.can_function('admin.feature_flags')) with check (public.can_function('admin.feature_flags'));

drop policy if exists audit_logs_select_admin on public.audit_logs;
create policy audit_logs_select_admin on public.audit_logs for select to authenticated
  using (public.can_function('admin.audit'));

drop policy if exists payroll_components_read on public.payroll_components;
create policy payroll_components_read on public.payroll_components for select to authenticated using (public.can_function('admin.payroll'));
drop policy if exists payroll_components_manage on public.payroll_components;
create policy payroll_components_manage on public.payroll_components for all to authenticated using (public.can_function('admin.payroll')) with check (public.can_function('admin.payroll'));
drop policy if exists employee_pay_profiles_manage on public.employee_pay_profiles;
create policy employee_pay_profiles_manage on public.employee_pay_profiles for all to authenticated using (public.can_function('admin.payroll')) with check (public.can_function('admin.payroll'));
drop policy if exists employee_pay_profiles_read on public.employee_pay_profiles;
create policy employee_pay_profiles_read on public.employee_pay_profiles for select to authenticated using (user_id = auth.uid() or public.can_function('admin.payroll'));
drop policy if exists employee_pay_items_manage on public.employee_pay_items;
create policy employee_pay_items_manage on public.employee_pay_items for all to authenticated using (public.can_function('admin.payroll')) with check (public.can_function('admin.payroll'));
drop policy if exists employee_pay_items_read on public.employee_pay_items;
create policy employee_pay_items_read on public.employee_pay_items for select to authenticated using (user_id = auth.uid() or public.can_function('admin.payroll'));
drop policy if exists payroll_inputs_manage on public.payroll_inputs;
create policy payroll_inputs_manage on public.payroll_inputs for all to authenticated using (public.can_function('admin.payroll')) with check (public.can_function('admin.payroll'));
drop policy if exists payroll_inputs_read on public.payroll_inputs;
create policy payroll_inputs_read on public.payroll_inputs for select to authenticated using (user_id = auth.uid() or public.can_function('admin.payroll'));
drop policy if exists payroll_runs_read on public.payroll_runs;
create policy payroll_runs_read on public.payroll_runs for select to authenticated using (public.can_function('admin.payroll'));
drop policy if exists payroll_runs_manage on public.payroll_runs;
create policy payroll_runs_manage on public.payroll_runs for all to authenticated using (public.can_function('admin.payroll')) with check (public.can_function('admin.payroll'));
drop policy if exists payslips_manage on public.payslips;
create policy payslips_manage on public.payslips for all to authenticated using (public.can_function('admin.payroll')) with check (public.can_function('admin.payroll'));
drop policy if exists payslips_read on public.payslips;
create policy payslips_read on public.payslips for select to authenticated using (
  public.can_function('admin.payroll')
  or (user_id = auth.uid() and exists (select 1 from public.payroll_runs r where r.id = payslips.run_id and r.status in ('APPROVED', 'PAID')))
);
drop policy if exists payslip_lines_manage on public.payslip_lines;
create policy payslip_lines_manage on public.payslip_lines for all to authenticated using (public.can_function('admin.payroll')) with check (public.can_function('admin.payroll'));
drop policy if exists payslip_lines_read on public.payslip_lines;
create policy payslip_lines_read on public.payslip_lines for select to authenticated using (
  exists (
    select 1 from public.payslips s join public.payroll_runs r on r.id = s.run_id
    where s.id = payslip_lines.payslip_id
      and (public.can_function('admin.payroll') or (s.user_id = auth.uid() and r.status in ('APPROVED', 'PAID')))
  )
);
drop policy if exists payroll_settings_manage on public.payroll_settings;
create policy payroll_settings_manage on public.payroll_settings for all to authenticated
  using (public.can_function('admin.payroll')) with check (public.can_function('admin.payroll'));

drop policy if exists app_settings_manage on public.app_settings;
create policy app_settings_manage on public.app_settings for all to authenticated
  using (public.can('settings') or public.can_function('admin.attendance_settings'))
  with check (public.can('settings') or public.can_function('admin.attendance_settings'));

drop policy if exists timesheet_periods_manage on public.timesheet_periods;
create policy timesheet_periods_manage on public.timesheet_periods for all to authenticated
  using (public.can_function('admin.timesheet_lock')) with check (public.can_function('admin.timesheet_lock'));
