/**
 * GET /api/cron/schedule-auto-fill?target=today|tomorrow
 *
 * Round 17 (2026-05-15). Runs the same Auto-assign logic Maria's
 * Schedule-tab button runs, but on a cron so the schedule lands even
 * when she doesn't click. Two daily slots:
 *   - 12:00 UTC (7 AM CT) with target=today  — safety net for the rare
 *     case Maria didn't build the schedule yesterday evening.
 *   - 01:00 UTC next day (8 PM CT) with target=tomorrow — primary run,
 *     so when she opens the tab in the morning a draft is ready.
 *
 * Critical safety rule: if `schedule_assignments` already has a row for
 * (property_id, target_date), this cron is a no-op for that property.
 * Maria's manual edits are never overwritten.
 *
 * Auth: CRON_SECRET bearer.
 *
 * This route exists because the supply ML cron needs schedule_assignments
 * to write supply_predictions (see predict_supply.py iterating
 * schedule_assignments → empty schedule = zero predictions). Without
 * this cron, every day's supply predictions are gated on Maria
 * remembering to open the Schedule tab.
 */

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { autoAssignRooms } from '@/lib/calculations';
import { runWithConcurrency } from '@/lib/parallel';
import { propertyLocalDateOffset } from '@/lib/schedule/local-date';
import { selectActiveCrewWithReasons } from '@/lib/schedule/active-crew';
import { fromStaffRow, parseStringField, parseNumberField } from '@/lib/db-mappers';
import type { StaffMember } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface PropertyRow {
  id: string;
  name: string;
  timezone: string | null;
  checkout_minutes: number | null;
  stayover_minutes: number | null;
  stayover_day1_minutes: number | null;
  stayover_day2_minutes: number | null;
  prep_minutes_per_activity: number | null;
  shift_minutes: number | null;
}

/** Runtime shape check for the SELECT in GET below. Audit finding H3. */
function parsePropertyRow(raw: unknown): PropertyRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = parseStringField(r.id);
  const name = parseStringField(r.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    timezone: parseStringField(r.timezone) ?? null,
    checkout_minutes: parseNumberField(r.checkout_minutes) ?? null,
    stayover_minutes: parseNumberField(r.stayover_minutes) ?? null,
    stayover_day1_minutes: parseNumberField(r.stayover_day1_minutes) ?? null,
    stayover_day2_minutes: parseNumberField(r.stayover_day2_minutes) ?? null,
    prep_minutes_per_activity: parseNumberField(r.prep_minutes_per_activity) ?? null,
    shift_minutes: parseNumberField(r.shift_minutes) ?? null,
  };
}

interface RoomRow {
  id: string;
  number: string;
  type: string;
  priority: string;
  stayover_day: number | null;
}

// Round 18: pulled into src/lib/schedule/local-date.ts so it has unit
// tests covering DST + high-positive-offset timezones (Pacific/Kiritimati
// was off-by-one in the prior UTC-round-trip implementation).
const localDate = propertyLocalDateOffset;

interface PerPropertyResult {
  propertyId: string;
  propertyName: string;
  date: string;
  outcome: 'auto_filled' | 'skipped_existing' | 'skipped_no_rooms' | 'skipped_no_crew' | 'error';
  detail?: string;
  roomsAssigned?: number;
  crewSize?: number;
}

async function autoFillForProperty(
  property: PropertyRow,
  targetDate: string,
  requestId: string,
): Promise<PerPropertyResult> {
  // Round 18: the existence check moved into the atomic RPC at the end
  // of this function. A pre-check here would re-introduce the race that
  // Codex flagged (cron reads empty → Maria saves → cron overwrites).
  // We still want to short-circuit BEFORE doing expensive work, so a
  // light "is there a row?" peek is fine — but the AUTHORITATIVE
  // skip-existing decision is the RPC's `on conflict do nothing`.
  const { data: existingPeek } = await supabaseAdmin
    .from('schedule_assignments')
    .select('property_id')
    .eq('property_id', property.id)
    .eq('date', targetDate)
    .limit(1)
    .maybeSingle();
  if (existingPeek) {
    return {
      propertyId: property.id, propertyName: property.name, date: targetDate,
      outcome: 'skipped_existing',
      detail: 'Manager already built this schedule — leaving it alone.',
    };
  }

  // 2. Load housekeeping staff with ALL fields the eligibility check needs.
  //    Round 18 fix: the previous version only selected id/name/department/
  //    is_active/schedule_priority and missed vacation_dates, weekly_hours,
  //    max_weekly_hours, max_days_per_week, days_worked_this_week. That
  //    meant the cron assigned rooms to housekeepers on vacation and
  //    pushed seniors into overtime. selectActiveCrewWithReasons enforces
  //    the same rules the staff page's `isEligible` does.
  const { data: staffRows, error: staffErr } = await supabaseAdmin
    .from('staff')
    .select('*')
    .eq('property_id', property.id);
  if (staffErr) {
    return {
      propertyId: property.id, propertyName: property.name, date: targetDate,
      outcome: 'error',
      detail: `staff load failed: ${staffErr.message}`,
    };
  }
  const allStaff: StaffMember[] = (staffRows ?? []).map((r) =>
    fromStaffRow(r as Record<string, unknown>),
  );
  const { eligible: activeCrew, excluded } = selectActiveCrewWithReasons(allStaff, {
    targetDate,
    requirePhone: false,  // cron writes the schedule; SMS-send is separate
    respectSchedulePriority: true,
  });
  if (activeCrew.length === 0) {
    const reasonSummary = excluded.length > 0
      ? ` ${excluded.length} housekeeper(s) excluded — top reason: ${excluded[0].reason}`
      : '';
    return {
      propertyId: property.id, propertyName: property.name, date: targetDate,
      outcome: 'skipped_no_crew',
      detail: `No eligible housekeeping staff for ${targetDate}.${reasonSummary}`,
    };
  }
  if (excluded.length > 0) {
    log.info('[schedule-auto-fill] partial crew exclusion', {
      requestId, propertyId: property.id, date: targetDate,
      eligible: activeCrew.length,
      excludedBy: excluded.reduce<Record<string, number>>((acc, e) => {
        acc[e.reason] = (acc[e.reason] ?? 0) + 1;
        return acc;
      }, {}),
    });
  }

  // 3. Load rooms for the target date. Cron seed-rooms-daily seeds
  //    these hourly; if nothing's seeded yet, skip rather than error.
  const { data: roomRows, error: roomErr } = await supabaseAdmin
    .from('rooms')
    .select('id, number, type, priority, stayover_day')
    .eq('property_id', property.id)
    .eq('date', targetDate);
  if (roomErr) {
    return {
      propertyId: property.id, propertyName: property.name, date: targetDate,
      outcome: 'error',
      detail: `rooms load failed: ${roomErr.message}`,
    };
  }
  // Match the UI's assignableRooms filter: only checkout + stayover.
  // 'vacant' rooms don't need cleaning today.
  const assignable = (roomRows as RoomRow[] | null ?? []).filter(
    (r) => r.type === 'checkout' || r.type === 'stayover',
  );
  if (assignable.length === 0) {
    return {
      propertyId: property.id, propertyName: property.name, date: targetDate,
      outcome: 'skipped_no_rooms',
      detail: `No assignable rooms for ${targetDate}. Either seed-rooms-daily hasn't run yet, or it's an all-vacant day.`,
    };
  }

  // 4. Shape rooms for autoAssignRooms. `activeCrew` is already
  //    StaffMember[] — Round 18 fix: previous version handed the
  //    algorithm fake stubs with weeklyHours=0/maxWeeklyHours=40 for
  //    every housekeeper, meaning the algorithm thought everyone was
  //    infinitely available. Real weekly hours now flow through, so
  //    seniors near their cap don't get overscheduled into overtime.
  const roomsForAlgo = assignable.map((r) => ({
    id: r.id,
    number: r.number,
    type: r.type,
    priority: r.priority,
    stayoverDay: r.stayover_day ?? undefined,
  }));
  const config = {
    checkoutMinutes: property.checkout_minutes ?? 30,
    stayoverMinutes: property.stayover_minutes ?? 20,
    stayoverDay1Minutes: property.stayover_day1_minutes ?? 15,
    stayoverDay2Minutes: property.stayover_day2_minutes ?? 20,
    prepMinutesPerRoom: property.prep_minutes_per_activity ?? 5,
    shiftMinutes: property.shift_minutes ?? 420,
  };

  // 5. Compute assignments using the same algorithm Maria's button runs.
  const roomAssignments = autoAssignRooms(roomsForAlgo, activeCrew, config);
  const assignedRoomCount = Object.keys(roomAssignments).length;
  if (assignedRoomCount === 0) {
    return {
      propertyId: property.id, propertyName: property.name, date: targetDate,
      outcome: 'error',
      detail: `Algorithm produced 0 assignments from ${assignable.length} rooms × ${activeCrew.length} crew. Possible all-excluded staff or shift-cap mismatch.`,
    };
  }

  // 6. Persist the schedule + the CSV-snapshot baseline for overnight-diff.
  // The UI uses schedule_assignments.csv_room_snapshot to warn Maria
  // when the morning CSV differs from the saved evening plan. Without
  // it, Codex review found that cron-built schedules silently disable
  // that signal. Pull the most-recent plan_snapshot for this
  // (property, target_date) and persist its rooms array alongside the
  // assignments.
  const { data: planRow } = await supabaseAdmin
    .from('plan_snapshots')
    .select('rooms, pulled_at')
    .eq('property_id', property.id)
    .eq('date', targetDate)
    .order('pulled_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  // Mirror the UI's `csvRoomSnapshot` shape:  { number, type }[]
  // The full plan_snapshot rooms array has more fields; the diff cares
  // only about the room number + type, so reshape here.
  type SnapshotRoom = { number?: string; type?: string; stayType?: string; status?: string };
  let csvRoomSnapshot: Array<{ number: string; type: 'checkout' | 'stayover' }> | null = null;
  if (planRow?.rooms) {
    const rooms = (planRow.rooms as SnapshotRoom[] | null) ?? [];
    csvRoomSnapshot = rooms
      .map((r) => {
        const num = r.number;
        if (!num) return null;
        // Match seed.ts mapRoomType: C/O stayType OR OCC status → checkout/stayover
        const type: 'checkout' | 'stayover' =
          r.stayType === 'C/O' ? 'checkout'
          : r.status === 'OCC' ? 'stayover'
          : 'stayover';
        return { number: num, type };
      })
      .filter((x): x is { number: string; type: 'checkout' | 'stayover' } => x !== null);
  }

  const staffNames: Record<string, string> = {};
  for (const s of activeCrew) staffNames[s.id] = s.name;

  // Atomic insert-if-absent. The RPC returns true iff THIS call inserted
  // the row. If false, Maria (or a concurrent cron worker) got there first
  // and we leave the existing row alone.
  const { data: inserted, error: rpcErr } = await supabaseAdmin.rpc(
    'staxis_schedule_auto_fill_if_absent',
    {
      p_property: property.id,
      p_date: targetDate,
      p_room_assignments: roomAssignments,
      p_crew: activeCrew.map((s) => s.id),
      p_staff_names: staffNames,
      p_csv_room_snapshot: csvRoomSnapshot,
      p_csv_pulled_at: planRow?.pulled_at ?? null,
    },
  );
  if (rpcErr) {
    log.error('[schedule-auto-fill] atomic insert failed', {
      requestId, propertyId: property.id, date: targetDate, error: rpcErr.message,
    });
    return {
      propertyId: property.id, propertyName: property.name, date: targetDate,
      outcome: 'error',
      detail: `RPC failed: ${rpcErr.message}`,
    };
  }
  // RPC returned false → row already existed (race winner: not us).
  // Surface this as `skipped_existing` to preserve "never overwrite"
  // invariant even when the early peek missed it.
  if (inserted === false) {
    return {
      propertyId: property.id, propertyName: property.name, date: targetDate,
      outcome: 'skipped_existing',
      detail: 'Concurrent writer (manager save or sibling cron) inserted first — leaving it alone.',
    };
  }
  return {
    propertyId: property.id, propertyName: property.name, date: targetDate,
    outcome: 'auto_filled',
    roomsAssigned: assignedRoomCount,
    crewSize: activeCrew.length,
  };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  const url = new URL(req.url);
  const targetParam = url.searchParams.get('target') ?? 'tomorrow';
  if (targetParam !== 'today' && targetParam !== 'tomorrow') {
    return err(`invalid target "${targetParam}" — must be "today" or "tomorrow"`, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const offsetDays = targetParam === 'today' ? 0 : 1;

  try {
    const { data: properties, error: propErr } = await supabaseAdmin
      .from('properties')
      .select(
        'id, name, timezone, checkout_minutes, stayover_minutes, ' +
          'stayover_day1_minutes, stayover_day2_minutes, ' +
          'prep_minutes_per_activity, shift_minutes',
      );
    if (propErr) throw propErr;

    const now = new Date();
    const propertyJobs: PropertyRow[] = [];
    for (const raw of properties ?? []) {
      const p = parsePropertyRow(raw);
      if (p) propertyJobs.push(p);
    }
    log.info('[schedule-auto-fill] start', {
      requestId, target: targetParam, propertyCount: propertyJobs.length,
    });

    // Round 18 fleet-scale finding: a single slow Supabase query inside
    // autoFillForProperty would block one of the 5 concurrency slots
    // indefinitely. At 50+ properties that compounds — one stuck slot
    // means the run-inference budget shrinks by 20%. Cap each property
    // at 8s wall-clock; outside that, mark it as an error so the slot
    // is freed and the next property can run. 8s is generous: a healthy
    // property completes the full read + RPC + persist sequence in ~200ms.
    const PER_PROPERTY_TIMEOUT_MS = 8_000;
    const outcomes = await runWithConcurrency(
      propertyJobs,
      async (p) => {
        const targetDate = localDate(now, p.timezone, offsetDays);
        return await Promise.race<PerPropertyResult>([
          autoFillForProperty(p, targetDate, requestId),
          new Promise<PerPropertyResult>((resolve) =>
            setTimeout(
              () => resolve({
                propertyId: p.id,
                propertyName: p.name,
                date: targetDate,
                outcome: 'error',
                detail: `per-property timeout after ${PER_PROPERTY_TIMEOUT_MS}ms — likely slow Supabase query or hung RPC`,
              }),
              PER_PROPERTY_TIMEOUT_MS,
            ),
          ),
        ]);
      },
      5,
    );

    const results: PerPropertyResult[] = outcomes.map((o) =>
      o.ok
        ? o.value
        : {
            propertyId: o.input.id, propertyName: o.input.name,
            date: localDate(now, o.input.timezone, offsetDays),
            outcome: 'error' as const,
            detail: `outer loop failed: ${o.error instanceof Error ? o.error.message : String(o.error)}`,
          },
    );

    const summary = {
      auto_filled: results.filter((r) => r.outcome === 'auto_filled').length,
      skipped_existing: results.filter((r) => r.outcome === 'skipped_existing').length,
      skipped_no_rooms: results.filter((r) => r.outcome === 'skipped_no_rooms').length,
      skipped_no_crew: results.filter((r) => r.outcome === 'skipped_no_crew').length,
      errors: results.filter((r) => r.outcome === 'error').length,
    };

    await writeCronHeartbeat('schedule-auto-fill', {
      requestId,
      status: summary.errors > 0 ? 'degraded' : 'ok',
      notes: { target: targetParam, ...summary },
    });

    return ok({ target: targetParam, summary, results }, { requestId });
  } catch (e) {
    return err(
      `schedule-auto-fill failed: ${e instanceof Error ? e.message : String(e)}`,
      { requestId, status: 500, code: ApiErrorCode.InternalError },
    );
  }
}
