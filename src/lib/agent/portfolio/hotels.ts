import 'server-only';

// ─── The portfolio's hotels, read one hotel at a time ───────────────────────
//
// THE SHAPE OF EVERY CROSS-HOTEL READ IN THIS CODEBASE.
//
// A portfolio answer is a LOOP over `scopedDb(pid)`, never a single query with
// `.in('property_id', […])`. That is not a style preference:
//
//   • `scopedDb` pre-applies the hotel filter before the caller sees a builder,
//     so there is no unfiltered builder to forget it on. A cross-property `.in`
//     would need the raw service-role client, which the eslint rule and
//     `scripts/audit-service-role-imports.mjs` refuse inside `src/lib/agent/**`.
//   • The wall therefore stays STRUCTURAL at portfolio scope. The set of hotels
//     is decided ONCE, by the spine, and every read is bounded by one of them.
//     A bug in this file can return the wrong SUBSET of the caller's own
//     hotels; it cannot reach a hotel the spine did not hand it.
//   • The cost is N indexed single-row reads instead of one. A management
//     company owns 5-50 hotels (`src/lib/company/roles.ts`), which is why
//     MAX_PORTFOLIO_HOTELS below is where it is.
//
// Anything added to the portfolio surface later must keep this shape.

import { scopedDb } from '@/lib/agent/scoped-db';

/**
 * How many hotels one portfolio read will touch.
 *
 * Not a permission boundary — the caller still COVERS every hotel past it. It
 * is a per-turn cost ceiling, and every reader that hits it must say so out
 * loud rather than silently answering for a subset (an unlabelled partial
 * answer to "which hotel had the worst week" is the worst possible failure of
 * this whole surface).
 */
export const MAX_PORTFOLIO_HOTELS = 50;

export interface PortfolioHotel {
  id: string;
  name: string | null;
  /** `properties.total_rooms`, kept in lock-step with room_inventory by the
   *  0125 trigger (INV-24). Structural, so it is safe in the cached prompt. */
  totalRooms: number | null;
  timezone: string | null;
}

/** What a portfolio read covered, and what it had to leave out. */
export interface PortfolioReach<T> {
  rows: T[];
  /** Hotels the caller covers that this read did not touch, and why. */
  omittedHotelCount: number;
}

/**
 * Bound a covered set to what one turn will read, preserving the caller's own
 * sort so "the first 50" is deterministic rather than whatever the map yielded.
 */
export function boundedHotelIds(propertyIds: readonly string[]): {
  ids: string[];
  omittedHotelCount: number;
} {
  const unique = [...new Set(propertyIds)].sort();
  return {
    ids: unique.slice(0, MAX_PORTFOLIO_HOTELS),
    omittedHotelCount: Math.max(0, unique.length - MAX_PORTFOLIO_HOTELS),
  };
}

/**
 * Run one per-hotel read across the covered set, in parallel, each through its
 * own hotel-scoped accessor.
 *
 * Failure-isolated: a hotel whose read throws contributes `null` rather than
 * failing the whole portfolio. One unreachable hotel must not blank a VP's
 * answer about the other nineteen — but the caller is told, so it can say
 * which hotels it could not read instead of implying they were quiet.
 */
export async function forEachHotel<T>(
  propertyIds: readonly string[],
  read: (db: ReturnType<typeof scopedDb>, propertyId: string) => Promise<T>,
): Promise<{ results: Array<{ propertyId: string; value: T | null }>; failedHotelCount: number }> {
  let failedHotelCount = 0;
  const results = await Promise.all(
    propertyIds.map(async (propertyId) => {
      try {
        return { propertyId, value: await read(scopedDb(propertyId), propertyId) };
      } catch {
        failedHotelCount += 1;
        return { propertyId, value: null as T | null };
      }
    }),
  );
  return { results, failedHotelCount };
}

/**
 * The hotels themselves — name, size, timezone. One scoped read each.
 *
 * `properties` is scoped on `id` (SCOPE_COLUMN_OVERRIDES), so the accessor's
 * filter and the row's identity are the same predicate: a hotel row cannot come
 * back through an accessor built for a different hotel.
 */
// Names and sizes are STRUCTURAL: they move when a hotel is renamed or its room
// list changes, which is not something that happens inside one conversation.
// The cache exists because a portfolio turn calls several tools and every one
// of them labels its rows with hotel names — without it, one question costs
// (tools x hotels) single-row reads of the same unchanging text.
const HOTEL_TTL_MS = 60_000;
const hotelCache = new Map<string, { hotels: PortfolioHotel[]; expiresAt: number }>();

/** Test seam: forget every hotel row read so far. */
export function clearPortfolioHotelCache(): void {
  hotelCache.clear();
}

export async function loadPortfolioHotels(
  propertyIds: readonly string[],
): Promise<PortfolioHotel[]> {
  const key = [...propertyIds].sort().join(',');
  const hit = hotelCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.hotels;
  const hotels = await loadPortfolioHotelsUncached(propertyIds);
  hotelCache.set(key, { hotels, expiresAt: Date.now() + HOTEL_TTL_MS });
  return hotels;
}

async function loadPortfolioHotelsUncached(
  propertyIds: readonly string[],
): Promise<PortfolioHotel[]> {
  const { results } = await forEachHotel(propertyIds, async (db, propertyId) => {
    const { data, error } = await db
      .from('properties')
      .select('id, name, total_rooms, timezone')
      .maybeSingle() as unknown as {
        data: { id: string; name: string | null; total_rooms: number | null; timezone: string | null } | null;
        error: { message: string } | null;
      };
    if (error) throw new Error(`properties read failed for ${propertyId}: ${error.message}`);
    return data;
  });

  const hotels: PortfolioHotel[] = [];
  for (const { propertyId, value } of results) {
    if (!value) continue;
    hotels.push({
      id: value.id ?? propertyId,
      name: value.name ?? null,
      totalRooms: value.total_rooms == null ? null : Number(value.total_rooms),
      timezone: value.timezone ?? null,
    });
  }

  // Sorted by NAME, with the id as the tie-break, so the identity block that
  // renders this list is byte-identical run to run whatever order the reads
  // resolved in. A list that reshuffles is a cached prompt that never hits.
  return hotels.sort((a, b) => {
    const an = a.name ?? '';
    const bn = b.name ?? '';
    if (an !== bn) return an < bn ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
