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
