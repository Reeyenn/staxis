// /api/staff-schedule/week-done — the "Finish week" sign-off flag (manager).
//
//   GET   ?hotelId=…                       → { weeks: ['2026-06-07', …] }
//   POST  { hotelId, weekStart, done }     → set / unset the flag
//
// A pure manager bookkeeping flag for the Schedule tab's week boxes
// (✓ DONE). Deliberately NOT the publish mechanism — shifts are published
// as they're placed (see /api/staff-schedule/fill). weekStart is the
// Sunday the new tab's weeks key on. Table is service-role only.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { verifyTeamManager, callerCan } from '@/lib/team-auth';
import { requireSectionEnabled } from '@/lib/sections/server';
import { validateUuid } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_shifts' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const { searchParams } = new URL(req.url);
  const hotelIdCheck = validateUuid(searchParams.get('hotelId'), 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  if (!(await callerCan(caller, 'manage_shifts', hotelIdCheck.value!))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  const { data, error } = await supabaseAdmin
    .from('schedule_week_signoffs').select('week_start')
    .eq('property_id', hotelIdCheck.value!);
  if (error) {
    log.error('[week-done:GET] failed', { requestId, msg: errToString(error) });
    return err('Failed to load sign-offs', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  return ok({ weeks: (data ?? []).map(r => String(r.week_start)) }, { requestId });
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_shifts' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const body = await req.json().catch(() => ({})) as {
    hotelId?: string; weekStart?: string; done?: boolean;
  };
  const hotelIdCheck = validateUuid(body.hotelId, 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;
  if (!(await callerCan(caller, 'manage_shifts', hotelId))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  // Section gate: if Staff is turned off for this hotel, block the write.
  const sectionGate = await requireSectionEnabled(req, hotelId, 'staff');
  if (!sectionGate.ok) return sectionGate.response;

  if (!body.weekStart || !DATE_RE.test(body.weekStart)) {
    return err('weekStart YYYY-MM-DD required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (typeof body.done !== 'boolean') {
    return err('done boolean required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  if (body.done) {
    const { error } = await supabaseAdmin
      .from('schedule_week_signoffs')
      .upsert(
        { property_id: hotelId, week_start: body.weekStart, finished_by: caller.accountId },
        { onConflict: 'property_id,week_start' },
      );
    if (error) {
      log.error('[week-done:POST] upsert failed', { requestId, msg: errToString(error) });
      return err('Failed to mark week done', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
  } else {
    const { error } = await supabaseAdmin
      .from('schedule_week_signoffs').delete()
      .eq('property_id', hotelId).eq('week_start', body.weekStart);
    if (error) {
      log.error('[week-done:POST] delete failed', { requestId, msg: errToString(error) });
      return err('Failed to un-mark week', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
  }
  return ok({ ok: true }, { requestId });
}
