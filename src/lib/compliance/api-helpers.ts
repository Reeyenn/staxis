// Shared API helpers for the compliance routes.
//
//  * checkStaffCapability  — the pid+staffId capability gate every public
//                            /api/engineer/* route runs (RLS bug class:
//                            supabaseAdmin + verify the pair exists on staff).
//  * getManagerRole        — role lookup for manager-only config/setup routes.
//  * resolveCostAccount    — an account to attribute Claude/vision spend to for
//                            the accountless engineer surface (best-effort).

import type { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { verifyStaffLinkToken } from '@/lib/staff-link-auth';

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
  // Fail closed for deactivated staff: a fired employee's leaked SMS link must
  // stop working even though the staff row still exists (Codex adversarial
  // finding — stale-link replay). `is_active` is null-as-active per app convention.
  if (data.is_active === false) return null;
  return {
    id: String(data.id),
    name: String(data.name ?? ''),
    language: typeof data.language === 'string' ? data.language : 'en',
    department: typeof data.department === 'string' ? data.department : null,
  };
}

/**
 * Security audit 2026-06-26 #1 — token-verifying replacement for the bare
 * checkStaffCapability(pid, staffId) gate on every public /api/engineer/* route.
 *
 * The credential is now the per-staff link token (`tok` in the URL/body), NOT
 * the (pid, staffId) tuple. This resolves identity from the token via
 * verifyStaffLinkToken, confirms it's bound to this pid+staffId, enforces
 * is_active, and returns either the StaffCapability the routes already consume
 * or a Response the route returns immediately.
 *
 * Routes call:
 *   const gate = await requireEngineerStaff(req, { pid, staffId, requestId, bodyToken });
 *   if (!gate.ok) return gate.response;
 *   const staff = gate.staff;   // same StaffCapability shape as before
 */
export async function requireEngineerStaff(
  req: NextRequest,
  args: { pid: string; staffId: string; requestId: string; bodyToken?: unknown },
): Promise<{ ok: true; staff: StaffCapability } | { ok: false; response: NextResponse }> {
  const verified = await verifyStaffLinkToken(req, args);
  if (!verified.ok) return { ok: false, response: verified.response };
  return {
    ok: true,
    staff: {
      id: verified.staff.staffId,
      name: verified.staff.name,
      language: verified.staff.language,
      department: verified.staff.department,
    },
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
