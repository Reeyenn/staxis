// /api/auth/join-codes — manage hotel join codes.
//   GET     ?hotelId=…  — list active (non-expired, not-revoked) codes
//   POST                — create. Body: { hotelId }. Codes are valid for
//                         7 days and accept up to 100 signups. Role is
//                         chosen by the staff member during /signup; not
//                         pre-baked into the code.
//   DELETE  ?id=…       — revoke (sets revoked_at)

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { verifyTeamManager, canManageHotel } from '@/lib/team-auth';
import { writeAudit } from '@/lib/audit';
import {
  generateJoinCode,
  STAFF_CODE_TTL_HOURS as CODE_TTL_HOURS,
  STAFF_CODE_MAX_USES as CODE_MAX_USES,
} from '@/lib/join-codes';

// New-flow defaults: codes don't pre-bind a role; the staff member chooses
// their own role at /signup. Validity is fixed at 7 days and up to 100
// signups per code — enough for a hotel-wide share without being unlimited.
// (Constants moved to @/lib/join-codes in Phase M1 so the admin
// property-create route mints codes from the same source.)

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

  const { data, error: qErr } = await supabaseAdmin
    .from('hotel_join_codes')
    .select('id, code, role, expires_at, max_uses, used_count, created_at, revoked_at')
    .eq('hotel_id', hotelId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (qErr) {
    log.error('[join-codes:GET] failed', { err: qErr, requestId });
    return err('Failed to load codes', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  return ok({ codes: data ?? [] }, { requestId });
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const body = await req.json() as { hotelId?: string };
  const { hotelId } = body;
  if (!hotelId) {
    return err('hotelId required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (!canManageHotel(caller, hotelId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }
  const ttl = CODE_TTL_HOURS;
  const uses = CODE_MAX_USES;

  // Pull hotel name for the code prefix.
  const { data: prop } = await supabaseAdmin.from('properties').select('name').eq('id', hotelId).maybeSingle();

  // Try a few times in case of collision on hotel_join_codes.code (UNIQUE
  // per migration 0064). Audit P3.1 (2026-05-17): switched from substring
  // match on the error message to the SQLSTATE code 23505 — error messages
  // can change between Postgres versions; SQLSTATEs are stable.
  let lastErr: unknown = null;
  for (let i = 0; i < 5; i++) {
    const code = generateJoinCode(prop?.name);
    const expiresAt = new Date(Date.now() + ttl * 60 * 60 * 1000).toISOString();
    const { data: ins, error: insErr } = await supabaseAdmin.from('hotel_join_codes').insert({
      hotel_id: hotelId,
      code,
      role: null,
      expires_at: expiresAt,
      max_uses: uses,
      created_by: caller.accountId,
    }).select('id, code, role, expires_at, max_uses, used_count, created_at').single();
    if (!insErr && ins) {
      await writeAudit({
        action: 'join_code.create',
        actorUserId: caller.authUserId,
        actorEmail: caller.authEmail,
        targetType: 'join_code',
        targetId: ins.id,
        hotelId,
        metadata: { code: ins.code, max_uses: ins.max_uses, ttl_hours: ttl },
      });
      return ok({ joinCode: ins }, { requestId });
    }
    lastErr = insErr;
    // Only retry on unique_violation (23505) — anything else is a real
    // failure that won't get better with a fresh code.
    if (insErr && insErr.code !== '23505') break;
  }
  log.error('[join-codes:POST] insert failed after retries', { err: lastErr, requestId });
  return err('Failed to create join code', { requestId, status: 500, code: ApiErrorCode.InternalError });
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return err('id required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const { data: row } = await supabaseAdmin.from('hotel_join_codes').select('hotel_id').eq('id', id).maybeSingle();
  if (!row) return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  if (!canManageHotel(caller, row.hotel_id)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const { error: updErr } = await supabaseAdmin
    .from('hotel_join_codes')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id);
  if (updErr) {
    log.error('[join-codes:DELETE] failed', { err: updErr, requestId });
    return err('Failed to revoke', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  await writeAudit({
    action: 'join_code.revoke',
    actorUserId: caller.authUserId,
    actorEmail: caller.authEmail,
    targetType: 'join_code',
    targetId: id,
    hotelId: row.hotel_id,
  });
  return ok({ success: true }, { requestId });
}
