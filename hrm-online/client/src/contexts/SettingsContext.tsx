// ============================================================================
// Cấu hình dùng chung, phát cho toàn app.
// ----------------------------------------------------------------------------
// Đặt BÊN TRONG AuthProvider vì RLS đòi đăng nhập mới đọc được `app_settings`:
// nạp lại mỗi khi phiên đăng nhập đổi, và nghe realtime để một quản lý sửa cấu
// hình thì mọi máy đang mở đổi theo ngay — đúng tinh thần "một nguồn sự thật".
// ============================================================================

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useRealtimeSync } from '@/hooks/useRealtimeSync';
import { DEFAULT_SETTINGS, fetchSettings, type AppSettings } from '@/lib/settings';
import { APP_TAGLINE } from '@/lib/branding';

interface SettingsContextValue {
  settings: AppSettings;
  /** Chưa nạp xong lần đầu — dùng để tránh chớp tên tổ chức mặc định. */
  loading: boolean;
  reload: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    // Chưa đăng nhập thì RLS chặn — giữ mặc định, không gọi cho phí.
    if (!profile) {
      setSettings(DEFAULT_SETTINGS);
      setLoading(false);
      return;
    }
    setSettings(await fetchSettings());
    setLoading(false);
  }, [profile]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Tiêu đề tab theo tên tổ chức — đổi tên trong Cấu hình là tab đổi theo.
  // Chưa đăng nhập thì giữ nguyên tiêu đề tĩnh trong index.html.
  useEffect(() => {
    if (profile) document.title = `${settings.orgName} — ${APP_TAGLINE}`;
  }, [profile, settings.orgName]);

  useRealtimeSync([{ table: 'app_settings' }], reload, {
    enabled: !!profile,
    channelKey: 'settings',
  });

  return (
    <SettingsContext.Provider value={{ settings, loading, reload }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings phải nằm trong SettingsProvider');
  return ctx;
}

/** Lối tắt cho nơi chỉ cần giá trị cấu hình. */
export function useAppSettings(): AppSettings {
  return useSettings().settings;
}
