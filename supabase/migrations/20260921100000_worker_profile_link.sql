-- ============================================================================
-- Nối hồ sơ người lao động với tài khoản đăng nhập.
-- ----------------------------------------------------------------------------
-- `overseas_workers` trước giờ đứng tách hẳn khỏi `profiles`: không có cột nào
-- cho biết hồ sơ lao động nào là của tài khoản nào. Hệ quả là nhân viên không
-- có cách nào xem hồ sơ và giấy tờ của chính mình — họ phải nhắn cho HR hỏi
-- hộ chiếu mình hết hạn ngày nào.
--
-- Cố tình KHÔNG suy ra liên kết bằng cách so tên hay số điện thoại. Trùng tên
-- là chuyện bình thường ở Việt Nam, mà đoán sai ở đây nghĩa là cho người này
-- xem số hộ chiếu và visa của người khác. Liên kết phải do người có quyền
-- `users` gán tay, một lần, một cách tường minh.
-- ============================================================================

alter table public.overseas_workers
  add column if not exists user_id uuid references public.profiles(id) on delete set null;

-- Một tài khoản chỉ ứng với một hồ sơ lao động. Nếu không chặn, trang cá nhân
-- sẽ phải tự chọn hiển thị hồ sơ nào trong nhiều hồ sơ — và chọn kiểu gì cũng
-- có lúc sai.
create unique index if not exists overseas_workers_user_unique
  on public.overseas_workers(user_id)
  where user_id is not null;

comment on column public.overseas_workers.user_id is
  'Tài khoản đăng nhập tương ứng. Do HR gán tay; NULL nghĩa là người lao động chưa có tài khoản.';

-- ---------------------------------------------------------------------------
-- RLS: thêm quyền ĐỌC hồ sơ của chính mình.
-- ---------------------------------------------------------------------------
-- Các policy hiện có (`*_admin`, dạng FOR ALL) vẫn giữ nguyên. Postgres gộp
-- nhiều permissive policy bằng OR, nên thêm policy SELECT ở đây chỉ mở rộng
-- thêm chứ không nới lỏng quyền ghi: nhân viên đọc được, vẫn không sửa được.

drop policy if exists overseas_workers_read_own on public.overseas_workers;
create policy overseas_workers_read_own on public.overseas_workers
for select to authenticated
using (user_id = auth.uid());

drop policy if exists worker_documents_read_own on public.worker_documents;
create policy worker_documents_read_own on public.worker_documents
for select to authenticated
using (
  exists (
    select 1 from public.overseas_workers w
    where w.id = worker_documents.worker_id
      and w.user_id = auth.uid()
  )
);

drop policy if exists worker_status_logs_read_own on public.worker_status_logs;
create policy worker_status_logs_read_own on public.worker_status_logs
for select to authenticated
using (
  exists (
    select 1 from public.overseas_workers w
    where w.id = worker_status_logs.worker_id
      and w.user_id = auth.uid()
  )
);

create index if not exists worker_documents_worker_idx
  on public.worker_documents(worker_id);
