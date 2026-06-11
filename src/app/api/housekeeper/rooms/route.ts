/**
 * Housekeeper rooms read — service-role bypass for RLS-blocked reads.
 *
 * Round 1 (2026-04-30):
 *   /housekeeper/[id] is a publicly-linkable page (SMS link, no Staxis
 *   login). Browser supabase client filtered the SELECT to zero rows
 *   under RLS, so every housekeeper saw "no rooms." First fix: server-
 *   side route using supabaseAdmin against the legacy `rooms` table.
 *
 * Round 2 (2026-05-25, Plan v4 follow-up):
 *   Migration 0204 dropped the legacy `rooms` table; 0205 re-created it
 *   as an empty stub so legacy callers don't 500. This route was still
 *   querying that empty stub → housekeepers saw "no rooms" again. Fix:
 *   read from the new pms_* schema via mergePmsRoomsForStaff(pid, staffId).
 *
 * Capability check:
 *   Explicit (pid, staffId) lookup against `staff`. Returns 404 for
 *   invalid pairs, 200 [] only for valid pairs with no assignments —
 *   distinguishes the two so an enumerator can't probe by inferring
 *   "rooms vs no rooms."
 *
 * Security:
 *   Same trust model as round 1 — (pid, staffId) is the capability tuple
 *   from the SMS link. Rate-limit on (pid, staffId) bounds replay if a
 *   link leaks.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { mergePmsRoomsForStaff } from '@/lib/pms-rooms-server';
import { getPropertyFeedStatus } from '@/lib/pms-feed-status-server';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
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
  const pid = pidV.value!;
  const staffId = staffV.value!;

  // Rate-limit per (pid, staffId). SMS links are forwardable capability
  // tokens — the cap bounds replay if a link leaks.
  const rl = await checkAndIncrementRateLimit(
    'housekeeper-rooms',
    hashToRateLimitKey(`${pid}:${staffId}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  // Explicit capability check — distinguishes "invalid pair" (404) from
  // "valid pair, no assignments" (200 []).
  const { data: staffRow, error: staffErr } = await supabaseAdmin
    .from('staff')
    .select('id')
    .eq('id', staffId)
    .eq('property_id', pid)
    .maybeSingle();
  if (staffErr) {
    log.error('[housekeeper/rooms] staff lookup failed', {
      requestId, msg: errToString(staffErr),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  if (!staffRow) {
    return err('Not found', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }

  try {
    const rooms = await mergePmsRoomsForStaff(pid, staffId);
    // feat/cua-partial-promotion — sibling key so `data` stays a bare
    // Room[] for stale mobile bundles (this is a PUBLIC SMS-linked page;
    // phones poll old JS for a while after a deploy). Fails safe.
    const feedStatus = await getPropertyFeedStatus(pid);
    return ok(rooms, { requestId, extra: { feedStatus } });
  } catch (e: unknown) {
    log.error('[housekeeper/rooms] merge failed', {
      requestId, pid, staffId, msg: errToString(e),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
