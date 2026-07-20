import { inBucket, type StockBucket } from './tokens';
import type { DisplayItem } from './types';

export interface MobileInventoryPartition {
  critical: DisplayItem[];
  low: DisplayItem[];
  good: DisplayItem[];
  uncounted: DisplayItem[];
  visibleCount: number;
}

function urgencySort(a: DisplayItem, b: DisplayItem) {
  const aDays = a.burnSource === 'fallback-60d' || a.burnSource === 'no-data'
    ? Number.POSITIVE_INFINITY
    : a.daysLeft;
  const bDays = b.burnSource === 'fallback-60d' || b.burnSource === 'no-data'
    ? Number.POSITIVE_INFINITY
    : b.daysLeft;
  return aDays - bDays || a.name.localeCompare(b.name);
}

/** Pure category filtering and urgency grouping for the responsive view. */
export function partitionMobileInventory(
  items: DisplayItem[],
  bucket: StockBucket,
  query = '',
): MobileInventoryPartition {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = items
    .filter((item) => inBucket(item, bucket))
    .filter((item) => (
      normalizedQuery
        ? `${item.name} ${item.vendor ?? ''} ${item.id}`.toLocaleLowerCase().includes(normalizedQuery)
        : true
    ));
  const counted = visible.filter((item) => !item.uncounted);
  return {
    critical: counted.filter((item) => item.status === 'critical').sort(urgencySort),
    low: counted.filter((item) => item.status === 'low').sort(urgencySort),
    good: counted.filter((item) => item.status === 'good').sort(urgencySort),
    uncounted: visible
      .filter((item) => item.uncounted)
      .sort((a, b) => a.name.localeCompare(b.name)),
    visibleCount: visible.length,
  };
}
