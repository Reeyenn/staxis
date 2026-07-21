// /api/staff-schedule/time-off — staff submit + manager decide.
//
//   POST  body: { hotelId, requestDate, reason? }   [staff endpoint]
//     Logged-in account must have accounts.staff_id set (linked to a
//     staff record at this property). Inserts a pending time_off_request.
//     No SMS — in-app only.
//
//   PUT   body: { hotelId, id, decision: 'approve' | 'deny', denyReason? }   [manager]
//     On approve, also auto-removes the matching scheduled_shifts row
//     for that staff+date (if any). The /housekeeping AI tomorrow-picks
//     flow respects this via the existing `vacationDates` check on
//     the staff record — but TOR doesn't write vacationDates (it's
//     per-day, vacation_dates is per-property setting). Instead, the
//     /housekeeping eligibility check is updated to query time_off_requests
//     as well; see src/lib/schedule/active-crew.ts.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { requireSession } from '@/lib/api-auth';
import { verifyTeamManager, callerCapabilityDecision } from '@/lib/team-auth';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { requireSectionEnabled } from '@/lib/sections/server';
import { validateDateStr, validateUuid } from '@/lib/api-validate';
import { fromTimeOffRequestRow } from '@/lib/db-mappers';
import { applyTimeOffDecision } from '@/lib/schedule/decide-time-off';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_REASON_LEN = 500;

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = await req.json().catch(() => ({})) as {
    hotelId?: string; requestDate?: string; reason?: string;
  };
  const hotelIdCheck = validateUuid(body.hotelId, 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;
  const dateCheck = validateDateStr(body.requestDate, {
    label: 'requestDate', allowPastDays: 0, allowFutureDays: 730,
  });
  if (dateCheck.error) {
    return err(dateCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length > MAX_REASON_LEN) {
    return err(`reason must be ${MAX_REASON_LEN} characters or fewer`, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  // Look up which staff record this account is linked to.
  const { data: acct, error: acctErr } = await supabaseAdmin
    .from('accounts').select('id, staff_id, property_access')
    .eq('data_user_id', session.userId).maybeSingle();
  if (acctErr || !acct) {
    return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  if (!acct.staff_id) {
    return err('Your account is not linked to a staff record. Ask your manager to link it.', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const access = (acct.property_access ?? []) as string[];
  if (!access.includes(hotelId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const sectionGate = await requireSectionEnabled(req, hotelId, 'staff');
  if (!sectionGate.ok) return sectionGate.response;

  // Sanity: staff record belongs to this property.
  const { data: staffRow, error: staffErr } = await supabaseAdmin
    .from('staff').select('id, property_id, is_active').eq('id', acct.staff_id).maybeSingle();
  if (staffErr) {
    log.error('[time-off:POST] staff lookup failed', { requestId, msg: errToString(staffErr) });
    return err('Failed to verify staff link', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!staffRow || staffRow.property_id !== hotelId || staffRow.is_active === false) {
    return err('Staff link out of sync', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const { data: existing, error: existingErr } = await supabaseAdmin
    .from('time_off_requests')
    .select('id')
    .eq('property_id', hotelId)
    .eq('staff_id', acct.staff_id)
    .eq('request_date', dateCheck.value!)
    .in('status', ['pending', 'approved'])
    .limit(1)
    .maybeSingle();
  if (existingErr) {
    log.error('[time-off:POST] duplicate lookup failed', { requestId, msg: errToString(existingErr) });
    return err('Failed to verify existing requests', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (existing) {
    return err('You already have a time-off request for that date', {
      requestId, status: 409, code: ApiErrorCode.IdempotencyConflict,
    });
  }

  const { data, error } = await supabaseAdmin
    .from('time_off_requests').insert({
      property_id:  hotelId,
      staff_id:     acct.staff_id,
      request_date: dateCheck.value!,
      reason:       reason || null,
      status:       'pending',
    }).select('*').single();
  if (error) {
    log.error('[time-off:POST] insert failed', { requestId, msg: errToString(error) });
    return err('Failed to submit request', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  return ok({ request: fromTimeOffRequestRow(data) }, { requestId });
}

export async function PUT(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_shifts' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const body = await req.json().catch(() => ({})) as {
    hotelId?: string; id?: string; decision?: 'approve' | 'deny'; denyReason?: string;
  };
  const hotelIdCheck = validateUuid(body.hotelId, 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;
  const capabilityDecision = await callerCapabilityDecision(caller, 'manage_shifts', hotelId);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  // Section gate: if Staff is turned off for this hotel, block the write.
  const sectionGate = await requireSectionEnabled(req, hotelId, 'staff');
  if (!sectionGate.ok) return sectionGate.response;

  const idCheck = validateUuid(body.id, 'id');
  if (idCheck.error) return err(idCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (body.decision !== 'approve' && body.decision !== 'deny') {
    return err('decision must be approve or deny', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // Load + stamp + (on approve) auto-remove the scheduled shift. Shared with
  // the `decide_time_off` agent tool so the two surfaces can't drift.
  const result = await applyTimeOffDecision({
    hotelId,
    requestId: idCheck.value!,
    decision: body.decision,
    denyReason: body.denyReason,
    decidedBy: caller.accountId,
  });
  if (!result.ok) {
    switch (result.reason) {
      case 'not_found':
        return err('Request not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
      case 'already_decided':
        return err('Request already decided', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      default:
        log.error('[time-off:PUT] decision failed', { requestId, reason: result.reason });
        return err('Failed to update request', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
  }

  return ok({ ok: true, removedShift: result.removedShift }, { requestId });
}
