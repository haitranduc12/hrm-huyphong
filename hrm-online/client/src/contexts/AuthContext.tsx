import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import type { Profile, SystemRole } from '@/types';
import {
  getCurrentUser,
  signIn as signInApi,
  signOut as signOutApi,
  updateProfile,
  getUsers,
  adminCreateUser,
  adminResetPassword,
  adminDeleteUser,
  changeOwnPassword,
} from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { isSupabaseConfigured } from '@/lib/supabaseConfig';

interface AuthContextValue {
  profile: Profile | null;
  loading: boolean;
  supabaseConfigured: boolean;
  /** `identifier` là tên đăng nhập hoặc email. */
  signIn: (identifier: string, password: string) => Promise<{ error: string | null }>;
  /** Đăng nhập nhanh theo vai trò (Admin / Team Lead / Staff) */
  signInAsRole: (role: SystemRole) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  /** Admin cấp tài khoản. Trả về mật khẩu tạm để bàn giao cho nhân viên. */
  createUser: (data: { name: string; identifier: string; role: SystemRole; access_role_code?: string; department?: string; permissions?: string[] }) => Promise<{ error: string | null; tempPassword?: string; email?: string }>;
  updateUser: (id: string, updates: Partial<Pick<Profile, 'name' | 'role' | 'access_role_code' | 'department' | 'is_active' | 'permissions'>>) => Promise<{ error: string | null }>;
  /** `partial` = chỉ xóa được hồ sơ, bản ghi đăng nhập trong auth.users vẫn còn. */
  deleteUser: (id: string) => Promise<{ error: string | null; partial?: boolean }>;
  /** Admin cấp lại mật khẩu tạm mới. */
  resetUserPassword: (id: string) => Promise<{ error: string | null; tempPassword?: string }>;
  /** Người dùng tự đổi mật khẩu — bắt buộc nhập mật khẩu cũ. */
  changePassword: (oldPassword: string, newPassword: string) => Promise<{ error: string | null }>;
  users: Profile[];
  loadUsers: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const DEMO_PROFILES: Record<string, Profile> = {
  admin: {
    id: 'demo-admin-id',
    name: 'Quản Trị Viên (Admin)',
    email: 'admin@hrm.vn',
    role: 'admin',
    access_role_code: null,
    department: 'Ban Giám Đốc',
    employee_code: 'ADM001',
    unit_id: null,
    position_id: null,
    manager_id: null,
    hire_date: '2024-01-01',
    employment_status: 'active',
    phone: '0901234567',
    avatar_url: null,
    is_active: true,
    must_change_password: false,
    permissions: ['users', 'projects', 'reports', 'attendance', 'shifts', 'leave', 'training', 'settings'],
    position_permissions: [],
    function_permissions: [
      'admin.overview',
      'admin.workforce',
      'admin.recruitment_orders',
      'admin.workforce_partners',
      'admin.worker_documents',
      'admin.employee_lifecycle',
      'admin.performance_manage',
      'admin.work_locations',
      'admin.feature_flags',
      'admin.attendance_settings',
      'admin.payroll',
      'admin.audit',
    ],
    annual_leave_quota: 14,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  teamlead: {
    id: 'demo-lead-id',
    name: 'Trưởng Nhóm (Team Lead)',
    email: 'lead@hrm.vn',
    role: 'teamlead',
    access_role_code: null,
    department: 'Kỹ Thuật',
    employee_code: 'TL001',
    unit_id: null,
    position_id: null,
    manager_id: null,
    hire_date: '2024-01-01',
    employment_status: 'active',
    phone: '0902345678',
    avatar_url: null,
    is_active: true,
    must_change_password: false,
    permissions: ['projects', 'reports', 'attendance', 'shifts', 'leave'],
    position_permissions: [],
    function_permissions: [],
    annual_leave_quota: 12,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  staff: {
    id: 'demo-staff-id',
    name: 'Nhân Viên (Staff)',
    email: 'staff@hrm.vn',
    role: 'staff',
    access_role_code: null,
    department: 'Phát Triển',
    employee_code: 'NV001',
    unit_id: null,
    position_id: null,
    manager_id: null,
    hire_date: '2024-02-01',
    employment_status: 'active',
    phone: '0903456789',
    avatar_url: null,
    is_active: true,
    must_change_password: false,
    permissions: [],
    position_permissions: [],
    function_permissions: [],
    annual_leave_quota: 12,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [supabaseConfigured] = useState(isSupabaseConfigured());

  const loadUsers = useCallback(async () => {
    setUsers(await getUsers());
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const savedDemo = localStorage.getItem('ppms_demo_profile');
      if (savedDemo) {
        try {
          const parsed = JSON.parse(savedDemo) as Profile;
          if (active) {
            setProfile(parsed);
            setLoading(false);
            return;
          }
        } catch {
          localStorage.removeItem('ppms_demo_profile');
        }
      }

      if (supabaseConfigured) {
        const current = await getCurrentUser();
        if (!active) return;
        if (current) {
          setProfile(current);
          await loadUsers();
        }
      }
      if (active) setLoading(false);
    })();

    const { data: sub } = supabaseConfigured && supabase ? supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        localStorage.removeItem('ppms_demo_profile');
        setProfile(null);
        setUsers([]);
      }
    }) : { data: { subscription: { unsubscribe: () => {} } } };

    return () => {
      active = false;
      sub?.subscription?.unsubscribe();
    };
  }, [loadUsers, supabaseConfigured]);

  /**
   * Theo dõi bảng `profiles` để quyền có hiệu lực ngay.
   *
   * Trước đây admin cấp quyền xong thì phiên của người được cấp vẫn giữ hồ sơ
   * nạp lúc đăng nhập: menu không mọc thêm mục nào, và họ tưởng việc cấp quyền
   * thất bại. Phải đăng xuất rồi đăng nhập lại mới thấy.
   *
   * Lưu ý: cái này chỉ đồng bộ phía giao diện. Quyền thực sự do RLS trong
   * database quyết định — hai bên phải khớp nhau thì hệ thống mới đúng.
   */
  useEffect(() => {
    if (!supabaseConfigured || !profile) return;

    const myId = profile.id;
    const channel = supabase
      .channel(`auth:profiles:${myId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'profiles' },
        (payload) => {
          const row = (payload.new ?? payload.old) as { id?: string } | null;
          void loadUsers();
          // Chỉ nạp lại hồ sơ của chính mình khi đúng dòng đó đổi, tránh gọi
          // getCurrentUser() mỗi lần bất kỳ ai trong công ty được sửa.
          if (row?.id === myId) {
            void (async () => {
              const current = await getCurrentUser();
              if (current) setProfile(current);
            })();
          }
        },
      );
    channel.subscribe();

    // Quyền mặc định có thể đổi ở cấp vị trí/chức danh. Cập nhật phiên hiện
    // tại ngay khi mẫu quyền của đúng vị trí thay đổi, không cần đăng xuất.
    const positionChannel = supabase
      .channel(`auth:position-permissions:${myId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'job_position_permissions' },
        (payload) => {
          const row = (payload.new ?? payload.old) as { position_id?: string } | null;
          if (row?.position_id === profile.position_id) {
            void (async () => {
              const current = await getCurrentUser();
              if (current) setProfile(current);
            })();
          }
        },
      );
    positionChannel.subscribe();

    const positionFunctionChannel = supabase
      .channel(`auth:position-functions:${myId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'job_position_function_permissions' },
        (payload) => {
          const row = (payload.new ?? payload.old) as { position_id?: string } | null;
          if (row?.position_id === profile.position_id) {
            void (async () => {
              const current = await getCurrentUser();
              if (current) setProfile(current);
            })();
          }
        },
      );
    positionFunctionChannel.subscribe();

    // Đồng bộ ngay khi Admin sửa mẫu vai trò nghiệp vụ trong Cấu hình hệ
    // thống. Không cần bắt nhân viên đăng xuất/đăng nhập lại để quyền mới có
    // hiệu lực trên giao diện (RLS ở database vẫn là hàng rào cuối cùng).
    const accessRoleChannel = supabase
      .channel(`auth:access-role:${myId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'system_access_roles' },
        (payload) => {
          const row = (payload.new ?? payload.old) as { code?: string } | null;
          if (row?.code === profile.access_role_code) {
            void (async () => {
              const current = await getCurrentUser();
              if (current) setProfile(current);
            })();
          }
        },
      );
    accessRoleChannel.subscribe();

    const accessRoleFunctionChannel = supabase
      .channel(`auth:access-role-functions:${myId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'system_access_role_functions' },
        (payload) => {
          const row = (payload.new ?? payload.old) as { access_role_code?: string } | null;
          if (row?.access_role_code === profile.access_role_code) {
            void (async () => {
              const current = await getCurrentUser();
              if (current) setProfile(current);
            })();
          }
        },
      );
    accessRoleFunctionChannel.subscribe();

    return () => { channel.unsubscribe(); positionChannel.unsubscribe(); positionFunctionChannel.unsubscribe(); accessRoleChannel.unsubscribe(); accessRoleFunctionChannel.unsubscribe(); };
  }, [supabaseConfigured, profile?.id, profile?.position_id, profile?.access_role_code, loadUsers]);

  const signInAsRole = async (role: SystemRole) => {
    const demoProf = DEMO_PROFILES[role] || DEMO_PROFILES.staff;
    if (supabaseConfigured) {
      try {
        const res = await signInApi(demoProf.email, 'AdminPassword123!');
        if (res.user) {
          localStorage.removeItem('ppms_demo_profile');
          setProfile(res.user);
          await loadUsers();
          return { error: null };
        }
      } catch {
        /* fallback */
      }
    }
    localStorage.setItem('ppms_demo_profile', JSON.stringify(demoProf));
    setProfile(demoProf);
    return { error: null };
  };

  const signIn = async (identifier: string, password: string) => {
    if (supabaseConfigured) {
      const result = await signInApi(identifier, password);
      if (!result.error && result.user) {
        localStorage.removeItem('ppms_demo_profile');
        setProfile(result.user);
        await loadUsers();
        return { error: null };
      }
    }
    // Fallback: determine role from identifier
    const idLower = identifier.toLowerCase();
    let targetRole: SystemRole = 'staff';
    if (idLower.includes('admin') || idLower.includes('ceo')) targetRole = 'admin';
    else if (idLower.includes('lead')) targetRole = 'teamlead';

    const demoProf = DEMO_PROFILES[targetRole] || DEMO_PROFILES.admin;
    localStorage.setItem('ppms_demo_profile', JSON.stringify(demoProf));
    setProfile(demoProf);
    return { error: null };
  };

  const signOut = async () => {
    localStorage.removeItem('ppms_demo_profile');
    if (supabaseConfigured && supabase) {
      await signOutApi();
    }
    setProfile(null);
    setUsers([]);
  };

  const refreshProfile = async () => {
    const savedDemo = localStorage.getItem('ppms_demo_profile');
    if (savedDemo) {
      try {
        setProfile(JSON.parse(savedDemo) as Profile);
        return;
      } catch {
        localStorage.removeItem('ppms_demo_profile');
      }
    }
    const current = await getCurrentUser();
    setProfile(current);
    if (current) await loadUsers();
  };

  const createUser = async (data: { name: string; identifier: string; role: SystemRole; access_role_code?: string; department?: string; permissions?: string[] }) => {
    const result = await adminCreateUser(data);
    if (result.error) return { error: result.error };
    await loadUsers();
    return { error: null, tempPassword: result.tempPassword, email: result.email };
  };

  const resetUserPassword = async (id: string) => {
    const result = await adminResetPassword(id);
    if (result.error) return { error: result.error };
    await loadUsers();
    return { error: null, tempPassword: result.tempPassword };
  };

  const changePassword = async (oldPassword: string, newPassword: string) => {
    if (!profile) return { error: 'Chưa đăng nhập.' };
    const savedDemo = localStorage.getItem('ppms_demo_profile');
    if (savedDemo) {
      const updated = { ...profile, must_change_password: false };
      localStorage.setItem('ppms_demo_profile', JSON.stringify(updated));
      setProfile(updated);
      return { error: null };
    }
    const result = await changeOwnPassword(profile.email, oldPassword, newPassword);
    if (result.error) return { error: result.error };
    setProfile({ ...profile, must_change_password: false });
    return { error: null };
  };

  const updateUser = async (id: string, updates: Partial<Pick<Profile, 'name' | 'role' | 'access_role_code' | 'department' | 'is_active' | 'permissions'>>) => {
    const result = await updateProfile(id, updates);
    if (result.error) return { error: result.error };
    await loadUsers();
    if (profile && profile.id === id) {
      const current = await getCurrentUser();
      if (current) setProfile(current);
    }
    return { error: null };
  };

  const deleteUser = async (id: string) => {
    const result = await adminDeleteUser(id);
    if (result.error) return { error: result.error };
    await loadUsers();
    return { error: null, partial: result.partial };
  };

  return (
    <AuthContext.Provider
      value={{
        profile,
        loading,
        supabaseConfigured,
        signIn,
        signInAsRole,
        signOut,
        refreshProfile,
        createUser,
        updateUser,
        deleteUser,
        resetUserPassword,
        changePassword,
        users,
        loadUsers,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
