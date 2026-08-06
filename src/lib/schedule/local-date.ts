/**
 * Timezone-aware "what's tomorrow in this property?" math.
 *
 * Why this file exists:
 *
 * Round 17's schedule-auto-fill cron computed local "today + N days" by
 * formatting today in the property timezone, anchoring at noon UTC, then
 * adding UTC days. For most timezones (UTC-12 to UTC+12) that round-trip
 * was fine. For Pacific/Kiritimati (UTC+14), noon UTC anchor + 1 UTC day
 * lands on the day AFTER the intended local day — silently skipping a
 * calendar date and writing/checking the wrong schedule_assignments row.
 *
 * Codex caught this on adversarial review (Round 18 finding #5). The fix:
 * never round-trip through UTC. Format → parse → add in the local
 * calendar → format. `Intl.DateTimeFormat` with `en-CA` produces
 * YYYY-MM-DD natively, which makes the math trivial.
 *
 * Exported pure functions:
 *   - propertyLocalToday(now, tz): the calendar date "now" falls on in tz
 *   - addDaysInTz(yyyymmdd, days): plain calendar add (no tz dependency)
 *   - propertyLocalDateOffset(now, tz, offsetDays): convenience
 */

/** Format an Instant into YYYY-MM-DD in the given IANA timezone.
 *  Uses en-CA because that locale prints YYYY-MM-DD natively. */
function formatInTz(date: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date);
}

/** Today in property's local calendar, as YYYY-MM-DD. Falls back to UTC
 *  if `timezone` is null/empty/invalid. */
export function propertyLocalToday(now: Date, timezone: string | null): string {
  if (!timezone) return now.toISOString().slice(0, 10);
  try {
    return formatInTz(now, timezone);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * The hour of the clock on the wall AT THE HOTEL, 0 to 23.
 *
 * Null when the hotel has no usable timezone, which is a real state and not a
 * reason to guess: the only caller greets somebody by time of day, and wishing
 * a night auditor good morning because the server is in another zone is worse
 * than not naming the time at all.
 */
export function propertyLocalHour(now: Date, timezone: string | null): number | null {
  if (!timezone) return null;
  try {
    const hour = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hour12: false,
    }).format(now);
    const parsed = Number.parseInt(hour, 10);
    // en-GB renders midnight as "24" in some ICU versions.
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 24) return null;
    return parsed === 24 ? 0 : parsed;
  } catch {
    return null;
  }
}

/**
 * The current wall-clock minute at the hotel, 0 through 1439.
 *
 * A missing or invalid timezone follows propertyLocalToday's UTC fallback so
 * schedule state stays deterministic instead of inheriting the manager's
 * browser timezone.
 */
export function propertyLocalClockMinutes(now: Date, timezone: string | null): number {
  const utcFallback = Number.isFinite(now.getTime())
    ? now.getUTCHours() * 60 + now.getUTCMinutes()
    : 0;
  if (!Number.isFinite(now.getTime())) return utcFallback;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone?.trim() || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '');
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '');
    const normalizedHour = hour === 24 ? 0 : hour;
    if (Number.isInteger(normalizedHour) && normalizedHour >= 0 && normalizedHour <= 23
      && Number.isInteger(minute) && minute >= 0 && minute <= 59) {
      return normalizedHour * 60 + minute;
    }
  } catch {
    // Invalid IANA timezone: preserve the deterministic UTC fallback.
  }
  return utcFallback;
}

/** Add (or subtract) calendar days from a YYYY-MM-DD string, returning
 *  another YYYY-MM-DD string. Pure calendar arithmetic — does NOT touch
 *  timezones, so this is safe for any local date that was already
 *  computed in the right zone.
 *
 *  Why we use Date.UTC despite "no UTC round-trip" being the motivation
 *  for this file: we're not computing a calendar across a tz here.
 *  We're starting from a known YYYY-MM-DD string and shifting the day
 *  number. Date.UTC gives us a deterministic add-days primitive without
 *  DST adjustments. The result is read back as YYYY-MM-DD with no tz
 *  involvement — no skip-a-day bug possible. */
export function addDaysInTz(yyyymmdd: string, days: number): string {
  // Parse the date components explicitly (don't rely on Date(string)
  // which has historically inconsistent parsing across JS engines).
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd);
  if (!m) {
    throw new Error(`Invalid YYYY-MM-DD: ${yyyymmdd}`);
  }
  const [, yStr, moStr, dStr] = m;
  const utcMs = Date.UTC(Number(yStr), Number(moStr) - 1, Number(dStr));
  const shifted = new Date(utcMs + days * 86_400_000);
  // Read back UTC components — no DST/timezone offset can interfere.
  const y = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/**
 * The zone's UTC offset in milliseconds at a given instant (local wall clock
 * minus UTC). Positive east of Greenwich.
 *
 * Derived by formatting the instant in the zone and reading the wall clock back
 * as if it were UTC — the difference IS the offset. Evaluated at a specific
 * instant rather than looked up per-zone, which is what makes it correct on
 * both sides of a DST boundary.
 */
function tzOffsetMsAt(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  // Some ICU versions render midnight as hour "24"; % 24 folds it back.
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  // Compare against the instant truncated to the second: asIfUtc carries no ms.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * A hotel-local wall-clock time on a given local day → the instant it happens.
 *
 * The inverse of propertyLocalToday, and the piece that was missing: everything
 * here could turn an instant into a local date, but nothing could turn a local
 * date back into an instant. Callers filled the gap with `${day}T23:59:59Z`,
 * which is not the end of the hotel's day — it is the end of the day in
 * Greenwich, i.e. 6:59pm in Texas and the following morning in Sydney.
 *
 * TWO PASSES, and the second one is the whole point. The offset that applies at
 * a wall-clock time is the offset AT THE ANSWER, not at the guess. Pass one
 * lands within an hour; pass two is evaluated at that instant and lands exactly.
 * They differ only across a DST boundary, which is precisely the day a
 * single-pass version is wrong.
 *
 * A null/invalid timezone degrades to UTC rather than throwing: a bad tz string
 * must never take a write down.
 */
function localWallClockToInstant(
  yyyymmdd: string,
  h: number, mi: number, s: number, ms: number,
  timezone: string | null,
): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd);
  if (!m) throw new Error(`Invalid YYYY-MM-DD: ${yyyymmdd}`);
  const wallMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, mi, s, ms);
  if (!timezone || !timezone.trim()) return new Date(wallMs);
  try {
    const firstPass = wallMs - tzOffsetMsAt(new Date(wallMs), timezone);
    return new Date(wallMs - tzOffsetMsAt(new Date(firstPass), timezone));
  } catch {
    return new Date(wallMs);
  }
}

/** The instant a hotel-local calendar day BEGINS (00:00:00.000 local). */
export function startOfLocalDay(yyyymmdd: string, timezone: string | null): Date {
  return localWallClockToInstant(yyyymmdd, 0, 0, 0, 0, timezone);
}

/**
 * The last instant of a hotel-local calendar day (23:59:59.999 local).
 *
 * THE due-date convention for the whole app: "due today" means due by the end
 * of today where the hotel is, so a to-do created this morning does not turn
 * red over dinner and a day-off request files under the day it names.
 */
export function endOfLocalDay(yyyymmdd: string, timezone: string | null): Date {
  return localWallClockToInstant(yyyymmdd, 23, 59, 59, 999, timezone);
}

/**
 * How many times the HOTEL's calendar has turned over between two instants.
 *
 * "Waiting 1 day" has to mean the hotel woke up once since, not that 24 hours
 * of Greenwich went by. Counting against UTC made a to-do handed over at 9pm
 * Monday in Texas still read "0 days" at breakfast on Tuesday, because UTC had
 * already rolled to Tuesday before the manager finished typing it and the
 * subtraction never reached a full 86,400,000ms.
 *
 * Both instants are reduced to the hotel's own calendar date FIRST and the
 * subtraction happens in that calendar, which is what makes a DST weekend
 * (a 23 or 25 hour day) still count as exactly one day. Negative when `from`
 * is later than `to`; callers that show the number to a person clamp at zero.
 */
export function localDaysBetween(from: Date, to: Date, timezone: string | null): number {
  return calendarDaysBetween(
    propertyLocalToday(from, timezone),
    propertyLocalToday(to, timezone),
  );
}

/** Whole days between two YYYY-MM-DD strings. Pure calendar arithmetic: both
 *  sides are read as UTC midnight, so no zone or DST offset can leak in. */
function calendarDaysBetween(from: string, to: string): number {
  return Math.round((utcMidnightOf(to) - utcMidnightOf(from)) / 86_400_000);
}

function utcMidnightOf(yyyymmdd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd);
  if (!m) throw new Error(`Invalid YYYY-MM-DD: ${yyyymmdd}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Convenience: get the property's local YYYY-MM-DD for now + offset days,
 *  computing the date shift purely in the local calendar (not via UTC
 *  round-trip).
 *
 *  Examples (cron firing at 2026-05-15T01:00:00Z):
 *    propertyLocalDateOffset(now, 'America/Chicago', 0)  → '2026-05-14'
 *    propertyLocalDateOffset(now, 'America/Chicago', 1)  → '2026-05-15'
 *    propertyLocalDateOffset(now, 'Pacific/Kiritimati', 0) → '2026-05-15'
 *    propertyLocalDateOffset(now, 'Pacific/Kiritimati', 1) → '2026-05-16'
 *    (previous UTC-round-trip implementation: 2026-05-17. WRONG.)
 */
export function propertyLocalDateOffset(
  now: Date,
  timezone: string | null,
  offsetDays: number,
): string {
  const today = propertyLocalToday(now, timezone);
  return addDaysInTz(today, offsetDays);
}
