// Local-calendar month helpers for the inventory page's budget/spend surfaces.
//
// Timezone-drift fix: these used to be computed on the UTC month (Date.UTC /
// getUTC*), so on the evening of the last day of a month (US timezones) the
// sidebar "This month" spend reset to $0 and the budget caps flipped to next
// month hours early. "This month" must mean the HOTEL'S local calendar month.
//
// Budget rows are different: `inventory_budgets.month_start` is a DATE column
// ('YYYY-MM-01') that the mappers parse as a UTC-midnight instant, so the
// stored year/month must be read back with getUTC* — only the "now" side is
// local. `isBudgetForLocalMonth` encodes that asymmetry in one place.

/** First instant of the LOCAL month containing `d`. */
export function startOfLocalMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** First instant of the LOCAL month `n` months after the one containing `d`. */
export function addLocalMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/**
 * Does a budget row (whose `monthStart` is a UTC-midnight parse of the stored
 * 'YYYY-MM-01' date) belong to the LOCAL calendar month containing `now`?
 */
export function isBudgetForLocalMonth(monthStart: Date, now: Date): boolean {
  return (
    monthStart.getUTCFullYear() === now.getFullYear() &&
    monthStart.getUTCMonth() === now.getMonth()
  );
}
