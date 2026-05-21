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
 * exists, it parses the access_token + refresh_token out of it and
 * forwards them to `supabase.auth.setSession`, which the SSR client
 * writes to cookies. The localStorage entry is then removed — but ONLY
 * after we've confirmed the cookie session is actually live.
 *
 * Clear-on-success-only is the key safety invariant (Codex review of
 * commit aa270b6, finding HIGH). The earlier version cleared the legacy
 * key in a `finally` block, so a transient Supabase 5xx, a network drop,
 * or a revoked refresh token would wipe the only copy of the user's
 * session and leave them silently signed out. We now keep the legacy
 * blob in place on any setSession failure so the next page load can
 * retry. Steady-state cost of a permanently-dead legacy entry is just a
 * single setSession() call per mount that fails fast — acceptable for
 * the ~12 active users during the brief migration window.
 *
 * Future-cleanup note: once we're confident no active sessions remain in
 * localStorage (a few weeks after the deploy), the entire helper can be
 * deleted along with the AuthContext call site. Safe to leave indefinitely
 * — once localStorage is empty the helper is a no-op fast path.
 */
import { supabase } from '@/lib/supabase';

const LEGACY_STORAGE_KEY = 'staxis-auth';

function clearLegacy(): void {
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // private browsing / storage disabled — ignore
  }
}

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

  // Parse + shape-validate eagerly. Corrupt/malformed blob is dead data —
  // safe to clear. Distinguishing this from a setSession failure (which we
  // do NOT want to clear on) is the point of doing the parse separately.
  let access_token: string | undefined;
  let refresh_token: string | undefined;
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
      if (typeof obj.access_token === 'string') access_token = obj.access_token;
      if (typeof obj.refresh_token === 'string') refresh_token = obj.refresh_token;
    }
  } catch {
    // Corrupt JSON — drop and exit.
    clearLegacy();
    return;
  }

  if (!access_token || !refresh_token) {
    // Parseable but wrong shape — drop and exit.
    clearLegacy();
    return;
  }

  // Try to lift to cookies. setSession can BOTH return { error } AND throw,
  // depending on the failure mode (auth-side rejection vs network/transport).
  // Handle both. ONLY clear legacy on confirmed success.
  try {
    const { data, error } = await supabase.auth.setSession({ access_token, refresh_token });
    if (!error && data?.session) {
      clearLegacy();
      return;
    }
    // Auth-side rejection — token is rejected by Supabase. The legacy data
    // can't be migrated. Log loudly (console.error → Sentry breadcrumb) so
    // we can count failures in production, but don't clear: future-self may
    // change strategy, and on a transient classification mistake the next
    // page load gets another shot.
    console.error('auth-storage-migration: setSession rejected', {
      message: error?.message ?? 'no session returned',
      status: (error as { status?: number } | null)?.status ?? null,
    });
  } catch (err) {
    // Network failure or other thrown exception. Keep legacy so the next
    // page load can retry once Supabase is reachable again.
    console.error('auth-storage-migration: setSession threw', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
