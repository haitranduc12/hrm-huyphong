// ============================================================================
// Hook đăng ký realtime rồi nạp lại dữ liệu khi có thay đổi.
// ----------------------------------------------------------------------------
// Gộp chung ba việc mà trước đây mỗi trang tự làm một kiểu: mở kênh, gom sự
// kiện dồn dập, và hủy kênh khi rời trang.
// ============================================================================

import { useEffect, useRef } from 'react';
import { subscribeToTables, type RealtimeSub } from '@/lib/realtimeSync';

interface Options {
  /** Tạm ngưng lắng nghe, ví dụ khi chưa biết id cần lọc. */
  enabled?: boolean;
  /**
   * Gom các sự kiện xảy ra sát nhau thành một lần nạp lại. Một thao tác của
   * người dùng thường sinh nhiều sự kiện — thêm thành viên vừa ghi
   * `project_members` vừa ghi `notifications` — nạp lại từng cái là phí.
   */
  delayMs?: number;
  /**
   * Đặt tên riêng cho kênh khi HAI component cùng hiển thị đăng ký cùng một
   * bộ bảng — ví dụ AdminLayout (đếm badge) và trang Giao việc đều nghe
   * `daily_assignments`. Không đặt thì hai bên trùng tên kênh, supabase-js ném
   * "cannot add postgres_changes callbacks after subscribe()" và trang trắng.
   */
  channelKey?: string;
}

export function useRealtimeSync(
  subs: RealtimeSub[],
  refetch: () => void | Promise<void>,
  { enabled = true, delayMs = 300, channelKey = '' }: Options = {},
) {
  // Giữ hàm nạp lại trong ref để không phải đưa nó vào deps — hầu hết trang
  // định nghĩa hàm này ngay trong thân component nên mỗi lần render lại là một
  // hàm mới, đưa vào deps sẽ mở/đóng kênh liên tục.
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  // Tương tự với subs: so sánh theo nội dung thay vì theo tham chiếu mảng.
  const key = JSON.stringify(subs);

  useEffect(() => {
    if (!enabled) return;

    const list = JSON.parse(key) as RealtimeSub[];
    if (list.length === 0) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const channel = subscribeToTables(
      list,
      () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (!cancelled) void refetchRef.current();
        }, delayMs);
      },
      // Tên kênh phải khác nhau giữa các trang, nếu không hai trang cùng mở sẽ
      // giẫm lên nhau khi hủy đăng ký.
      `sync:${channelKey}${channelKey ? ':' : ''}${list.map((s) => s.table + (s.filter ?? '')).join('|')}`,
    );

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      channel.unsubscribe();
    };
  }, [key, enabled, delayMs, channelKey]);
}
