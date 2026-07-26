// ─── The hotel's own history, as a detector sees it ──────────────────────────
//
// Phase 2A watches for two things no rule could have predicted: a number that
// is unusual FOR THIS HOTEL, and a thing this hotel always did that stopped.
// Both need the same raw material — the hotel's own trailing record — so the
// shapes live here rather than being invented twice.
//
// EVERY DATE IN THIS FILE IS A HOTEL-LOCAL CALENDAR DATE (YYYY-MM-DD).
// Not a timestamp, not UTC. A 9pm delivery in Beaumont belongs to that day's
// week however the row was stamped, and "nobody counted yesterday" has to mean
// yesterday where the hotel is. The loaders convert once, at the edge, and
// nothing downstream ever sees an instant again.
//
// MONEY IS CENTS, ALWAYS.
// The source columns (`inventory_orders.total_cost`, `work_orders.repair_cost`,
// `inventory_counts.variance_value`) are numeric DOLLARS. The loaders multiply
// by 100 and round exactly once, at the edge, for the same reason: a detector
// that has to remember which unit it is holding will eventually forget.

/** One hotel-local day with a number attached. */
export interface DailySeriesPoint {
  /** YYYY-MM-DD, hotel-local. */
  date: string;
  value: number;
}

/**
 * The honesty floor shared by every history feed. A hotel that started
 * recording three weeks ago has no baseline, and the detector needs to be able
 * to SAY that rather than treat eleven empty weeks as eleven quiet weeks.
 *
 * `coverageStartDate` is the earliest day this hotel has a record of this kind
 * on, within the window fetched. When it is later than the start of the
 * baseline period, the hotel simply has not been doing this long enough.
 */
export interface HistoryCoverage {
  coverageStartDate: string | null;
  /** How many days back the loader looked. Bounds every claim made on it. */
  windowDays: number;
}

// ─── Supply spend ────────────────────────────────────────────────────────────

/**
 * What the hotel spent restocking, per day, from its OWN delivery log
 * (`inventory_orders`). Correction rows are summed in alongside receipts —
 * they are the ledger's own retraction of a mistyped delivery, so the net is
 * the truth and dropping them would leave a phantom spike on record.
 */
export interface SupplySpendHistory extends HistoryCoverage {
  /** Cents per hotel-local day. Days with no delivery are simply absent. */
  days: DailySeriesPoint[];
}

// ─── Work orders ─────────────────────────────────────────────────────────────

export interface WorkOrderHistory extends HistoryCoverage {
  /** Work orders CREATED per hotel-local day. */
  createdPerDay: DailySeriesPoint[];
  /**
   * What this hotel has actually paid to fix things, in cents. The only
   * honest basis for "what is a work order worth" — and when it is empty, the
   * detector says nothing about money at all.
   */
  repairCostCentsSamples: number[];
}

// ─── Work orders, per location ───────────────────────────────────────────────

/**
 * One place in the hotel and the maintenance it has generated lately.
 *
 * WHY THIS IS A SECOND WORK-ORDER FEED AND NOT A FIELD ON THE FIRST
 * `WorkOrderHistory` answers "is this hotel logging maintenance faster than it
 * usually does" — one number a day, hotel-wide. This answers "does one PLACE
 * keep breaking", which is a different question with a different unit and a
 * different remedy: the first one is a heads-up, this one has a fix attached.
 * Folding them together would mean every detector that wants the rate pays to
 * load the per-location breakdown.
 *
 * `location` is `work_orders.room_number`, which since migration 0131 stores
 * free text — "Room 214", "Lobby", "Hall 2F". It is carried through VERBATIM,
 * never parsed into a room number: the action that acts on this writes the same
 * string straight back onto the board, so any normalisation here would be a
 * place for the card and the ticket to disagree about where the problem is.
 */
export interface LocationWorkOrders {
  /** Exactly as the board stores it. Never normalised, never parsed. */
  location: string;
  /** Work orders opened at this location inside the window. */
  total: number;
  /** Of those, how many are still not resolved. */
  stillOpen: number;
  /** Hotel-local date of the most recent one. */
  lastDate: string;
}

export interface RoomWorkOrderHistory extends HistoryCoverage {
  locations: LocationWorkOrders[];
  /** What this hotel has actually paid to fix things, in cents. Empty means
   *  the finding carries no dollar figure at all. */
  repairCostCentsSamples: number[];
}

// ─── Inventory usage ─────────────────────────────────────────────────────────

/** Consumption of one item between two consecutive counts of that item. */
export interface UsageInterval {
  /** Hotel-local date of the LATER count. */
  endDate: string;
  /** Days between the two counts. Always >= 1. */
  days: number;
  /** stock_before + delivered - discarded - stock_after. Never negative. */
  unitsUsed: number;
}

export interface InventoryItemUsage {
  itemId: string;
  itemName: string;
  unit: string;
  intervals: UsageInterval[];
  /** Unit costs this hotel actually PAID for this item, in cents. */
  unitCostCentsSamples: number[];
  /**
   * The stock level at which this hotel says it reorders, and how long its own
   * orders take to arrive. Both are things the hotel typed in, and both are
   * null when it never did — which is a real answer, and the reason the reorder
   * action declines to exist rather than inventing a number.
   */
  reorderAt: number | null;
  reorderLeadDays: number | null;
}

export interface InventoryUsageHistory extends HistoryCoverage {
  items: InventoryItemUsage[];
}

// ─── Operating rhythm ────────────────────────────────────────────────────────

/**
 * One thing this hotel does repeatedly, and the days it did it. The absence
 * detector learns the cadence from these dates and from nothing else — there
 * is no configured "linen should be counted every 3 days" anywhere, because a
 * number nobody at the hotel chose is a number the hotel will resent.
 */
export interface ActivityStream {
  /** Stable slug. Becomes part of the finding's identity. */
  id: string;
  /** Goes straight into the sentence: "nobody has been counting inventory". */
  label: string;
  /** Hotel-local dates it happened, ascending and deduplicated. */
  dates: string[];
  /**
   * What resuming is worth, in cents, sampled from the hotel's own records —
   * or an empty array, which means the finding carries no dollar figure.
   */
  worthCentsSamples: number[];
  /** How those samples should be described, if there are any. */
  worthBasis: string | null;
}

export interface OperatingRhythmHistory extends HistoryCoverage {
  streams: ActivityStream[];
}

// ─── Shared pure helpers ─────────────────────────────────────────────────────

/** Dollars (as the numeric columns store them) to whole cents. */
export function dollarsToCents(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Sum a list of dated points into one point per date, ascending. */
export function collapseByDate(points: readonly DailySeriesPoint[]): DailySeriesPoint[] {
  const byDate = new Map<string, number>();
  for (const point of points) {
    byDate.set(point.date, (byDate.get(point.date) ?? 0) + point.value);
  }
  return [...byDate.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The earliest date in a list, or null. */
export function earliestDate(dates: readonly string[]): string | null {
  let earliest: string | null = null;
  for (const date of dates) if (!earliest || date < earliest) earliest = date;
  return earliest;
}
