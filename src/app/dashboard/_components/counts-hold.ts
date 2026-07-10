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
