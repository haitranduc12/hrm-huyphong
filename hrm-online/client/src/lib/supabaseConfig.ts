// ============================================================================
// Supabase configuration resolver.
// Reads config from Vite env vars first, then falls back to a value saved in
// localStorage (set via the /setup page). This lets the app run on any machine
// without forcing developers to edit .env files.
// ============================================================================

const STORAGE_KEY = 'ppms_supabase_config';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}


export function getSupabaseConfig(): SupabaseConfig | null {
  const envUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
  const envKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();

  if (envUrl && envKey) {
    return { url: envUrl, anonKey: envKey };
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const cfg = JSON.parse(raw) as SupabaseConfig;
      if (cfg.url && cfg.anonKey) return cfg;
    }
  } catch {
    /* ignore */
  }


  return null;
}

export function saveSupabaseConfig(cfg: SupabaseConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function isSupabaseConfigured(): boolean {
  return getSupabaseConfig() !== null;
}
