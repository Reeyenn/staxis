/**
 * Housekeeper rooms read — service-role bypass for RLS-blocked reads.
 *
 * THE PROBLEM (round 1, 2026-04-30):
 *   /housekeeper/[id] is a publicly-linkable page (SMS link, no Staxis
 *   login). Browser supabase client filtered the SELECT to zero rows
 *   under RLS for the anon caller, so every housekeeper saw "no rooms."
 *   First fix: server-side route using supabaseAdmin against the legacy
 *   `rooms` table.
 *
 * THE PROBLEM (round 2, 2026-05-25 — Plan v4 follow-up):
 *   The legacy `rooms` table was dropped by migration 0204 and re-created
 *   as an empty stub by 0205. This route was still querying that empty
 *   stub. Every housekeeper saw "no rooms" again — same symptom, new
 *   cause.
 *
 * THE FIX:
 *   - Capability check: explicit (pid, staffId) lookup against `staff`.
 *     Returns 404 for invalid pairs (Codex post-merge review Critical #3
 *     — the previous version returned 200 [] for both "invalid pair" and
 *     "valid pair with no assignments," letting attackers enumerate
 *     property/staff combinations via response timing or by inferring
 *     "rooms vs no rooms.")
 *   - Read via `mergePmsRoomsForStaff(pid, staffId)` from the new pms_*
 *     schema. Returns Room[] across the assignment date window so the
 *     housekeeper page can pick today / next-future / last-past
 *     client-side.
 *
 * SECURITY:
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

  // 2026-05-20 audit M3 — rate-limit per (pid, staffId). SMS links are
  // capability tokens but they're forwardable and effectively permanent.
  // 3600/hr matches the page's 4s polling worst case + headroom.
  const rl = await checkAndIncrementRateLimit(
    'housekeeper-rooms',
    hashToRateLimitKey(`${pid}:${staffId}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  // Capability check — staff must belong to property. Explicit lookup
  // here (Codex Critical #3) so we can distinguish "invalid pair" (404)
  // from "valid pair, no assignments" (200 with []).
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
    // Don't echo back which side of the pair was wrong — that helps an
    // enumerator. Same posture as the legacy capability check.
    return err('Not found', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }

  try {
    const rooms = await mergePmsRoomsForStaff(pid, staffId);
    return ok(rooms, { requestId });
  } catch (e: unknown) {
    log.error('[housekeeper/rooms] merge failed', {
      requestId, pid, staffId, msg: errToString(e),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
