/**
 * Resolve who is currently working at the front desk for a property.
 *
 * Source of truth: `scheduled_shifts` (migration 0147) where
 *   - department = 'front_desk'
 *   - kind = 'shift'
 *   - status in ('published','sent','confirmed') — anything Mario has
 *     committed to. Draft / declined / open are NOT counted.
 *   - shift_date = today in the property's timezone
 *   - current wall-clock time in the property's timezone is between
 *     shift_start_time and shift_end_time
 *
 * Why we read from scheduled_shifts (not staff.department):
 *   - staff.department tells you their job role, not whether they're
 *     on shift RIGHT NOW. The whole reason for the strip is "who is
 *     reachable", which is a schedule question.
 *
 * DST safety: the shift_date + shift_start_time + shift_end_time are
 *   stored as DATE + TIME (no timezone), interpreted in the property's
 *   IANA timezone. We use Intl.DateTimeFormat to compute the current
 *   wall-clock time in that timezone, so the inclusion check survives
 *   DST transitions correctly (a 9am-5pm shift on 2027-03-14 is still
 *   "in window" at 9:30am local in America/Chicago, even though that
 *   instant is one hour different in UTC than the day before).
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

export interface CurrentlyWorkingStaff {
  staffId: string;
  name: string;
  phone: string | null;
  shiftStartTime: string; // HH:MM:SS local
  shiftEndTime: string;   // HH:MM:SS local
  shiftId: string;
}

/**
 * Read the property's IANA timezone with a hard-coded fallback.
 * 'America/Chicago' matches migration 0016's default — keeps the
 * helper safe to call even if a property row predates that migration.
 */
async function resolvePropertyTimezone(propertyId: string): Promise<string> {
  try {
    const { data, error } = await supabaseAdmin
      .from('properties')
      .select('timezone')
      .eq('id', propertyId)
      .maybeSingle();
    if (error || !data) return 'America/Chicago';
    const tz = (data as { timezone?: string | null }).timezone;
    return tz && typeof tz === 'string' && tz.length > 0 ? tz : 'America/Chicago';
  } catch {
    return 'America/Chicago';
  }
}

/**
 * Returns { date: YYYY-MM-DD, time: HH:MM:SS } for `now` rendered in
 * the given IANA timezone. Used for shift-window inclusion checks.
 *
 * Implementation note: Intl.DateTimeFormat with `hour12: false` and an
 * explicit `timeZone` is the only library-free way Node + browser both
 * support without a date-fns/luxon dependency. We split the parts and
 * normalize "24" → "00" because some ICU versions emit "24:00:00" for
 * midnight depending on locale rounding.
 */
export function clockInTimezone(
  now: Date,
  timeZone: string,
): { date: string; time: string } {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '00';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  let hour = get('hour');
  const minute = get('minute');
  const second = get('second');
  if (hour === '24') hour = '00'; // edge case in some ICU implementations
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}:${second}`,
  };
}

/**
 * Compare two HH:MM:SS strings lexicographically (works because the
 * format is zero-padded fixed-width). Returns true if `t` is in
 * [start, end] — inclusive on both ends matches "shift starts at 9am"
 * intuitively (a 9:00:00 timestamp is in the 9-5 window).
 *
 * Overnight shifts: if end < start (e.g. 22:00 → 06:00), we treat the
 * shift as crossing midnight and the "in window" predicate becomes
 * (t >= start) OR (t <= end). This matches how the night-audit shift
 * is naturally scheduled in scheduled_shifts.
 */
export function isTimeInShiftWindow(
  t: string,
  start: string,
  end: string,
): boolean {
  if (end < start) {
    return t >= start || t <= end;
  }
  return t >= start && t <= end;
}

/**
 * Returns staff currently on a front-desk shift, ordered by shift start.
 * Empty array on any read error (the caller's UI surfaces "no one is
 * currently scheduled" — same shape as an empty result).
 */
export async function findCurrentlyWorkingFrontDesk(
  propertyId: string,
  now: Date = new Date(),
): Promise<CurrentlyWorkingStaff[]> {
  try {
    const tz = await resolvePropertyTimezone(propertyId);
    const clock = clockInTimezone(now, tz);

    // Pull today's published+ front-desk shifts. We don't filter by
    // start/end in SQL because the lexicographic comparison + overnight
    // wraparound is cleaner to express in TS. Worst case is ~10 rows.
    const { data, error } = await supabaseAdmin
      .from('scheduled_shifts')
      .select('id, staff_id, shift_start_time, shift_end_time')
      .eq('property_id', propertyId)
      .eq('department', 'front_desk')
      .eq('kind', 'shift')
      .in('status', ['published', 'sent', 'confirmed'])
      .eq('shift_date', clock.date)
      .order('shift_start_time', { ascending: true });

    if (error) {
      log.warn('[find-currently-working] scheduled_shifts read failed', {
        propertyId, err: error.message,
      });
      return [];
    }
    const rows = data ?? [];
    const matching = rows.filter((r) => {
      const start = (r as { shift_start_time?: string }).shift_start_time;
      const end = (r as { shift_end_time?: string }).shift_end_time;
      if (typeof start !== 'string' || typeof end !== 'string') return false;
      return isTimeInShiftWindow(clock.time, start, end);
    });

    if (matching.length === 0) return [];

    const staffIds = Array.from(new Set(
      matching
        .map((r) => (r as { staff_id?: string | null }).staff_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ));
    if (staffIds.length === 0) return [];

    const { data: staffRows, error: staffErr } = await supabaseAdmin
      .from('staff')
      .select('id, name, phone')
      .eq('property_id', propertyId)
      .in('id', staffIds);

    if (staffErr) {
      log.warn('[find-currently-working] staff read failed', {
        propertyId, err: staffErr.message,
      });
      return [];
    }

    const byId = new Map<string, { name: string; phone: string | null }>();
    for (const s of staffRows ?? []) {
      const r = s as { id: string; name: string; phone?: string | null };
      byId.set(r.id, { name: r.name, phone: r.phone ?? null });
    }

    const out: CurrentlyWorkingStaff[] = [];
    for (const row of matching) {
      const r = row as {
        id: string;
        staff_id: string | null;
        shift_start_time: string;
        shift_end_time: string;
      };
      if (!r.staff_id) continue;
      const staff = byId.get(r.staff_id);
      if (!staff) continue;
      out.push({
        staffId: r.staff_id,
        name: staff.name,
        phone: staff.phone,
        shiftStartTime: r.shift_start_time,
        shiftEndTime: r.shift_end_time,
        shiftId: r.id,
      });
    }
    return out;
  } catch (err) {
    log.error('[find-currently-working] threw', {
      propertyId, err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
