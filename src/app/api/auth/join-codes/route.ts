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
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { verifyTeamManager, callerCapabilityDecision } from '@/lib/team-auth';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { writeAudit } from '@/lib/audit';
import {
  generateJoinCode,
  isUsableJoinCode,
  STAFF_CODE_TTL_HOURS as CODE_TTL_HOURS,
  STAFF_CODE_MAX_USES as CODE_MAX_USES,
  withJoinCodeHotelLock,
} from '@/lib/join-codes';

// New-flow defaults: codes don't pre-bind a role; the staff member chooses
// their own role at /signup. Validity is fixed at 7 days and up to 100
// signups per code — enough for a hotel-wide share without being unlimited.
// (Constants moved to @/lib/join-codes in Phase M1 so the admin
// property-create route mints codes from the same source.)

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JOIN_CODE_COLUMNS = 'id, code, role, expires_at, max_uses, used_count, created_at, revoked_at';

interface JoinCodeRow {
  id: string;
  code: string;
  role: string | null;
  expires_at: string;
  max_uses: number;
  used_count: number;
  created_at: string;
  revoked_at: string | null;
}

async function usableCodesForHotel(hotelId: string): Promise<{
  codes: JoinCodeRow[];
  error: { message?: string } | null;
}> {
  const { data, error } = await supabaseAdmin
    .from('hotel_join_codes')
    .select(JOIN_CODE_COLUMNS)
    .eq('hotel_id', hotelId)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    // Oldest wins so a newly-created race loser never replaces a link that a
    // manager may already have copied.
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(100);

  return {
    codes: ((data ?? []) as JoinCodeRow[]).filter((code) => isUsableJoinCode(code)),
    error,
  };
}

async function reconcileUsableCodesForHotel(
  hotelId: string,
  codes: JoinCodeRow[],
): Promise<{
  canonical: JoinCodeRow | null;
  revokedIds: string[];
  error: unknown | null;
}> {
  const canonical = codes[0] ?? null;
  if (!canonical || codes.length === 1) {
    return { canonical, revokedIds: [], error: null };
  }

  const duplicateIds = codes.slice(1).map((code) => code.id);
  const { error: revokeErr } = await supabaseAdmin
    .from('hotel_join_codes')
    .update({ revoked_at: new Date().toISOString() })
    .in('id', duplicateIds)
    .is('revoked_at', null);
  if (revokeErr) {
    return { canonical, revokedIds: [], error: revokeErr };
  }

  // A second read is part of the contract: never claim convergence if a
  // concurrent writer appeared or an update silently matched no rows.
  const verification = await usableCodesForHotel(hotelId);
  if (verification.error) {
    return { canonical, revokedIds: [], error: verification.error };
  }
  if (verification.codes.length !== 1 || verification.codes[0]?.id !== canonical.id) {
    return {
      canonical,
      revokedIds: [],
      error: new Error('Join-code reconciliation did not converge to one canonical code'),
    };
  }

  return { canonical, revokedIds: duplicateIds, error: null };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const hotelId = searchParams.get('hotelId');
  if (!hotelId) return err('hotelId required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const capabilityDecision = await callerCapabilityDecision(caller, 'manage_team', hotelId);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const { codes, error: qErr } = await usableCodesForHotel(hotelId);
  if (qErr) {
    log.error('[join-codes:GET] failed', { requestId, msg: errToString(qErr) });
    return err('Failed to load codes', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  // Only expose the deterministic canonical link. A failed best-effort race
  // cleanup must never make a newer duplicate become the visible hotel link.
  return ok({ codes: codes.slice(0, 1) }, { requestId });
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  let body: { hotelId?: string };
  try {
    body = await req.json() as { hotelId?: string };
  } catch {
    return err('A valid JSON body is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const { hotelId } = body;
  if (!hotelId) {
    return err('hotelId required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const capabilityDecision = await callerCapabilityDecision(caller, 'manage_team', hotelId);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }
  return withJoinCodeHotelLock(hotelId, async () => {
    // POST is get-or-create. Multiple open management surfaces receive one
    // stable active link instead of silently minting competing codes.
    const existingResult = await usableCodesForHotel(hotelId);
    if (existingResult.error) {
      log.error('[join-codes:POST] existing-code lookup failed', {
        requestId,
        msg: errToString(existingResult.error),
      });
      return err('Failed to load join code', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
    if (existingResult.codes.length > 0) {
      const reconciliation = await reconcileUsableCodesForHotel(hotelId, existingResult.codes);
      if (reconciliation.error || !reconciliation.canonical) {
        log.error('[join-codes:POST] existing duplicate reconciliation failed', {
          requestId,
          msg: errToString(reconciliation.error),
        });
        return err('Existing invite links could not be reconciled. Try again.', {
          requestId,
          status: 500,
          code: ApiErrorCode.InternalError,
        });
      }
      if (reconciliation.revokedIds.length > 0) {
        await writeAudit({
          action: 'join_code.concurrent_duplicate_revoke',
          actorUserId: caller.authUserId,
          actorEmail: caller.authEmail,
          targetType: 'join_code',
          targetId: reconciliation.canonical.id,
          hotelId,
          metadata: {
            canonical_id: reconciliation.canonical.id,
            revoked_ids: reconciliation.revokedIds,
          },
        });
      }
      return ok({ joinCode: reconciliation.canonical, created: false }, { requestId });
    }

    const ttl = CODE_TTL_HOURS;
    const uses = CODE_MAX_USES;
    const { data: prop, error: propErr } = await supabaseAdmin
      .from('properties')
      .select('name')
      .eq('id', hotelId)
      .maybeSingle();
    if (propErr) {
      log.error('[join-codes:POST] property lookup failed', { requestId, msg: errToString(propErr) });
      return err('Failed to verify hotel', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
    if (!prop) {
      return err('Hotel not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }

    // Try a few times in case the globally-unique human-readable code collides.
    let inserted: JoinCodeRow | null = null;
    let lastErr: unknown = null;
    for (let i = 0; i < 5; i++) {
      const code = generateJoinCode(prop.name);
      const expiresAt = new Date(Date.now() + ttl * 60 * 60 * 1000).toISOString();
      const { data: ins, error: insErr } = await supabaseAdmin.from('hotel_join_codes').insert({
        hotel_id: hotelId,
        code,
        role: null,
        expires_at: expiresAt,
        max_uses: uses,
        created_by: caller.accountId,
      }).select(JOIN_CODE_COLUMNS).single();
      if (!insErr && ins) {
        inserted = ins as JoinCodeRow;
        break;
      }
      lastErr = insErr;
      if (insErr && !String(insErr.message ?? '').toLowerCase().includes('duplicate')) break;
    }
    if (!inserted) {
      log.error('[join-codes:POST] insert failed after retries', { requestId, msg: errToString(lastErr) });
      return err('Failed to create join code', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }

    // A different serverless instance can pass the first lookup at the same
    // time. Re-read after insertion, choose the same deterministic oldest row
    // everywhere, revoke every usable duplicate, then verify convergence.
    const canonicalResult = await usableCodesForHotel(hotelId);
    if (canonicalResult.error || canonicalResult.codes.length === 0) {
      log.error('[join-codes:POST] post-insert reconciliation lookup failed', {
        requestId,
        msg: errToString(canonicalResult.error),
      });
      return err('The invite link was created but could not be verified. Try again.', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
      });
    }
    const reconciliation = await reconcileUsableCodesForHotel(hotelId, canonicalResult.codes);
    if (reconciliation.error || !reconciliation.canonical) {
      log.error('[join-codes:POST] duplicate reconciliation failed', {
        requestId,
        msg: errToString(reconciliation.error),
      });
      return err('A concurrent invite-link request could not be reconciled. Try again.', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
      });
    }
    const canonical = reconciliation.canonical;
    if (canonical.id !== inserted.id) {
      await writeAudit({
        action: 'join_code.concurrent_duplicate_revoke',
        actorUserId: caller.authUserId,
        actorEmail: caller.authEmail,
        targetType: 'join_code',
        targetId: canonical.id,
        hotelId,
        metadata: {
          canonical_id: canonical.id,
          revoked_ids: reconciliation.revokedIds,
        },
      });
      return ok({ joinCode: canonical, created: false }, { requestId });
    }

    await writeAudit({
      action: 'join_code.create',
      actorUserId: caller.authUserId,
      actorEmail: caller.authEmail,
      targetType: 'join_code',
      targetId: inserted.id,
      hotelId,
      metadata: { code: inserted.code, max_uses: inserted.max_uses, ttl_hours: ttl },
    });
    return ok({ joinCode: inserted, created: true }, { requestId, status: 201 });
  });
}

export async function DELETE(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_team' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return err('id required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const { data: row } = await supabaseAdmin.from('hotel_join_codes').select('hotel_id').eq('id', id).maybeSingle();
  if (!row) return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  const capabilityDecision = await callerCapabilityDecision(caller, 'manage_team', row.hotel_id);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const { error: updErr } = await supabaseAdmin
    .from('hotel_join_codes')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id);
  if (updErr) {
    log.error('[join-codes:DELETE] failed', { requestId, msg: errToString(updErr) });
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
