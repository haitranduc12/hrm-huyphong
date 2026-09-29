-- ============================================================================
-- KPI theo mẫu vị trí (rubric nhiều tiêu chí, có trọng số) — Giai đoạn 6 BRD.
-- ----------------------------------------------------------------------------
-- `performance_reviews` hiện tại chỉ có MỘT điểm tự chấm + MỘT điểm quản lý
-- chấm cho cả kỳ, nhập tay. Đúng như 15 file KPI thật của Huy Phong (đối
-- chiếu tại sheet "Đặc tả Lương – KPI" của bộ Bản đồ chức năng): mỗi vị trí có
-- một BẢNG tiêu chí riêng (dưới 10 dòng), mỗi tiêu chí có trọng số % và một
-- thang điểm rời rạc (thường 4/3/2/1/0), % hoàn thành = Σ (điểm quản lý chấm
-- ÷ điểm tối đa tiêu chí × trọng số).
--
-- Bản thân các file Excel gốc của khách đang tính SAI ở nhiều nơi (17 lỗi
-- được liệt kê ở mục H sheet "Đặc tả Lương – KPI"): tổng trọng số một mẫu chỉ
-- ra 96% hoặc 104% (thiếu/thừa một dòng), công thức nhân điểm thang 100 thẳng
-- vào tiền lương (gấp 100 lần), tỷ lệ bị đảo ngược (thực hiện/chỉ tiêu thay vì
-- chỉ tiêu/thực hiện)... vì mỗi người tự gõ công thức trong Excel, không ai
-- kiểm lại tổng. Thiết kế dưới đây KHÔNG cho phép lớp lỗi đó tái diễn:
--   - Trọng số & điểm tối đa là DỮ LIỆU (kpi_position_template_criteria), một
--     nơi duy nhất — không phải công thức gõ lại ở từng phiếu.
--   - `guard_kpi_template_balanced()` chặn kích hoạt một mẫu nếu tổng trọng số
--     các tiêu chí đang bật không ra đúng 100%.
--   - `guard_kpi_score_bounds()` chặn nhập điểm vượt quá điểm tối đa của tiêu
--     chí (chặn lớp lỗi kiểu nhân điểm thang 100 vào thẳng tiền).
--   - % hoàn thành và xếp loại của cả review được TÍNH LẠI TỰ ĐỘNG bằng
--     trigger mỗi khi có điểm thay đổi (`recalc_kpi_review()`), không có chỗ
--     nào để BA/kế toán tự gõ tổng bằng tay rồi gõ sai.
--
-- Cố ý KHÔNG đụng vào bảng `performance_goals` (kiểu OKR, một mục tiêu số),
-- đang được StaffGrowth.tsx dùng cho "Lộ trình & mục tiêu" — đó là một mô
-- hình khác, giữ nguyên. Đây là một lớp mới cộng thêm vào `performance_reviews`
-- qua `template_id`, không phá dữ liệu review kiểu nhập tay cũ (review nào
-- không gắn template thì vẫn nhập self_score/manager_score thủ công như cũ).
--
-- Việc CÒN LẠI (chưa làm ở migration này, chờ chốt với khách hàng — xem sheet
-- "Đặc tả Lương – KPI" mục P03/L07/LU-09): nối `final_pct` này thành biến
-- `KPI_PCT` cho `payroll_components` (calc_type PERCENT/FORMULA) — đó là việc
-- của Giai đoạn tài chính (RC6.2 trong BRD v0.6), không phải giai đoạn này.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Mẫu KPI theo vị trí + tiêu chí có trọng số
-- ---------------------------------------------------------------------------
create table if not exists public.kpi_position_templates (
  id uuid primary key default gen_random_uuid(),
  -- Mã gợi nhớ như trong sheet Excel gốc (KPI-KV-01, KPI-KD-02...) để BA đối
  -- chiếu ngược lại nguồn khi cần, không bắt buộc theo định dạng cụ thể.
  code text not null unique,
  name text not null,
  -- CHỈ 2 khối — đúng cột "Khối (theo KH)" trong sheet "Mẫu KPI theo vị trí":
  -- 20/23 mẫu (Kho vận, Marketing, Kế toán, Nhập khẩu, Dự án) ghi "Văn phòng";
  -- chỉ 3 mẫu KPI-KD-01~03 ghi "Kinh doanh". KHÔNG có "Kho"/"Vận chuyển" là
  -- khối riêng ở tài liệu — đây là điểm tôi từng tự suy luận sai theo BRD
  -- RC7.1 ("4 khối bộ phận") rồi bịa thêm 2 giá trị không có trong nguồn, đã
  -- được người phụ trách dự án xác nhận lại trực tiếp: Kho vận nằm trong
  -- khối Văn phòng. Lưu sẵn ở đây để khi sang giai đoạn tài chính khỏi phải
  -- suy luận lại nhân viên KPI khối nào ăn lương theo mẫu phiếu nào.
  block_code text not null check (block_code in ('VAN_PHONG', 'KINH_DOANH')),
  unit_id uuid references public.organization_units(id) on delete set null,
  position_id uuid references public.job_positions(id) on delete set null,
  -- Tên phòng/vị trí hiển thị khi chưa gán được unit_id/position_id chuẩn hoá
  -- (nhiều mẫu KPI gốc dùng tên phòng ban tự do, ví dụ "Kho vận — Quản lý kho").
  department_label text,
  -- Nguồn trích xuất, ví dụ "KPIs_QL_kho.xlsx (sheet Giá Trị)" — phục vụ truy
  -- vết khi khách hàng cần đối chiếu lại với file gốc.
  source_note text,
  is_active boolean not null default false,
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Phòng trường hợp bảng đã được tạo ở lần chạy trước với ràng buộc 4 khối cũ
-- (CREATE TABLE IF NOT EXISTS ở trên sẽ bỏ qua, không tự sửa bảng đã có) —
-- chuẩn hoá dữ liệu cũ trước rồi siết lại constraint đúng 2 khối.
update public.kpi_position_templates
  set block_code = 'VAN_PHONG'
  where block_code not in ('VAN_PHONG', 'KINH_DOANH');

alter table public.kpi_position_templates drop constraint if exists kpi_position_templates_block_code_check;
alter table public.kpi_position_templates
  add constraint kpi_position_templates_block_code_check
  check (block_code in ('VAN_PHONG', 'KINH_DOANH'));

create index if not exists kpi_position_templates_block_idx
  on public.kpi_position_templates(block_code, is_active);
create index if not exists kpi_position_templates_position_idx
  on public.kpi_position_templates(position_id);

create table if not exists public.kpi_template_criteria (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.kpi_position_templates(id) on delete cascade,
  name text not null,
  weight_percent numeric(5, 2) not null check (weight_percent > 0 and weight_percent <= 100),
  -- Điểm tối đa của thang chấm tiêu chí này. Đa số mẫu Excel dùng thang 4
  -- (4/3/2/1/0) nhưng vài mẫu (vd Quản lý kho) dùng thang khác — để cấu hình
  -- được thay vì hard-code "4" khắp nơi như file KH đang làm.
  max_score numeric(5, 2) not null default 4 check (max_score > 0),
  -- Mô tả từng mức điểm, ví dụ:
  -- [{"score":4,"label":"Không sai đơn nào"},{"score":3,"label":"Sai 1 lần"}, ...]
  -- Hiển thị cho người chấm chọn đúng mức thay vì gõ số tự do.
  score_levels jsonb not null default '[]'::jsonb,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Vừa hợp lý về nghiệp vụ (không nhân đôi một tiêu chí trong cùng mẫu) vừa
  -- làm điểm neo cho ON CONFLICT khi seed dữ liệu mẫu bên dưới chạy lại.
  unique (template_id, name)
);

create index if not exists kpi_template_criteria_template_idx
  on public.kpi_template_criteria(template_id, sort_order);

-- Tổng trọng số các tiêu chí ĐANG BẬT của một mẫu. Dùng lại ở cả trigger chặn
-- kích hoạt mẫu lẫn màn hình cấu hình (hiển thị "đang thiếu X%").
create or replace function public.kpi_template_weight_total(p_template_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(weight_percent), 0)
  from public.kpi_template_criteria
  where template_id = p_template_id and is_active;
$$;

revoke all on function public.kpi_template_weight_total(uuid) from public;
grant execute on function public.kpi_template_weight_total(uuid) to authenticated;

-- Chặn đúng lớp lỗi LOI-10/LOI-14 trong file Excel gốc (tổng trọng số một mẫu
-- ra 96%/104% vì thiếu hoặc thừa một dòng, không ai cộng lại tổng để kiểm).
-- Cho phép soạn thảo tự do khi mẫu còn nháp (is_active = false trên chính
-- template); chỉ chặn khi mẫu đã/đang ở trạng thái publish.
create or replace function public.guard_kpi_template_balanced()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_template_id uuid;
  v_template_active boolean;
  v_total numeric;
begin
  -- template_id là NOT NULL trên bảng này nên COALESCE luôn dừng ở NEW cho
  -- nhánh INSERT/UPDATE (không chạm tới OLD, vốn "chưa gán" ở nhánh INSERT);
  -- chỉ nhánh DELETE mới thật sự cần đọc OLD.
  v_template_id := coalesce(new.template_id, old.template_id);
  select is_active into v_template_active
    from public.kpi_position_templates where id = v_template_id;

  if v_template_active is true then
    v_total := public.kpi_template_weight_total(v_template_id);
    if abs(v_total - 100) > 0.01 then
      -- RAISE của PL/pgSQL chỉ nhận placeholder "%" đơn giản (không có định
      -- dạng kiểu printf như "%.2f"), và ba dấu % liền nhau (placeholder rồi
      -- tới "%%" thoát) bị phân tích nhầm thành cặp thoát trước — nên ghép sẵn
      -- ký tự "%" vào chuỗi đối số thay vì đặt liền trong chuỗi định dạng.
      raise exception
        'Tổng trọng số tiêu chí đang bật của mẫu KPI này là %, phải đúng 100%% trước khi mẫu ở trạng thái sử dụng.',
        round(v_total, 2)::text || '%'
        using errcode = '23514';
    end if;
  end if;

  -- Constraint trigger kiểu AFTER: giá trị trả về bị Postgres bỏ qua, nhưng
  -- vẫn phải trả một giá trị hợp lệ để hàm biên dịch được.
  return null;
end;
$$;

drop trigger if exists kpi_template_criteria_balance_guard on public.kpi_template_criteria;
create constraint trigger kpi_template_criteria_balance_guard
  after insert or update or delete on public.kpi_template_criteria
  deferrable initially deferred
  for each row execute function public.guard_kpi_template_balanced();

-- Chặn luôn chiều ngược lại: bật is_active trên chính mẫu khi tổng trọng số
-- tiêu chí chưa đủ 100% (ví dụ mẫu mới tạo, chưa thêm tiêu chí nào).
create or replace function public.guard_kpi_template_activation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total numeric;
  v_should_check boolean;
begin
  -- Tách nhánh tg_op tường minh thay vì gộp vào một biểu thức OR: tránh phụ
  -- thuộc vào việc PL/pgSQL có short-circuit hay không khi một nhánh đọc OLD
  -- (chưa được gán ở tg_op = 'INSERT').
  if tg_op = 'INSERT' then
    v_should_check := new.is_active;
  else
    v_should_check := new.is_active and new.is_active is distinct from old.is_active;
  end if;

  if v_should_check then
    v_total := public.kpi_template_weight_total(new.id);
    if abs(v_total - 100) > 0.01 then
      raise exception
        'Không thể bật mẫu KPI "%": tổng trọng số tiêu chí đang bật là %, phải đúng 100%%.',
        new.name, round(v_total, 2)::text || '%'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists kpi_position_templates_activation_guard on public.kpi_position_templates;
create trigger kpi_position_templates_activation_guard
  before insert or update of is_active on public.kpi_position_templates
  for each row execute function public.guard_kpi_template_activation();

-- ---------------------------------------------------------------------------
-- 2. Thang xếp loại — dữ liệu cấu hình được, KHÔNG hard-code trong công thức
--    (NFR7 BRD). Ranh giới D/C/B/A/A+ dưới đây lấy theo sheet "Đặc tả Lương –
--    KPI" mục QT-00 — đây là SUY LUẬN CỦA BA, CHƯA được khách hàng xác nhận
--    (mục QT-02 chính sheet đó ghi nhận ranh giới đang "hở": không rõ 50%,
--    80,5%... thuộc hạng nào). Vì là dữ liệu nên sửa lại bằng UPDATE, không
--    cần sửa code, khi khách chốt lại.
-- ---------------------------------------------------------------------------
create table if not exists public.kpi_rating_bands (
  code text primary key check (code in ('D', 'C', 'B', 'A', 'A_PLUS')),
  label text not null,
  -- Cận dưới (đóng, >=) của dải %. Dải tiếp theo được suy ra từ cận dưới của
  -- hạng liền trên — tránh khai hai đầu rồi lệch nhau tạo khoảng hở/chồng.
  min_pct numeric(6, 2) not null,
  sort_order integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.kpi_rating_bands(code, label, min_pct, sort_order) values
  ('D', 'D — Chưa đạt', 0, 1),
  ('C', 'C — Đạt', 51, 2),
  ('B', 'B — Khá', 81, 3),
  ('A', 'A — Tốt', 95, 4),
  ('A_PLUS', 'A+ — Xuất sắc', 101, 5)
on conflict (code) do nothing;

create or replace function public.compute_kpi_rating(p_pct numeric)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select code
  from public.kpi_rating_bands
  where min_pct <= p_pct
  order by min_pct desc
  limit 1;
$$;

revoke all on function public.compute_kpi_rating(numeric) from public;
grant execute on function public.compute_kpi_rating(numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Gắn mẫu KPI vào performance_reviews + điểm theo từng tiêu chí
-- ---------------------------------------------------------------------------
alter table public.performance_reviews
  add column if not exists template_id uuid references public.kpi_position_templates(id) on delete set null;
alter table public.performance_reviews
  add column if not exists final_pct numeric(6, 2);
-- Khóa lại sau khi đã dùng để tính lương/khen thưởng — không cho sửa điểm nữa,
-- đúng tinh thần NFR5 (audit) và luồng R03 trong sheet Excel ("khóa kỳ; thay
-- đổi sau khóa kỳ xử lý bằng bảng điều chỉnh kỳ sau", không sửa đè dữ liệu cũ).
alter table public.performance_reviews
  add column if not exists locked_at timestamptz;

alter table public.performance_reviews drop constraint if exists performance_reviews_rating_check;
alter table public.performance_reviews
  add constraint performance_reviews_rating_check
  check (rating is null or rating in ('A_PLUS', 'A', 'B', 'C', 'D'));

create table if not exists public.performance_review_scores (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.performance_reviews(id) on delete cascade,
  -- Cố ý KHÔNG cascade khi xoá tiêu chí: một tiêu chí đã có điểm chấm là dữ
  -- liệu lịch sử, muốn thay đổi mẫu thì tắt is_active của tiêu chí đó (giữ lại
  -- để review cũ vẫn tra cứu được), không xoá thẳng.
  criteria_id uuid not null references public.kpi_template_criteria(id) on delete restrict,
  self_score numeric(5, 2) check (self_score is null or self_score >= 0),
  manager_score numeric(5, 2) check (manager_score is null or manager_score >= 0),
  self_comment text,
  manager_comment text,
  evidence_url text,
  scored_self_at timestamptz,
  scored_manager_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (review_id, criteria_id)
);

create index if not exists performance_review_scores_review_idx
  on public.performance_review_scores(review_id);

-- Chặn lớp lỗi LOI-03 (nhân điểm thang 100 thẳng vào lương, gấp 100 lần) và
-- LOI-16 (điểm cá nhân tự chấm không theo công thức/thang điểm): không cho
-- nhập điểm vượt quá điểm tối đa đã khai báo ở chính tiêu chí đó.
create or replace function public.guard_kpi_score_bounds()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max numeric;
  v_locked timestamptz;
begin
  select max_score into v_max from public.kpi_template_criteria where id = new.criteria_id;
  if v_max is null then
    raise exception 'Tiêu chí KPI không tồn tại.' using errcode = '23503';
  end if;
  -- RAISE của PL/pgSQL không hỗ trợ định dạng kiểu printf ("%.2f") — chỉ có
  -- placeholder "%" đơn giản, giá trị numeric tự hiển thị theo đúng scale cột.
  if new.self_score is not null and new.self_score > v_max then
    raise exception 'Điểm tự chấm (%) vượt điểm tối đa của tiêu chí (%).', new.self_score, v_max
      using errcode = '23514';
  end if;
  if new.manager_score is not null and new.manager_score > v_max then
    raise exception 'Điểm quản lý chấm (%) vượt điểm tối đa của tiêu chí (%).', new.manager_score, v_max
      using errcode = '23514';
  end if;

  select locked_at into v_locked from public.performance_reviews where id = new.review_id;
  if v_locked is not null then
    raise exception 'Kỳ đánh giá này đã khóa, không thể sửa điểm — dùng kỳ điều chỉnh tiếp theo.'
      using errcode = '42501';
  end if;

  -- OLD chưa được gán ở nhánh INSERT (truy cập OLD.field lúc đó ném lỗi
  -- "record old is not assigned yet"), nên phải tách nhánh theo tg_op thay vì
  -- gộp chung một điều kiện distinct-from như khi chỉ có UPDATE.
  if tg_op = 'INSERT' then
    if new.self_score is not null then
      new.scored_self_at := now();
    end if;
    if new.manager_score is not null then
      new.scored_manager_at := now();
    end if;
  else
    if new.self_score is distinct from old.self_score then
      new.scored_self_at := now();
    end if;
    if new.manager_score is distinct from old.manager_score then
      new.scored_manager_at := now();
    end if;
  end if;
  new.updated_at := now();

  return new;
end;
$$;

drop trigger if exists performance_review_scores_bounds_guard on public.performance_review_scores;
create trigger performance_review_scores_bounds_guard
  before insert or update on public.performance_review_scores
  for each row execute function public.guard_kpi_score_bounds();

-- % hoàn thành = Σ (điểm quản lý chấm ÷ điểm tối đa tiêu chí × trọng số),
-- đúng công thức QT-00 trong sheet "Đặc tả Lương – KPI". Chỉ tính lại cho
-- review có gắn template_id — review kiểu nhập tay cũ (template_id null) giữ
-- nguyên self_score/manager_score thủ công, không bị trigger này đụng vào.
create or replace function public.recalc_kpi_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_review_id uuid;
  v_template_id uuid;
  v_pct numeric;
begin
  v_review_id := coalesce(new.review_id, old.review_id);

  select template_id into v_template_id
    from public.performance_reviews where id = v_review_id;

  if v_template_id is not null then
    select round(sum(coalesce(s.manager_score, 0) / c.max_score * c.weight_percent)::numeric, 2)
      into v_pct
    from public.performance_review_scores s
    join public.kpi_template_criteria c on c.id = s.criteria_id and c.is_active
    where s.review_id = v_review_id;

    v_pct := coalesce(v_pct, 0);

    update public.performance_reviews
      set final_pct = v_pct,
          rating = public.compute_kpi_rating(v_pct),
          updated_at = now()
      where id = v_review_id;
  end if;

  -- AFTER trigger: giá trị trả về bị Postgres bỏ qua.
  return null;
end;
$$;

drop trigger if exists performance_review_scores_recalc on public.performance_review_scores;
create trigger performance_review_scores_recalc
  after insert or update or delete on public.performance_review_scores
  for each row execute function public.recalc_kpi_review();

-- Nhân viên chưa gán quản lý trực tiếp thì không ai chấm — mặc định
-- reviewer_id theo profiles.manager_id nếu người tạo review không chỉ định
-- sẵn, để đúng luồng "nhân viên tự chấm → quản lý trực tiếp chấm/duyệt".
create or replace function public.default_kpi_review_reviewer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.reviewer_id is null then
    select manager_id into new.reviewer_id from public.profiles where id = new.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists performance_reviews_default_reviewer on public.performance_reviews;
create trigger performance_reviews_default_reviewer
  before insert on public.performance_reviews
  for each row execute function public.default_kpi_review_reviewer();

-- Tự tạo sẵn một dòng điểm (rỗng) cho mỗi tiêu chí đang bật của mẫu, ngay khi
-- review được tạo. Lý do bắt buộc phải làm ở DB thay vì để app tự INSERT: nhân
-- viên/quản lý chỉ có quyền UPDATE trên performance_review_scores (xem policy
-- performance_review_scores_self_manager_update bên dưới), không có quyền
-- INSERT — tránh việc một tài khoản thường tự thêm tiêu chí/điểm tuỳ ý ngoài
-- đúng bộ tiêu chí của mẫu đã publish.
create or replace function public.seed_kpi_review_scores()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.template_id is not null then
    insert into public.performance_review_scores (review_id, criteria_id)
    select new.id, c.id
    from public.kpi_template_criteria c
    where c.template_id = new.template_id and c.is_active
    on conflict (review_id, criteria_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists performance_reviews_seed_scores on public.performance_reviews;
create trigger performance_reviews_seed_scores
  after insert on public.performance_reviews
  for each row execute function public.seed_kpi_review_scores();

-- ---------------------------------------------------------------------------
-- 4. Phân quyền
-- ---------------------------------------------------------------------------
alter table public.kpi_position_templates enable row level security;
alter table public.kpi_template_criteria enable row level security;
alter table public.kpi_rating_bands enable row level security;
alter table public.performance_review_scores enable row level security;

drop policy if exists kpi_position_templates_read on public.kpi_position_templates;
create policy kpi_position_templates_read on public.kpi_position_templates for select to authenticated
  using (is_active or public.can_function('admin.performance_manage'));
drop policy if exists kpi_position_templates_manage on public.kpi_position_templates;
create policy kpi_position_templates_manage on public.kpi_position_templates for all to authenticated
  using (public.can_function('admin.performance_manage')) with check (public.can_function('admin.performance_manage'));

drop policy if exists kpi_template_criteria_read on public.kpi_template_criteria;
create policy kpi_template_criteria_read on public.kpi_template_criteria for select to authenticated
  using (
    public.can_function('admin.performance_manage')
    or exists (select 1 from public.kpi_position_templates t where t.id = template_id and t.is_active)
  );
drop policy if exists kpi_template_criteria_manage on public.kpi_template_criteria;
create policy kpi_template_criteria_manage on public.kpi_template_criteria for all to authenticated
  using (public.can_function('admin.performance_manage')) with check (public.can_function('admin.performance_manage'));

drop policy if exists kpi_rating_bands_read on public.kpi_rating_bands;
create policy kpi_rating_bands_read on public.kpi_rating_bands for select to authenticated using (true);
drop policy if exists kpi_rating_bands_manage on public.kpi_rating_bands;
create policy kpi_rating_bands_manage on public.kpi_rating_bands for all to authenticated
  using (public.can_function('admin.performance_manage')) with check (public.can_function('admin.performance_manage'));

drop policy if exists performance_review_scores_read on public.performance_review_scores;
create policy performance_review_scores_read on public.performance_review_scores for select to authenticated
  using (
    public.can_function('admin.performance_manage')
    or exists (
      select 1 from public.performance_reviews r
      where r.id = review_id and (r.user_id = auth.uid() or r.reviewer_id = auth.uid())
    )
  );
-- Cùng mô hình tin cậy tầng ứng dụng như performance_reviews hiện có (nhân
-- viên/quản lý cùng sửa được hàng của mình qua UI khác nhau) — chưa tách được
-- quyền theo cột self_score/manager_score ở tầng RLS của Postgres.
drop policy if exists performance_review_scores_self_manager_update on public.performance_review_scores;
create policy performance_review_scores_self_manager_update on public.performance_review_scores for update to authenticated
  using (
    public.can_function('admin.performance_manage')
    or exists (
      select 1 from public.performance_reviews r
      where r.id = review_id and (r.user_id = auth.uid() or r.reviewer_id = auth.uid()) and r.locked_at is null
    )
  )
  with check (
    public.can_function('admin.performance_manage')
    or exists (
      select 1 from public.performance_reviews r
      where r.id = review_id and (r.user_id = auth.uid() or r.reviewer_id = auth.uid()) and r.locked_at is null
    )
  );
drop policy if exists performance_review_scores_manage on public.performance_review_scores;
create policy performance_review_scores_manage on public.performance_review_scores for all to authenticated
  using (public.can_function('admin.performance_manage')) with check (public.can_function('admin.performance_manage'));

grant select, insert, update, delete on public.kpi_position_templates to authenticated;
grant select, insert, update, delete on public.kpi_template_criteria to authenticated;
grant select, insert, update, delete on public.kpi_rating_bands to authenticated;
grant select, insert, update, delete on public.performance_review_scores to authenticated;

-- Sửa 3 policy còn sót của performance_reviews: đang khoá cứng is_admin(),
-- nghĩa là một HR được cấp riêng quyền 'admin.performance_manage' (không phải
-- role kỹ thuật admin/ceo) vẫn không tạo được review — lệch với cycles/goals
-- cùng module đã chuyển sang can_function() từ migration 20260922100000.
drop policy if exists reviews_read on public.performance_reviews;
create policy reviews_read on public.performance_reviews for select to authenticated
  using (user_id = auth.uid() or reviewer_id = auth.uid() or public.can_function('admin.performance_manage'));
drop policy if exists reviews_self_update on public.performance_reviews;
create policy reviews_self_update on public.performance_reviews for update to authenticated
  using (
    (user_id = auth.uid() or reviewer_id = auth.uid() or public.can_function('admin.performance_manage'))
    and locked_at is null
  )
  with check (user_id = auth.uid() or reviewer_id = auth.uid() or public.can_function('admin.performance_manage'));
drop policy if exists reviews_manage on public.performance_reviews;
create policy reviews_manage on public.performance_reviews for insert to authenticated
  with check (public.can_function('admin.performance_manage'));

-- ---------------------------------------------------------------------------
-- 5. Dữ liệu mẫu để demo/kiểm thử — CHỈ 1 mẫu, cố ý không seed cả 23 mẫu KPI
--    thật của khách. Sheet "Đặc tả Lương – KPI" mục H liệt kê 17 lỗi công
--    thức trong chính các file Excel gốc (LOI-01..LOI-17); bê nguyên các mẫu
--    đó vào hệ thống trước khi khách xác nhận lại số liệu đúng là lặp lại
--    đúng lớp lỗi đang muốn sửa. Mẫu dưới đây dùng để test luồng, không phải
--    số liệu chính thức — is_active để false, không lẫn vào chu kỳ thật.
-- ---------------------------------------------------------------------------
insert into public.kpi_position_templates (code, name, block_code, department_label, source_note, is_active, note)
values (
  'KPI-KV-02-DEMO',
  'Thủ kho (mẫu demo)',
  'VAN_PHONG',
  'Kho vận — Thủ kho',
  'Trích tham khảo KPIs_thu_kho.xlsx (sheet Giá Trị T0625) — sheet "Mẫu KPI theo vị trí" của Bản đồ chức năng HRM.',
  false,
  'Dữ liệu demo để kiểm thử luồng chấm điểm. KHÔNG dùng để tính lương/xếp loại thật cho đến khi khách hàng xác nhận lại toàn bộ 23 mẫu KPI (xem mục H sheet Đặc tả Lương – KPI).'
)
on conflict (code) do nothing;

insert into public.kpi_template_criteria (template_id, name, weight_percent, max_score, score_levels, sort_order, note)
select t.id, c.name, c.weight_percent, 4, c.score_levels::jsonb, c.sort_order, c.note
from public.kpi_position_templates t
cross join (values
  ('Công tác nhập hàng', 20.0, 1,
   '[{"score":4,"label":"Không sai (muộn) đơn nào"},{"score":3,"label":"Sai/muộn 1 lần"},{"score":2,"label":"Sai/muộn 2 lần"},{"score":1,"label":"Sai/muộn từ 3 lần trở lên"}]',
   null),
  ('Công tác xuất hàng', 20.0, 2,
   '[{"score":4,"label":"Không sai (muộn) đơn nào"},{"score":3,"label":"Sai/muộn 1 lần"},{"score":2,"label":"Sai/muộn 2 lần"},{"score":1,"label":"Sai/muộn từ 3 lần trở lên"}]',
   null),
  ('Công tác kiểm kê hàng hóa hàng tháng', 20.0, 3,
   '[{"score":4,"label":"Hàng hóa đúng, đủ"},{"score":3,"label":"Chênh lệch 1 mã"},{"score":2,"label":"Chênh lệch 2 mã"},{"score":1,"label":"Chênh lệch từ 3 mã trở lên"}]',
   null),
  ('Bảo quản kho', 16.0, 4,
   '[{"score":4,"label":"Không phát sinh lỗi"},{"score":3,"label":"Phát sinh 1 lỗi/tháng"},{"score":2,"label":"Phát sinh 2 lỗi/tháng"},{"score":1,"label":"Phát sinh từ 3 lỗi/tháng trở lên"}]',
   null),
  ('Công tác báo cáo', 12.0, 5,
   '[{"score":4,"label":"Báo cáo đầy đủ, chính xác"},{"score":3,"label":"Sai/thiếu/muộn 1 lần"},{"score":2,"label":"Sai/thiếu/muộn 2 lần"},{"score":1,"label":"Sai/muộn từ 3 lần trở lên"}]',
   'BC phải nộp trước 10h sáng ngày 01 của tháng kế tiếp.'),
  ('Chuyên cần', 12.0, 6,
   '[{"score":4,"label":"Đi làm đủ công, đúng giờ"},{"score":3,"label":"Đi muộn + nghỉ không quá 2 lần/tháng"},{"score":2,"label":"Đi muộn + nghỉ 3-5 lần/tháng"},{"score":1,"label":"Đi muộn + nghỉ > 5 lần/tháng"}]',
   'Suy luận nên lấy tự động từ chấm công (HR-03) thay vì quản lý chấm tay.')
) as c(name, weight_percent, sort_order, score_levels, note)
where t.code = 'KPI-KV-02-DEMO'
on conflict (template_id, name) do nothing;
