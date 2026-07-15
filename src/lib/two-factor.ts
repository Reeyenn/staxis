/**
 * Global human-2FA switch — server-side reader/writer.
 *
 * Backed by the single-row `app_settings` table (migration 0310). The flag
 * gates ALL human Staxis 2FA (password-login-on-new-device OTP, admin device
 * trust, signup email confirm, phone-handoff code). It does NOT touch the
 * PMS/CUA robot's own MFA.
 *
 * `isTwoFactorEnabled()` is the hot-path reader: `validateDeviceTrust` (in
 * api-auth.ts) calls it on every /api request, so we cache the value in-process
 * with a short TTL rather than hitting the DB each time.
 *
 * FAIL-SAFE DIRECTION: default to ENABLED. A missing row, a read error, or any
 * thrown exception all resolve to `true` (2FA ON) so a database hiccup can
 * never silently drop the 2FA wall — it mirrors the fail-closed posture the
 * rest of the auth layer uses.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';

const TTL_MS = 15_000;

let cache: { value: boolean; expiresAt: number } | null = null;

/** Read the flag straight from the DB (no cache). Fail-safe → true. */
export async function readTwoFactorEnabledFresh(): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from('app_settings')
      .select('two_factor_enabled')
      .eq('id', true)
      .maybeSingle();
    // Missing row / error → enforce (true). Only an explicit `false` disables.
    if (error || !data) return true;
    return (data as { two_factor_enabled?: boolean | null }).two_factor_enabled !== false;
  } catch {
    return true;
  }
}

/**
 * Cached reader for the hot path. Returns whether human 2FA is currently
 * enforced. Defaults to `true` (enforce) on any failure.
 */
export async function isTwoFactorEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  const value = await readTwoFactorEnabledFresh();
  cache = { value, expiresAt: now + TTL_MS };
  return value;
}

/** Drop the in-process cache so the next read re-hits the DB. */
export function invalidateTwoFactorCache(): void {
  cache = null;
}

/**
 * Flip the global switch. Writes the single app_settings row and invalidates
 * this instance's cache. Other serverless instances pick up the change within
 * the TTL window. `updatedBy` is the admin account's data_user_id (nullable).
 */
export async function setTwoFactorEnabled(
  enabled: boolean,
  updatedBy: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabaseAdmin
    .from('app_settings')
    .update({
      two_factor_enabled: enabled,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    })
    .eq('id', true);
  if (error) return { ok: false, error: error.message };
  invalidateTwoFactorCache();
  return { ok: true };
}
