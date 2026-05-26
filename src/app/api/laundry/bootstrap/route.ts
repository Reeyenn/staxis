/**
 * Laundry person bootstrap — single round-trip server-side data fetch for
 * the public /laundry/[id] page.
 *
 * Round 1 (2026-04-30):
 *   /laundry/[id] is publicly-linkable. Browser supabase client filtered
 *   reads to zero rows under RLS. Fixed via supabaseAdmin server route
 *   reading public_areas + laundry_config + the legacy `rooms` table.
 *
 * Round 2 (2026-05-25, Plan v4 follow-up):
 *   The legacy `rooms` table was dropped (migration 0204) / re-created as
 *   an empty stub (0205). Laundry workers saw empty checkout/stayover
 *   counts. Fix: read rooms from the new pms_* schema via
 *   `mergePmsRoomsForDate(pid, date)` — the same helper the manager Rooms
 *   tab uses.
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

  // 2026-05-20 audit M3 — rate-limit per property.
  const rl = await checkAndIncrementRateLimit('laundry-bootstrap', pid);
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  // Capability check — staff must belong to property. Same enumeration-
  // resistance posture as the other public housekeeper / laundry endpoints.
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

  // Pick the date in Houston / America-Chicago — matches the rest of the app.
  const targetDate = date || (() => {
    try {
      const now = new Date();
      const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' });
      return fmt.format(now); // YYYY-MM-DD
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  })();

  // public_areas + laundry_config are still on legacy tables (manager-
  // configured, not CUA-extracted) — read those directly. Rooms come
  // from the new pms_* schema via the merge helper.
  try {
    const [areasRes, configRes, rooms] = await Promise.all([
      supabaseAdmin.from('public_areas').select('*').eq('property_id', pid),
      supabaseAdmin.from('laundry_config').select('*').eq('property_id', pid),
      mergePmsRoomsForDate(pid, targetDate),
    ]);

    if (areasRes.error || configRes.error) {
      log.error('[laundry/bootstrap] static query failed', {
        requestId,
        msg: errToString(areasRes.error || configRes.error),
        pid,
        staffId,
      });
      return err('Internal server error', {
        requestId, status: 500, code: ApiErrorCode.InternalError,
      });
    }

    const publicAreas = (areasRes.data ?? []).map(fromPublicAreaRow);
    const laundryConfig = (configRes.data ?? []).map(fromLaundryRow);

    return ok({ publicAreas, laundryConfig, rooms, date: targetDate }, { requestId });
  } catch (e: unknown) {
    log.error('[laundry/bootstrap] rooms merge failed', {
      requestId, pid, staffId, targetDate, msg: errToString(e),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
