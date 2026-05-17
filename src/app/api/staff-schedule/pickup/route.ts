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
import { getOrMintRequestId } from '@/lib/log';
import { requireSession } from '@/lib/api-auth';
import { validateUuid } from '@/lib/api-validate';
import { fromScheduledShiftRow } from '@/lib/db-mappers';

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

  const { data: acct } = await supabaseAdmin
    .from('accounts').select('id, staff_id, property_access')
    .eq('data_user_id', session.userId).maybeSingle();
  if (!acct?.staff_id) {
    return err('Your account is not linked to a staff record', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const access = (acct.property_access ?? []) as string[];
  if (!access.includes(hotelId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  // Verify staff record + dept match (staff can only pick up shifts in
  // their own dept; the design's open-shifts card already filters this
  // client-side, but enforce server-side too).
  const { data: staffRow } = await supabaseAdmin
    .from('staff').select('id, department, property_id').eq('id', acct.staff_id).maybeSingle();
  if (!staffRow || staffRow.property_id !== hotelId) {
    return err('Staff link out of sync', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
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
    .select('*').maybeSingle();

  if (upErr) {
    console.error('[pickup:POST] update failed', upErr);
    return err(upErr.message || 'Failed to pick up', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!updated) {
    return err('That shift is already covered', { requestId, status: 409, code: ApiErrorCode.ValidationFailed });
  }

  return ok({ shift: fromScheduledShiftRow(updated) }, { requestId });
}
