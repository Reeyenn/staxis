/**
 * GET /api/housekeeper/component-rooms?pid=...&staffId=...
 *
 * Returns the property's component-room links so the housekeeper page
 * can collapse multi-room suites into a single job card. Manager-curated
 * data; small cardinality (typically <20 suites per property).
 *
 * Capability gate is the same shape as the rest of /api/housekeeper/* —
 * (pid, staffId) must be a real pair on the same property.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { verifyStaffLinkToken } from '@/lib/staff-link-auth';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };
  const { searchParams } = new URL(req.url);

  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  const staffV = validateUuid(searchParams.get('staffId'), 'staffId');
  if (staffV.error) {
    return err(staffV.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  const pid = pidV.value!;
  const staffId = staffV.value!;

  // Reuse the rooms-read rate-limit bucket — same shape (property-data
  // read polled by the housekeeper page).
  const rl = await checkAndIncrementRateLimit(
    'housekeeper-rooms',
    hashToRateLimitKey(`${pid}:${staffId}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  // Security audit 2026-06-26 #1: verify the per-staff link token (?tok=),
  // not the raw (pid, staffId) tuple.
  const gate = await verifyStaffLinkToken(req, { pid, staffId, requestId });
  if (!gate.ok) return gate.response;

  try {
    type LinkRow = {
      parent_room_number: string;
      child_room_numbers: string[] | unknown;
      label: string | null;
    };
    const { data, error: q } = await supabaseAdmin
      .from('component_rooms')
      .select('parent_room_number, child_room_numbers, label')
      .eq('property_id', pid);
    if (q) throw q;
    const links = ((data ?? []) as LinkRow[])
      .map((row) => ({
        parent_room_number: row.parent_room_number,
        child_room_numbers: Array.isArray(row.child_room_numbers)
          ? (row.child_room_numbers as unknown[]).filter((x): x is string => typeof x === 'string')
          : [],
        label: row.label,
      }))
      .filter((l) => l.child_room_numbers.length > 0);
    return ok({ links }, { requestId, headers });
  } catch (caughtErr) {
    log.error('component-rooms: GET failed', {
      requestId, err: errToString(caughtErr),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError, headers,
    });
  }
}
