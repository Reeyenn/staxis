// Pure last-good hold for the dashboard's 30-second counts poll.
//
// fetchTodayPropertyCounts (src/lib/db/today-room-work.ts) collapses any RPC
// error to the ALL-ZERO shape (deliberately: "non-crashing in the bootstrap
// window"). The dashboard used to setCounts() unconditionally, so a single
// transient DB/network hiccup flipped a live wall-TV dashboard from real
// numbers to the blank '—  learning from your PMS' ring for up to 30s, then
// back. Same posture as useFeedStatus's last-known-good hold.
//
// Genuine all-zero data still lands: in the bootstrap window prev is null (or
// itself all-zero), so nothing is held. A real snapshot always carries a
// non-zero total_rooms, which keeps the two states distinguishable.

import type { TodayPropertyCounts } from '@/lib/db/today-room-work';

export function isZeroCounts(c: TodayPropertyCounts): boolean {
  return (
    c.checkouts === 0 &&
    c.stayovers === 0 &&
    c.vacant_clean === 0 &&
    c.vacant_dirty === 0 &&
    c.ooo === 0 &&
    c.total_rooms === 0 &&
    c.total_checkouts_today === 0 &&
    c.in_house === 0
  );
}

/** Next counts state for a poll result: hold the previous real numbers when
 *  the new value is the error-fallback all-zero shape. */
export function holdLastGoodCounts(
  prev: TodayPropertyCounts | null,
  next: TodayPropertyCounts,
): TodayPropertyCounts {
  if (prev && !isZeroCounts(prev) && isZeroCounts(next)) return prev;
  return next;
}

/**
 * Headline occupancy % for the ring — or null when the PMS has not reported a
 * room mix yet, which the ring renders as the honest "waiting for PMS data".
 *
 * Occupancy means rooms occupied TONIGHT: `in_house`, i.e.
 * pms_in_house_snapshot.total_occupied_rooms. That is the same figure the Home
 * tile and the sealed daily history read, so every surface agrees for one
 * hotel on one day.
 *
 * It is NOT stayovers + checkouts. Those two filters are disjoint and describe
 * two different nights (a checkout occupied the room LAST night and has already
 * left), so their sum is "every reservation that touches today" and overstates
 * occupancy by roughly the day's departure count.
 *
 * When the snapshot carries no in_house figure we fall back to
 * total_rooms - vacant_clean - vacant_dirty - ooo, the same derivation the
 * nightly seal uses. That fallback only applies once the snapshot has actually
 * reported something: with no snapshot at all every one of those columns is 0
 * and the subtraction would read as a completely full hotel.
 */
export function occupancyPctFromCounts(
  counts: TodayPropertyCounts | null,
  totalRooms: number,
): number | null {
  if (!counts || counts.total_rooms <= 0) return null;
  // No in-house snapshot yet → occupancy is unknown, not zero and not full.
  const snapshotReported = counts.in_house > 0
    || counts.vacant_clean > 0
    || counts.vacant_dirty > 0
    || counts.ooo > 0;
  if (!snapshotReported) return null;

  const denom = totalRooms > 0 ? totalRooms : counts.total_rooms;
  const occupied = counts.in_house > 0
    ? counts.in_house
    : Math.max(0, counts.total_rooms - counts.vacant_clean - counts.vacant_dirty - counts.ooo);
  // A configured room count that lags the PMS must never read past 100%.
  return Math.min(100, Math.round((occupied / denom) * 100));
}
