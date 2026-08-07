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

import { dollarsToCents as canonicalDollarsToCents } from '@/lib/format';

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

// ─── Work orders, per piece of equipment ─────────────────────────────────────

/**
 * One asset from the hotel's equipment registry and the maintenance it has
 * generated lately.
 *
 * WHY THIS IS A THIRD WORK-ORDER FEED AND NOT A FIELD ON `LocationWorkOrders`
 * A location groups by WHERE a ticket was written. An asset groups by WHAT the
 * person who wrote it said was broken, and the two answer questions that do not
 * even have the same shape: a batch of PTAC units installed in 2019 covers forty
 * rooms, so the pattern "that batch is dying" is INVISIBLE to a per-location
 * count — four tickets across four different rooms look like four unrelated
 * faults. That is precisely the pattern this feed exists to make countable.
 *
 * The reverse is also true, which is why both feeds stay: four tickets on the
 * one room's own plumbing are a room problem, not an asset problem, and nothing
 * links them to a registry row.
 *
 * WHAT AN ASSET'S REPAIR COSTS ARE FOR
 * `repairCostCentsSamples` here is scoped to THIS asset's own tickets, which is
 * a tighter and more honest basis for "what does fixing one of these cost" than
 * the hotel-wide spread. It is frequently empty even at a hotel that records
 * costs, so the detector falls back to the hotel-wide samples with a basis line
 * that says which of the two it used.
 */
export interface EquipmentWorkOrders {
  /** `equipment.id`. The finding's identity and its chip target. */
  id: string;
  /** As the hotel typed it: "PTAC units — rooms 201-240". Goes in the sentence. */
  name: string;
  /** `equipment.location` — the coverage text, or null when they left it blank. */
  location: string | null;
  /** Install YEAR, from `equipment.install_date`. Null when unrecorded. */
  installYear: number | null;
  /** Work orders linked to this asset inside the window. */
  total: number;
  /** Of those, how many are still not resolved. */
  stillOpen: number;
  /** Hotel-local date of the most recent one. */
  lastDate: string;
  /** What this hotel has paid to fix THIS asset, in cents. Often empty. */
  repairCostCentsSamples: number[];
}

export interface EquipmentWorkOrderHistory extends HistoryCoverage {
  equipment: EquipmentWorkOrders[];
  /**
   * How many assets the hotel has on its registry AT ALL, linked or not.
   *
   * Separate from `equipment.length` on purpose: that array only carries assets
   * with at least one ticket in the window, and the runner's minimum-data check
   * needs to tell "this hotel does not track equipment" apart from "this hotel
   * tracks equipment and none of it broke". Only the first is a reason to skip.
   */
  registeredCount: number;
  /** The hotel's own recorded repair costs, whatever the ticket was against.
   *  The fallback basis when one asset has too few of its own. */
  hotelRepairCostCentsSamples: number[];
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

// ─── Preventive schedules ────────────────────────────────────────────────────

/**
 * One upkeep schedule, as the hotel typed it into Maintenance → Preventive.
 *
 * DELIBERATELY NOT A `HistoryCoverage` FEED. Everything else in this file is
 * the hotel's trailing RECORD, and every claim made on one is bounded by how
 * far back the loader looked. This is the hotel's stated INTENTION — "we flush
 * the water heater every six months, and we last did it in March" — and there
 * is no window to be short of. A schedule typed in yesterday is complete
 * information about itself, so a coverage floor here would refuse to speak
 * about a fact that is fully known.
 *
 * Every date is a hotel-local calendar date (YYYY-MM-DD), converted once by the
 * loader, for the same reason as the rest of this file: "due today" has to mean
 * today where the hotel is.
 */
export interface PreventiveScheduleEntry {
  /** preventive_tasks.id — also the finding's target value. */
  id: string;
  /** "Water heater flush". Goes straight into the sentence. */
  name: string;
  /** "Building", "Pool". Free text the hotel typed; null when they left it blank. */
  area: string | null;
  /** The cadence in days, as stored. Always >= 1. */
  frequencyDays: number;
  /**
   * When it was last done, or null when this hotel has never recorded a
   * completion. Null is a REAL answer and the detector treats it as one — see
   * preventive-due.ts on why a never-done schedule is not overdue.
   */
  lastDoneDate: string | null;
  /**
   * The same completion as a raw instant, exactly as the database returned it.
   *
   * Carried ALONGSIDE the local date because the two answer different
   * questions. The date is what the card says and what due-ness is computed
   * from. This is what the action FREEZES and what the execute transaction
   * re-compares — and "has anybody marked this done since Staxis offered?"
   * has to be exact. Comparing local dates there would miss a completion
   * recorded later the same day, which is precisely the window in which a
   * manager marks something done and then taps a card they had already opened.
   */
  lastDoneAtIso: string | null;
  /** lastDoneDate + frequencyDays. Null exactly when lastDoneDate is. */
  nextDueDate: string | null;
  /** When somebody was called about it, or null. Drives the resting state. */
  calledDate: string | null;
  /** Who said so. Only ever set alongside calledDate. */
  calledBy: string | null;
  /**
   * When somebody put THIS occurrence down without the work being done, or null.
   *
   * A skip is neither a completion nor a call, and it is deliberately a THIRD
   * date rather than a flavour of either: moving `lastDoneDate` would write into
   * the hotel's maintenance record that a job nobody performed was performed,
   * and reusing `calledDate` would claim somebody had been called out when
   * nobody had. Rests the schedule for one full cadence. See migration 0462.
   */
  skippedDate: string | null;
  /** Who skipped it. Only ever set alongside skippedDate. */
  skippedBy: string | null;
}

export interface PreventiveScheduleFeed {
  tasks: PreventiveScheduleEntry[];
  /** The hotel-local day this was resolved against. Every claim is relative to it. */
  asOfDate: string;
}

// ─── Shared pure helpers ─────────────────────────────────────────────────────

/**
 * Dollars (as the legacy numeric columns store them) to whole cents, keeping
 * this module's null-tolerant signature.
 *
 * The conversion itself is the app-wide canonical one. This used to be a bare
 * `Math.round(n * 100)`, which disagreed with the import pipeline's rounding at
 * the half-cent boundary ($1.005 became 100c here and 101c there) even though
 * both read the same unit_cost / repair_cost columns.
 */
export function dollarsToCents(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return null;
  return canonicalDollarsToCents(n);
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

/**
 * Whole days from one hotel-local calendar date to another. Positive when
 * `to` is later.
 *
 * Anchored at NOON UTC rather than midnight. Two YYYY-MM-DD strings parsed as
 * midnight-UTC and subtracted are exact — but the same arithmetic done anywhere
 * near a DST boundary with local-midnight anchors lands 23 or 25 hours apart and
 * rounds to the wrong day. Noon puts twelve hours of slack on either side of
 * every shift, which is the same fix `addDaysLocal` applies on the client
 * (PreventiveTab's fall-back bug: backfilled dates banded one day early).
 *
 * Returns null for anything that is not a calendar date, so a malformed stored
 * value produces "we cannot say" rather than a confident NaN.
 */
export function daysBetweenDates(from: string, to: string): number | null {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}
