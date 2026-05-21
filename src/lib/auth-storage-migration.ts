'use client';

/**
 * One-time legacy-session migration shim.
 *
 * Before this batch, the browser Supabase client persisted sessions to
 * `localStorage` under the key `staxis-auth`. After the migration to
 * `@supabase/ssr` (cookies as storage), users with an existing session
 * in localStorage would silently lose it on first page load.
 *
 * This helper runs once on app mount. If a legacy localStorage entry
 * exists, it pulls the access_token + refresh_token out of it and
 * forwards them to `supabase.auth.setSession`, which the SSR client
 * writes to cookies. The localStorage entry is then removed.
 *
 * Future-cleanup note: once we're confident no active sessions remain in
 * localStorage (a few weeks after the deploy), the entire helper can be
 * deleted along with the AuthContext call site. Safe to leave indefinitely
 * — once localStorage is empty the helper is a no-op fast path.
 */
import { supabase } from '@/lib/supabase';

const LEGACY_STORAGE_KEY = 'staxis-auth';

export async function migrateLegacySessionIfPresent(): Promise<void> {
  if (typeof window === 'undefined') return;

  let raw: string | null;
  try {
    raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    // Private browsing / storage disabled — nothing to migrate.
    return;
  }
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw) as unknown;
    // supabase-js v2 wrote sessions as either { currentSession: { access_token, refresh_token, ... } }
    // (older versions) or as the bare session object (newer versions). Handle both.
    const inner =
      typeof parsed === 'object' && parsed !== null && 'currentSession' in parsed
        ? (parsed as { currentSession?: unknown }).currentSession
        : parsed;

    if (typeof inner === 'object' && inner !== null) {
      const obj = inner as { access_token?: unknown; refresh_token?: unknown };
      if (typeof obj.access_token === 'string' && typeof obj.refresh_token === 'string') {
        await supabase.auth.setSession({
          access_token: obj.access_token,
          refresh_token: obj.refresh_token,
        });
      }
    }
  } catch {
    // Corrupt / unexpected shape — drop silently. Worst case the user re-OTPs.
  } finally {
    try {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}
