import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface ViewModeContextValue {
  viewAs: 'admin' | 'staff';
  setViewAs: (mode: 'admin' | 'staff') => void;
}

const ViewModeContext = createContext<ViewModeContextValue | undefined>(undefined);

export function ViewModeProvider({ children }: { children: ReactNode }) {
  const [viewAs, setViewAsState] = useState<'admin' | 'staff'>(() =>
    typeof window !== 'undefined' && window.sessionStorage.getItem('hrm:view-as') === 'staff'
      ? 'staff'
      : 'admin',
  );
  const setViewAs = useCallback((mode: 'admin' | 'staff') => {
    setViewAsState(mode);
    window.sessionStorage.setItem('hrm:view-as', mode);
  }, []);
  return (
    <ViewModeContext.Provider value={{ viewAs, setViewAs }}>
      {children}
    </ViewModeContext.Provider>
  );
}

export function useViewMode() {
  const ctx = useContext(ViewModeContext);
  if (!ctx) throw new Error('useViewMode must be used within ViewModeProvider');
  return ctx;
}
