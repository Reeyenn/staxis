// /api/auth/team — list accounts with access to a specific hotel.
//   GET  ?hotelId=…  — returns the people on that hotel's team.
//
// Visible to admin / owner / general_manager. Owner/GM are scoped to hotels
// in their property_access; admin can read any hotel's team.
//
// This is the owner-facing counterpart to /api/auth/accounts (admin-only,
// returns ALL accounts in the system). Settings → Account & Team uses this
// to show a team-member list to non-admin managers.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { verifyTeamManager, canManageHotel } from '@/lib/team-auth';
import type { AppRole } from '@/lib/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const hotelId = searchParams.get('hotelId');
  if (!hotelId) return err('hotelId required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!canManageHotel(caller, hotelId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  // Admins implicitly have access to every hotel — match either:
  //   role = 'admin', OR
  //   property_access @> [hotelId]
  // We do the filter in JS instead of Postgres so we don't have to deal
  // with array-contains operator syntax through PostgREST.
  const { data: rows, error: qErr } = await supabaseAdmin
    .from('accounts')
    .select('id, username, display_name, role, property_access, created_at, data_user_id')
    .order('created_at', { ascending: true });
  if (qErr) {
    console.error('[team:GET] query failed', qErr);
    return err('Failed to load team', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  const teamRows = (rows ?? []).filter(r =>
    r.role === 'admin' || (Array.isArray(r.property_access) && r.property_access.includes(hotelId))
  );

  // Look up emails by data_user_id. listUsers paginates (1000 max per call) —
  // fine at our scale.
  const emailByUserId = new Map<string, string>();
  const { data: authPage, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) {
    console.error('[team:GET] auth listUsers failed', listErr);
  } else {
    for (const u of authPage?.users ?? []) {
      if (u.id && u.email) emailByUserId.set(u.id, u.email);
    }
  }

  const team = teamRows.map(r => ({
    accountId: r.id,
    username: r.username,
    displayName: r.display_name,
    email: emailByUserId.get(r.data_user_id) ?? '',
    role: r.role as AppRole,
    propertyAccess: r.role === 'admin' ? ['*'] : (r.property_access ?? []),
    createdAt: r.created_at,
  }));

  return ok({ team }, { requestId });
}
