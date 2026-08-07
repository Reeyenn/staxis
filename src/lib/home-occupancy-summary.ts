// ═══════════════════════════════════════════════════════════════════════════
// The Home hub's occupancy line — and the reason it is not computed in the
// route.
//
// THE BUG THIS EXISTS TO KILL. `today_property_counts_v1` COALESCEs the whole
// in-house snapshot to 0 and takes `total_rooms` from a completely separate
// table (`pms_rooms_inventory`). So a hotel whose room roster has been learned
// but whose in-house snapshot has not landed — which is EVERY hotel on a PMS
// family where the counts feed is 'unavailable', per the note on countsTrusted
// in src/lib/pms/feed-status.ts — returns `in_house = 0, total_rooms = 74`.
// The Home tile divided one by the other and printed "0% occupied" in the
// green "everything is fine" tone, while the Dashboard, reading the same RPC
// through occupancyPctFromCounts, correctly showed "—  waiting for PMS data".
//
// Worse than the empty hotel: when the snapshot reports the vacant columns but
// not `total_occupied_rooms`, the Dashboard falls back to
// total_rooms − vacant_clean − vacant_dirty − ooo and shows 65%. The Home tile
// still said 0%. Two screens, one hotel, one second, 65 points apart.
//
// So the percentage is NOT derived here. It is derived by
// occupancyPctFromCounts — the single occupancy derivation the Dashboard ring
// and the nightly seal already share — and this module only turns its answer
// into the tile's short line. A null percentage is the honest "we have not
// been told" and renders as the tile's muted door, never as a zero.
//
// Lives in src/lib rather than in the route because a Next.js route file may
// only export its HTTP handlers, so a helper defined there cannot be exercised
// by a test. Same shape and same reason as its sibling
// src/lib/home-inventory-summary.ts.
// ═══════════════════════════════════════════════════════════════════════════

import { occupancyPctFromCounts } from '@/app/dashboard/_components/counts-hold';
import type { TodayPropertyCounts } from '@/lib/db/today-room-work';

export type HomeOccupancyTone = 'ok' | 'muted';

export interface HomeOccupancyLine {
  en: string;
  tone: HomeOccupancyTone;
}

/** The raw row shape `today_property_counts_v1` hands back. Every field is
 *  `unknown` because it arrives from PostgREST, not from our own code. */
export interface HomeOccupancyCountsRow {
  vacant_clean?: unknown;
  vacant_dirty?: unknown;
  ooo?: unknown;
  total_rooms?: unknown;
  in_house?: unknown;
}

/** Coerce one PostgREST column to a non-negative count. A null, a string or a
 *  NaN all mean "this column told us nothing", which is 0 rows — never a
 *  number that could tilt the derivation. */
function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The Home tile's occupancy line, or null when the hotel has not reported a
 * room mix yet and the tile must fall back to its muted door.
 *
 * `configuredTotalRooms` is `properties.total_rooms` — the hotel's own
 * inventory, which is what the Dashboard divides by. The PMS snapshot's
 * `total_rooms` can be a partial sample, and dividing by it is how a tile ends
 * up claiming a hotel is 125% full; it is used only when the property has no
 * configured count of its own.
 */
export function summarizeHomeOccupancy(
  row: HomeOccupancyCountsRow | null | undefined,
  configuredTotalRooms: unknown,
): HomeOccupancyLine | null {
  if (!row) return null;

  const counts: TodayPropertyCounts = {
    checkouts: 0,
    stayovers: 0,
    total_checkouts_today: 0,
    vacant_clean: count(row.vacant_clean),
    vacant_dirty: count(row.vacant_dirty),
    ooo: count(row.ooo),
    total_rooms: count(row.total_rooms),
    in_house: count(row.in_house),
  };

  const configured = count(configuredTotalRooms);
  const denominator = configured > 0 ? configured : counts.total_rooms;

  const pct = occupancyPctFromCounts(counts, denominator);
  if (pct == null) return null;
  return { en: `${pct}% occupied`, tone: 'ok' };
}
