// ═══════════════════════════════════════════════════════════════════════════
// ML Feature Snapshot Derivation
//
// Computes the 10 ML feature columns for a cleaning_events row at insert time.
// All features are best-effort — errors fall back to NULL and are logged but
// never thrown (the room update must not block on feature computation).
//
// See migration 0021 for the spec of each feature.
// ═══════════════════════════════════════════════════════════════════════════

import { log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';

/**
 * Derives the 10 ML feature columns for a cleaning event.
 *
 * Each feature derivation is wrapped in try/catch. Errors are logged but
 * never thrown — null is returned for that feature, and the insert proceeds.
 * The room update has already succeeded at this point, so we must not fail.
 */
export async function deriveCleaningEventFeatures(input: {
  propertyId: string;
  date: string;
  roomNumber: string;
  staffId: string;
  startedAt: Date;
  completedAt: Date;
  propertyTimezone?: string;
}): Promise<{
  dayOfWeek: number | null;
  dayOfStayRaw: number | null;
  roomFloor: number | null;
  occupancyAtStart: number | null;
  totalCheckoutsToday: number | null;
  totalRoomsAssignedToHk: number | null;
  routePosition: number | null;
  minutesSinceShiftStart: number | null;
  wasDndDuringClean: boolean | null;
  weatherClass: string | null;
}> {
  // Initialize all features to null. Each derivation overwrites on success.
  const features = {
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

  // ─── day_of_week (0=Sun..6=Sat) in property's local timezone ──────────────
  try {
    const tz = input.propertyTimezone ?? 'America/Chicago';
    // Noon UTC anchor: same calendar day in any continental timezone.
    // Midnight UTC would shift to the previous day in CT/MT/PT.
    const dateObj = new Date(input.date + 'T12:00:00Z');
    const formatter = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      timeZone: tz,
    });
    const weekdayName = formatter.format(dateObj);
    const weekdayMap: Record<string, number> = {
      Sunday: 0,
      Monday: 1,
      Tuesday: 2,
      Wednesday: 3,
      Thursday: 4,
      Friday: 5,
      Saturday: 6,
    };
    features.dayOfWeek = weekdayMap[weekdayName] ?? null;
  } catch (err) {
    log.warn('deriveCleaningEventFeatures: day_of_week failed', { err: String(err), date: input.date });
  }

  // ─── day_of_stay_raw — read from rooms table ──────────────────────────────
  try {
    const { data: room, error } = await supabaseAdmin
      .from('rooms')
      .select('stayover_day')
      .eq('property_id', input.propertyId)
      .eq('date', input.date)
      .eq('number', input.roomNumber)
      .maybeSingle();

    if (!error && room && typeof room.stayover_day === 'number' && room.stayover_day > 0) {
      features.dayOfStayRaw = room.stayover_day;
    }
  } catch (err) {
    log.warn('deriveCleaningEventFeatures: day_of_stay_raw failed', { err: String(err) });
  }

  // ─── room_floor — parse first digit of room_number ────────────────────────
  try {
    const floor = parseInt(input.roomNumber[0], 10);
    if (!isNaN(floor) && floor >= 0) {
      features.roomFloor = floor;
    }
  } catch (err) {
    log.warn('deriveCleaningEventFeatures: room_floor failed', { err: String(err) });
  }

  // ─── occupancy_at_start — read from rooms.last_started_occupancy ──────────
  try {
    const { data: room, error } = await supabaseAdmin
      .from('rooms')
      .select('last_started_occupancy')
      .eq('property_id', input.propertyId)
      .eq('date', input.date)
      .eq('number', input.roomNumber)
      .maybeSingle();

    if (!error && room) {
      // Prefer last_started_occupancy if set. Fall back to current dashboard.
      if (room.last_started_occupancy !== null && typeof room.last_started_occupancy === 'number') {
        features.occupancyAtStart = room.last_started_occupancy;
      } else {
        // Fall back to current dashboard snapshot. Best-effort.
        const { data: dashboard, error: dashErr } = await supabaseAdmin
          .from('scraper_status')
          .select('data')
          .eq('key', 'dashboard')
          .maybeSingle();

        if (!dashErr && dashboard) {
          const dashData = dashboard.data as Record<string, unknown> | null;
          if (dashData && typeof dashData.in_house === 'number') {
            features.occupancyAtStart = dashData.in_house;
          }
        }
      }
    }
  } catch (err) {
    log.warn('deriveCleaningEventFeatures: occupancy_at_start failed', { err: String(err) });
  }

  // ─── total_checkouts_today — from plan_snapshots ────────────────────────
  try {
    const { data: snapshot, error } = await supabaseAdmin
      .from('plan_snapshots')
      .select('checkouts')
      .eq('property_id', input.propertyId)
      .eq('date', input.date)
      .maybeSingle();

    if (!error && snapshot && typeof snapshot.checkouts === 'number') {
      features.totalCheckoutsToday = snapshot.checkouts;
    }
  } catch (err) {
    log.warn('deriveCleaningEventFeatures: total_checkouts_today failed', { err: String(err) });
  }

  // ─── total_rooms_assigned_to_hk — count from schedule_assignments ────────
  try {
    const { data: schedule, error } = await supabaseAdmin
      .from('schedule_assignments')
      .select('room_assignments')
      .eq('property_id', input.propertyId)
      .eq('date', input.date)
      .maybeSingle();

    if (!error && schedule) {
      const roomAssignments = schedule.room_assignments as Record<string, string> | null;
      if (roomAssignments && Object.keys(roomAssignments).length > 0) {
        const count = Object.values(roomAssignments).filter(
          (staffId) => staffId === input.staffId
        ).length;
        features.totalRoomsAssignedToHk = count;
      } else {
        features.totalRoomsAssignedToHk = 0;
      }
    }
  } catch (err) {
    log.warn('deriveCleaningEventFeatures: total_rooms_assigned_to_hk failed', { err: String(err) });
  }

  // ─── route_position — count prior events same day + 1 ────────────────────
  try {
    const { data: priorEvents, error } = await supabaseAdmin
      .from('cleaning_events')
      .select('id')
      .eq('property_id', input.propertyId)
      .eq('date', input.date)
      .eq('staff_id', input.staffId)
      .lt('started_at', input.startedAt.toISOString());

    if (!error && Array.isArray(priorEvents)) {
      features.routePosition = (priorEvents.length ?? 0) + 1;
    }
  } catch (err) {
    log.warn('deriveCleaningEventFeatures: route_position failed', { err: String(err) });
  }

  // ─── minutes_since_shift_start — NULL for route_position=1, else duration ─
  try {
    if (features.routePosition === 1) {
      features.minutesSinceShiftStart = null; // by spec (migration 0021 comment)
    } else {
      const { data: events, error } = await supabaseAdmin
        .from('cleaning_events')
        .select('started_at')
        .eq('property_id', input.propertyId)
        .eq('date', input.date)
        .eq('staff_id', input.staffId)
        .order('started_at', { ascending: true })
        .limit(1);

      if (!error && Array.isArray(events) && events.length > 0) {
        const firstStartedAt = new Date(String(events[0].started_at));
        const diffMs = input.startedAt.getTime() - firstStartedAt.getTime();
        const diffMin = Math.round(diffMs / 60_000);
        features.minutesSinceShiftStart = Math.max(0, diffMin);
      }
    }
  } catch (err) {
    log.warn('deriveCleaningEventFeatures: minutes_since_shift_start failed', { err: String(err) });
  }

  // ─── was_dnd_during_clean — read current rooms.is_dnd (best-effort) ──────
  try {
    const { data: room, error } = await supabaseAdmin
      .from('rooms')
      .select('is_dnd')
      .eq('property_id', input.propertyId)
      .eq('date', input.date)
      .eq('number', input.roomNumber)
      .maybeSingle();

    if (!error && room && typeof room.is_dnd === 'boolean') {
      features.wasDndDuringClean = room.is_dnd;
    }
  } catch (err) {
    log.warn('deriveCleaningEventFeatures: was_dnd_during_clean failed', { err: String(err) });
  }

  // ─── weather_class — reserved for future, always NULL for now ─────────────
  // (no implementation yet; feature slot reserved)

  return features;
}
