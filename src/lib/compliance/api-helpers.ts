// Shared API helpers for the compliance routes.
//
//  * checkStaffCapability  — the pid+staffId capability gate every public
//                            /api/engineer/* route runs (RLS bug class:
//                            supabaseAdmin + verify the pair exists on staff).
//  * getManagerRole        — role lookup for manager-only config/setup routes.
//  * resolveCostAccount    — an account to attribute Claude/vision spend to for
//                            the accountless engineer surface (best-effort).

import { supabaseAdmin } from '@/lib/supabase-admin';

export interface StaffCapability {
  id: string;
  name: string;
  language: string;
  department: string | null;
}

/**
 * Verify (staffId, pid) is a real staff row on this property. Returns the
 * minimal staff fields the engineer surface needs, or null when the pair
 * doesn't exist (caller 404s). Never trusts the client beyond the URL params.
 */
export async function checkStaffCapability(pid: string, staffId: string): Promise<StaffCapability | null> {
  const { data, error } = await supabaseAdmin
    .from('staff')
    .select('id, name, language, department, is_active')
    .eq('id', staffId)
    .eq('property_id', pid)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: String(data.id),
    name: String(data.name ?? ''),
    language: typeof data.language === 'string' ? data.language : 'en',
    department: typeof data.department === 'string' ? data.department : null,
  };
}

const MANAGER_ROLES = new Set(['admin', 'owner', 'general_manager']);

/** Returns the caller's role, or null if no account row. */
export async function getAccountRole(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('accounts')
    .select('role')
    .eq('data_user_id', userId)
    .maybeSingle();
  return (data?.role as string | undefined) ?? null;
}

/** True when the caller is owner / GM / admin (allowed to configure schedules). */
export async function isManager(userId: string): Promise<boolean> {
  const role = await getAccountRole(userId);
  return role !== null && MANAGER_ROLES.has(role);
}

/**
 * Find an account to attribute vision/Claude spend to for the accountless
 * engineer surface. Prefers an owner/GM with access to the property. Returns
 * null when none is resolvable (cost recording is then skipped; the per-hour
 * rate limit still bounds spend).
 */
export async function resolveCostAccount(pid: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('accounts')
    .select('id, role, property_access')
    .in('role', ['owner', 'general_manager', 'admin']);
  for (const a of data ?? []) {
    const access = (a.property_access as string[] | null) ?? [];
    if (a.role === 'admin' || access.includes(pid) || access.includes('*')) {
      return String(a.id);
    }
  }
  return null;
}
