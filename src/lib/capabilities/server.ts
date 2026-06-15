// ═══════════════════════════════════════════════════════════════════════════
// Server-side capability resolution. Loads a hotel's override rows (deny-all
// RLS → supabaseAdmin only) and feeds them to the SAME pure can() the browser
// uses. API routes and server gates import from here; client components must NOT
// (this pulls in supabase-admin / server-only).
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';
import { cache } from 'react';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AppRole } from '@/lib/roles';
import { can, type CapabilityOverrideMap, type CapUser } from './can';
import { isCapabilityKey, isHotelRole, type CapabilityKey } from './registry';

/**
 * Load one hotel's capability overrides as a { capability → role → allowed } map.
 * Wrapped in React `cache()` so repeated gate checks within a single request
 * share one read. Reads fresh per request (no TTL) so an Access-tab toggle takes
 * effect on the very next page load / API call. Returns {} on any error or for a
 * missing pid — i.e. falls back to the everyone-everything default, never throws.
 */
export const loadOverridesForProperty = cache(
  async (propertyId: string): Promise<CapabilityOverrideMap> => {
    const map: CapabilityOverrideMap = {};
    if (!propertyId) return map;
    const { data, error } = await supabaseAdmin
      .from('capability_overrides')
      .select('capability, role, allowed')
      .eq('property_id', propertyId);
    if (error || !data) return map;
    for (const row of data as Array<{ capability: string; role: string; allowed: boolean }>) {
      if (!isCapabilityKey(row.capability) || !isHotelRole(row.role)) continue;
      (map[row.capability] ??= {})[row.role] = !!row.allowed;
    }
    return map;
  },
);

/** Resolve an auth user's account role (cached per request). */
export const resolveAccountRole = cache(
  async (userId: string): Promise<AppRole | null> => {
    if (!userId) return null;
    const { data } = await supabaseAdmin
      .from('accounts')
      .select('role')
      .eq('data_user_id', userId)
      .maybeSingle();
    return ((data?.role as AppRole | undefined) ?? null);
  },
);

/**
 * Can this user (whose role is already known) use `capability` at `propertyId`?
 * Loads the hotel's overrides only when they could matter (a non-admin, non-
 * admin-only path) — admin and admin-only short-circuit without a DB read.
 */
export async function canForProperty(
  user: CapUser,
  capability: CapabilityKey,
  propertyId: string | null | undefined,
): Promise<boolean> {
  // Fast paths that never depend on overrides: admin, and admin-only caps.
  if (user?.role === 'admin') return can(user, capability, undefined);
  const overrides = propertyId ? await loadOverridesForProperty(propertyId) : undefined;
  return can(user, capability, overrides);
}

/**
 * Convenience for routes that have a userId but not yet a role: resolve the role
 * from `accounts`, then delegate to canForProperty.
 */
export async function canForUserId(
  userId: string,
  capability: CapabilityKey,
  propertyId: string | null | undefined,
): Promise<boolean> {
  const role = await resolveAccountRole(userId);
  return canForProperty({ role }, capability, propertyId);
}
