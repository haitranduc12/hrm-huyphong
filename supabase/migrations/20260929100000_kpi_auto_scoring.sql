-- ============================================================================
-- Tự động chấm KPI theo thang điểm do người dùng tự định nghĩa.
-- ----------------------------------------------------------------------------
-- Trước migration này, `score_levels` chỉ là NHÃN mô tả từng mức:
--   [{"score": 4, "label": "Không sai đơn nào"}, {"score": 3, "label": "Sai 1 lần"}]
-- Người chấm phải tự đọc nhãn rồi chọn mức. Nghĩa là mỗi tháng, mỗi tiêu chí,
-- mỗi nhân sự đều phải có một người ngồi đối chiếu bằng mắt — vừa chậm vừa
-- không nhất quán giữa các quản lý.
--
-- Thay đổi: mỗi mức nhận thêm NGƯỠNG SỐ, và phiếu chấm nhận SỐ ĐO THỰC TẾ.
-- Hệ thống tự suy ra điểm.
--
--   [{"score": 4, "max": 0,            "label": "Không sai đơn nào"},
--    {"score": 3, "min": 1, "max": 1,  "label": "Sai 1 lần"},
--    {"score": 2, "min": 2, "max": 3,  "label": "Sai 2-3 lần"},
--    {"score": 0, "min": 4,            "label": "Sai trên 3 lần"}]
--
-- `min`/`max` đều BAO GỒM hai đầu, và đều tuỳ chọn: thiếu `min` là không có
-- cận dưới, thiếu `max` là không có cận trên. Nhờ vậy một dạng khai duy nhất
-- phục vụ được cả tiêu chí "càng thấp càng tốt" (số lỗi) lẫn "càng cao càng
-- tốt" (% doanh số) mà không cần cột hướng riêng.
--
-- Mức nào KHÔNG khai cả min lẫn max thì bị bỏ qua khi tự chấm — đó là mức mô
-- tả thuần, giữ nguyên cách chấm tay như cũ.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Số đo thực tế trên từng dòng điểm
-- ---------------------------------------------------------------------------
alter table public.performance_review_scores
  -- Con số quản lý nhập (hoặc hệ thống lấy về): số đơn sai, % doanh số, số
  -- ngày đi muộn… Để NULL nghĩa là chấm tay như trước.
  add column if not exists actual_value numeric(15, 2),
  -- Ghi lại điểm có phải do hệ thống suy ra hay không, để phiếu đánh giá nói
  -- rõ được "máy chấm" hay "người chấm". Không có cờ này thì một điểm bị sửa
  -- tay sau đó trông y hệt điểm tự động.
  add column if not exists auto_scored boolean not null default false;

comment on column public.performance_review_scores.actual_value is
  'Số đo thực tế của tiêu chí. Có giá trị thì hệ thống tự suy ra manager_score theo thang điểm của tiêu chí.';
comment on column public.performance_review_scores.auto_scored is
  'true = điểm do hệ thống suy ra từ actual_value. false = người chấm nhập tay.';

-- ---------------------------------------------------------------------------
-- 2. Đơn vị đo, để màn chấm hỏi đúng thứ cần hỏi
-- ---------------------------------------------------------------------------
alter table public.kpi_template_criteria
  -- Ví dụ: 'đơn sai', '%', 'ngày', 'lần'. Chỉ để hiển thị cạnh ô nhập, không
  -- tham gia tính toán — nhưng thiếu nó thì người chấm phải đoán đang nhập gì.
  add column if not exists measure_unit text,
  -- Câu hướng dẫn ngắn cho người nhập số đo.
  add column if not exists measure_hint text;

comment on column public.kpi_template_criteria.measure_unit is
  'Đơn vị của số đo thực tế, hiển thị cạnh ô nhập. Không tham gia tính toán.';

-- ---------------------------------------------------------------------------
-- 3. Suy điểm từ thang điểm
-- ---------------------------------------------------------------------------
-- Tách thành hàm riêng thay vì nhét vào trigger: màn hình cần gọi để xem
-- trước ("nhập 2 đơn sai thì được mấy điểm?") mà không phải ghi dữ liệu.
create or replace function public.kpi_score_from_levels(
  p_levels jsonb,
  p_actual numeric
)
returns numeric
language plpgsql
immutable
set search_path = public
as $fn$
declare
  v_level jsonb;
  v_min numeric;
  v_max numeric;
begin
  if p_actual is null or p_levels is null or jsonb_typeof(p_levels) <> 'array' then
    return null;
  end if;

  -- Duyệt theo đúng thứ tự khai và lấy mức KHỚP ĐẦU TIÊN. Thứ tự là quy tắc
  -- phân xử khi người dùng khai hai mức chồng nhau: mức khai trước thắng, thay
  -- vì trả về một kết quả tuỳ tâm trạng của bộ tối ưu.
  for v_level in select * from jsonb_array_elements(p_levels)
  loop
    v_min := nullif(v_level ->> 'min', '')::numeric;
    v_max := nullif(v_level ->> 'max', '')::numeric;

    -- Mức mô tả thuần, không có ngưỡng nào: bỏ qua khi tự chấm.
    continue when v_min is null and v_max is null;

    if (v_min is null or p_actual >= v_min)
       and (v_max is null or p_actual <= v_max) then
      return nullif(v_level ->> 'score', '')::numeric;
    end if;
  end loop;

  -- Không mức nào khớp: trả NULL chứ KHÔNG trả 0. Số đo rơi ngoài mọi khoảng
  -- là dấu hiệu thang điểm khai thiếu, và im lặng cho 0 điểm sẽ trừ oan tiền
  -- lương của người bị chấm.
  return null;
end;
$fn$;

comment on function public.kpi_score_from_levels(jsonb, numeric) is
  'Suy điểm từ thang điểm theo số đo thực tế. Mức khớp đầu tiên thắng. NULL nếu không mức nào khớp.';

revoke all on function public.kpi_score_from_levels(jsonb, numeric) from public;
grant execute on function public.kpi_score_from_levels(jsonb, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Trigger tự chấm khi số đo thay đổi
-- ---------------------------------------------------------------------------
create or replace function public.auto_score_kpi_criteria()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_levels jsonb;
  v_max_score numeric;
  v_score numeric;
begin
  -- Không có số đo thì giữ nguyên hành vi chấm tay.
  if new.actual_value is null then
    new.auto_scored := false;
    return new;
  end if;

  select c.score_levels, c.max_score
    into v_levels, v_max_score
  from public.kpi_template_criteria c
  where c.id = new.criteria_id;

  v_score := public.kpi_score_from_levels(v_levels, new.actual_value);

  if v_score is null then
    -- Thang điểm không phủ hết: để người chấm tự quyết thay vì bịa ra một con
    -- số. Màn hình sẽ thấy điểm trống và biết phải xử lý.
    new.auto_scored := false;
    return new;
  end if;

  -- Kẹp trong thang của tiêu chí: thang điểm khai sai (score 5 trên thang 4)
  -- sẽ đẩy final_pct vượt trần mà không có gì chặn.
  new.manager_score := least(greatest(v_score, 0), v_max_score);
  new.auto_scored := true;
  new.scored_manager_at := now();
  return new;
end;
$fn$;

drop trigger if exists performance_review_scores_auto_score on public.performance_review_scores;
create trigger performance_review_scores_auto_score
before insert or update of actual_value on public.performance_review_scores
for each row execute function public.auto_score_kpi_criteria();

-- ---------------------------------------------------------------------------
-- 5. Bổ sung ngưỡng cho các mẫu đã seed
-- ---------------------------------------------------------------------------
-- Các mẫu seed sẵn dùng thang 4/3/2/1/0 theo số lần sai (càng ít càng tốt).
-- Gắn ngưỡng mặc định cho những tiêu chí CHƯA có ngưỡng nào, để mẫu cũ dùng
-- được ngay mà không phải khai lại tay từng cái.
--
-- Chỉ đụng tới tiêu chí có đúng thang 4 và mọi mức đều thiếu min/max — tiêu
-- chí đã khai ngưỡng hoặc dùng thang khác thì giữ nguyên, không đoán hộ.
update public.kpi_template_criteria c
set score_levels = jsonb_build_array(
      jsonb_build_object('score', 4, 'max', 0, 'label', 'Không sai lần nào'),
      jsonb_build_object('score', 3, 'min', 1, 'max', 1, 'label', 'Sai 1 lần'),
      jsonb_build_object('score', 2, 'min', 2, 'max', 3, 'label', 'Sai 2-3 lần'),
      jsonb_build_object('score', 1, 'min', 4, 'max', 5, 'label', 'Sai 4-5 lần'),
      jsonb_build_object('score', 0, 'min', 6, 'label', 'Sai trên 5 lần')
    ),
    measure_unit = coalesce(c.measure_unit, 'lần'),
    measure_hint = coalesce(c.measure_hint, 'Nhập số lần sai sót ghi nhận trong kỳ.'),
    updated_at = now()
where c.max_score = 4
  and not exists (
    select 1
    from jsonb_array_elements(coalesce(c.score_levels, '[]'::jsonb)) as level
    where level ? 'min' or level ? 'max'
  );
