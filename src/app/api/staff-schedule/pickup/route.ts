// /api/staff-schedule/pickup — staff picks up an open shift.
//
//   POST  body: { hotelId, shiftId }
//     Logged-in account must have accounts.staff_id set + access to
//     this hotel. The shift must be kind='open' and not yet picked up.
//     First-come wins via a conditional UPDATE; subsequent picks get
//     "already covered".

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { requireSession } from '@/lib/api-auth';
import { validateUuid } from '@/lib/api-validate';
import { fromScheduledShiftRow } from '@/lib/db-mappers';
import { requireSectionEnabled } from '@/lib/sections/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = await req.json().catch(() => ({})) as { hotelId?: string; shiftId?: string };
  const hotelIdCheck = validateUuid(body.hotelId, 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;
  const shiftIdCheck = validateUuid(body.shiftId, 'shiftId');
  if (shiftIdCheck.error) return err(shiftIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const { data: acct, error: acctErr } = await supabaseAdmin
    .from('accounts').select('id, staff_id, property_access')
    .eq('data_user_id', session.userId).maybeSingle();
  if (acctErr) {
    log.error('[pickup:POST] account lookup failed', { requestId, msg: errToString(acctErr) });
    return err('Failed to verify your account', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!acct?.staff_id) {
    return err('Your account is not linked to a staff record', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const access = (acct.property_access ?? []) as string[];
  if (!access.includes(hotelId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const sectionGate = await requireSectionEnabled(req, hotelId, 'staff');
  if (!sectionGate.ok) return sectionGate.response;

  // Verify staff record + dept match (staff can only pick up shifts in
  // their own dept; the design's open-shifts card already filters this
  // client-side, but enforce server-side too).
  const { data: staffRow, error: staffErr } = await supabaseAdmin
    .from('staff').select('id, department, property_id, is_active').eq('id', acct.staff_id).maybeSingle();
  if (staffErr) {
    log.error('[pickup:POST] staff lookup failed', { requestId, msg: errToString(staffErr) });
    return err('Failed to verify your staff record', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!staffRow || staffRow.property_id !== hotelId || staffRow.is_active === false) {
    return err('Staff link out of sync', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // Resolve the date/status before the compare-and-set so draft shifts and
  // approved leave can never be picked up merely by guessing a row UUID.
  const { data: openShift, error: shiftErr } = await supabaseAdmin
    .from('scheduled_shifts')
    .select('id, shift_date, department, kind, status')
    .eq('id', shiftIdCheck.value!)
    .eq('property_id', hotelId)
    .maybeSingle();
  if (shiftErr) {
    log.error('[pickup:POST] shift lookup failed', { requestId, msg: errToString(shiftErr) });
    return err('Failed to verify the shift', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!openShift || openShift.kind !== 'open' || openShift.status !== 'published') {
    return err('That shift is not available', { requestId, status: 409, code: ApiErrorCode.ValidationFailed });
  }
  if (openShift.department !== staffRow.department) {
    return err('That shift is for another department', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const { data: approvedLeave, error: leaveErr } = await supabaseAdmin
    .from('time_off_requests')
    .select('id')
    .eq('property_id', hotelId)
    .eq('staff_id', acct.staff_id)
    .eq('request_date', openShift.shift_date)
    .eq('status', 'approved')
    .limit(1)
    .maybeSingle();
  if (leaveErr) {
    log.error('[pickup:POST] time-off lookup failed', { requestId, msg: errToString(leaveErr) });
    return err('Failed to verify approved time off', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (approvedLeave) {
    return err('You have approved time off that day', { requestId, status: 409, code: ApiErrorCode.ValidationFailed });
  }

  // Conditional update: only succeeds if the row is still open. Equivalent
  // to a SELECT FOR UPDATE + INSERT inside a TX, but using PostgREST's
  // conditional update + RETURNING. The .eq('kind','open') filter is the
  // optimistic-lock — losers get 0 rows and a polite "already covered".
  const { data: updated, error: upErr } = await supabaseAdmin
    .from('scheduled_shifts').update({
      staff_id: acct.staff_id,
      kind:     'shift',
      // Status remains whatever it was (most likely 'published' since
      // open shifts are visible to staff; if it was 'draft' that's a
      // manager who hasn't published yet and shouldn't be visible —
      // but be permissive).
    })
    .eq('id', shiftIdCheck.value!)
    .eq('property_id', hotelId)
    .eq('department', staffRow.department)
    .eq('kind', 'open')
    .eq('status', 'published')
    .select('*').maybeSingle();

  if (upErr) {
    log.error('[pickup:POST] update failed', { requestId, msg: errToString(upErr) });
    // 23P01 = exclusion_violation: the staffer already has an overlapping shift
    // that day. Surface a friendly message + 409 instead of leaking the raw
    // Postgres constraint text with a 500. (Audit fix 2026-06-18.)
    if ((upErr as { code?: string }).code === '23P01') {
      return err('You already have a shift that day', { requestId, status: 409, code: ApiErrorCode.ValidationFailed });
    }
    return err('Failed to pick up the shift', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!updated) {
    return err('That shift is already covered', { requestId, status: 409, code: ApiErrorCode.ValidationFailed });
  }

  return ok({ shift: fromScheduledShiftRow(updated) }, { requestId });
}
