import type { DisplayItem } from './types';

/** Names of stocked items excluded from valuation because they have no price. */
export function missingPriceItemNames(items: readonly DisplayItem[]): string[] {
  return items
    .filter((item) => item.counted > 0 && item.raw.unitCost == null)
    .map((item) => item.name.trim() || item.id)
    .sort((a, b) => a.localeCompare(b));
}
