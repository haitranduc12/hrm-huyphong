// ============================================================================
// Nhận diện thương hiệu — nguồn duy nhất.
// ----------------------------------------------------------------------------
// Tên app trước đây được viết cứng ở 8 chỗ khác nhau, đổi tên là phải lục từng
// file. Giờ mọi nơi đọc từ đây.
//
// LƯU Ý: `INTERNAL_EMAIL_DOMAIN` trong `lib/identity.ts` KHÔNG nằm trong file
// này và KHÔNG được đổi theo tên thương hiệu — nó là một phần định danh đăng
// nhập đã lưu trong database. Xem giải thích tại đó.
// ============================================================================

/** Tên hiển thị đầy đủ. */
export const APP_NAME = 'Huy Phong Wine HRM';

/** Tên ngắn cho chỗ hẹp (tab trình duyệt, sidebar thu gọn). */
export const APP_SHORT_NAME = 'Huy Phong Wine';

export const APP_TAGLINE = 'Quản trị nhân sự và vận hành xuất khẩu rượu vang';

// ---------------------------------------------------------------------------
// HAI FILE TĨNH PHẢI SỬA TAY khi đổi tên — chúng không import được từ đây:
//
//   client/index.html                 <title>, apple-mobile-web-app-title,
//                                     meta description, favicon nội tuyến
//   client/public/manifest.webmanifest  name, short_name, description
//
// Đã có lần cả hai file lệch khỏi giá trị ở trên ("HRM Huy Phong" thay vì
// "Huy Phong Wine HRM") mà không ai thấy, vì tên chỉ hiện trên tab trình
// duyệt và màn hình chính của điện thoại.
// ---------------------------------------------------------------------------
