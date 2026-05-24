/**
 * Time/timezone utilities for the rules engine.
 *
 * The PMS gives us property-local times (e.g. arrival_time='14:00:00')
 * with the timezone living on properties.timezone. The engine works in
 * UTC Date objects internally so date arithmetic is unambiguous.
 *
 * No external deps: we use Intl.DateTimeFormat to read offsets, which
 * is fast and accurate across DST transitions.
 */

/** Format a UTC Date as a YYYY-MM-DD date string in the given timezone. */
export function propertyLocalDate(now: Date, timezone: string | null | undefined): string {
  if (!timezone) return now.toISOString().slice(0, 10);
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Day-of-week (0 = Sunday … 6 = Saturday) in the given timezone for the
 *  given UTC instant. */
export function propertyLocalDayOfWeek(
  now: Date,
  timezone: string | null | undefined,
): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  const tz = timezone ?? 'UTC';
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
    });
    const wd = fmt.format(now);
    const map: Record<string, 0 | 1 | 2 | 3 | 4 | 5 | 6> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    return map[wd] ?? 0;
  } catch {
    return now.getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  }
}

/**
 * Convert a property-local (date, time) pair to a UTC Date instant.
 *
 *   localDateTimeToUtc('2026-05-26', '14:00', 'America/Chicago')
 *   → Date corresponding to 2026-05-26T14:00 CDT (= 19:00 UTC)
 *
 * Handles DST transitions correctly because we ask Intl what the offset
 * was at that specific civil time.
 */
export function localDateTimeToUtc(
  date: string,
  time: string,
  timezone: string | null | undefined,
): Date | null {
  if (!date) return null;
  const dParts = date.split('-').map(Number);
  if (dParts.length !== 3 || dParts.some((n) => Number.isNaN(n))) return null;
  const [y, mo, d] = dParts;

  const tParts = (time || '00:00:00').split(':').map(Number);
  if (tParts.some((n) => Number.isNaN(n))) return null;
  const [h, mi, s = 0] = [tParts[0] ?? 0, tParts[1] ?? 0, tParts[2] ?? 0];

  if (!timezone) {
    return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  }

  // Pretend the civil time IS UTC, then ask Intl what that UTC moment
  // looks like in the target timezone — the difference is the offset.
  const candidateUtcMs = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(candidateUtcMs)).map((p) => [p.type, p.value]),
    );
    // Intl returns "24" for midnight in some implementations; normalize.
    const hh = parts.hour === '24' ? '00' : parts.hour;
    const tzAsIfUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(hh),
      Number(parts.minute),
      Number(parts.second),
    );
    const offsetMs = candidateUtcMs - tzAsIfUtc;
    return new Date(candidateUtcMs + offsetMs);
  } catch {
    return new Date(candidateUtcMs);
  }
}

/** Subtract N minutes from a Date and return a new Date. */
export function minusMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() - minutes * 60_000);
}

/** Difference between two Dates in minutes (b - a). */
export function diffMinutes(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60_000;
}

/**
 * Day index within a stay. day_of_stay = 1 on arrival_date, 2 the next
 * day, etc. Used by the long-stay and short-stay cadence rules.
 *
 * Inputs are property-local date strings (YYYY-MM-DD) to avoid TZ shifts.
 */
export function computeDayOfStay(arrivalDate: string, businessDate: string): number {
  const a = parseDateUtc(arrivalDate);
  const b = parseDateUtc(businessDate);
  if (!a || !b) return 1;
  const days = Math.floor((b.getTime() - a.getTime()) / (24 * 60 * 60_000));
  return Math.max(1, days + 1);
}

function parseDateUtc(s: string): Date | null {
  const parts = s.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
}
