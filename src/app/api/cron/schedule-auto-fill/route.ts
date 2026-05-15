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

interface StaffRow {
  id: string;
  name: string;
  department: string | null;
  is_active: boolean | null;
  schedule_priority: 'priority' | 'normal' | 'excluded' | null;
}

interface RoomRow {
  id: string;
  number: string;
  type: string;
  priority: string;
  stayover_day: number | null;
}

/** Compute property's local YYYY-MM-DD for now + offsetDays. */
function localDate(now: Date, timezone: string | null, offsetDays: number): string {
  const tz = timezone ?? 'UTC';
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const todayStr = fmt.format(now);
    if (offsetDays === 0) return todayStr;
    // Anchor at noon UTC to avoid DST edge cases when adding days.
    const anchor = new Date(`${todayStr}T12:00:00Z`);
    anchor.setUTCDate(anchor.getUTCDate() + offsetDays);
    return fmt.format(anchor);
  } catch {
    const utcStr = now.toISOString().slice(0, 10);
    if (offsetDays === 0) return utcStr;
    const anchor = new Date(`${utcStr}T12:00:00Z`);
    anchor.setUTCDate(anchor.getUTCDate() + offsetDays);
    return anchor.toISOString().slice(0, 10);
  }
}

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
  // 1. Skip if a row already exists — never overwrite manager intent.
  const { data: existing, error: existingErr } = await supabaseAdmin
    .from('schedule_assignments')
    .select('property_id')
    .eq('property_id', property.id)
    .eq('date', targetDate)
    .maybeSingle();
  if (existingErr) {
    return {
      propertyId: property.id, propertyName: property.name, date: targetDate,
      outcome: 'error',
      detail: `existing-row check failed: ${existingErr.message}`,
    };
  }
  if (existing) {
    return {
      propertyId: property.id, propertyName: property.name, date: targetDate,
      outcome: 'skipped_existing',
      detail: 'Manager already built this schedule — leaving it alone.',
    };
  }

  // 2. Load housekeeping staff (active + non-excluded).
  const { data: staffRows, error: staffErr } = await supabaseAdmin
    .from('staff')
    .select('id, name, department, is_active, schedule_priority')
    .eq('property_id', property.id);
  if (staffErr) {
    return {
      propertyId: property.id, propertyName: property.name, date: targetDate,
      outcome: 'error',
      detail: `staff load failed: ${staffErr.message}`,
    };
  }
  const activeCrew = (staffRows as StaffRow[] | null ?? []).filter(
    (s) =>
      (s.department === 'housekeeping' || s.department === null) &&
      s.is_active !== false &&
      s.schedule_priority !== 'excluded',
  );
  if (activeCrew.length === 0) {
    return {
      propertyId: property.id, propertyName: property.name, date: targetDate,
      outcome: 'skipped_no_crew',
      detail: 'No active housekeeping staff for this property.',
    };
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

  // 4. Shape staff + rooms for autoAssignRooms.
  const staffForAlgo: StaffMember[] = activeCrew.map((s) => ({
    id: s.id,
    name: s.name,
    language: 'en' as const,
    isSenior: false,
    department: 'housekeeping' as const,
    scheduledToday: true,
    weeklyHours: 0,
    maxWeeklyHours: 40,
    schedulePriority: s.schedule_priority ?? 'normal',
  }));
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
  const roomAssignments = autoAssignRooms(roomsForAlgo, staffForAlgo, config);
  const assignedRoomCount = Object.keys(roomAssignments).length;
  if (assignedRoomCount === 0) {
    return {
      propertyId: property.id, propertyName: property.name, date: targetDate,
      outcome: 'error',
      detail: `Algorithm produced 0 assignments from ${assignable.length} rooms × ${activeCrew.length} crew. Possible all-excluded staff or shift-cap mismatch.`,
    };
  }

  // 6. Persist.
  const staffNames: Record<string, string> = {};
  for (const s of activeCrew) staffNames[s.id] = s.name;
  const { error: writeErr } = await supabaseAdmin
    .from('schedule_assignments')
    .upsert(
      {
        property_id: property.id,
        date: targetDate,
        room_assignments: roomAssignments,
        crew: activeCrew.map((s) => s.id),
        staff_names: staffNames,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'property_id,date' },
    );
  if (writeErr) {
    log.error('[schedule-auto-fill] write failed', {
      requestId, propertyId: property.id, date: targetDate, error: writeErr.message,
    });
    return {
      propertyId: property.id, propertyName: property.name, date: targetDate,
      outcome: 'error',
      detail: `write failed: ${writeErr.message}`,
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
    const propertyJobs = (properties ?? []) as unknown as PropertyRow[];
    log.info('[schedule-auto-fill] start', {
      requestId, target: targetParam, propertyCount: propertyJobs.length,
    });

    const outcomes = await runWithConcurrency(
      propertyJobs,
      async (p) => {
        const targetDate = localDate(now, p.timezone, offsetDays);
        return await autoFillForProperty(p, targetDate, requestId);
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
