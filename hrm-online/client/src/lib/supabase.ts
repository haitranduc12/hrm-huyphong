// ============================================================================
// Supabase client (real backend with safe dummy fallback).
// ----------------------------------------------------------------------------
// Creates a real Supabase client when configured, or a safe dummy client when
// unconfigured, so pages never throw null pointer errors during testing or dev.
// ============================================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseConfig } from './supabaseConfig';

const cfg = getSupabaseConfig();

function createDummyClient(): SupabaseClient {
  const dummyBuilder: any = {
    select: () => dummyBuilder,
    insert: () => dummyBuilder,
    update: () => dummyBuilder,
    upsert: () => dummyBuilder,
    delete: () => dummyBuilder,
    eq: () => dummyBuilder,
    neq: () => dummyBuilder,
    gt: () => dummyBuilder,
    gte: () => dummyBuilder,
    lt: () => dummyBuilder,
    lte: () => dummyBuilder,
    like: () => dummyBuilder,
    ilike: () => dummyBuilder,
    is: () => dummyBuilder,
    in: () => dummyBuilder,
    contains: () => dummyBuilder,
    containedBy: () => dummyBuilder,
    range: () => dummyBuilder,
    order: () => dummyBuilder,
    limit: () => dummyBuilder,
    offset: () => dummyBuilder,
    single: async () => ({ data: null, error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (val: any) => void) => Promise.resolve({ data: [], error: null, count: 0 }).then(resolve),
    catch: (reject: (val: any) => void) => Promise.resolve({ data: [], error: null, count: 0 }).catch(reject),
  };

  const dummyAuth: any = {
    getUser: async () => ({ data: { user: null }, error: null }),
    getSession: async () => ({ data: { session: null }, error: null }),
    signInWithPassword: async () => ({ data: { user: null, session: null }, error: null }),
    signUp: async () => ({ data: { user: null, session: null }, error: null }),
    signOut: async () => ({ error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  };

  const dummyChannel: any = {
    on: () => dummyChannel,
    subscribe: () => dummyChannel,
    unsubscribe: () => {},
  };

  return {
    from: () => dummyBuilder,
    channel: () => dummyChannel,
    removeChannel: () => {},
    removeAllChannels: () => {},
    auth: dummyAuth,
    rpc: async () => ({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

export const supabase: SupabaseClient = cfg
  ? createClient(cfg.url, cfg.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : createDummyClient();

/** Create a new client from explicit credentials (used by the /setup page). */
export function createSupabaseClient(url: string, anonKey: string): SupabaseClient {
  if (!url || !anonKey) return createDummyClient();
  return createClient(url, anonKey);
}
