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
