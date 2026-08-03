// ═══════════════════════════════════════════════════════════════════════════
// Occupancy history: months in, days out.
//
// WHY THIS EXISTS
// The inventory model learns "how fast does this hotel burn towels" by pairing
// two counts with what the hotel was DOING between them. Without occupancy for
// the same dates, a year of imported counts teaches nothing at all — the
// windows are dropped for want of an exposure number. So occupancy history is
// not a nice-to-have beside the inventory import; it is the other half of it.
//
// WHAT A HOTEL ACTUALLY HAS is a monthly summary: "March, 71.4%". What the
// trainer reads is public.daily_logs, one row per day. So a month is spread
// evenly across its days, and both halves of that are recorded honestly:
//
//   • the MONTH as the manager gave it is the source of record, stored whole
//     in inventory_import_occupancy_months;
//   • the DAYS derived from it are written to daily_logs with
//     occupancy_source = 'operator' — a person told us, no feed did — and each
//     day's prior values are kept so removing the import puts them back.
//
// A derived day never overwrites a real one. A sealed row, or a row that
// already names a source, is left exactly as it is.
// ═══════════════════════════════════════════════════════════════════════════

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** How far back an imported month is allowed to reach. Beyond three years the
 *  hotel is a different hotel and the model should not be learning from it. */
export const OCCUPANCY_IMPORT_MAX_AGE_MONTHS = 36;

export interface NormalizedOccupancyMonth {
  /** First day of the month, YYYY-MM-DD. */
  monthStart: string;
  daysInMonth: number;
  /** Percentage 0..100, to two decimals. Null when it could not be established. */
  occupancyPct: number | null;
  /** Rooms sold across the whole month (room-nights). */
  roomsSoldMonth: number | null;
  /** Rooms available across the whole month (room-nights). */
  roomsAvailableMonth: number | null;
  /** The per-day numbers written to daily_logs. */
  perDay: { roomsAvailable: number | null; roomsSold: number | null; occupied: number | null };
}

export interface OccupancyParseIssue {
  input: string;
  reason: 'unreadable_month' | 'out_of_range' | 'no_numbers' | 'duplicate_month';
}

export interface NormalizedOccupancy {
  months: NormalizedOccupancyMonth[];
  issues: OccupancyParseIssue[];
}

// ── Month parsing ──────────────────────────────────────────────────────────

/** "2026-03", "Mar 2026", "March 2026", "03/2026", "2026/03", "Mar-26" → "2026-03-01". */
export function parseMonthStart(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
  if (!s) return null;

  const iso = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(s);
  if (iso) return monthStartFrom(Number(iso[1]), Number(iso[2]));

  const slash = /^(\d{1,4})[/.](\d{1,4})$/.exec(s);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    if (a > 12) return monthStartFrom(a, b);
    if (b > 12) return monthStartFrom(b, a);
    // Both plausible as a month: MM/YYYY is how sheets are written far more
    // often than YYYY/MM when both are small, but two small numbers cannot be
    // a real year anyway, so refuse rather than coin-flip.
    return null;
  }

  const lower = s.toLowerCase();
  const nameIdx = MONTH_NAMES.findIndex((n) => new RegExp(`(^|[^a-z])${n.slice(0, 3)}[a-z]*([^a-z]|$)`).test(lower));
  if (nameIdx >= 0) {
    const year = /(\d{4})/.exec(s)?.[1]
      ?? (/['\-\s](\d{2})(?:\D|$)/.exec(s)?.[1] ? `20${/['\-\s](\d{2})(?:\D|$)/.exec(s)![1]}` : null);
    if (!year) return null;
    return monthStartFrom(Number(year), nameIdx + 1);
  }
  return null;
}

function monthStartFrom(year: number, month: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  if (year < 1970 || year > 2200 || month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

export function daysInMonthOf(monthStart: string): number {
  const [y, m] = monthStart.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Every calendar date in a month, as YYYY-MM-DD. */
export function datesInMonth(monthStart: string): string[] {
  const [y, m] = monthStart.split('-').map(Number);
  const total = daysInMonthOf(monthStart);
  const out: string[] = [];
  for (let d = 1; d <= total; d++) out.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  return out;
}

// ── Number parsing ─────────────────────────────────────────────────────────

export function parseCount(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/,/g, '').replace(/[^0-9.]/g, '');
  if (!cleaned || !/^\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * "71.4%" → 71.4. "0.714" → 71.4. "71.4" → 71.4.
 *
 * The fraction rule is deliberately narrow: a bare value at or under 1 is only
 * read as a fraction when it is written with a decimal point and no percent
 * sign. "1" stays 1 percent, because a hotel that typed 1 meant one.
 */
export function parseOccupancyPct(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  const hasPercent = s.includes('%');
  const cleaned = s.replace(/%/g, '').replace(/,/g, '').trim();
  if (!/^\d*\.?\d+$/.test(cleaned)) return null;
  let n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  if (!hasPercent && n <= 1 && cleaned.includes('.')) n *= 100;
  if (n > 100) return null;
  return Math.round(n * 100) / 100;
}

// ── Normalization ──────────────────────────────────────────────────────────

export interface NormalizeOccupancyInput {
  rows: ReadonlyArray<{
    month: string;
    occupancy_pct?: string | number | null;
    rooms_sold?: string | number | null;
    rooms_available?: string | number | null;
  }>;
  /** The hotel's room count. Used to tell a per-day figure from a month total,
   *  and to turn a bare percentage into rooms. Null when unknown. */
  propertyTotalRooms: number | null;
  /** Today at the hotel, for the "not older than three years" floor. */
  todayLocal: string;
}

/**
 * Fold the reader's month rows into the numbers daily_logs needs.
 *
 * The one genuinely ambiguous input is `rooms_available`: a sheet may print
 * the hotel's room count (60) or the month's room-nights (1,860). We resolve
 * it against the hotel's own room count, and when we cannot resolve it we
 * leave it null rather than guessing — a null rooms_available costs us the
 * derived occupancy percentage and nothing else.
 */
export function normalizeOccupancyMonths(input: NormalizeOccupancyInput): NormalizedOccupancy {
  const { propertyTotalRooms, todayLocal } = input;
  const months: NormalizedOccupancyMonth[] = [];
  const issues: OccupancyParseIssue[] = [];
  const seen = new Set<string>();

  const [ty, tm] = todayLocal.split('-').map(Number);
  const floorMonths = (ty * 12 + tm) - OCCUPANCY_IMPORT_MAX_AGE_MONTHS;

  for (const row of input.rows) {
    const monthStart = parseMonthStart(row.month);
    if (!monthStart) {
      issues.push({ input: String(row.month), reason: 'unreadable_month' });
      continue;
    }
    const [my, mm] = monthStart.split('-').map(Number);
    if (my * 12 + mm < floorMonths || my * 12 + mm > ty * 12 + tm) {
      issues.push({ input: monthStart, reason: 'out_of_range' });
      continue;
    }
    if (seen.has(monthStart)) {
      issues.push({ input: monthStart, reason: 'duplicate_month' });
      continue;
    }

    const days = daysInMonthOf(monthStart);
    const pctGiven = parseOccupancyPct(row.occupancy_pct);
    const soldGiven = parseCount(row.rooms_sold);
    const availGiven = parseCount(row.rooms_available);

    // Resolve rooms_available to a PER-DAY room count.
    let availPerDay: number | null = null;
    if (availGiven !== null && availGiven > 0) {
      if (propertyTotalRooms && propertyTotalRooms > 0) {
        // A month total is at least twenty times the hotel's room count; a
        // per-day figure is within a factor of two of it. Anything between is
        // unreadable and falls through to the hotel's own number.
        if (availGiven >= propertyTotalRooms * 20) availPerDay = Math.round(availGiven / days);
        else if (availGiven <= propertyTotalRooms * 2) availPerDay = availGiven;
        else availPerDay = propertyTotalRooms;
      } else {
        availPerDay = availGiven >= 400 ? Math.round(availGiven / days) : availGiven;
      }
    } else if (propertyTotalRooms && propertyTotalRooms > 0) {
      availPerDay = propertyTotalRooms;
    }

    // Resolve rooms_sold to a PER-DAY room count.
    let soldPerDay: number | null = null;
    let soldMonth: number | null = null;
    if (soldGiven !== null && soldGiven > 0) {
      const looksMonthly = availPerDay !== null ? soldGiven > availPerDay * 2 : soldGiven >= 400;
      soldMonth = looksMonthly ? soldGiven : soldGiven * days;
      soldPerDay = looksMonthly ? Math.round(soldGiven / days) : soldGiven;
    } else if (pctGiven !== null && availPerDay !== null) {
      soldPerDay = Math.round((pctGiven / 100) * availPerDay);
      soldMonth = soldPerDay * days;
    }

    if (soldPerDay === null && pctGiven === null) {
      issues.push({ input: monthStart, reason: 'no_numbers' });
      continue;
    }

    const pct = pctGiven !== null
      ? pctGiven
      : (soldPerDay !== null && availPerDay !== null && availPerDay > 0
        ? Math.round((soldPerDay / availPerDay) * 10_000) / 100
        : null);

    // A day cannot sell more rooms than it has.
    const cappedSold = soldPerDay !== null && availPerDay !== null
      ? Math.min(soldPerDay, availPerDay)
      : soldPerDay;

    seen.add(monthStart);
    months.push({
      monthStart,
      daysInMonth: days,
      occupancyPct: pct !== null && pct >= 0 && pct <= 100 ? pct : null,
      roomsSoldMonth: soldMonth,
      roomsAvailableMonth: availPerDay !== null ? availPerDay * days : null,
      perDay: {
        roomsAvailable: availPerDay,
        roomsSold: cappedSold,
        // The legacy column the Python trainer still reads first.
        occupied: cappedSold,
      },
    });
  }

  months.sort((a, b) => (a.monthStart < b.monthStart ? -1 : a.monthStart > b.monthStart ? 1 : 0));
  return { months, issues };
}

// ─── Which days may be written, and which are already true ────────────────

/** What daily_logs already holds for one date. */
export interface ExistingDay {
  date: string;
  occupied: number | null;
  rooms_sold: number | null;
  rooms_available: number | null;
  occupancy_source: string | null;
  sealed_at: string | null;
}

export interface PlannedOccupancyDay {
  date: string;
  occupied: number | null;
  roomsSold: number | null;
  roomsAvailable: number | null;
  /** 0344's rule: a value without a stated source cannot exist. A person told
   *  us this, so the source is the person. */
  occupancySource: 'operator';
  /** What was there before, so the undo restores rather than blanks. */
  prior: Omit<ExistingDay, 'date'>;
}

export type DayLeftAloneReason = 'sealed' | 'has_source' | 'has_occupied' | 'demo_hotel';

export interface OccupancyDayPlan {
  write: PlannedOccupancyDay[];
  leaveAlone: Array<{ date: string; reason: DayLeftAloneReason }>;
}

/**
 * Decide, for one month, which days a derived figure may be written to.
 *
 * A day is LEFT ALONE when it is already true three different ways: it is
 * sealed, its occupancy bucket already names a source, or it already carries an
 * `occupied` count from the robot. A monthly average is never more true than
 * any of those.
 *
 * And a demo hotel writes nothing at all. `is_test` properties are already
 * excluded from the network priors every real hotel inherits, but a demo
 * hotel's paperwork should not be able to reach a training input by any route,
 * so the exclusion is stated here too rather than relied on downstream.
 */
export function planOccupancyDayWrites(args: {
  month: NormalizedOccupancyMonth;
  existing: ReadonlyArray<ExistingDay>;
  mayFeedTraining: boolean;
}): OccupancyDayPlan {
  const { month, mayFeedTraining } = args;
  const priorByDate = new Map(args.existing.map((d) => [d.date, d]));
  const write: PlannedOccupancyDay[] = [];
  const leaveAlone: Array<{ date: string; reason: DayLeftAloneReason }> = [];

  for (const date of datesInMonth(month.monthStart)) {
    const prior = priorByDate.get(date) ?? null;
    if (prior?.sealed_at) { leaveAlone.push({ date, reason: 'sealed' }); continue; }
    if (prior?.occupancy_source) { leaveAlone.push({ date, reason: 'has_source' }); continue; }
    if (prior?.occupied !== null && prior?.occupied !== undefined) {
      leaveAlone.push({ date, reason: 'has_occupied' });
      continue;
    }
    if (!mayFeedTraining) { leaveAlone.push({ date, reason: 'demo_hotel' }); continue; }
    write.push({
      date,
      occupied: month.perDay.occupied,
      roomsSold: month.perDay.roomsSold,
      roomsAvailable: month.perDay.roomsAvailable,
      occupancySource: 'operator',
      prior: {
        occupied: prior?.occupied ?? null,
        rooms_sold: prior?.rooms_sold ?? null,
        rooms_available: prior?.rooms_available ?? null,
        occupancy_source: prior?.occupancy_source ?? null,
        sealed_at: prior?.sealed_at ?? null,
      },
    });
  }
  return { write, leaveAlone };
}

/** Human month label for the confirm screen: "March 2026". */
export function monthLabel(monthStart: string): string {
  const [y, m] = monthStart.split('-').map(Number);
  const name = MONTH_NAMES[m - 1];
  if (!name) return monthStart;
  return `${name[0].toUpperCase()}${name.slice(1)} ${y}`;
}

/** "March 2026 to June 2026", or "March 2026" for one. Empty for none. */
export function monthRangeLabel(monthStarts: readonly string[]): string {
  if (monthStarts.length === 0) return '';
  const sorted = [...monthStarts].sort();
  const first = monthLabel(sorted[0]);
  const last = monthLabel(sorted[sorted.length - 1]);
  return first === last ? first : `${first} to ${last}`;
}
