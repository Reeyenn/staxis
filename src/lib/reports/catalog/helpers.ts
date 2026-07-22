/**
 * Report catalog — shared query/date helpers.
 *
 * All report definitions run server-side with supabaseAdmin and are scoped to
 * one property. These helpers handle the property-local ↔ UTC date math (so a
 * "last 7 days" window lines up with the property's calendar, not the server's)
 * plus a few aggregation primitives.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';

/** Add `n` days to a YYYY-MM-DD string (pure, UTC-safe). */
export function dateAddDays(dateIso: string, n: number): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Offset (ms) between `timeZone` wall-clock and UTC at the given instant.
 * Positive east of UTC. Uses Intl so it's DST-correct.
 */
function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asUTC - date.getTime();
}

/** The UTC instant of property-local midnight for a YYYY-MM-DD date. */
export function localMidnightUtc(dateIso: string, timeZone: string): string {
  const guess = new Date(`${dateIso}T00:00:00Z`).getTime();
  const offset = tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess - offset).toISOString();
}

/**
 * UTC half-open bounds [fromUtc, toUtcExclusive) for a property-local
 * inclusive date range [from, to]. Use for filtering timestamptz columns.
 */
export function utcBoundsForLocalRange(
  from: string,
  to: string,
  timeZone: string,
): { fromUtc: string; toUtcExclusive: string } {
  return {
    fromUtc: localMidnightUtc(from, timeZone),
    toUtcExclusive: localMidnightUtc(dateAddDays(to, 1), timeZone),
  };
}

// ─── tiny aggregation primitives ─────────────────────────────────────────────

export function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function avg(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return sum(xs) / xs.length;
}

export function round(n: number, dp = 0): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Group rows by a string key. */
export function groupBy<T>(rows: T[], keyOf: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/**
 * Resolve a property's staff id → display name. One query per report run.
 * Names survive even if a staff row is later deactivated (we read all rows).
 */
export async function getStaffNameMap(propertyId: string): Promise<Map<string, string>> {
  const { data, error } = await supabaseAdmin
    .from('staff')
    .select('id, name')
    .eq('property_id', propertyId);
  if (error) throw error;
  const m = new Map<string, string>();
  for (const r of (data ?? []) as Array<{ id: string; name: string | null }>) {
    m.set(r.id, r.name ?? 'Unknown');
  }
  return m;
}

/** Resolve a property's timezone (defaults to UTC). */
export async function getPropertyMeta(
  propertyId: string,
): Promise<{ timezone: string; totalRooms: number; name: string }> {
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('name, timezone, total_rooms')
    .eq('id', propertyId)
    .maybeSingle();
  if (error) throw error;
  const row = (data ?? {}) as { name?: string; timezone?: string; total_rooms?: number };
  return {
    timezone: row.timezone || 'UTC',
    totalRooms: Number(row.total_rooms ?? 0),
    name: row.name ?? 'Property',
  };
}
