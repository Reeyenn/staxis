import {
  inventoryMonthEndDateKey,
  shiftInventoryMonthKey,
  type InventoryMonthCloseHistoryRow,
} from '@/lib/inventory-month-close';

export type InventoryCompareBasis = 'months' | 'years' | 'custom';
export type InventoryCompareActualStatus = 'complete' | 'partial' | 'pending' | 'unavailable';

export interface InventoryCompareActual {
  actualUsageValue: number | null;
  confirmedPurchasesValue: number | null;
  actualUsageStatus: InventoryCompareActualStatus;
  closedMonths: number;
  expectedMonths: number;
  /** Full calendar months ended inside the selected year window. */
  windowMonths: number;
}

const unavailable = (): InventoryCompareActual => ({
  actualUsageValue: null,
  confirmedPurchasesValue: null,
  actualUsageStatus: 'unavailable',
  closedMonths: 0,
  expectedMonths: 0,
  windowMonths: 0,
});

const pending = (
  closedMonths = 0,
  expectedMonths = 0,
  windowMonths = expectedMonths,
): InventoryCompareActual => ({
  actualUsageValue: null,
  confirmedPurchasesValue: null,
  actualUsageStatus: 'pending',
  closedMonths,
  expectedMonths,
  windowMonths,
});

/**
 * Resolve immutable monthly-close actuals for one Compare window.
 *
 * A property's inventory activity may predate the month-close feature by
 * years. For year comparisons, the first close-history row is therefore the
 * availability boundary; pre-feature months are not treated as missing closes.
 */
export function resolveInventoryCompareActual(args: {
  basis: InventoryCompareBasis;
  from: string;
  to: string;
  currentMonth: string;
  closes: readonly InventoryMonthCloseHistoryRow[];
}): InventoryCompareActual {
  if (args.basis === 'custom') return unavailable();

  let expected: string[] = [];
  let windowMonths = 0;
  if (args.basis === 'months') {
    const month = args.from.slice(0, 7);
    if (args.from !== `${month}-01` || args.to !== inventoryMonthEndDateKey(month)) {
      return unavailable();
    }
    expected = [month];
    windowMonths = 1;
  } else {
    const firstMonthWithCloseHistory = args.closes.reduce<string | null>(
      (earliest, row) => earliest == null || row.month < earliest ? row.month : earliest,
      null,
    );
    const firstRangeMonth = args.from.slice(0, 7);
    if (args.from !== `${firstRangeMonth}-01`) return unavailable();

    let month = firstRangeMonth;
    for (let guard = 0; guard < 24 && inventoryMonthEndDateKey(month) <= args.to; guard += 1) {
      if (month < args.currentMonth) windowMonths += 1;
      if (
        firstMonthWithCloseHistory != null
        && month >= firstMonthWithCloseHistory
        && month < args.currentMonth
      ) {
        expected.push(month);
      }
      month = shiftInventoryMonthKey(month, 1);
    }
  }

  if (expected.length === 0) return pending(0, 0, windowMonths);

  const closeByMonth = new Map(
    args.closes
      .filter((row) => row.status === 'closed')
      .map((row) => [row.month, row] as const),
  );
  const closed = expected
    .map((month) => closeByMonth.get(month))
    .filter((row): row is InventoryMonthCloseHistoryRow => row != null && row.actualUsageCents != null);
  if (closed.length !== expected.length) {
    return pending(closed.length, expected.length, windowMonths);
  }

  return {
    actualUsageValue: closed.reduce((sum, row) => sum + Number(row.actualUsageCents), 0) / 100,
    confirmedPurchasesValue: closed.reduce((sum, row) => sum + Number(row.purchasesCents ?? 0), 0) / 100,
    actualUsageStatus: closed.some((row) => row.isPartial) ? 'partial' : 'complete',
    closedMonths: closed.length,
    expectedMonths: expected.length,
    windowMonths,
  };
}
