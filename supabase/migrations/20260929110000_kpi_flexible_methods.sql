-- ============================================================================
-- Mỗi bộ KPI tự chọn CÁCH TÍNH và ngưỡng xếp loại riêng.
-- ----------------------------------------------------------------------------
-- Migration trước đã cho admin tự khai tiêu chí và thang điểm. Nhưng hai thứ
-- vẫn nằm cứng trong database, và đó chính là chỗ các phòng ban khác nhau:
--
--   1. Cách gộp điểm. `recalc_kpi_review` luôn tính
--        final_pct = Σ(điểm ÷ thang × trọng số)
--      Đây là trung bình có trọng số. Nhiều bộ phận chấm theo TỔNG ĐIỂM thuần
--      (được 17/20 điểm là 85%), không quan tâm trọng số — hai cách cho ra số
--      khác nhau và cả hai đều hợp lệ.
--
--   2. Ngưỡng xếp loại. `kpi_rating_bands` khoá theo `code`, tức CẢ CÔNG TY
--      dùng chung một bộ ngưỡng. Khối kinh doanh muốn 90% mới đạt A trong khi
--      khối kho lấy 80% là chuyện bình thường, và hiện không khai được.
--
-- Thêm vào đó là TRẦN và SÀN kết quả: bộ phận cho phép vượt 100% (thưởng vượt
-- chỉ tiêu) khác hẳn bộ phận chốt cứng ở 100%.
--
-- Mặc định giữ NGUYÊN hành vi cũ, nên mẫu đã chấm không đổi kết quả.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Cách tính của từng bộ KPI
-- ---------------------------------------------------------------------------
alter table public.kpi_position_templates
  add column if not exists score_method text not null default 'WEIGHTED_PERCENT'
    check (score_method in ('WEIGHTED_PERCENT', 'TOTAL_POINTS')),
  -- Trần kết quả. NULL = không chặn, cho phép vượt 100% khi bộ phận có cơ chế
  -- thưởng vượt chỉ tiêu.
  add column if not exists result_cap_percent numeric(6, 2)
    check (result_cap_percent is null or result_cap_percent > 0),
  -- Sàn kết quả. Mặc định 0: không có lý do nào cho ra phần trăm âm.
  add column if not exists result_floor_percent numeric(6, 2) not null default 0
    check (result_floor_percent >= 0);

comment on column public.kpi_position_templates.score_method is
  'WEIGHTED_PERCENT = Σ(điểm ÷ thang × trọng số). TOTAL_POINTS = Σđiểm ÷ Σthang × 100, bỏ qua trọng số.';
comment on column public.kpi_position_templates.result_cap_percent is
  'Trần kết quả %. NULL = không chặn, cho phép vượt 100%.';

-- ---------------------------------------------------------------------------
-- 2. Ngưỡng xếp loại theo từng bộ KPI
-- ---------------------------------------------------------------------------
-- Giữ nguyên các dòng đang có làm bộ NGƯỠNG CHUNG (template_id = null), rồi
-- cho phép thêm bộ riêng cho từng mẫu. Cách này không đụng tới dữ liệu cũ và
-- không bắt mọi mẫu phải khai lại ngưỡng của mình.
alter table public.kpi_rating_bands
  add column if not exists id uuid not null default gen_random_uuid(),
  add column if not exists template_id uuid references public.kpi_position_templates(id) on delete cascade;

do $do$
begin
  -- Khoá chính đang là `code`, nghĩa là mỗi mã xếp loại chỉ tồn tại một lần
  -- trong toàn hệ thống — đúng thứ cần bỏ để có bộ ngưỡng riêng.
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.kpi_rating_bands'::regclass and contype = 'p'
      and conname = 'kpi_rating_bands_pkey'
  ) then
    alter table public.kpi_rating_bands drop constraint kpi_rating_bands_pkey;
    alter table public.kpi_rating_bands add constraint kpi_rating_bands_pkey primary key (id);
  end if;
end;
$do$;

-- Hai chỉ mục thay cho khoá chính cũ: một mã chỉ xuất hiện một lần trong bộ
-- chung, và một lần trong mỗi bộ riêng.
create unique index if not exists kpi_rating_bands_global_code_idx
  on public.kpi_rating_bands(code) where template_id is null;
create unique index if not exists kpi_rating_bands_template_code_idx
  on public.kpi_rating_bands(template_id, code) where template_id is not null;

comment on column public.kpi_rating_bands.template_id is
  'NULL = bộ ngưỡng chung của công ty. Có giá trị = bộ ngưỡng riêng của mẫu KPI đó, ghi đè bộ chung.';

-- ---------------------------------------------------------------------------
-- 3. Xếp loại theo bộ ngưỡng của mẫu, lùi về bộ chung khi mẫu chưa khai
-- ---------------------------------------------------------------------------
create or replace function public.compute_kpi_rating(p_pct numeric, p_template_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  -- Mẫu có bộ ngưỡng riêng thì CHỈ xét bộ riêng; chưa khai thì xét bộ chung.
  -- Trộn hai bộ lại sẽ cho ra xếp loại lai giữa hai chính sách khác nhau.
  with scope as (
    select exists (
      select 1 from public.kpi_rating_bands b where b.template_id = p_template_id
    ) as has_own
  )
  select b.code
  from public.kpi_rating_bands b, scope
  where b.min_pct <= p_pct
    and case when scope.has_own
             then b.template_id = p_template_id
             else b.template_id is null
        end
  order by b.min_pct desc
  limit 1;
$$;

revoke all on function public.compute_kpi_rating(numeric, uuid) from public;
grant execute on function public.compute_kpi_rating(numeric, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Tính lại kết quả theo cách tính của mẫu
-- ---------------------------------------------------------------------------
create or replace function public.recalc_kpi_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_review_id uuid;
  v_template_id uuid;
  v_method text;
  v_cap numeric;
  v_floor numeric;
  v_pct numeric;
begin
  -- Rẽ theo TG_OP chứ không dùng coalesce(new.x, old.x): trên DELETE, `NEW`
  -- chưa được gán nên chạm vào `new.review_id` sẽ ném "record new is not
  -- assigned yet" — và vì đây là trigger AFTER DELETE có cascade từ
  -- performance_reviews, lỗi đó sẽ làm không xoá nổi một phiếu chấm nào.
  if tg_op = 'DELETE' then
    v_review_id := old.review_id;
  else
    v_review_id := new.review_id;
  end if;

  select template_id into v_template_id
    from public.performance_reviews where id = v_review_id;

  if v_template_id is null then
    return null;
  end if;

  select score_method, result_cap_percent, result_floor_percent
    into v_method, v_cap, v_floor
  from public.kpi_position_templates
  where id = v_template_id;

  if v_method = 'TOTAL_POINTS' then
    -- Tổng điểm trên tổng điểm tối đa. Trọng số CỐ Ý bị bỏ qua — đó chính là
    -- điểm khác biệt của cách tính này, không phải thiếu sót.
    select case
             when sum(c.max_score) > 0
               then round((sum(coalesce(s.manager_score, 0)) / sum(c.max_score) * 100)::numeric, 2)
             else 0
           end
      into v_pct
    from public.performance_review_scores s
    join public.kpi_template_criteria c on c.id = s.criteria_id and c.is_active
    where s.review_id = v_review_id;
  else
    select round(sum(coalesce(s.manager_score, 0) / c.max_score * c.weight_percent)::numeric, 2)
      into v_pct
    from public.performance_review_scores s
    join public.kpi_template_criteria c on c.id = s.criteria_id and c.is_active
    where s.review_id = v_review_id;
  end if;

  v_pct := coalesce(v_pct, 0);
  v_pct := greatest(v_pct, coalesce(v_floor, 0));
  if v_cap is not null then
    v_pct := least(v_pct, v_cap);
  end if;

  update public.performance_reviews
    set final_pct = v_pct,
        rating = public.compute_kpi_rating(v_pct, v_template_id),
        updated_at = now()
    where id = v_review_id;

  -- AFTER trigger: giá trị trả về bị Postgres bỏ qua.
  return null;
end;
$fn$;
