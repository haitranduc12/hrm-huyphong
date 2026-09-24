export type SystemRole = 'admin' | 'ceo' | 'staff' | 'teamlead';
export type ProjectStatus = 'planning' | 'active' | 'on_hold' | 'completed' | 'archived';
export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';
/** Mã role dự án do dữ liệu cấu hình; không đóng union để có thể mở rộng. */
export type MemberRole = string;
export type AttendanceStatus = 'active' | 'completed';
export type ShiftType = 'morning' | 'afternoon' | 'night' | 'full';
export type ShiftStatus = 'pending' | 'approved' | 'rejected';
export type DocumentType = 'brd' | 'srs' | 'contract' | 'quotation' | 'minutes' | 'design' | 'report' | 'other';
export type LeaveType = 'annual' | 'sick' | 'unpaid' | 'other';
export type LeaveStatus = 'pending' | 'approved' | 'rejected';
export type TrainingCourseStatus = 'draft' | 'published' | 'archived';
export type TrainingEnrollmentStatus = 'enrolled' | 'in_progress' | 'completed';
export type OrganizationUnitType = 'group' | 'company' | 'branch' | 'department' | 'team';
export type EmploymentStatus = 'onboarding' | 'probation' | 'active' | 'suspended' | 'terminated';

export interface Profile {
  id: string;
  name: string;
  email: string;
  role: SystemRole;
  /** Vai trò nghiệp vụ do Admin cấu hình; role cũ vẫn giữ để tương thích. */
  access_role_code?: string | null;
  department: string | null;
  employee_code?: string | null;
  unit_id?: string | null;
  position_id?: string | null;
  manager_id?: string | null;
  hire_date?: string | null;
  employment_status?: EmploymentStatus;
  /** Số điện thoại — nhân viên tự sửa được ở trang Hồ sơ cá nhân. */
  phone: string | null;
  avatar_url: string | null;
  is_active: boolean;
  /** Đang dùng mật khẩu tạm do admin cấp — bị ép đổi trước khi vào hệ thống. */
  must_change_password: boolean;
  /**
   * Quyền lẻ vào khu quản trị, cấp cho nhân viên. Admin/CEO ngầm định có tất cả
   * nên mảng này thường rỗng với họ. Xem `lib/permissions.ts`.
   */
  permissions: string[];
  /** Quyền mặc định kế thừa từ vị trí/chức danh trong cơ cấu tổ chức. */
  position_permissions?: string[];
  /** Quyền kế thừa từ vai trò nghiệp vụ cấu hình trong hệ thống. */
  access_role_permissions?: string[];
  /** Quyền chức năng nhạy cảm được gán riêng từ vai trò hoặc vị trí. */
  function_permissions?: string[];
  /** Số ngày phép năm được hưởng. Mặc định 12 theo Bộ luật Lao động. */
  annual_leave_quota: number;
  created_at: string;
  updated_at: string;
}

export interface OrganizationUnit {
  id: string;
  code: string;
  name: string;
  unit_type: OrganizationUnitType;
  parent_id: string | null;
  manager_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface JobPosition {
  id: string;
  code: string;
  title: string;
  unit_id: string;
  reports_to_position_id: string | null;
  is_manager: boolean;
  is_active: boolean;
  permissions?: string[];
  created_at: string;
  updated_at: string;
}

export interface ProjectDocument {
  id: string;
  project_id: string;
  doc_type: DocumentType;
  title: string;
  note: string | null;
  /** Đường dẫn trong Storage — có khi là file tải lên. */
  storage_path: string | null;
  /** URL Google Docs — có khi là liên kết ngoài. Luôn loại trừ với storage_path. */
  external_url: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  /** Chỉ người có quyền `projects` xem được; thành viên thường bị ẩn. */
  confidential: boolean;
  uploaded_by: string | null;
  created_at: string;
  uploader?: Pick<Profile, 'id' | 'name' | 'avatar_url'>;
}

export interface LeaveRequest {
  id: string;
  user_id: string;
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  /**
   * Số ngày tính công, đã trừ thứ Bảy/Chủ nhật. Hỗ trợ nửa ngày (0.5).
   *
   * DATABASE TỰ TÍNH giá trị này khi nhân viên gửi/sửa đơn — không tin số do
   * trình duyệt gửi lên. Trước đây client tự khai, nên gửi thẳng PostgREST một
   * đơn 4 tháng mà khai 0.5 ngày là quỹ phép chỉ trừ 0.5 trong khi bảng lương
   * trả cho gần 90 ngày. Chỉ người có quyền `leave` mới đặt tay được (để trừ
   * ngày lễ), và vẫn không được vượt số ngày làm việc thật trong khoảng.
   * Xem migration 20260811210000.
   */
  days: number;
  /** Nghỉ nửa ngày — chỉ hợp lệ khi đơn gói gọn trong một ngày. */
  half_day: boolean;
  reason: string | null;
  status: LeaveStatus;
  approved_by: string | null;
  approved_at: string | null;
  reason_reject: string | null;
  is_cancelled?: boolean;
  cancelled_at?: string | null;
  cancelled_by?: string | null;
  created_at: string;
  updated_at: string;
  profile?: Profile;
}

export interface TrainingCourse {
  id: string;
  title: string;
  description: string | null;
  category: string;
  instructor: string | null;
  duration_hours: number;
  deadline: string | null;
  resource_url: string | null;
  video_path: string | null;
  video_file_name: string | null;
  status: TrainingCourseStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TrainingEnrollment {
  id: string;
  course_id: string;
  user_id: string;
  status: TrainingEnrollmentStatus;
  progress: number;
  note: string | null;
  enrolled_at: string;
  completed_at: string | null;
  course?: TrainingCourse;
  profile?: Profile;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  start_date: string;
  end_date: string;
  budget: number | null;
  client: string | null;
  status: ProjectStatus;
  lead_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectMember {
  id: string;
  project_id: string;
  user_id: string;
  role: MemberRole;
  /** Nguồn quyền mới; `role` được giữ để tương thích client/migration cũ. */
  role_code?: MemberRole;
  joined_at: string;
  profile?: Profile;
  project_role?: ProjectRoleDefinition;
}

export interface ProjectRoleDefinition {
  code: MemberRole;
  name: string;
  description: string | null;
  permissions: string[];
  is_system: boolean;
  is_active: boolean;
  sort_order: number;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  assignee_id: string | null;
  /** Ngày bắt đầu theo kế hoạch. Cùng `due_date` tạo thành thanh trên Gantt. */
  start_date: string | null;
  due_date: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  parent_task_id: string | null;
  order_index: number;
  /** Ước lượng giờ. Không có thì giờ thực tế chỉ là con số trơ, không so được. */
  estimated_hours: number | null;
  created_at: string;
  updated_at: string;
  project?: Project;
  assignee?: Profile;
}

/**
 * Một dòng nhật ký giờ.
 * Ràng buộc UNIQUE(task_id, user_id, work_date) bảo đảm mỗi người mỗi tác vụ
 * mỗi ngày chỉ có đúng một dòng — ghi lại là sửa, không cộng dồn dòng mới.
 */
export interface TaskWorklog {
  id: string;
  task_id: string;
  user_id: string;
  work_date: string;
  hours: number;
  note: string | null;
  created_at: string;
  updated_at: string;
  task?: Task;
  profile?: Profile;
}

export type AssignmentStatus = 'pending' | 'submitted' | 'approved' | 'rejected';

/**
 * Một công việc quản lý giao cho MỘT người vào MỘT ngày cụ thể.
 * Giao "cả tuần" = một dòng cho mỗi ngày được chọn — nhờ vậy câu hỏi
 * "hôm nay xong hết chưa" (điều kiện hiện nút check-out) luôn tính được
 * bằng một phép lọc theo work_date, không có ngoại lệ việc-nhiều-ngày.
 */
export interface DailyAssignment {
  id: string;
  user_id: string;
  assigned_by: string | null;
  work_date: string;
  title: string;
  description: string | null;
  priority: TaskPriority;
  status: AssignmentStatus;
  /** Ghi chú nhân viên đính kèm khi bấm "Gửi duyệt". */
  submit_note: string | null;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  /** Lý do từ chối — bắt buộc khi quản lý trả lại để làm lại. */
  review_note: string | null;
  created_at: string;
  updated_at: string;
  profile?: Profile;
  assigner?: Pick<Profile, 'id' | 'name' | 'avatar_url'>;
  reviewer?: Pick<Profile, 'id' | 'name' | 'avatar_url'>;
}

/**
 * Cấu hình lương từng người — chỉ admin/CEO đọc-ghi được lương người khác
 * (RLS is_admin), nhân viên đọc được đúng dòng của mình.
 *
 * @deprecated Thay bằng `EmployeePayProfile` + `EmployeePayItem`. Bảng cũ còn
 * lại để đối chiếu số liệu trước khi chuyển sang bộ máy lương mới; không viết
 * thêm dữ liệu vào đây.
 */
export interface SalaryProfile {
  user_id: string;
  /** VND/tháng. */
  base_salary: number;
  /** Phụ cấp cố định VND/tháng, tính trọn tháng không theo ngày công. */
  allowance: number;
  note: string | null;
  updated_by: string | null;
  updated_at: string;
}

// ============================================================================
// Hồ sơ người lao động — xem migration 20260908150000_workforce_mobility.
// ----------------------------------------------------------------------------
// Trước đây các kiểu này nằm cục bộ trong AdminWorkforceCenter.tsx. Đưa ra đây
// vì trang hồ sơ cá nhân cũng đọc chúng để mỗi người xem được hồ sơ của mình.
// ============================================================================

export type WorkerProgram = 'TECHNICAL_INTERN' | 'SPECIFIED_SKILLED' | 'ENGINEER';

export type JapaneseLevel = 'NONE' | 'N5' | 'N4' | 'N3' | 'JFT_BASIC';

export type WorkerStatus =
  | 'SCREENING' | 'TRAINING' | 'WAITING_INTERVIEW' | 'PASSED' | 'POST_PASS_TRAINING'
  | 'COE' | 'VISA' | 'WAITING_DEPARTURE' | 'WORKING_ABROAD' | 'RETURNED'
  | 'FAILED' | 'WITHDRAWN';

export type WorkerDocumentType =
  | 'PASSPORT' | 'COE' | 'VISA' | 'JAPANESE_CERTIFICATE' | 'HEALTH_CHECK' | 'CONTRACT';

export interface OverseasWorker {
  id: string;
  code: string;
  full_name: string;
  date_of_birth: string | null;
  gender: 'MALE' | 'FEMALE' | null;
  hometown: string | null;
  phone: string | null;
  program: WorkerProgram;
  industry: string | null;
  japanese_level: JapaneseLevel;
  status: WorkerStatus;
  order_id: string | null;
  /** Tài khoản đăng nhập tương ứng. NULL = chưa có tài khoản. */
  user_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerDocument {
  id: string;
  worker_id: string;
  document_type: WorkerDocumentType;
  document_number: string;
  issue_date: string | null;
  expiry_date: string | null;
  note: string | null;
  created_at: string;
}

export interface WorkerStatusLog {
  id: string;
  worker_id: string;
  status: WorkerStatus;
  changed_at: string;
  note: string | null;
  changed_by: string | null;
}

// ============================================================================
// Bộ máy lương theo thành phần — xem migration 20260921090000_payroll_engine.
// ============================================================================

/** Cách quy đổi một khoản lương ra tiền. */
export type PayCalcType = 'FIXED' | 'PER_DAY' | 'PER_HOUR' | 'PER_UNIT' | 'PERCENT' | 'FORMULA';

/**
 * EARNING cộng vào lương, DEDUCTION trừ khỏi lương, EMPLOYER_COST là phần
 * doanh nghiệp chịu — hiện trong báo cáo chi phí nhưng KHÔNG trừ của nhân viên.
 */
export type PayComponentKind = 'EARNING' | 'DEDUCTION' | 'EMPLOYER_COST';

/** Cơ chế trả lương gốc. Quyết định `base_amount` mang nghĩa gì. */
export type PayBasis = 'MONTHLY' | 'HOURLY' | 'DAILY' | 'PIECE' | 'COMMISSION';

/** FLAT dùng cho hợp đồng thời vụ dưới 3 tháng (khấu trừ thẳng 10%). */
export type TaxMode = 'PROGRESSIVE' | 'FLAT' | 'NONE';

export type PayrollRunStatus = 'DRAFT' | 'CALCULATED' | 'APPROVED' | 'PAID';

/** Định nghĩa một khoản lương ở cấp công ty. */
export interface PayComponent {
  id: string;
  /** Viết hoa không dấu — dùng làm biến trong biểu thức của khoản khác. */
  code: string;
  name: string;
  kind: PayComponentKind;
  calc_type: PayCalcType;
  default_amount: number;
  /** PER_HOUR/PER_UNIT: lấy số lượng từ `payroll_inputs` có cùng mã này. */
  input_code: string | null;
  /** PERCENT: tính phần trăm trên giá trị của mã này. */
  base_code: string | null;
  formula: string | null;
  taxable: boolean;
  insurable: boolean;
  prorate: boolean;
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** Cơ chế lương của một người, áp dụng từ `effective_from`. */
export interface EmployeePayProfile {
  id: string;
  user_id: string;
  effective_from: string;
  pay_basis: PayBasis;
  /** Lương tháng, hoặc đơn giá giờ/ngày/sản phẩm tùy `pay_basis`. */
  base_amount: number;
  /** Mức đóng bảo hiểm nếu khác lương thực tế. */
  insurance_base: number | null;
  insurance_enabled: boolean;
  dependents: number;
  tax_mode: TaxMode;
  flat_tax_rate: number;
  standard_days_override: number | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Một khoản lương đã gán cho một người, có thể kèm giá trị/công thức riêng. */
export interface EmployeePayItem {
  id: string;
  user_id: string;
  component_id: string;
  amount: number | null;
  formula: string | null;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  component?: PayComponent;
}

/** Số liệu biến động của một người trong một tháng (giờ OT, sản lượng...). */
export interface PayrollInput {
  id: string;
  user_id: string;
  month_start: string;
  code: string;
  quantity: number;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PayrollRun {
  id: string;
  month_start: string;
  status: PayrollRunStatus;
  note: string | null;
  created_by: string | null;
  calculated_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Phiếu lương đã đóng băng. Không tính lại khi cấu hình đổi. */
export interface Payslip {
  id: string;
  run_id: string;
  user_id: string;
  employee_name: string;
  employee_code: string | null;
  department: string | null;
  pay_basis: PayBasis;
  work_days: number;
  leave_days: number;
  paid_days: number;
  standard_days: number;
  work_hours: number;
  gross_pay: number;
  taxable_income: number;
  insurance_employee: number;
  insurance_employer: number;
  personal_income_tax: number;
  other_deductions: number;
  net_pay: number;
  /** Tham số đã dùng lúc chốt: thuế suất, người phụ thuộc, trần bảo hiểm... */
  snapshot: Record<string, unknown>;
  note: string | null;
  created_at: string;
  lines?: PayslipLine[];
}

export interface PayslipLine {
  id: string;
  payslip_id: string;
  sequence: number;
  code: string;
  name: string;
  kind: PayComponentKind;
  quantity: number | null;
  rate: number | null;
  amount: number;
  taxable: boolean;
  insurable: boolean;
  /** Câu giải thích con số, ví dụ "12.000.000 ÷ 26 × 24 ngày". */
  detail: string | null;
}

export interface Attendance {
  id: string;
  user_id: string;
  date: string;
  check_in_time: string | null;
  check_out_time: string | null;
  status: AttendanceStatus;
  approved_by_lead: boolean;
  approved_at: string | null;
  approved_by_user_id: string | null;
  location_id?: string | null;
  check_in_method?: 'GPS' | 'WIFI' | 'MANUAL' | null;
  check_in_latitude?: number | null;
  check_in_longitude?: number | null;
  gps_accuracy_meters?: number | null;
  gps_captured_at?: string | null;
  wifi_bssid?: string | null;
  anomaly_flags?: string[];
  created_at: string;
  profile?: Profile;
  /** Địa điểm được hệ thống xác định lúc check-in; dùng để đối soát. */
  location?: {
    id: string;
    name: string;
    address?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    radius_meters?: number | null;
  } | null;
}

export interface AttendanceSession {
  id: string;
  attendance_id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  source: 'CHECK_IN' | 'REOPEN' | 'ADMIN';
  created_at: string;
}

export interface LeaveLedgerEntry {
  id: string;
  user_id: string;
  leave_type: LeaveType;
  leave_year: number;
  entry_type: 'GRANT' | 'CARRY_FORWARD' | 'USED' | 'REFUND' | 'ADJUSTMENT';
  days: number;
  source_request_id: string | null;
  note: string | null;
  created_at: string;
}

export interface LeaveCancellationRequest {
  id: string;
  leave_request_id: string;
  requested_by: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  leave?: LeaveRequest;
}

export interface Shift {
  id: string;
  user_id: string;
  start_date: string;
  end_date: string;
  shift_type: ShiftType;
  status: ShiftStatus;
  approved_by: string | null;
  reason_reject: string | null;
  /** NULL = nhân viên tự đăng ký. Có giá trị = quản lý xếp trực tiếp. */
  assigned_by: string | null;
  created_at: string;
  profile?: Profile;
}

/**
 * Loại ca kèm giờ cụ thể, đọc từ bảng `shift_types`.
 * Trước đây chỉ là nhãn viết cứng trong utils.ts nên không tính được giờ công.
 */
export interface ShiftTypeConfig {
  code: string;
  label: string;
  /** Dạng HH:MM:SS từ Postgres. */
  start_time: string;
  end_time: string;
  hours: number;
  color: string;
  dot: string;
  sort_order: number;
  is_active: boolean;
}

/**
 * Một dòng nhật ký thao tác. Ghi bằng trigger ở database (xem migration
 * 20260811170000) nên không đường ghi nào lách được — kể cả gọi thẳng
 * PostgREST bằng anon key. Bảng chỉ thêm: không ai sửa/xoá được lịch sử.
 */
export interface AuditLog {
  id: number;
  actor_id: string | null;
  /** Tên người thực hiện, chụp lại lúc ghi — họ có thể bị xoá về sau. */
  actor_name: string | null;
  /** Mã hành động, ví dụ `salary.update`. */
  action: string;
  entity_type: string;
  entity_id: string | null;
  target_user_id: string | null;
  target_name: string | null;
  /** Câu tiếng Việt đọc hiểu ngay. */
  summary: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

export type ProjectEventType = 'meeting' | 'reminder';

/**
 * Lịch họp / nhắc nhở gắn với một dự án. Trưởng nhóm tạo cho dự án mình lead;
 * thành viên dự án xem được và nhận thông báo. Xem migration 20260811250000.
 */
export interface ProjectEvent {
  id: string;
  project_id: string;
  type: ProjectEventType;
  title: string;
  description: string | null;
  /** Tên khách hàng — chỉ dùng cho cuộc họp. */
  client_name: string | null;
  /** Địa điểm hoặc link online. */
  location: string | null;
  /** Thời điểm họp / mốc nhắc nhở (ISO). */
  start_at: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  project?: Pick<Project, 'id' | 'name'>;
  creator?: Pick<Profile, 'id' | 'name' | 'avatar_url'>;
}

export interface Notification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  message: string;
  is_read: boolean;
  created_at: string;
}

export interface Comment {
  id: string;
  task_id: string | null;
  project_id: string | null;
  user_id: string;
  content: string;
  created_at: string;
  profile?: Profile;
}
