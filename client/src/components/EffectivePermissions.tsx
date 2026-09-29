// ============================================================================
// Quyền đang có hiệu lực của một người, kèm NGUỒN cấp.
// ----------------------------------------------------------------------------
// Quyền được gộp từ bốn nguồn bằng phép HOẶC: vai trò hệ thống, quyền lẻ của
// tài khoản, vai trò nghiệp vụ, và vị trí trong cơ cấu tổ chức. Nhìn vào giao
// diện cũ chỉ thấy KẾT QUẢ, không thấy vì sao.
//
// Hệ quả thực tế: người quản trị bỏ tick một quyền ở trang Hồ sơ & tài khoản,
// thấy nó vẫn còn, rồi kết luận "hệ thống lỗi" — trong khi quyền đó đến từ vị
// trí, phải gỡ ở Cơ cấu tổ chức. Bảng này chỉ thẳng ra phải sửa ở đâu.
// ============================================================================

import { Link } from 'react-router-dom';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import {
  explainPermissions, PERMISSION_LABELS,
  type PermissionSource,
} from '@/lib/permissions';
import type { Profile } from '@/types';

const SOURCE_META: Record<
  PermissionSource['kind'],
  { label: string; style: string; fixAt: string | null }
> = {
  FULL_ADMIN: {
    label: 'Admin/CEO',
    style: 'bg-violet-50 text-violet-700 border-violet-200',
    fixAt: null,
  },
  TEAMLEAD: {
    label: 'Trưởng nhóm',
    style: 'bg-blue-50 text-blue-700 border-blue-200',
    fixAt: null,
  },
  DIRECT: {
    label: 'Quyền lẻ',
    style: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    fixAt: 'Sửa ngay trên trang này',
  },
  ACCESS_ROLE: {
    label: 'Vai trò nghiệp vụ',
    style: 'bg-amber-50 text-amber-700 border-amber-200',
    fixAt: 'Sửa ở vai trò nghiệp vụ',
  },
  POSITION: {
    label: 'Vị trí',
    style: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    fixAt: 'Sửa ở Cơ cấu tổ chức → Vị trí',
  },
};

export function EffectivePermissions({ profile }: { profile: Profile }) {
  const effective = explainPermissions(profile);
  const fullAdmin = effective.some((e) => e.sources.some((s) => s.kind === 'FULL_ADMIN'));

  // Quyền đến từ nhiều nguồn cùng lúc là chỗ gỡ hụt hay xảy ra nhất.
  const multiSource = effective.filter((e) => e.sources.length > 1);

  if (effective.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
        <p className="text-xs font-bold text-slate-600">Quyền quản trị đang có hiệu lực</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          Không có quyền quản trị nào. Người này chỉ dùng được khu nhân viên.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-indigo-600" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-slate-700">
            Quyền quản trị đang có hiệu lực ({effective.length})
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
            {fullAdmin
              ? 'Vai trò Admin/CEO có sẵn mọi quyền — không cấp phát từng cái, nên không gỡ lẻ được.'
              : 'Mỗi quyền ghi rõ đến từ đâu. Muốn gỡ thì phải gỡ ở ĐÚNG nguồn đã cấp.'}
          </p>
        </div>
      </div>

      {multiSource.length > 0 && (
        <p className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-800">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>
            {multiSource.length} quyền đến từ <strong>nhiều nguồn cùng lúc</strong>. Bỏ tick ở một
            chỗ sẽ không gỡ được — phải gỡ ở tất cả các nguồn ghi bên dưới.
          </span>
        </p>
      )}

      <ul className="mt-3 space-y-1.5">
        {effective.map(({ permission, sources }) => (
          <li key={permission} className="flex flex-wrap items-center gap-2">
            <span className="min-w-[8.5rem] text-xs font-semibold text-slate-700">
              {PERMISSION_LABELS[permission]?.label ?? permission}
            </span>
            {sources.map((source) => {
              const meta = SOURCE_META[source.kind];
              return (
                <span
                  key={source.kind}
                  title={meta.fixAt ?? undefined}
                  className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${meta.style}`}
                >
                  {meta.label}
                </span>
              );
            })}
          </li>
        ))}
      </ul>

      {effective.some((e) => e.sources.some((s) => s.kind === 'POSITION')) && (
        <p className="mt-3 border-t border-slate-100 pt-2.5 text-[11px] leading-relaxed text-slate-500">
          Quyền gắn nhãn <strong className="text-indigo-700">Vị trí</strong> đến từ chức danh của
          người này, gỡ ở{' '}
          <Link to="/admin/organization?tab=positions" className="font-semibold text-indigo-600 hover:text-indigo-700">
            Cơ cấu tổ chức → Vị trí
          </Link>
          . Gỡ ở đó sẽ ảnh hưởng tới <strong>mọi người</strong> giữ cùng vị trí.
        </p>
      )}
    </div>
  );
}
