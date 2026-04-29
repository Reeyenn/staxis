/**
 * Room assignment math.
 *
 * Distributes the day's cleanable rooms across the available housekeepers.
 * The function is intentionally pure (no I/O, no clock, no random) so it's
 * easy to test and behavior is deterministic across re-runs — Mario can
 * click "Send" twice and get the same room split, the cron can re-run the
 * morning resend and get the same distribution.
 *
 * Lifted out of /api/morning-resend/route.ts on 2026-04-29 so the same
 * algorithm can be reused by /api/send-shift-confirmations and any future
 * scheduling UI without copy-pasting (and so it can be tested in isolation).
 *
 * Algorithm summary:
 *   1. Group rooms by floor (the first character of the room number).
 *   2. Within a floor, sort: checkouts first (more work), then stayovers,
 *      then ties broken by ascending room number for stable output.
 *   3. Assign each floor's rooms as a block to the housekeeper with the
 *      least cumulative cleaning-minutes so far. This keeps each
 *      housekeeper on a single floor where possible (less walking) and
 *      balances total minutes across the crew.
 *
 * Cleaning minute estimates are conservative defaults — see CLEANING_TIMES
 * below. Real per-property tuning can come later by passing a config arg.
 */

export interface RoomForAssignment {
  /** Room number — first character is treated as the floor. */
  number: string;
  /** What the room needs. Vacant rooms should NOT be passed in (filter upstream). */
  type: 'checkout' | 'stayover' | 'vacant';
  /** Optional carry-through fields the caller may want to keep. */
  id?: string;
  assigned_to?: string | null;
}

export interface HousekeeperSlot {
  /** 0-based index matching the order of the housekeepers passed to assign. */
  index: number;
  /** Room numbers assigned to this housekeeper, in the order they should clean them. */
  rooms: string[];
  /** Total estimated cleaning minutes for this slot. */
  totalMinutes: number;
}

/**
 * Default per-room cleaning minute estimates. Tuned to "Mario's hotel" for
 * now; once we have data on real durations from completed shifts we can
 * make this per-property in a follow-up.
 */
export const CLEANING_TIMES: Readonly<Record<'checkout' | 'stayover', number>> = {
  checkout: 30,
  stayover: 20,
};

/** Fallback minutes if a row has an unexpected `type` value. */
const FALLBACK_MINUTES = 25;

/**
 * Distribute `rooms` across `numHousekeepers` slots using the floor-block
 * + minute-balanced strategy described in the file header.
 *
 * Returns `numHousekeepers` slots even when some end up empty (e.g. only
 * one floor has rooms today). Caller decides what to do with empty slots.
 *
 * Returns an empty array iff `numHousekeepers <= 0` or `rooms` is empty.
 */
export function smartAssignRooms(
  rooms: RoomForAssignment[],
  numHousekeepers: number,
): HousekeeperSlot[] {
  if (numHousekeepers <= 0 || rooms.length === 0) return [];

  // Group by first-digit floor.
  const byFloor: Record<string, RoomForAssignment[]> = {};
  for (const room of rooms) {
    const floor = String(room.number).charAt(0);
    if (!byFloor[floor]) byFloor[floor] = [];
    byFloor[floor].push(room);
  }

  // Within each floor: checkouts before stayovers, then numeric ascending.
  for (const floor of Object.keys(byFloor)) {
    byFloor[floor].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'checkout' ? -1 : 1;
      return parseInt(a.number) - parseInt(b.number);
    });
  }

  const slots: HousekeeperSlot[] = Array.from({ length: numHousekeepers }, (_, i) => ({
    index: i,
    rooms: [],
    totalMinutes: 0,
  }));

  // Iterate floors in insertion order — `Object.values` preserves it on
  // modern JS engines for string keys, which matches how the original
  // implementation behaved.
  for (const floorRooms of Object.values(byFloor)) {
    // Pick the slot with the lowest totalMinutes. Ties go to the lower
    // index (stable selection) because `reduce` keeps the accumulator on
    // ties.
    const lightest = slots.reduce(
      (min, s) => (s.totalMinutes < min.totalMinutes ? s : min),
      slots[0],
    );
    for (const room of floorRooms) {
      lightest.rooms.push(room.number);
      lightest.totalMinutes +=
        CLEANING_TIMES[room.type as 'checkout' | 'stayover'] ?? FALLBACK_MINUTES;
    }
  }

  return slots;
}
