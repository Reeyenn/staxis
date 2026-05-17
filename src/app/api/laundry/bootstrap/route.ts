/**
 * Laundry person bootstrap — single round-trip server-side data fetch for
 * the public /laundry/[id] page.
 *
 * Why this exists:
 *   /laundry/[id] is publicly-linkable by design (the laundry worker opens
 *   it on their phone with no Staxis login). The page used to call three
 *   separate functions — getPublicAreas, getLaundryConfig, subscribeToRooms
 *   — all of which went through the supabase browser client. With no
 *   auth session every SELECT silently filtered to zero rows under RLS,
 *   and the page just sat on its loading spinner / empty state forever.
 *   Same bug class as the housekeeper "no rooms" issue from earlier today.
 *
 *   This route runs server-side with supabaseAdmin (service-role,
 *   RLS-bypass), validates the (pid, staffId) capability tuple, and
 *   returns everything the page needs in one shot. Mirrors the security
 *   posture of /api/staff-list and /api/housekeeper/rooms.
 *
 * Response shape:
 *   { ok, requestId, data: { publicAreas, laundryConfig, rooms } }
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import {
  fromPublicAreaRow,
  fromLaundryRow,
  fromRoomRow,
} from '@/lib/db-mappers';

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
  // Light validation — date is YYYY-MM-DD or empty (server picks today below).
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return err('date must be YYYY-MM-DD', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const pid = pidV.value!;
  const staffId = staffV.value!;

  // Capability check — staff must belong to property. Same enumeration-
  // resistance posture as the other public housekeeper / laundry endpoints.
  const { data: staffRow, error: staffErr } = await supabaseAdmin
    .from('staff')
    .select('id')
    .eq('id', staffId)
    .eq('property_id', pid)
    .maybeSingle();
  if (staffErr) {
    log.error('[laundry/bootstrap] staff lookup failed', { err: staffErr, requestId });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!staffRow) {
    return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Pick the date in Houston / America-Chicago — matches the rest of the app.
  // (Workers occasionally leave the page open across midnight; the laundry
  // page itself flips its `today` reactively, so we just need a sensible
  // default for the URL-omitted case.)
  const targetDate = date || (() => {
    try {
      // Lazy compute via Intl in the property's TZ — keeps deps light and
      // avoids pulling date-fns-tz server-side.
      const now = new Date();
      const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' });
      return fmt.format(now); // YYYY-MM-DD
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  })();

  // Fan out the three queries concurrently. Each is bypass-RLS via service-
  // role; the pid scoping is done in the WHERE clause.
  const [areasRes, configRes, roomsRes] = await Promise.all([
    supabaseAdmin.from('public_areas').select('*').eq('property_id', pid),
    supabaseAdmin.from('laundry_config').select('*').eq('property_id', pid),
    supabaseAdmin.from('rooms').select('*').eq('property_id', pid).eq('date', targetDate),
  ]);

  if (areasRes.error || configRes.error || roomsRes.error) {
    log.error('[laundry/bootstrap] query failed', {
      err: areasRes.error || configRes.error || roomsRes.error,
      requestId,
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  const publicAreas = (areasRes.data ?? []).map(fromPublicAreaRow);
  const laundryConfig = (configRes.data ?? []).map(fromLaundryRow);
  const rooms = (roomsRes.data ?? []).map(fromRoomRow);

  return ok({ publicAreas, laundryConfig, rooms, date: targetDate }, { requestId });
}
