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
  /** Cross-dept extension: open slots inserted for non-HK depts. Counts
   *  how many `scheduled_shifts` rows were inserted per dept (or 0 when
   *  the dept already had any shift for the date — we don't overwrite). */
  crossDeptSeeded?: Record<string, number>;
}

/** Cross-dept open-slot seeding (feature #21 — 2026-05-26).
 *
 *  For each non-HK dept that has a configured demand in the property
 *  config, ensure there's at least one open slot (kind='open', status=
 *  'draft', staff_id=null) on the target date. If any shift (open or
 *  assigned) already exists for the dept on that date, we leave it alone
 *  — the manager has already started on this dept. Times come from the
 *  property's first preset for the dept, falling back to 08:00–16:00.
 *
 *  Idempotent: re-running this for the same (property, date) is a no-op
 *  once the seed has landed.
 *
 *  HK is intentionally excluded — schedule_assignments (above) is the
 *  HK source of truth, not scheduled_shifts; scheduling rooms via the
 *  separate atomic RPC + the manager's UI building the week-grid keeps
 *  them coherent. */
const CROSS_DEPT_DEMAND_KEYS: ReadonlyArray<{
  dept: 'front_desk' | 'maintenance' | 'breakfast' | 'houseman';
  hasDemand: (cfg: CrossDeptConfigRow) => boolean;
  shiftCount: (cfg: CrossDeptConfigRow) => number;
  fallback: { start: string; end: string };
}> = [
  {
    dept: 'front_desk',
    hasDemand: (c) => typeof c.front_desk_coverage_hours === 'number' && c.front_desk_coverage_hours > 0,
    // 24/7 → 3 shifts; <=12 → 1; else 2.
    shiftCount: (c) => {
      const h = c.front_desk_coverage_hours ?? 0;
      if (h >= 22) return 3;
      if (h >= 12) return 2;
      return 1;
    },
    fallback: { start: '08:00', end: '16:00' },
  },
  {
    dept: 'maintenance',
    hasDemand: (c) => typeof c.maintenance_shifts_per_day === 'number' && c.maintenance_shifts_per_day > 0,
    shiftCount: (c) => c.maintenance_shifts_per_day ?? 0,
    fallback: { start: '09:00', end: '17:00' },
  },
  {
    dept: 'breakfast',
    hasDemand: (c) => Boolean(c.breakfast_window_start && c.breakfast_window_end),
    shiftCount: () => 1,
    fallback: { start: '06:00', end: '10:30' },
  },
  {
    dept: 'houseman',
    hasDemand: (c) => typeof c.houseman_shifts_per_day === 'number' && c.houseman_shifts_per_day > 0,
    shiftCount: (c) => c.houseman_shifts_per_day ?? 0,
    fallback: { start: '08:00', end: '16:00' },
  },
];

interface CrossDeptConfigRow {
  front_desk_coverage_hours: number | null;
  maintenance_shifts_per_day: number | null;
  houseman_shifts_per_day: number | null;
  breakfast_window_start: string | null;
  breakfast_window_end: string | null;
}

async function seedNonHkOpenSlots(
  propertyId: string,
  targetDate: string,
  requestId: string,
): Promise<Record<string, number>> {
  const summary: Record<string, number> = {};

  // Load coverage config + dept presets in parallel.
  const [cfgRes, presetsRes] = await Promise.all([
    supabaseAdmin
      .from('properties')
      .select(
        'front_desk_coverage_hours, maintenance_shifts_per_day, ' +
          'houseman_shifts_per_day, breakfast_window_start, breakfast_window_end',
      )
      .eq('id', propertyId)
      .maybeSingle(),
    supabaseAdmin
      .from('property_shift_presets')
      .select('department, start_time, end_time, sort_order')
      .eq('property_id', propertyId)
      .order('sort_order', { ascending: true }),
  ]);
  if (cfgRes.error || !cfgRes.data) return summary;
  const cfg = cfgRes.data as unknown as CrossDeptConfigRow;
  const presetsByDept = new Map<string, { start: string; end: string }>();
  for (const p of (presetsRes.data ?? []) as Array<{
    department: string; start_time: string; end_time: string;
  }>) {
    if (!presetsByDept.has(p.department)) {
      presetsByDept.set(p.department, {
        start: String(p.start_time).slice(0, 5),
        end: String(p.end_time).slice(0, 5),
      });
    }
  }

  // Bulk-load existing shifts per dept for the date so each insert can
  // skip work without an extra round-trip.
  const { data: existingShifts, error: shiftErr } = await supabaseAdmin
    .from('scheduled_shifts')
    .select('department, kind')
    .eq('property_id', propertyId)
    .eq('shift_date', targetDate);
  if (shiftErr) {
    log.warn('[schedule-auto-fill] seed: existing shifts query failed', {
      requestId, propertyId, targetDate, err: shiftErr.message,
    });
    return summary;
  }
  const deptsWithShifts = new Set<string>();
  for (const row of (existingShifts ?? []) as Array<{ department: string }>) {
    deptsWithShifts.add(row.department);
  }

  for (const spec of CROSS_DEPT_DEMAND_KEYS) {
    summary[spec.dept] = 0;
    if (!spec.hasDemand(cfg)) continue;
    if (deptsWithShifts.has(spec.dept)) continue;  // manager already touched it
    const count = Math.max(0, Math.min(8, Math.floor(spec.shiftCount(cfg))));
    if (count === 0) continue;
    const times = presetsByDept.get(spec.dept) ?? spec.fallback;
    const rows = Array.from({ length: count }, () => ({
      property_id: propertyId,
      staff_id: null,
      department: spec.dept,
      shift_date: targetDate,
      start_time: times.start,
      end_time: times.end,
      kind: 'open',
      status: 'draft',
      reason: 'auto-seeded by schedule-auto-fill cron',
    }));
    const { error: insErr } = await supabaseAdmin
      .from('scheduled_shifts')
      .insert(rows);
    if (insErr) {
      log.warn('[schedule-auto-fill] seed insert failed', {
        requestId, propertyId, dept: spec.dept,
        err: insErr.message,
      });
      continue;
    }
    summary[spec.dept] = rows.length;
  }
  return summary;
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

  // 2b. Load approved time_off_requests for this date — they're per-day,
  //     orthogonal to the staff.vacation_dates list. Manager approving a
  //     TOR (e.g. "doctor appt Thu") should skip that housekeeper on
  //     auto-fill even though staff.vacation_dates wasn't edited.
  const { data: torRows } = await supabaseAdmin
    .from('time_off_requests')
    .select('staff_id')
    .eq('property_id', property.id)
    .eq('status', 'approved')
    .eq('request_date', targetDate);
  const staffIdsOnApprovedTimeOff = new Set<string>(
    (torRows ?? []).map((r) => String(r.staff_id)),
  );

  const { eligible: activeCrew, excluded } = selectActiveCrewWithReasons(allStaff, {
    targetDate,
    requirePhone: false,  // cron writes the schedule; SMS-send is separate
    respectSchedulePriority: true,
    staffIdsOnApprovedTimeOff,
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

  // 3. Load room work for the target date from the Plan v4 bridge RPC
  //    (today_room_work_v1). Source-of-truth is pms_room_status_log +
  //    pms_reservations — what the CUA wrote on its last poll.
  //    Empty when the CUA hasn't reached this property yet — return
  //    skipped_no_rooms (same outcome as the old "seed-rooms-daily
  //    hasn't run").
  const { data: workRows, error: roomErr } = await supabaseAdmin
    .rpc('today_room_work_v1', { p_property_id: property.id, p_date: targetDate });
  if (roomErr) {
    return {
      propertyId: property.id, propertyName: property.name, date: targetDate,
      outcome: 'error',
      detail: `today_room_work_v1 failed: ${roomErr.message}`,
    };
  }
  type WorkRow = { room_number: string; stay_type: 'C/O' | 'Stay' | null; stayover_day: number | null };
  const assignable: RoomRow[] = (workRows as WorkRow[] | null ?? [])
    .filter((r) => r.stay_type === 'C/O' || r.stay_type === 'Stay')
    .map((r) => ({
      id: `${targetDate}_${r.room_number}`,
      number: r.room_number,
      type: r.stay_type === 'C/O' ? 'checkout' : 'stayover',
      priority: 'standard',
      stayover_day: r.stayover_day,
    }));
  if (assignable.length === 0) {
    // Even on an all-vacant day, non-HK departments still need to work
    // (front-desk staffs the lobby, breakfast still serves, etc.). Seed
    // open slots for those depts even though HK has nothing to do.
    let crossDeptSeeded: Record<string, number> | undefined;
    try {
      crossDeptSeeded = await seedNonHkOpenSlots(property.id, targetDate, requestId);
    } catch (e) {
      log.warn('[schedule-auto-fill] seedNonHkOpenSlots threw on no_rooms (swallowed)', {
        requestId, propertyId: property.id,
        err: e instanceof Error ? e.message : String(e),
      });
    }
    return {
      propertyId: property.id, propertyName: property.name, date: targetDate,
      outcome: 'skipped_no_rooms',
      detail: `No assignable rooms for ${targetDate}. Either seed-rooms-daily hasn't run yet, or it's an all-vacant day.`,
      crossDeptSeeded,
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
  // CSV-snapshot baseline reuses the already-loaded `workRows` from step 3
  // (we don't re-call today_room_work_v1 here — that was deduplicated when
  // the source-of-truth moved from plan_snapshots to the bridge RPC).
  type SnapshotRow = { room_number: string; stay_type: 'C/O' | 'Stay' | null };
  let csvRoomSnapshot: Array<{ number: string; type: 'checkout' | 'stayover' }> | null = null;
  if (Array.isArray(workRows) && workRows.length > 0) {
    csvRoomSnapshot = (workRows as SnapshotRow[])
      .map((r) => {
        const type: 'checkout' | 'stayover' | null =
          r.stay_type === 'C/O' ? 'checkout'
          : r.stay_type === 'Stay' ? 'stayover'
          : null;
        if (!type) return null;
        return { number: r.room_number, type };
      })
      .filter((x): x is { number: string; type: 'checkout' | 'stayover' } => x !== null);
  }

  // The old plan_snapshots had a pulled_at column; we use the latest
  // pms_room_status_log.changed_at as the equivalent freshness marker.
  const { data: latestRow } = await supabaseAdmin
    .from('pms_room_status_log')
    .select('changed_at')
    .eq('property_id', property.id)
    .order('changed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const csvPulledAt = latestRow?.changed_at ?? null;

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
      p_csv_pulled_at: csvPulledAt,
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
  // Cross-dept open-slot seed (feature #21). Independent of the HK
  // assignment outcome — even if HK skipped (e.g. all-vacant day),
  // non-HK depts may still want shifts on the books.
  let crossDeptSeeded: Record<string, number> | undefined;
  try {
    crossDeptSeeded = await seedNonHkOpenSlots(property.id, targetDate, requestId);
  } catch (e) {
    log.warn('[schedule-auto-fill] seedNonHkOpenSlots threw (swallowed)', {
      requestId, propertyId: property.id,
      err: e instanceof Error ? e.message : String(e),
    });
  }

  return {
    propertyId: property.id, propertyName: property.name, date: targetDate,
    outcome: 'auto_filled',
    roomsAssigned: assignedRoomCount,
    crewSize: activeCrew.length,
    crossDeptSeeded,
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
