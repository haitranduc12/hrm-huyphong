// ============================================================================
// Tải động một trang, tự phục hồi khi bản build đã đổi.
// ----------------------------------------------------------------------------
// App chia thành 109 mảnh, tên mảnh gắn mã băm nội dung. Sau mỗi lần deploy,
// tab đang mở vẫn giữ `index.html` CŨ — nó trỏ tới những mảnh mang mã băm cũ,
// mà máy chủ không còn phục vụ nữa.
//
// Hệ quả: người dùng bấm vào một trang chưa từng mở trong phiên đó và nhận
// màn hình trắng kèm "Failed to fetch dynamically imported module". Nhìn hệt
// như tính năng bị mất. Bản cài lên màn hình chính bị nặng hơn vì nó ở mở
// hàng ngày, có khi cả tuần không đóng.
//
// Cách xử lý: lần nhập đầu hỏng thì TẢI LẠI TRANG một lần. Tải lại sẽ lấy
// `index.html` mới với mã băm mới, và mọi thứ chạy tiếp.
//
// Chốt chặn chống lặp vô hạn nằm ở `sessionStorage`: nếu vừa tải lại vì đúng
// module này mà vẫn hỏng, thì đây là lỗi thật (mất mạng, chunk hỏng) chứ không
// phải bản build cũ — khi đó ném lỗi ra cho Suspense/ErrorBoundary xử lý thay
// vì quay vòng tải lại.
// ============================================================================

import { lazy, type ComponentType } from 'react';

/* eslint-disable @typescript-eslint/no-explicit-any -- React.lazy tự
   nhận ComponentType<any>; siết chặt hơn sẽ không khớp chữ ký của nó. */

const RELOAD_PREFIX = 'chunk-reload:';

export function lazyRoute<T extends ComponentType<any>>(
  /** Khóa ổn định để nhớ "đã thử tải lại vì module này rồi". */
  key: string,
  load: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    try {
      return await load();
    } catch (error) {
      const marker = RELOAD_PREFIX + key;
      const alreadyRetried = sessionStorage.getItem(marker) === '1';

      if (!alreadyRetried) {
        sessionStorage.setItem(marker, '1');
        window.location.reload();
        // Trả về một promise không bao giờ xong: trang đang tải lại, dựng ra
        // một màn hình lỗi chớp nhoáng chỉ làm người dùng hoang mang.
        return new Promise<never>(() => {});
      }

      sessionStorage.removeItem(marker);
      throw error;
    }
  });
}

/**
 * Xóa dấu vết sau khi vào được trang.
 *
 * Không xóa thì lần deploy SAU, đúng trang này hỏng lần đầu sẽ bị coi là "đã
 * thử rồi" và không được tải lại — tức là cơ chế phục hồi chỉ dùng được một
 * lần cho mỗi phiên.
 */
export function clearChunkReloadMarks(): void {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(RELOAD_PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {
    /* Trình duyệt chặn sessionStorage (chế độ riêng tư) — bỏ qua. */
  }
}
