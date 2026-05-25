/**
 * POST /api/housekeeper/complete-clean
 *
 * Housekeeper taps "Done" on a room they've been actively cleaning.
 * Replaces the single-tap 'finish' action on /api/housekeeper/room-action.
 *
 * Key differences vs. legacy 'finish':
 *   • Requires the room is currently `in_progress` (housekeeper tapped
 *     Start). Hard 409 otherwise — there's no started_at to derive
 *     anymore.
 *   • Subtracts `total_paused_seconds` from raw elapsed time so the
 *     cleaning_events.duration_minutes reflects ACTIVE cleaning, not
 *     wall-clock.
 *   • Closes any still-open pause window (housekeeper hit Pause then
 *     Done without Resume) by folding the elapsed pause into the total.
 *
 * Like 'finish' it also:
 *   • Writes a cleaning_events audit row with ML feature snapshot.
 *   • 90s dedup window against retry-storm doubles.
 *   • Classifies duration into recorded / flagged / discarded buckets
 *     matching the existing thresholds (3 / 60 / 90 minutes).
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { deriveCleaningEventFeatures } from '@/lib/feature-derivation';
import { incrementMLFailureCounter } from '@/lib/ml-failure-counters';
import { gateHousekeeperRequest, loadRoomForStaff } from '@/lib/housekeeper-workflow/auth';
import {
  transition,
  activeDurationMinutes,
} from '@/lib/housekeeper-workflow/state-machine';
import { bucketStayoverDay } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// Threshold tiers match /api/housekeeper/room-action (Reeyen, 2026-05-01).
// Kept in sync so the Performance tab doesn't see two different
// classification rules depending on which route wrote the row.
const DISCARD_UNDER_MIN = 3;
const FLAG_OVER_MIN = 60;
const DISCARD_OVER_MIN = 90;

interface Body {
  pid?: string;
  staffId?: string;
  roomId?: string;
}



function classify(
  durationMin: number,
): { status: 'recorded' | 'discarded' | 'flagged'; flag_reason: string | null } {
  if (durationMin < DISCARD_UNDER_MIN) {
    return { status: 'discarded', flag_reason: 'under_3min' };
  }
  if (durationMin > DISCARD_OVER_MIN) {
    return { status: 'discarded', flag_reason: 'over_90min' };
  }
  if (durationMin > FLAG_OVER_MIN) {
    return { status: 'flagged', flag_reason: 'over_60min' };
  }
  return { status: 'recorded', flag_reason: null };
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'housekeeper-complete-clean');
  if (!gate.ok) return gate.response;
  const body = gate.body;
  if (!body.roomId) {
    return err('missing roomId', {
      requestId: gate.requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers: gate.headers,
    });
  }

  const roomR = await loadRoomForStaff({
    pid: gate.pid,
    staffId: gate.staffId,
    roomId: body.roomId,
    requestId: gate.requestId,
    headers: gate.headers,
  });
  if (!roomR.ok) return roomR.response;
  const room = roomR.room;

  const now = new Date().toISOString();
  const result = transition(
    {
      status: (room.status as 'dirty' | 'in_progress' | 'clean' | 'inspected') ?? 'dirty',
      isPaused: !!room.is_paused,
      exceptionType: (room.exception_type as never) ?? null,
      startedAt: room.started_at,
      pausedAt: room.paused_at,
      completedAt: room.completed_at,
      totalPausedSeconds: room.total_paused_seconds ?? 0,
    },
    'complete',
    now,
  );
  if (!result.ok || !result.next) {
    return err(result.reason ?? 'illegal transition', {
      requestId: gate.requestId,
      status: 409,
      code: ApiErrorCode.ValidationFailed,
      headers: gate.headers,
    });
  }

  const startedAt = room.started_at ?? now;
  const completedAt = now;
  const totalPaused = result.next.totalPausedSeconds;
  const durationMin = activeDurationMinutes(startedAt, completedAt, totalPaused);

  // ─── Update rooms ──────────────────────────────────────────────────────
  const { error: updErr } = await supabaseAdmin
    .from('rooms')
    .update({
      status: 'clean',
      started_at: startedAt,
      completed_at: completedAt,
      is_paused: false,
      paused_at: null,
      total_paused_seconds: totalPaused,
    })
    .eq('id', body.roomId);
  if (updErr) {
    log.error('complete-clean: room update failed', {
      requestId: gate.requestId,
      pid: gate.pid,
      staffId: gate.staffId,
      err: errToString(updErr),
    });
    return err('Internal server error', {
      requestId: gate.requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: gate.headers,
    });
  }

  // ─── Close any open pause audit row ────────────────────────────────────
  // If the user went paused → done without Resume, the audit row is still
  // open. Tag it resumed_at=now so the audit doesn't claim the room is
  // forever paused.
  if (room.is_paused) {
    try {
      const { data: openRow } = await supabaseAdmin
        .from('room_pause_events')
        .select('id')
        .eq('room_id', body.roomId)
        .is('resumed_at', null)
        .order('paused_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (openRow?.id) {
        await supabaseAdmin
          .from('room_pause_events')
          .update({ resumed_at: completedAt })
          .eq('id', openRow.id as string);
      }
    } catch (auditErr) {
      log.warn('complete-clean: pause-event close failed (non-fatal)', {
        requestId: gate.requestId,
        err: errToString(auditErr),
      });
    }
  }

  // ─── cleaning_events audit row ─────────────────────────────────────────
  // Only checkout/stayover rooms get an audit row — vacant cleans aren't
  // training data for the supply model.
  const isCleanable = room.type === 'checkout' || room.type === 'stayover';
  let cleaningEventInserted = false;
  let cleaningEventOutcome: 'fresh' | 'deduped' | 'failed' | 'skipped' = 'skipped';
  let isDuplicate = false;

  if (isCleanable && room.date && room.number) {
    const dedupeWindow = new Date(Date.now() - 90_000).toISOString();
    try {
      const { data: recent } = await supabaseAdmin
        .from('cleaning_events')
        .select('id')
        .eq('property_id', gate.pid)
        .eq('staff_id', gate.staffId)
        .eq('room_number', room.number)
        .eq('date', room.date)
        .neq('status', 'discarded')
        .gte('completed_at', dedupeWindow)
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (recent) isDuplicate = true;
    } catch (dedupeErr) {
      log.warn('complete-clean: dedupe lookup failed', {
        requestId: gate.requestId,
        err: errToString(dedupeErr),
      });
    }

    if (!isDuplicate) {
      const { status, flag_reason } = classify(durationMin);

      // ML feature derivation — non-fatal, all-or-none.
      let features = {
        dayOfWeek: null as number | null,
        dayOfStayRaw: null as number | null,
        roomFloor: null as number | null,
        occupancyAtStart: null as number | null,
        totalCheckoutsToday: null as number | null,
        totalRoomsAssignedToHk: null as number | null,
        routePosition: null as number | null,
        minutesSinceShiftStart: null as number | null,
        wasDndDuringClean: null as boolean | null,
        weatherClass: null as string | null,
      };
      try {
        features = await deriveCleaningEventFeatures({
          propertyId: gate.pid,
          date: room.date,
          roomNumber: room.number,
          staffId: gate.staffId,
          startedAt: new Date(startedAt),
          completedAt: new Date(completedAt),
        });
      } catch (featureErr) {
        log.error('complete-clean: feature derivation threw', {
          requestId: gate.requestId,
          err: errToString(featureErr),
        });
        await incrementMLFailureCounter(gate.pid, 'feature_derivation', featureErr);
      }

      const cePayload: Record<string, unknown> = {
        property_id: gate.pid,
        date: room.date,
        room_number: room.number,
        room_type: room.type,
        // bucketStayoverDay reads from a typed-but-optional field; the
        // legacy room shape might not have it on every row.
        stayover_day: bucketStayoverDay(
          (room as { stayover_day?: number }).stayover_day ?? null,
          room.type as 'checkout' | 'stayover',
        ),
        staff_id: gate.staffId,
        staff_name: gate.staffName,
        started_at: startedAt,
        completed_at: completedAt,
        duration_minutes: durationMin,
        status,
        flag_reason,
        day_of_week: features.dayOfWeek,
        day_of_stay_raw: features.dayOfStayRaw,
        room_floor: features.roomFloor,
        occupancy_at_start: features.occupancyAtStart,
        total_checkouts_today: features.totalCheckoutsToday,
        total_rooms_assigned_to_hk: features.totalRoomsAssignedToHk,
        route_position: features.routePosition,
        minutes_since_shift_start: features.minutesSinceShiftStart,
        was_dnd_during_clean: features.wasDndDuringClean,
        weather_class: features.weatherClass,
      };

      const { data: insertedRows, error: ceErr } = await supabaseAdmin
        .from('cleaning_events')
        .upsert(cePayload, {
          onConflict: 'property_id,date,room_number,started_at,completed_at',
          ignoreDuplicates: true,
        })
        .select('id');

      if (ceErr) {
        cleaningEventOutcome = 'failed';
        log.error('complete-clean: cleaning_events insert failed (non-fatal)', {
          requestId: gate.requestId,
          pid: gate.pid,
          staffId: gate.staffId,
          err: errToString(ceErr),
        });
      } else if (Array.isArray(insertedRows) && insertedRows.length > 0) {
        cleaningEventOutcome = 'fresh';
        cleaningEventInserted = true;
      } else {
        cleaningEventOutcome = 'deduped';
        cleaningEventInserted = true;
      }
    } else {
      cleaningEventOutcome = 'deduped';
      cleaningEventInserted = true;
    }
  }

  return ok(
    {
      roomId: body.roomId,
      startedAt,
      completedAt,
      activeDurationMinutes: durationMin,
      totalPausedSeconds: totalPaused,
      cleaningEventInserted,
      cleaningEventOutcome,
      deduped: isDuplicate,
    },
    { requestId: gate.requestId, headers: gate.headers },
  );
}
