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
// Plan v4 bridge: deriveCleaningEventFeatures now reads from the
// today_room_work_v1 + today_property_counts_v1 RPCs (which derive live
// from pms_room_status_log + pms_reservations + pms_in_house_snapshot +
// pms_housekeeping_assignments — all written by the vision CUA). Any
// feature that can't be derived (CUA hasn't reached the hotel yet,
// schema drift, RPC error) returns null — cleaning_events insert still
// proceeds.
import { deriveCleaningEventFeatures } from '@/lib/feature-derivation';
import { gateHousekeeperRequest, loadRoomForStaff } from '@/lib/housekeeper-workflow/auth';
import { writeWorkflowFields } from '@/lib/housekeeper-workflow/workflow-store';
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

  // ─── Persist completion to the pms assignment (Plan-v4; migration 0269) ──
  const w = await writeWorkflowFields(gate.pid, body.roomId, {
    status: 'clean',
    started_at: startedAt,
    completed_at: completedAt,
    is_paused: false,
    paused_at: null,
    total_paused_seconds: totalPaused,
  });
  if (!w.ok) {
    log.error('complete-clean: write failed', {
      requestId: gate.requestId,
      pid: gate.pid,
      staffId: gate.staffId,
      err: w.error,
    });
    return err('Internal server error', {
      requestId: gate.requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: gate.headers,
    });
  }

  // ─── Component-room fanout (migration 0225) ─────────────────────────────
  // If the just-completed room is the parent of a multi-room suite, mark
  // every child as clean too. The spec's promise was "one Done tap
  // completes everything"; without this fanout, the manager dashboard
  // would show the parent clean and the children still dirty.
  //
  // Best-effort — a child UPDATE failure logs a warning but doesn't roll
  // back the parent. The housekeeper isn't standing in the suite running
  // separate clocks per sub-room, so the audit row on the parent is the
  // source of truth.
  if (room.number) {
    try {
      type CompRow = { child_room_numbers: unknown };
      const { data: comp, error: compErr } = await supabaseAdmin
        .from('component_rooms')
        .select('child_room_numbers')
        .eq('property_id', gate.pid)
        .eq('parent_room_number', room.number)
        .maybeSingle();
      if (compErr) throw compErr;
      const children = Array.isArray((comp as CompRow | null)?.child_room_numbers)
        ? ((comp as CompRow).child_room_numbers as unknown[]).filter(
            (x): x is string => typeof x === 'string',
          )
        : [];
      if (children.length > 0 && room.date) {
        const { error: fanoutWriteErr } = await supabaseAdmin
          .from('pms_housekeeping_assignments')
          .update({
            status: 'completed',
            started_at: startedAt,
            completed_at: completedAt,
            is_paused: false,
            paused_at: null,
          })
          .eq('property_id', gate.pid)
          .eq('date', room.date)
          .in('room_number', children)
          // Only flip rooms that are still dirty/in-progress — don't
          // accidentally re-clean a sub-room someone already inspected.
          .in('status', ['not_started', 'in_progress']);
        if (fanoutWriteErr) {
          log.warn('complete-clean: component-room fanout write failed (non-fatal)', {
            requestId: gate.requestId,
            pid: gate.pid,
            parentRoom: room.number,
            err: errToString(fanoutWriteErr),
          });
        }
      }
    } catch (fanoutErr) {
      log.warn('complete-clean: component-room fanout failed (non-fatal)', {
        requestId: gate.requestId,
        pid: gate.pid,
        parentRoom: room.number,
        err: errToString(fanoutErr),
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

      // ML feature derivation — best-effort, all-or-some-null is fine.
      // Reads the today_*_v1 bridge RPCs which derive live from pms_*.
      const features = await deriveCleaningEventFeatures({
        propertyId: gate.pid,
        date: room.date,
        roomNumber: room.number,
        staffId: gate.staffId,
        startedAt: new Date(startedAt),
        completedAt: new Date(completedAt),
      }).catch((err: unknown) => {
        log.error('complete-clean: feature derivation unexpectedly threw', {
          requestId: gate.requestId, err: errToString(err),
        });
        return {
          dayOfWeek: null, dayOfStayRaw: null, roomFloor: null,
          occupancyAtStart: null, totalCheckoutsToday: null,
          totalRoomsAssignedToHk: null, routePosition: null,
          minutesSinceShiftStart: null, wasDndDuringClean: null,
          weatherClass: null,
        };
      });

      const cePayload: Record<string, unknown> = {
        property_id: gate.pid,
        date: room.date,
        room_number: room.number,
        room_type: room.type,
        stayover_day: bucketStayoverDay(
          room.stayover_day ?? null,
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
