// ─── Team-management auth helper ─────────────────────────────────────────
// Used by /api/auth/invites/* and /api/auth/join-codes/* — admin can manage
// any hotel; owner/general_manager can only manage hotels they have access to.
//
// Audit 2026-05-22: this helper now routes JWT validation through
// requireSession() so the new server-side device-trust enforcement
// applies. Before this change, a leaked password JWT could call
// invite/code management without ever completing OTP — a path-around
// the requireSession gate added in the auth/2FA audit.

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canManageTeam, type AppRole } from '@/lib/roles';
import { requireSession } from '@/lib/api-auth';

export interface TeamCaller {
  accountId: string;
  authUserId: string;
  authEmail?: string;
  role: AppRole;
  propertyAccess: string[];
  isAdmin: boolean;
}

export async function verifyTeamManager(req: NextRequest): Promise<TeamCaller | null> {
  // requireSession enforces device-trust by default (Phase 1 audit). If
  // it fails — invalid JWT, no device cookie, skip_2fa refusal — we
  // return null and the caller surfaces a generic 403. (We swallow the
  // typed 401 response here because the existing call sites expect a
  // null|TeamCaller shape; the typed shape is preserved in
  // requireAdmin / requireSession callers that have been migrated.)
  const session = await requireSession(req);
  if (!session.ok) return null;

  const { data: account, error: acctErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role, property_access')
    .eq('data_user_id', session.userId)
    .maybeSingle();
  if (acctErr || !account) return null;

  const role = account.role as AppRole;
  if (!canManageTeam(role)) return null;

  return {
    accountId: account.id,
    authUserId: session.userId,
    authEmail: session.email ?? undefined,
    role,
    propertyAccess: (account.property_access ?? []) as string[],
    isAdmin: role === 'admin',
  };
}

export function canManageHotel(caller: TeamCaller, hotelId: string): boolean {
  if (caller.isAdmin) return true;
  return caller.propertyAccess.includes(hotelId);
}

/**
 * Capability check for property-scoped MANAGEMENT routes that already hold a
 * validated session (from requireSession) and want to authorize owner / GM /
 * admin — but NOT staff — for a specific hotel.
 *
 * Returns true iff the account behind `authUserId` is a management role
 * (canManageTeam) AND (is admin OR has hotelId in property_access).
 *
 * Why this exists alongside verifyTeamManager: some routes (e.g. the PMS
 * onboarding wizard endpoints) need requireSession's typed 401 + token-
 * refresh behaviour and just want to layer "management-with-access" authz on
 * top, rather than collapse no-session and not-a-manager into one null/403.
 * Before migration 0273 those routes gated on owner_id === session.userId,
 * which dead-ended GM self-onboarding; this keeps them management-only while
 * letting an invited GM (or the owner) complete PMS setup. Fails CLOSED.
 */
export async function callerManagesHotel(authUserId: string, hotelId: string): Promise<boolean> {
  const { data: account, error } = await supabaseAdmin
    .from('accounts')
    .select('role, property_access')
    .eq('data_user_id', authUserId)
    .maybeSingle();
  if (error || !account) return false;
  const role = account.role as AppRole;
  if (!canManageTeam(role)) return false;
  if (role === 'admin') return true;
  return ((account.property_access ?? []) as string[]).includes(hotelId);
}
