/**
 * Housekeeping rooms read — pms_* tables → legacy Room shape.
 *
 * THE PROBLEM:
 *   Plan v4 (migration 0204) dropped the legacy `rooms` table. The
 *   housekeeping page, dashboard, and front-desk page all subscribe to
 *   the camel-cased Room[] shape via subscribeToRooms() in
 *   src/lib/db/rooms.ts. Without this route, every consumer renders
 *   empty because their underlying source is gone.
 *
 *   The new `pms_*` schema (15 tables, migration 0202) is service-role
 *   only — RLS deny-all-browser means the supabase anon / authenticated
 *   client can't read them. Realtime subscriptions can't fire for the
 *   same reason. So the new read path MUST go through a server route
 *   using supabaseAdmin.
 *
 * THE FIX:
 *   GET /api/housekeeping/rooms?pid=...&date=YYYY-MM-DD
 *     → requireSession (manager-facing UI)
 *     → property-access check (user must own pid)
 *     → rate-limit (M10 — 2400/hr per (user, property))
 *     → mergePmsRoomsForDate() composes Room[] from:
 *         pms_rooms_inventory (canonical room list)
 *         pms_room_status_log (latest status per room, last 90d)
 *         pms_housekeeping_assignments (today's HK plan + dnd_active)
 *         pms_reservations (arrival flags + stayover-day derivation)
 *         staff (best-effort name → id mapping)
 *     → returns standard {ok, requestId, data: Room[]} envelope
 *
 * Same shape rooms.ts used to emit via fromRoomRow() — RoomsTab.tsx and
 * every other consumer renders unchanged.
 */

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { mergePmsRoomsForDate } from '@/lib/pms-rooms-server';
import { getPropertyFeedStatus } from '@/lib/pms-feed-status-server';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

// YYYY-MM-DD — same shape useTodayStr emits. Cheap regex check before
// the merge function trusts it.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Calendar-validity check on top of DATE_RE (post-merge sweep Nit #11).
// DATE_RE alone accepts "2026-99-99". Round-trip through Date to confirm
// the string parses to itself. Cheap; runs once per request.
function isCalendarValid(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const d = new Date(date + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().startsWith(date);
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  // Manager-facing UI (RoomsTab on /housekeeping). Bearer or cookie
  // session — fetchWithAuth handles both.
  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(req.url);
  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const pid = pidV.value!;

  const date = searchParams.get('date') ?? '';
  if (!isCalendarValid(date)) {
    return err('date must be a calendar-valid YYYY-MM-DD', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  // The session caller must have access to this property — without this
  // check any signed-in user could enumerate any hotel's room board by
  // spraying pids.
  const hasAccess = await userHasPropertyAccess(auth.userId, pid);
  if (!hasAccess) {
    log.warn('[housekeeping/rooms] forbidden — user lacks property access', {
      requestId, userId: auth.userId, pid,
    });
    return err('forbidden — no access to this property', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  // M10 — rate-limit per (userId, propertyId). RoomsTab polls every 6s
  // foregrounded so a single tab is well within the 2400/hr cap. Multi-
  // tab managers + visibility-burst refetches still fit. A runaway
  // useEffect or compromised session is bounded.
  const rl = await checkAndIncrementRateLimit(
    'housekeeping-rooms',
    hashToRateLimitKey(`${auth.userId}:${pid}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  try {
    const rooms = await mergePmsRoomsForDate(pid, date);
    // feat/cua-partial-promotion — per-feed trust rides as a TOP-LEVEL
    // sibling so `data` stays a bare Room[] (deployed clients hard-require
    // Array.isArray(data); stale bundles keep working, new clients read the
    // sibling). getPropertyFeedStatus fails safe to "render as today".
    const feedStatus = await getPropertyFeedStatus(pid);
    return ok(rooms, { requestId, extra: { feedStatus } });
  } catch (e: unknown) {
    log.error('[housekeeping/rooms] merge failed', {
      requestId, pid, date, msg: errToString(e),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
