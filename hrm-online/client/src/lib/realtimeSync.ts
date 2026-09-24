// ============================================================================
// Đồng bộ thời gian thực giữa các phiên đang mở.
// ----------------------------------------------------------------------------
// Cách cũ là ghép thẳng payload của Postgres vào mảng đang hiển thị. Cách đó
// hỏng với mọi truy vấn có join: payload chỉ chứa các cột của chính bảng đó,
// không bao giờ kèm bảng được join. Ví dụ danh sách thành viên nạp bằng
//     .select('*, profile:profiles(*)')
// nhưng payload realtime của `project_members` không có `profile`, nên người
// vừa được thêm hiện ra thiếu cả tên lẫn email cho tới khi tải lại trang.
//
// Cách hiện tại: coi sự kiện realtime chỉ là tín hiệu "có gì đó đổi", rồi nạp
// lại bằng đúng truy vấn ban đầu. Chậm hơn một nhịp mạng nhưng luôn khớp với
// những gì RLS cho phép người dùng thấy, và không còn cả một lớp lỗi dữ liệu
// hiển thị dở dang.
// ============================================================================

import { supabase } from './supabase';

export interface RealtimeSub {
  table: string;
  /** Bộ lọc phía server, ví dụ `project_id=eq.<uuid>`. */
  filter?: string;
}

/**
 * Lắng nghe nhiều bảng trên một kênh duy nhất. Mỗi kênh là một WebSocket
 * subscription; gộp lại để một trang không mở ra bốn năm kênh song song.
 */
export function subscribeToTables(
  subs: RealtimeSub[],
  onChange: () => void,
  channelName: string,
) {
  const channel = supabase.channel(channelName);

  for (const { table, filter } of subs) {
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) },
      () => onChange(),
    );
  }

  channel.subscribe();
  return channel;
}
