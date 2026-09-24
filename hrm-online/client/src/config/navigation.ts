import type { LucideIcon } from 'lucide-react';
import {
  BarChart3, BookOpen, BriefcaseBusiness, CalendarDays, CalendarOff, ClipboardCheck,
  ClipboardList, Clock, ContactRound, Factory, FileWarning, FolderKanban, LayoutDashboard,
  LayoutGrid, MapPinned, Network, NotebookPen, Rocket, Settings, SlidersHorizontal, Table,
  Target, ToggleLeft, UserSearch, Users, Wallet,
} from 'lucide-react';
import type { AdminFunctionCode, AdminPermission } from '@/lib/permissions';

export interface AdminNavItem {
  to: string;
  label: string;
  description: string;
  icon: LucideIcon;
  permission: AdminPermission;
  anyPermissions?: AdminPermission[];
  group: string;
  keywords?: string;
  fullAdminOnly?: boolean;
  functionCode?: AdminFunctionCode;
  hideForTeamlead?: boolean;
}

/**
 * Một nguồn điều hướng duy nhất cho sidebar và tìm kiếm nhanh.
 * Thứ tự phản ánh vòng đời nghiệp vụ: thiết lập tổ chức → thu hút/tiếp nhận
 * nhân sự → vận hành công việc & thời gian → phát triển → hệ thống.
 */
export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { to: '/admin/overview', label: 'Tổng quan điều hành', description: 'Toàn cảnh nhân sự và các cảnh báo cần xử lý', icon: LayoutGrid, permission: 'reports', group: 'Tổng quan', keywords: 'dieu hanh canh bao', functionCode: 'admin.overview' },
  { to: '/admin/dashboard', label: 'Dashboard nhân sự', description: 'Chỉ số nhân sự, công việc và hiện diện hôm nay', icon: LayoutDashboard, permission: 'reports', group: 'Tổng quan', keywords: 'chi so nhan su hien dien' },
  { to: '/admin/reports', label: 'Báo cáo & phân tích', description: 'Theo dõi xu hướng và xuất dữ liệu tổng hợp', icon: BarChart3, permission: 'reports', group: 'Tổng quan', keywords: 'thong ke bieu do xuat du lieu' },

  { to: '/admin/organization', label: 'Cơ cấu tổ chức', description: 'Đơn vị, vị trí và tuyến quản lý', icon: Network, permission: 'users', group: 'Tổ chức & Nhân sự', keywords: 'co cau don vi phong ban chi nhanh vi tri tuyen quan ly' },
  { to: '/admin/users', label: 'Hồ sơ & tài khoản', description: 'Danh bạ nhân viên, vai trò và quyền truy cập', icon: Users, permission: 'users', group: 'Tổ chức & Nhân sự', keywords: 'danh ba nhan vien tai khoan phan quyen user' },
  { to: '/admin/employee-lifecycle', label: 'Hội nhập & nghỉ việc', description: 'Checklist onboarding, offboarding và người hướng dẫn', icon: Rocket, permission: 'users', group: 'Tổ chức & Nhân sự', keywords: 'onboarding offboarding checklist mentor', functionCode: 'admin.employee_lifecycle' },

  { to: '/admin/recruitment', label: 'Tuyển dụng nội bộ', description: 'Yêu cầu tuyển, SLA phê duyệt và pipeline ứng viên', icon: UserSearch, permission: 'users', anyPermissions: ['users', 'projects'], group: 'Tuyển dụng & Cung ứng', keywords: 'yeu cau tuyen ung vien phong van offer noi bo' },
  { to: '/admin/recruitment-orders', label: 'Đơn hàng cung ứng', description: 'Chỉ tiêu và tiến độ cung ứng lao động cho đối tác', icon: BriefcaseBusiness, permission: 'users', group: 'Tuyển dụng & Cung ứng', keywords: 'don hang chi tieu cung ung lao dong nhat ban', functionCode: 'admin.recruitment_orders' },
  { to: '/admin/workforce-partners', label: 'Đối tác tuyển dụng', description: 'Doanh nghiệp tiếp nhận, nghiệp đoàn và đơn vị liên kết', icon: Factory, permission: 'users', group: 'Tuyển dụng & Cung ứng', keywords: 'doanh nghiep nghiep doan doi tac', functionCode: 'admin.workforce_partners' },
  { to: '/admin/workforce', label: 'Hồ sơ người lao động', description: 'Thông tin và tiến trình tuyển chọn của người lao động', icon: ContactRound, permission: 'users', group: 'Tuyển dụng & Cung ứng', keywords: 'ung vien nguoi lao dong xuat khau', functionCode: 'admin.workforce' },
  { to: '/admin/worker-documents', label: 'Hồ sơ giấy tờ', description: 'Theo dõi hợp đồng, visa và tài liệu lao động', icon: FileWarning, permission: 'users', group: 'Tuyển dụng & Cung ứng', keywords: 'hop dong visa tai lieu giay to', functionCode: 'admin.worker_documents' },

  { to: '/admin/projects', label: 'Dự án', description: 'Dự án, thành viên, mốc và tác vụ', icon: FolderKanban, permission: 'projects', group: 'Công việc & Dự án', keywords: 'project tac vu' },
  { to: '/admin/assignments', label: 'Giao việc hằng ngày', description: 'Phân công và xác nhận kết quả công việc trong ngày', icon: ClipboardList, permission: 'attendance', group: 'Công việc & Dự án', keywords: 'giao viec phan cong xac nhan' },
  { to: '/admin/worklog', label: 'Nhật ký giờ', description: 'Đối chiếu thời gian thực tế theo người và tác vụ', icon: NotebookPen, permission: 'reports', group: 'Công việc & Dự án', keywords: 'gio cong worklog timesheet' },

  { to: '/admin/shifts', label: 'Lịch & ca làm', description: 'Phân ca, duyệt đăng ký và đối chiếu hiện diện', icon: CalendarDays, permission: 'shifts', group: 'Thời gian & Nghỉ phép', keywords: 'lich ca lam' },
  { to: '/admin/attendance-settings', label: 'Thiết lập công & chấm công', description: 'Giờ chuẩn và hạn mức mặc định cho thời gian, nghỉ phép', icon: SlidersHorizontal, permission: 'attendance', group: 'Thời gian & Nghỉ phép', keywords: 'cau hinh cong cham cong gio chuan phep nam', functionCode: 'admin.attendance_settings' },
  { to: '/admin/work-locations', label: 'Điểm chấm công', description: 'Địa điểm GPS, bán kính và WiFi văn phòng', icon: MapPinned, permission: 'settings', group: 'Thời gian & Nghỉ phép', keywords: 'gps wifi bssid dia diem', functionCode: 'admin.work_locations' },
  { to: '/admin/attendance', label: 'Duyệt chấm công', description: 'Kiểm tra check-in, check-out và xác nhận ngày công', icon: Clock, permission: 'attendance', group: 'Thời gian & Nghỉ phép', keywords: 'check in out ngay cong' },
  { to: '/admin/leave', label: 'Nghỉ phép', description: 'Duyệt đơn và quản lý hạn mức phép năm', icon: CalendarOff, permission: 'leave', group: 'Thời gian & Nghỉ phép', keywords: 'don xin nghi quy phep' },
  { to: '/admin/timesheet', label: 'Bảng công tháng', description: 'Tổng hợp ngày công đã duyệt và xuất Excel', icon: Table, permission: 'attendance', group: 'Thời gian & Nghỉ phép', keywords: 'bang cong xuat excel timesheet', hideForTeamlead: true },

  { to: '/admin/payroll', label: 'Bảng lương', description: 'Tính lương từ công đã duyệt và phép hưởng lương', icon: Wallet, permission: 'attendance', group: 'Lương & Đãi ngộ', keywords: 'tinh luong payroll thuc nhan phu cap', functionCode: 'admin.payroll' },

  { to: '/admin/training', label: 'Đào tạo', description: 'Khóa học, phân công và tiến độ học tập', icon: BookOpen, permission: 'training', group: 'Phát triển nhân sự', keywords: 'dao tao khoa hoc hoc tap' },
  { to: '/admin/performance', label: 'KPI & đánh giá', description: 'Mục tiêu, chu kỳ và kết quả hiệu suất', icon: Target, permission: 'reports', group: 'Phát triển nhân sự', keywords: 'kpi okr hieu suat danh gia', functionCode: 'admin.performance_manage' },

  { to: '/admin/settings', label: 'Cấu hình hệ thống', description: 'Thiết lập vận hành dùng chung toàn tổ chức', icon: Settings, permission: 'settings', group: 'Hệ thống', keywords: 'cau hinh thiet lap' },
  { to: '/admin/feature-flags', label: 'Tính năng thử nghiệm', description: 'Bật hoặc tắt an toàn các chức năng mới', icon: ToggleLeft, permission: 'settings', group: 'Hệ thống', keywords: 'feature flags bat tat', functionCode: 'admin.feature_flags' },
  { to: '/admin/audit', label: 'Nhật ký hệ thống', description: 'Truy vết thay đổi dữ liệu và thao tác quản trị', icon: ClipboardCheck, permission: 'settings', group: 'Hệ thống', keywords: 'audit log lich su truy vet', functionCode: 'admin.audit' },
];
