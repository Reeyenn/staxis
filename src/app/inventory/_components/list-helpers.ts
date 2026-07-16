import { useMemo } from 'react';
import { inBucket, type StockBucket } from './tokens';
import type { DisplayItem } from './types';

// Shared list plumbing for the two inventory views (Ledger + Board). The
// bucket/query filter and the counted/uncounted split were byte-identical in
// both; this is the one place they live now. Never-counted items are split out
// so a 0-stock seeded item never reads as red "Order now".
export function useBucketFilter(items: DisplayItem[], bucket: StockBucket, query: string) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((it) => inBucket(it, bucket))
      .filter((it) => (q ? `${it.name} ${it.vendor} ${it.id}`.toLowerCase().includes(q) : true));
  }, [items, bucket, query]);
  const counted = useMemo(() => filtered.filter((it) => !it.uncounted), [filtered]);
  const uncounted = useMemo(() => filtered.filter((it) => it.uncounted), [filtered]);
  return { filtered, counted, uncounted };
}

// Days-left sort value shared by both views: items with no real forecast (a
// par/60 fallback or no data at all) sort to the bottom; everyone else sorts
// soonest-to-run-out first. Mirrors the honesty rule that only ml /
// rule-occupancy items show a real number.
export function daysSortValue(d: DisplayItem): number {
  if (d.burnSource === 'fallback-60d' || d.burnSource === 'no-data') return Infinity;
  return d.daysLeft;
}
