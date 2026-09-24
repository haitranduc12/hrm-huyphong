// ============================================================================
// Chính sách mật khẩu dùng chung cho toàn bộ luồng auth.
// Yêu cầu: tối thiểu 8 ký tự, có cả chữ và số.
// ============================================================================

export const PASSWORD_MIN_LENGTH = 8;

export interface PasswordRule {
  label: string;
  ok: boolean;
}

export function passwordRules(pwd: string): PasswordRule[] {
  return [
    { label: `Ít nhất ${PASSWORD_MIN_LENGTH} ký tự`, ok: pwd.length >= PASSWORD_MIN_LENGTH },
    { label: 'Có chữ cái (a-z, A-Z)', ok: /[A-Za-z]/.test(pwd) },
    { label: 'Có chữ số (0-9)', ok: /\d/.test(pwd) },
  ];
}

/** Trả về thông báo lỗi đầu tiên, hoặc null nếu mật khẩu hợp lệ. */
export function validatePassword(pwd: string): string | null {
  if (pwd.length < PASSWORD_MIN_LENGTH) return `Mật khẩu phải có ít nhất ${PASSWORD_MIN_LENGTH} ký tự.`;
  if (!/[A-Za-z]/.test(pwd)) return 'Mật khẩu phải chứa ít nhất một chữ cái.';
  if (!/\d/.test(pwd)) return 'Mật khẩu phải chứa ít nhất một chữ số.';
  return null;
}

export interface PasswordStrength {
  label: string;
  color: string;
  bar: string;
}

export function getPasswordStrength(pwd: string): PasswordStrength {
  if (pwd.length === 0) return { label: '', color: 'bg-slate-200', bar: '' };

  let score = 0;
  if (pwd.length >= PASSWORD_MIN_LENGTH) score++;
  if (pwd.length >= 12) score++;
  if (/[a-z]/.test(pwd)) score++;
  if (/[A-Z]/.test(pwd)) score++;
  if (/\d/.test(pwd)) score++;
  if (/[^A-Za-z0-9]/.test(pwd)) score++;

  if (score <= 2) return { label: 'Yếu', color: 'bg-red-500', bar: 'w-1/4' };
  if (score <= 4) return { label: 'Trung bình', color: 'bg-amber-500', bar: 'w-2/4' };
  return { label: 'Mạnh', color: 'bg-emerald-500', bar: 'w-full' };
}
