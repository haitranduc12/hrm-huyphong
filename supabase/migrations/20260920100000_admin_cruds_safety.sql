-- CRUDS an toàn: chỉ xóa vật lý yêu cầu tuyển khi HR có quyền quản lý.
-- UI sẽ chuyển sang CANCELLED/WITHDRAWN khi bản ghi đã có lịch sử nghiệp vụ.

drop policy if exists recruitment_requisitions_delete on public.recruitment_requisitions;
create policy recruitment_requisitions_delete on public.recruitment_requisitions for delete to authenticated
  using (public.can('users'));

grant delete on public.recruitment_requisitions to authenticated;
