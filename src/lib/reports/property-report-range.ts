import {
  inventoryDateKeyInZone,
  inventoryMonthKeyInZone,
  shiftInventoryDateKey,
} from '@/lib/inventory-month-close';

export type PropertyReportRangeKey = 'last7' | 'last30' | 'mtd' | 'custom';

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Resolve the month named by an inventory report without slicing a UTC
 * timestamp. Positive-offset hotels can begin a local month on the preceding
 * UTC date, so the server's explicit property-month key is authoritative. */
export function inventoryReportMonthKey(
  explicitMonthKey: string | null | undefined,
  monthStart: string | null | undefined,
  timezone: string,
  now = new Date(),
): string {
  if (explicitMonthKey && MONTH_KEY_RE.test(explicitMonthKey)) return explicitMonthKey;
  if (monthStart) {
    const parsed = new Date(monthStart);
    if (Number.isFinite(parsed.getTime())) return inventoryMonthKeyInZone(parsed, timezone);
  }
  return inventoryMonthKeyInZone(now, timezone);
}

/** Build report bounds from the hotel's calendar, not the manager's device. */
export function propertyReportRange(
  key: PropertyReportRangeKey,
  timezone: string,
  customFrom?: string,
  customTo?: string,
  now = new Date(),
): { from: string; to: string } {
  const today = inventoryDateKeyInZone(now, timezone);
  if (key === 'custom') {
    return {
      from: customFrom || shiftInventoryDateKey(today, -6),
      to: customTo || today,
    };
  }
  if (key === 'mtd') return { from: `${today.slice(0, 7)}-01`, to: today };
  return {
    from: shiftInventoryDateKey(today, key === 'last30' ? -29 : -6),
    to: today,
  };
}
