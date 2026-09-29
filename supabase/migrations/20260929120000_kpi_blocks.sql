-- ============================================================================
-- Khối nghiệp vụ của bộ KPI trở thành danh mục tự khai.
-- ----------------------------------------------------------------------------
-- `kpi_position_templates.block_code` đang bị khoá bằng CHECK chỉ nhận đúng
-- hai giá trị: 'VAN_PHONG' và 'KINH_DOANH'. Công ty có thêm khối Kho, Sản
-- xuất hay Xuất khẩu lao động thì phải sửa constraint và deploy lại — đúng
-- kiểu ràng buộc chặn người dùng mà không mang lại gì.
--
-- Chuyển thành bảng danh mục: admin tự thêm khối, và khoá ngoại vẫn giữ được
-- tính toàn vẹn (không gõ bừa một mã khối không tồn tại).
-- ============================================================================

create table if not exists public.kpi_blocks (
  code text primary key check (code ~ '^[A-Z][A-Z0-9_]*$'),
  name text not null,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.kpi_blocks is
  'Khối nghiệp vụ dùng để nhóm các bộ KPI. Admin tự khai, không khoá cứng trong code.';

-- Hai khối đang dùng, giữ nguyên mã để các mẫu hiện có không lỡ khoá ngoại.
insert into public.kpi_blocks(code, name, sort_order) values
  ('VAN_PHONG', 'Văn phòng', 10),
  ('KINH_DOANH', 'Kinh doanh', 20)
on conflict (code) do nothing;

-- Mã khối nào đang được mẫu dùng mà chưa có trong danh mục thì thêm nốt, nếu
-- không lệnh thêm khoá ngoại bên dưới sẽ hỏng. Tên tạm lấy chính mã, admin đổi
-- lại sau — thà có một dòng tên xấu còn hơn migration chạy dở dang.
insert into public.kpi_blocks(code, name, sort_order)
select distinct t.block_code, t.block_code, 900
from public.kpi_position_templates t
where t.block_code is not null
  and not exists (select 1 from public.kpi_blocks b where b.code = t.block_code)
on conflict (code) do nothing;

-- Bỏ CHECK cứng, thay bằng khoá ngoại.
alter table public.kpi_position_templates
  drop constraint if exists kpi_position_templates_block_code_check;

alter table public.kpi_position_templates
  drop constraint if exists kpi_position_templates_block_fk;
alter table public.kpi_position_templates
  add constraint kpi_position_templates_block_fk
  foreign key (block_code) references public.kpi_blocks(code)
  on update cascade on delete restrict;

comment on column public.kpi_position_templates.block_code is
  'Khối nghiệp vụ, tham chiếu kpi_blocks. Đổi mã khối sẽ lan xuống đây nhờ ON UPDATE CASCADE.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Đọc mở cho người đăng nhập: màn KPI cần hiện tên khối. Ghi chỉ Admin/CEO,
-- cùng ranh giới với các danh mục cấu hình khác.
alter table public.kpi_blocks enable row level security;

drop policy if exists kpi_blocks_read on public.kpi_blocks;
create policy kpi_blocks_read on public.kpi_blocks
for select to authenticated using (true);

drop policy if exists kpi_blocks_manage on public.kpi_blocks;
create policy kpi_blocks_manage on public.kpi_blocks
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.kpi_blocks to authenticated;
