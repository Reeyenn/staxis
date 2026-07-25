/**
 * ML feature derivation for cleaning_events rows.
 *
 * Re-derived against the new pms_* schema (Plan v4 rebuild). The original
 * helper read `plan_snapshots.rooms[]` and `scraper_status[dashboard].in_house`
 * — both dropped in v4. This version pulls the same fields from the bridge
 * RPCs (today_room_work_v1 + today_property_counts_v1) which derive live
 * from pms_room_status_log + pms_reservations + pms_in_house_snapshot,
 * written by the vision CUA every 30 sec.
 *
 * Contract: called from /api/housekeeper/complete-clean and
 * /api/housekeeper/room-action right before the cleaning_events insert.
 * Returns null fields when a feature can't be derived (CUA hasn't written
 * data yet, source row missing, etc.) — never throws. cleaning_events
 * inserts MUST proceed even when this returns all-nulls.
 *
 * Why a separate helper (not inline in the routes): same shape on Start
 * (occupancy_at_start) and Done (everything else). Easier to test in
 * isolation. The route just calls deriveCleaningEventFeatures(...) and
 * passes the result into the insert payload.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

export interface CleaningEventFeatures {
  /** ISO day-of-week (0=Sunday). Pulled from the cleaning's date. */
  dayOfWeek: number | null;
  /** 1-indexed day-of-stay from today_room_work_v1.stayover_day. */
  dayOfStayRaw: number | null;
  /** Floor number parsed from room number prefix (101 → 1, 215 → 2). */
  roomFloor: number | null;
  /** Property-level in-house room count from today_property_counts_v1.in_house at Start time. */
  occupancyAtStart: number | null;
  /** Total checkouts scheduled for today across the whole property. */
  totalCheckoutsToday: number | null;
  /** Rooms assigned to this housekeeper today (from pms_housekeeping_assignments). */
  totalRoomsAssignedToHk: number | null;
  /** Sequence position of this room in this housekeeper's day (1-indexed). */
  routePosition: number | null;
  /** Minutes from the housekeeper's first cleaning_events.start to this cleaning's start. */
  minutesSinceShiftStart: number | null;
  /** Whether DND was active during this clean (from pms_housekeeping_assignments.dnd_active). */
  wasDndDuringClean: boolean | null;
  /** Weather class for the day. NULL — weather plumbing was pre-v4 and is not back yet. */
  weatherClass: string | null;
}

const NULL_FEATURES: CleaningEventFeatures = {
  dayOfWeek: null,
  dayOfStayRaw: null,
  roomFloor: null,
  occupancyAtStart: null,
  totalCheckoutsToday: null,
  totalRoomsAssignedToHk: null,
  routePosition: null,
  minutesSinceShiftStart: null,
  wasDndDuringClean: null,
  weatherClass: null,
};

interface DeriveArgs {
  propertyId: string;
  /** YYYY-MM-DD. The cleaning's calendar date in the property's timezone. */
  date: string;
  roomNumber: string;
  staffId: string;
  /** When the housekeeper tapped Start. */
  startedAt: Date;
  /** When they tapped Done. */
  completedAt: Date;
}

/**
 * Derive all features for one cleaning_events row. Best-effort: any field
 * that can't be computed (missing CUA data, schema drift, RPC failure)
 * returns null instead of throwing. Use the returned object as-is.
 */
export async function deriveCleaningEventFeatures(args: DeriveArgs): Promise<CleaningEventFeatures> {
  const out: CleaningEventFeatures = { ...NULL_FEATURES };

  // 1. dayOfWeek — pure date math, never fails.
  try {
    out.dayOfWeek = parseDateOnly(args.date).getUTCDay();
  } catch {
    // unparseable date string; leave null
  }

  // 2. roomFloor — parse the leading digit(s) of the room number.
  out.roomFloor = parseFloorFromRoom(args.roomNumber);

  // 3. dayOfStayRaw — from today_room_work_v1 RPC.
  try {
    const { data, error } = await supabaseAdmin
      .rpc('today_room_work_v1', { p_property_id: args.propertyId, p_date: args.date });
    if (!error && Array.isArray(data)) {
      const row = (data as Array<{ room_number: string; stayover_day: number | null }>)
        .find(r => r.room_number === args.roomNumber);
      out.dayOfStayRaw = row?.stayover_day ?? null;
    }
  } catch (err) {
    log.warn('feature-derivation: today_room_work_v1 failed', {
      err: (err as Error).message, propertyId: args.propertyId, date: args.date,
    });
  }

  // 4. occupancyAtStart + totalCheckoutsToday — from today_property_counts_v1.
  try {
    const { data, error } = await supabaseAdmin
      .rpc('today_property_counts_v1', { p_property_id: args.propertyId, p_date: args.date });
    if (!error && Array.isArray(data) && data.length > 0) {
      const row = (data as Array<{ in_house: number; total_checkouts_today: number }>)[0];
      out.occupancyAtStart = row.in_house ?? null;
      out.totalCheckoutsToday = row.total_checkouts_today ?? null;
    }
  } catch (err) {
    log.warn('feature-derivation: today_property_counts_v1 failed', {
      err: (err as Error).message, propertyId: args.propertyId, date: args.date,
    });
  }

  // 5. totalRoomsAssignedToHk + routePosition + wasDndDuringClean.
  //    0346: the assignment is an identity (room_work.assigned_staff_id), not a
  //    name string. The old `housekeeper_name === myName` filter was an EXACT
  //    string compare — "Maria  Garcia" from the PMS never matched "Maria
  //    Garcia" in staff, so these three features silently came back empty for
  //    any name that was spelled even slightly differently. Matching on the id
  //    removes that whole class of miss. scheduled_time still comes from the
  //    PMS mirror (it is what the report printed).
  try {
    const [workRes, mirrorRes] = await Promise.all([
      supabaseAdmin
        .from('room_work')
        .select('room_number, dnd_active, assigned_staff_id')
        .eq('property_id', args.propertyId)
        .eq('date', args.date)
        .eq('assigned_staff_id', args.staffId),
      supabaseAdmin
        .from('pms_housekeeping_assignments')
        .select('room_number, scheduled_time, dnd_active')
        .eq('property_id', args.propertyId)
        .eq('date', args.date),
    ]);
    const workRows = (workRes.data ?? []) as Array<{
      room_number: string; dnd_active: boolean | null; assigned_staff_id: string | null;
    }>;
    if (workRows.length > 0) {
      const mirrorByRoom = new Map(
        ((mirrorRes.data ?? []) as Array<{
          room_number: string; scheduled_time: string | null; dnd_active: boolean | null;
        }>).map(r => [String(r.room_number), r]),
      );
      const mine = workRows
        .map(r => ({
          room_number: String(r.room_number),
          scheduled_time: mirrorByRoom.get(String(r.room_number))?.scheduled_time ?? null,
          dnd_active: r.dnd_active ?? mirrorByRoom.get(String(r.room_number))?.dnd_active ?? null,
        }))
        .sort((a, b) => {
          const ta = a.scheduled_time ? Date.parse(a.scheduled_time) : 0;
          const tb = b.scheduled_time ? Date.parse(b.scheduled_time) : 0;
          if (ta !== tb) return ta - tb;
          return a.room_number.localeCompare(b.room_number);
        });
      out.totalRoomsAssignedToHk = mine.length;
      const idx = mine.findIndex(r => r.room_number === args.roomNumber);
      out.routePosition = idx >= 0 ? idx + 1 : null;
      out.wasDndDuringClean = mine.find(r => r.room_number === args.roomNumber)?.dnd_active ?? null;
    }
  } catch (err) {
    log.warn('feature-derivation: room_work / hk mirror failed', {
      err: (err as Error).message, propertyId: args.propertyId, date: args.date,
    });
  }

  // 6. minutesSinceShiftStart — earliest cleaning_events.started_at for this
  //    staff member on this date, minus this clean's startedAt.
  try {
    const { data } = await supabaseAdmin
      .from('cleaning_events')
      .select('started_at')
      .eq('property_id', args.propertyId)
      .eq('staff_id', args.staffId)
      .eq('date', args.date)
      .order('started_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    const firstStart = (data?.started_at as string | undefined) ?? null;
    if (firstStart) {
      const firstMs = Date.parse(firstStart);
      const thisMs = args.startedAt.getTime();
      if (Number.isFinite(firstMs) && Number.isFinite(thisMs)) {
        out.minutesSinceShiftStart = Math.max(0, Math.round((thisMs - firstMs) / 60_000));
      }
    } else {
      // This IS the first cleaning of the shift.
      out.minutesSinceShiftStart = 0;
    }
  } catch (err) {
    log.warn('feature-derivation: cleaning_events first-start failed', {
      err: (err as Error).message, propertyId: args.propertyId, staffId: args.staffId,
    });
  }

  return out;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function parseDateOnly(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function parseFloorFromRoom(roomNumber: string): number | null {
  // Common patterns: '101', '215', '2BR12' — pull the LEADING digit
  // group, treat the first digit as the floor (101 → 1, 215 → 2).
  const m = String(roomNumber).match(/^(\d+)/);
  if (!m) return null;
  const digits = m[1];
  if (digits.length === 0) return null;
  const first = parseInt(digits[0], 10);
  return Number.isFinite(first) ? first : null;
}
