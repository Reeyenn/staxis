/**
 * Role + property-access gate shared by every /api/front-desk/* route.
 *
 *   resolveCallerRole(userId)       → AppRole | null  (DB read once)
 *   ROLES_ALLOWED_FRONT_DESK_READ   → front_desk, manager-tier, owner, admin
 *   ROLES_ALLOWED_FRONT_DESK_WRITE  → same set (no role does writes that read can't)
 *   ROLES_ALLOWED_MANAGER_TIER      → only manager-tier (GM/owner/admin)
 *                                     — used for phone-number visibility +
 *                                     notification-log access (read of PII).
 *
 * Housekeeping and maintenance staff get a hard 403 from these gates,
 * even if they somehow obtained a valid pid. The Header.tsx visibility
 * check is UI hygiene, NOT a security boundary.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import type { AppRole } from '@/lib/roles';

export const ROLES_ALLOWED_FRONT_DESK_READ: ReadonlySet<AppRole> = new Set<AppRole>([
  'admin', 'owner', 'general_manager', 'front_desk',
]);

export const ROLES_ALLOWED_FRONT_DESK_WRITE: ReadonlySet<AppRole> = new Set<AppRole>([
  'admin', 'owner', 'general_manager', 'front_desk',
]);

/**
 * Routes that expose PII (staff phone numbers, full notification body)
 * gate on this set — front-desk staff can use the page but should not
 * see the phone of every coworker, only managers can.
 */
export const ROLES_ALLOWED_MANAGER_TIER: ReadonlySet<AppRole> = new Set<AppRole>([
  'admin', 'owner', 'general_manager',
]);

export interface CallerRoleInfo {
  role: AppRole | null;
  propertyAccess: string[];
}

/**
 * One DB read → role + property_access. Returns role=null on any
 * failure (route layer treats null as 403). Mirrors the pattern used
 * by userHasPropertyAccess but exposes the role so routes can apply
 * a finer-grained gate than "owns the property".
 */
export async function resolveCallerRole(userId: string): Promise<CallerRoleInfo> {
  try {
    const { data, error } = await supabaseAdmin
      .from('accounts')
      .select('role, property_access')
      .eq('data_user_id', userId)
      .maybeSingle();
    if (error) {
      log.warn('[front-desk role-gate] accounts read failed', { userId, err: error.message });
      return { role: null, propertyAccess: [] };
    }
    if (!data) return { role: null, propertyAccess: [] };
    return {
      role: (data as { role?: AppRole }).role ?? null,
      propertyAccess: ((data as { property_access?: string[] }).property_access ?? []),
    };
  } catch (err) {
    log.error('[front-desk role-gate] threw', {
      userId, err: err instanceof Error ? err.message : String(err),
    });
    return { role: null, propertyAccess: [] };
  }
}

/**
 * Returns true if `info` is allowed to act on `pid` via the route gated
 * by `allowedRoles`. The wildcard '*' in property_access means
 * admin-style cross-property access (kept from the legacy admin
 * convention).
 */
export function passesFrontDeskGate(
  info: CallerRoleInfo,
  pid: string,
  allowedRoles: ReadonlySet<AppRole> = ROLES_ALLOWED_FRONT_DESK_READ,
): boolean {
  if (!info.role) return false;
  if (!allowedRoles.has(info.role)) return false;
  if (info.role === 'admin') return true;
  return info.propertyAccess.includes(pid) || info.propertyAccess.includes('*');
}
