// /api/staff-schedule/publish — manager Publish Week + Copy Last Week.
//
//   POST  body: { hotelId, weekStart, action?: 'publish' | 'copy' }
//     action='publish' (default) → flips every draft scheduled_shifts row
//       in the [weekStart, weekStart+6d] window to status='published' and
//       stamps a week_publications row.
//     action='copy' → looks at the previous week (weekStart - 7d, +6d),
//       clones each shift to the target week at status='draft', skipping
//       any staff/day where an approved time_off_request exists.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { verifyTeamManager, canManageHotel } from '@/lib/team-auth';
import { validateUuid } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const body = await req.json().catch(() => ({})) as {
    hotelId?: string; weekStart?: string; action?: 'publish' | 'copy';
  };
  const hotelIdCheck = validateUuid(body.hotelId, 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;
  if (!canManageHotel(caller, hotelId)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }
  if (!body.weekStart || !DATE_RE.test(body.weekStart)) {
    return err('weekStart YYYY-MM-DD required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const weekStart = body.weekStart;
  const weekEnd = addDays(weekStart, 6);
  const action = body.action ?? 'publish';

  if (action === 'publish') {
    // Flip drafts → published. We leave shifts already at sent/confirmed/
    // declined alone (those are mid-SMS-cycle from /housekeeping flow).
    const { error: upErr, count } = await supabaseAdmin
      .from('scheduled_shifts').update({ status: 'published' }, { count: 'exact' })
      .eq('property_id', hotelId)
      .eq('status', 'draft')
      .gte('shift_date', weekStart).lte('shift_date', weekEnd);
    if (upErr) {
      log.error('[publish:POST] update failed', { requestId, msg: errToString(upErr) });
      return err('Failed to publish', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }

    // Stamp a publication record (keep history, latest row wins).
    const { error: pubErr } = await supabaseAdmin
      .from('week_publications').insert({
        property_id: hotelId,
        week_start:  weekStart,
        published_by: caller.accountId,
      });
    if (pubErr) {
      log.error('[publish:POST] publication insert failed', { requestId, msg: errToString(pubErr) });
      return err('Failed to record publication', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }

    return ok({ ok: true, published: count ?? 0 }, { requestId });
  }

  if (action === 'copy') {
    const sourceStart = addDays(weekStart, -7);
    const sourceEnd   = addDays(weekStart, -1);

    // Pull source-week shifts. Only clone real assignments (kind='shift',
    // staff_id set). We don't clone open-shift rows — those were specific
    // to that week.
    const { data: src, error: srcErr } = await supabaseAdmin
      .from('scheduled_shifts').select('staff_id, department, shift_date, start_time, end_time, preset_id, note')
      .eq('property_id', hotelId).eq('kind', 'shift')
      .gte('shift_date', sourceStart).lte('shift_date', sourceEnd)
      .not('staff_id', 'is', null);
    if (srcErr) {
      log.error('[publish:copy] source query failed', { requestId, msg: errToString(srcErr) });
      return err('Failed to read source week', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
    if (!src || src.length === 0) {
      return ok({ ok: true, copied: 0, note: 'Source week is empty' }, { requestId });
    }

    // Skip approved time-off in the target week.
    const { data: tor } = await supabaseAdmin
      .from('time_off_requests').select('staff_id, request_date')
      .eq('property_id', hotelId).eq('status', 'approved')
      .gte('request_date', weekStart).lte('request_date', weekEnd);
    const torKeys = new Set((tor ?? []).map(r => `${r.staff_id}:${r.request_date}`));

    const toInsert = src.map(r => {
      const newDate = addDays(String(r.shift_date), 7);
      return {
        property_id: hotelId,
        staff_id:    r.staff_id,
        department:  r.department,
        shift_date:  newDate,
        start_time:  r.start_time,
        end_time:    r.end_time,
        kind:        'shift' as const,
        status:      'draft' as const,
        preset_id:   r.preset_id,
        note:        r.note,
      };
    }).filter(row => !torKeys.has(`${row.staff_id}:${row.shift_date}`));

    if (toInsert.length === 0) {
      return ok({ ok: true, copied: 0, note: 'All source shifts conflict with approved TOR' }, { requestId });
    }

    // Bulk insert. on_conflict isn't supported with the exclusion
    // constraint; instead we delete-then-insert for any existing rows in
    // the target week first.
    await supabaseAdmin
      .from('scheduled_shifts').delete()
      .eq('property_id', hotelId).eq('kind', 'shift')
      .gte('shift_date', weekStart).lte('shift_date', weekEnd)
      .in('staff_id', toInsert.map(r => r.staff_id!));

    const { error: insErr } = await supabaseAdmin.from('scheduled_shifts').insert(toInsert);
    if (insErr) {
      log.error('[publish:copy] insert failed', { requestId, msg: errToString(insErr) });
      return err('Failed to copy week', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
    return ok({ ok: true, copied: toInsert.length, skipped: src.length - toInsert.length }, { requestId });
  }

  return err('Invalid action (publish | copy)', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
}
