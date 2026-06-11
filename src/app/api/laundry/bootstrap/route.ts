/**
 * Laundry person bootstrap — single round-trip server-side data fetch for
 * the public /laundry/[id] page.
 *
 * Round 1 (2026-04-30):
 *   Publicly-linkable page. Browser supabase client filtered reads to
 *   zero rows under RLS for anon callers. First fix: supabaseAdmin
 *   server route reading public_areas + laundry_config + the legacy
 *   `rooms` table.
 *
 * Round 2 (2026-05-25, Plan v4 follow-up):
 *   The legacy `rooms` table was dropped (migration 0204) / re-created
 *   as an empty stub (0205). Laundry workers saw empty checkout +
 *   stayover counts. Fix: read rooms from the new pms_* schema via
 *   `mergePmsRoomsForDate(pid, date)`.
 *
 * Response shape (unchanged):
 *   { ok, requestId, data: { publicAreas, laundryConfig, rooms, date } }
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import {
  fromPublicAreaRow,
  fromLaundryRow,
} from '@/lib/db-mappers';
import { mergePmsRoomsForDate } from '@/lib/pms-rooms-server';
import { getPropertyFeedStatus } from '@/lib/pms-feed-status-server';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
} from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const { searchParams } = new URL(req.url);

  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const staffV = validateUuid(searchParams.get('staffId'), 'staffId');
  if (staffV.error) {
    return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const date = (searchParams.get('date') || '').slice(0, 10);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return err('date must be YYYY-MM-DD', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const pid = pidV.value!;
  const staffId = staffV.value!;

  const rl = await checkAndIncrementRateLimit('laundry-bootstrap', pid);
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  const { data: staffRow, error: staffErr } = await supabaseAdmin
    .from('staff')
    .select('id')
    .eq('id', staffId)
    .eq('property_id', pid)
    .maybeSingle();
  if (staffErr) {
    log.error('[laundry/bootstrap] staff lookup failed', { requestId, msg: errToString(staffErr), pid, staffId });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!staffRow) {
    return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Default to the property's local date (America/Chicago) — matches the
  // rest of the app and avoids the UTC midnight roll giving "tomorrow's
  // rooms" at 7pm Houston.
  const targetDate = date || (() => {
    try {
      const now = new Date();
      const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' });
      return fmt.format(now);
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  })();

  // Codex Major #8: degrade gracefully if mergePmsRoomsForDate throws —
  // public_areas + laundry_config are independent and should still render.
  // The laundry page handles `rooms: []` cleanly (renders zero
  // checkouts/stayovers counts); a 500 would blank the whole page.
  const [areasRes, configRes, roomsRes, completionRes] = await Promise.allSettled([
    supabaseAdmin.from('public_areas').select('*').eq('property_id', pid),
    supabaseAdmin.from('laundry_config').select('*').eq('property_id', pid),
    mergePmsRoomsForDate(pid, targetDate),
    // Saved checklist progress for this worker + day (migration 0242).
    // Degrades to "nothing checked yet" if the row is absent or this errors.
    supabaseAdmin
      .from('laundry_completion')
      .select('completed_area_ids, completed_load_categories')
      .eq('property_id', pid)
      .eq('staff_id', staffId)
      .eq('shift_date', targetDate)
      .maybeSingle(),
  ]);

  // public_areas + laundry_config are the laundry worker's primary surface.
  // If both fail, return 500 — the page can't usefully render.
  const areasErr =
    areasRes.status === 'rejected'
      ? String(areasRes.reason)
      : areasRes.value.error?.message;
  const configErr =
    configRes.status === 'rejected'
      ? String(configRes.reason)
      : configRes.value.error?.message;
  if (areasErr && configErr) {
    log.error('[laundry/bootstrap] both static queries failed', {
      requestId, pid, staffId, areasErr, configErr,
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  if (areasErr) {
    log.warn('[laundry/bootstrap] public_areas query failed — returning empty', {
      requestId, pid, staffId, msg: areasErr,
    });
  }
  if (configErr) {
    log.warn('[laundry/bootstrap] laundry_config query failed — returning empty', {
      requestId, pid, staffId, msg: configErr,
    });
  }

  const publicAreas =
    areasRes.status === 'fulfilled' && !areasRes.value.error
      ? ((areasRes.value.data ?? []).map(fromPublicAreaRow))
      : [];
  const laundryConfig =
    configRes.status === 'fulfilled' && !configRes.value.error
      ? ((configRes.value.data ?? []).map(fromLaundryRow))
      : [];
  let rooms: Awaited<ReturnType<typeof mergePmsRoomsForDate>> = [];
  if (roomsRes.status === 'fulfilled') {
    rooms = roomsRes.value;
  } else {
    log.warn('[laundry/bootstrap] rooms merge failed — returning empty rooms', {
      requestId, pid, staffId, targetDate, msg: String(roomsRes.reason),
    });
  }

  const completion =
    completionRes.status === 'fulfilled' && !completionRes.value.error
      ? completionRes.value.data
      : null;
  const completedAreaIds = Array.isArray(completion?.completed_area_ids)
    ? (completion.completed_area_ids as string[])
    : [];
  const completedLoadCategories = Array.isArray(completion?.completed_load_categories)
    ? (completion.completed_load_categories as string[])
    : [];

  // feat/cua-partial-promotion — per-feed trust as a top-level sibling
  // (same convention as the rooms routes): the laundry page derives
  // checkout/stayover load counts from `rooms`, and a missing departures/
  // arrivals feed must show "still learning", not a confident zero.
  // `derived` stripped — public page, doesn't use it (senior review #5).
  const { derived: _derived, ...feedStatus } = await getPropertyFeedStatus(pid);
  return ok(
    { publicAreas, laundryConfig, rooms, date: targetDate, completedAreaIds, completedLoadCategories },
    { requestId, extra: { feedStatus } },
  );
}
