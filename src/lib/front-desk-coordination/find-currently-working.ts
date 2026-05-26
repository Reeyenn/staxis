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
 * YYYY-MM-DD for the day BEFORE `dateStr` (interpreted as a calendar date,
 * not a UTC instant — so it survives DST without needing a tz argument).
 */
function previousDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map((s) => parseInt(s, 10));
  // Use UTC math (date math doesn't care about tz) and shift back one day.
  const t = Date.UTC(y, m - 1, d);
  const prev = new Date(t - 24 * 60 * 60 * 1000);
  return prev.toISOString().slice(0, 10);
}

/**
 * Returns staff currently on a front-desk shift, ordered by shift start.
 * Empty array on any read error (the caller's UI surfaces "no one is
 * currently scheduled" — same shape as an empty result).
 *
 * Overnight shifts: a shift stored on shift_date=YESTERDAY with
 * end_time < start_time (e.g. 22:00 → 06:00) is still active at 02:00
 * TODAY local. We query BOTH `clock.date` and the previous local date,
 * then evaluate each row against its own date+window so a night-audit
 * shift stays "currently working" past midnight.
 */
export async function findCurrentlyWorkingFrontDesk(
  propertyId: string,
  now: Date = new Date(),
): Promise<CurrentlyWorkingStaff[]> {
  try {
    const tz = await resolvePropertyTimezone(propertyId);
    const clock = clockInTimezone(now, tz);
    const prevDate = previousDate(clock.date);

    // Pull today's + yesterday's published+ front-desk shifts. The TS
    // filter below handles the wraparound (yesterday's row only counts
    // if its window wraps midnight AND we're inside the post-midnight
    // half). Worst case is ~20 rows total.
    //
    // Column names: `start_time` / `end_time` per migration 0147 (NOT
    // `shift_start_time` / `shift_end_time` — Codex caught the earlier
    // mismatch). Aliased here so the rest of the module's shape stays
    // intuitive.
    const { data, error } = await supabaseAdmin
      .from('scheduled_shifts')
      .select('id, staff_id, shift_date, start_time, end_time')
      .eq('property_id', propertyId)
      .eq('department', 'front_desk')
      .eq('kind', 'shift')
      .in('status', ['published', 'sent', 'confirmed'])
      .in('shift_date', [clock.date, prevDate])
      .order('start_time', { ascending: true });

    if (error) {
      log.warn('[find-currently-working] scheduled_shifts read failed', {
        propertyId, err: error.message,
      });
      return [];
    }
    const rows = data ?? [];
    const matching = rows.filter((r) => {
      const start = (r as { start_time?: string }).start_time;
      const end = (r as { end_time?: string }).end_time;
      const sd = (r as { shift_date?: string }).shift_date;
      if (typeof start !== 'string' || typeof end !== 'string' || typeof sd !== 'string') return false;

      // Same-day shift (not wrapping midnight): row must be on
      // `clock.date` and the wall-clock must fall in [start, end].
      const wraps = end < start;
      if (!wraps) {
        if (sd !== clock.date) return false;
        return isTimeInShiftWindow(clock.time, start, end);
      }

      // Wrapping shift (overnight): two valid cases.
      //   (a) Row is on `clock.date`: clock.time >= start (we're still
      //       in the pre-midnight half).
      //   (b) Row is on `prevDate`: clock.time <= end (we're in the
      //       post-midnight half — yesterday's shift bleeds into today).
      if (sd === clock.date && clock.time >= start) return true;
      if (sd === prevDate && clock.time <= end) return true;
      return false;
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
        start_time: string;
        end_time: string;
      };
      if (!r.staff_id) continue;
      const staff = byId.get(r.staff_id);
      if (!staff) continue;
      out.push({
        staffId: r.staff_id,
        name: staff.name,
        phone: staff.phone,
        shiftStartTime: r.start_time,
        shiftEndTime: r.end_time,
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
