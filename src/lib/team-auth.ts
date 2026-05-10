// ─── Team-management auth helper ─────────────────────────────────────────
// Used by /api/auth/invites/* and /api/auth/join-codes/* — admin can manage
// any hotel; owner/general_manager can only manage hotels they have access to.

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canManageTeam, type AppRole } from '@/lib/roles';

export interface TeamCaller {
  accountId: string;
  authUserId: string;
  role: AppRole;
  propertyAccess: string[];
  isAdmin: boolean;
}

export async function verifyTeamManager(req: NextRequest): Promise<TeamCaller | null> {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData.user) return null;

  const { data: account, error: acctErr } = await supabaseAdmin
    .from('accounts')
    .select('id, role, property_access')
    .eq('data_user_id', userData.user.id)
    .maybeSingle();
  if (acctErr || !account) return null;

  const role = account.role as AppRole;
  if (!canManageTeam(role)) return null;

  return {
    accountId: account.id,
    authUserId: userData.user.id,
    role,
    propertyAccess: (account.property_access ?? []) as string[],
    isAdmin: role === 'admin',
  };
}

export function canManageHotel(caller: TeamCaller, hotelId: string): boolean {
  if (caller.isAdmin) return true;
  return caller.propertyAccess.includes(hotelId);
}
