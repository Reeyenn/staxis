/**
 * GET /api/housekeeper/daily-summary?pid=...&staffId=...&date=YYYY-MM-DD
 *
 * Returns the housekeeper's personal end-of-shift stats:
 *   - roomsCleaned, roomsRemaining, totalAssigned
 *   - activeCleaningMinutes (sum of cleaning_events.duration_minutes,
 *     recorded + flagged only — discarded events are excluded)
 *   - averageMinutesPerRoom (active / cleaned)
 *   - lunchMinutes (sum of staff_breaks where break_type = 'lunch')
 *   - shortBreakMinutes
 *   - shiftStartedAt / shiftEndedAt (first started_at / last completed_at)
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { verifyStaffLinkToken } from '@/lib/staff-link-auth';
import { mergePmsRoomsForStaff } from '@/lib/pms-rooms-server';
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
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers,
    });
  }
  const staffV = validateUuid(searchParams.get('staffId'), 'staffId');
  if (staffV.error) {
    return err(staffV.error, {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers,
    });
  }
  const date = searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return err('invalid date (YYYY-MM-DD)', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers,
    });
  }
  const pid = pidV.value!;
  const staffId = staffV.value!;

  const rl = await checkAndIncrementRateLimit(
    'housekeeper-daily-summary',
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
    type EventSum = { duration_minutes: number | null; started_at: string | null; completed_at: string | null };
    type BreakSum = { break_type: string; started_at: string; ended_at: string | null };
    const [assignedRooms, cleaningRes, breakRes] = await Promise.all([
      // Rooms assigned to this housekeeper for the date, from the pms_*
      // merge (single source — resolves the staff UUID to the assignment
      // housekeeper_name). Filter to the requested date below.
      mergePmsRoomsForStaff(pid, staffId),
      supabaseAdmin
        .from('cleaning_events')
        .select('duration_minutes, started_at, completed_at')
        .eq('property_id', pid)
        .eq('staff_id', staffId)
        .eq('date', date)
        .in('status', ['recorded', 'flagged']),
      supabaseAdmin
        .from('staff_breaks')
        .select('break_type, started_at, ended_at')
        .eq('property_id', pid)
        .eq('staff_id', staffId)
        .eq('business_date', date),
    ]);

    if (cleaningRes.error) throw cleaningRes.error;
    if (breakRes.error) throw breakRes.error;

    const rooms = assignedRooms.filter((r) => r.date === date);
    const events = (cleaningRes.data ?? []) as EventSum[];
    const breaks = (breakRes.data ?? []) as BreakSum[];

    const totalAssigned = rooms.length;
    const roomsCleaned = rooms.filter(
      (r) => r.status === 'clean' || r.status === 'inspected',
    ).length;
    const roomsRemaining = Math.max(0, totalAssigned - roomsCleaned);

    let activeMin = 0;
    let firstStart: string | null = null;
    let lastDone: string | null = null;
    for (const ev of events) {
      activeMin += Number(ev.duration_minutes ?? 0);
      if (ev.started_at && (!firstStart || ev.started_at < firstStart)) firstStart = ev.started_at;
      if (ev.completed_at && (!lastDone || ev.completed_at > lastDone)) lastDone = ev.completed_at;
    }

    let lunchMin = 0;
    let shortMin = 0;
    for (const br of breaks) {
      if (!br.ended_at) continue;
      const ms = Date.parse(br.ended_at) - Date.parse(br.started_at);
      if (!Number.isFinite(ms) || ms <= 0) continue;
      const mins = ms / 60_000;
      if (br.break_type === 'lunch') lunchMin += mins;
      else shortMin += mins;
    }

    const avgPerRoom = roomsCleaned > 0 ? Number((activeMin / roomsCleaned).toFixed(1)) : 0;

    return ok(
      {
        staffName: gate.staff.name,
        date,
        totalAssigned,
        roomsCleaned,
        roomsRemaining,
        activeCleaningMinutes: Number(activeMin.toFixed(1)),
        averageMinutesPerRoom: avgPerRoom,
        lunchMinutes: Number(lunchMin.toFixed(1)),
        shortBreakMinutes: Number(shortMin.toFixed(1)),
        shiftStartedAt: firstStart,
        shiftEndedAt: lastDone,
      },
      { requestId, headers },
    );
  } catch (caughtErr) {
    log.error('daily-summary: query failed', {
      requestId,
      err: errToString(caughtErr),
    });
    return err('Internal server error', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers,
    });
  }
}
