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
 * effect on the very next page load / API call. A successful empty result means
 * the hotel has no overrides and therefore uses the registry defaults. A read
 * failure is different: silently treating it as an empty result would erase an
 * explicit deny for the duration of the outage, so failures throw and API gates
 * must fail closed.
 */
export class CapabilityLookupError extends Error {
  readonly propertyId: string;

  constructor(propertyId: string, options?: { cause?: unknown }) {
    super('failed to read capability overrides', options);
    this.name = 'CapabilityLookupError';
    this.propertyId = propertyId;
  }
}

export function isCapabilityLookupError(error: unknown): error is CapabilityLookupError {
  return error instanceof CapabilityLookupError;
}

export const loadOverridesForProperty = cache(
  async (propertyId: string): Promise<CapabilityOverrideMap> => {
    const map: CapabilityOverrideMap = {};
    if (!propertyId) return map;
    const { data, error } = await supabaseAdmin
      .from('capability_overrides')
      .select('capability, role, allowed')
      .eq('property_id', propertyId);
    if (error || !Array.isArray(data)) {
      throw new CapabilityLookupError(propertyId, { cause: error });
    }
    for (const row of data as Array<{ capability: string; role: string; allowed: boolean }>) {
      if (!isCapabilityKey(row.capability) || !isHotelRole(row.role)) continue;
      (map[row.capability] ??= {})[row.role] = !!row.allowed;
    }
    return map;
  },
);

export type CapabilityDecision = 'allowed' | 'denied' | 'unavailable';

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
 * API-friendly capability resolution. Only the known override-store outage is
 * converted to `unavailable`; programmer errors and unrelated failures still
 * surface normally. Callers can therefore return a deliberate retryable 503
 * without ever confusing an outage with an authorization denial or grant.
 */
export async function capabilityDecisionForProperty(
  user: CapUser,
  capability: CapabilityKey,
  propertyId: string | null | undefined,
): Promise<CapabilityDecision> {
  try {
    return (await canForProperty(user, capability, propertyId)) ? 'allowed' : 'denied';
  } catch (error) {
    if (isCapabilityLookupError(error)) return 'unavailable';
    throw error;
  }
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

/**
 * Tri-state HTTP-boundary variant of canForUserId. Account absence/unknown
 * roles remain ordinary denials; only a capability-override lookup outage is
 * reported as unavailable so routes can return the standard retryable 503.
 */
export async function capabilityDecisionForUserId(
  userId: string,
  capability: CapabilityKey,
  propertyId: string | null | undefined,
): Promise<CapabilityDecision> {
  const role = await resolveAccountRole(userId);
  return capabilityDecisionForProperty({ role }, capability, propertyId);
}
