// ─── Feed loaders ────────────────────────────────────────────────────────────
//
// The only place in the findings layer that touches data. Each loader turns one
// existing subsystem into a plain value plus its honesty metadata (how many
// records, when the data was true, how old the weakest input is), and the
// runner loads the union of what the registered detectors declared — once per
// hotel, however many detectors read it.
//
// WHY THE THREE EXISTING SYSTEMS APPEAR HERE RATHER THAN BEING REWRITTEN
// The cleaning rules engine, the nudge checks and the operational-signal
// aggregators are called through their own published entry points, unchanged.
// Not one line of those modules moved. That is deliberate:
//
//   • Their EMITTED output must stay byte-identical. cleaning_tasks are still
//     written by the 5-minute rules-engine cron, nudges are still inserted by
//     the nudge cron, and drip questions still read the same signals. The
//     findings runner runs their DETECTION and records what it saw; it emits
//     nothing on their behalf, so there is nothing to double-write and nothing
//     to drift.
//   • The rules engine writes into housekeeping, which another workstream owns
//     and has just rebuilt. It is called here in DRY-RUN, which evaluates every
//     rule and writes nothing (engine.ts: the whole write block is behind
//     `if (!dryRun)`). Zero changes to housekeeping schema, UI or behaviour.

import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { scopedDb } from '@/lib/agent/scoped-db';
import { gatherOperationalSignals } from '@/lib/agent/operational-signals';
import { checkOperationalAlerts } from '@/lib/agent/nudges';
import { runRulesEngineForProperty, type PropertyRunResult } from '@/lib/rules-engine';
import { isSectionEnabled, type EnabledSections } from '@/lib/sections/registry';
import { addDaysInTz, propertyLocalToday } from '@/lib/schedule/local-date';

import {
  collapseByDate,
  dollarsToCents,
  earliestDate,
  type ActivityStream,
  type DailySeriesPoint,
  type InventoryItemUsage,
  type LocationWorkOrders,
  type PreventiveScheduleEntry,
  type UsageInterval,
} from './history';
import type { FeedId, FeedOutcome, FeedResult } from './types';

/** Everything the loaders share, resolved once per hotel per run. */
export interface FeedLoadEnv {
  propertyId: string;
  now: Date;
  timezone: string | null;
  businessDate: string;
  enabledSections: EnabledSections;
}

export type FeedLoader<K extends FeedId> = (env: FeedLoadEnv) => Promise<FeedResult<K>>;

const MS_PER_DAY = 86_400_000;

function ageDays(asOf: Date | null, now: Date): number | null {
  if (!asOf) return null;
  return Math.max(0, (now.getTime() - asOf.getTime()) / MS_PER_DAY);
}

/**
 * The hotel's own records — work orders, complaints, inspections, cleaning
 * times — aggregated over 30 days by the existing operational-signal layer.
 * Read live, so the data is true as of now; the 30-day window is part of each
 * signal's evidence, not part of its age.
 */
const loadOperationalSignals: FeedLoader<'operational_signals'> = async (env) => {
  const signals = await gatherOperationalSignals(env.propertyId);
  return {
    value: signals,
    recordCount: signals.length,
    asOf: env.now,
    weakestInputAgeDays: 0,
  };
};

/**
 * The nudge layer's operational alerts. It already refuses to speak when the
 * PMS feed is older than one report cycle (INV-34) and stamps each draft with
 * the capture time it reasoned from, so the age here is the DATA's age, not the
 * clock's.
 */
const loadNudgeDrafts: FeedLoader<'nudge_drafts'> = async (env) => {
  const drafts = await checkOperationalAlerts(env.propertyId);
  let asOf: Date | null = null;
  for (const draft of drafts) {
    const raw = (draft.payload as { asOf?: unknown }).asOf;
    if (typeof raw !== 'string') continue;
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) continue;
    // The weakest input is the OLDEST capture behind any draft.
    if (!asOf || at.getTime() < asOf.getTime()) asOf = at;
  }
  return {
    value: drafts,
    recordCount: drafts.length,
    asOf: asOf ?? env.now,
    weakestInputAgeDays: ageDays(asOf, env.now) ?? 0,
  };
};

/**
 * The cleaning rules engine, evaluated and NOT written. Respects the same
 * section gate the engine's own fleet runner applies, so a hotel with
 * housekeeping switched off is not quietly evaluated behind its back.
 */
const loadCleaningPlan: FeedLoader<'cleaning_plan'> = async (env) => {
  if (!isSectionEnabled(env.enabledSections, 'housekeeping')) {
    const empty: PropertyRunResult = {
      property_id: env.propertyId,
      business_date: env.businessDate,
      engine_run_id: '',
      rooms_evaluated: 0,
      tasks_upserted: 0,
      tasks_skipped_in_progress: 0,
      rooms_no_task: 0,
      errors: [],
      duration_ms: 0,
      outcomes: [],
      dry_run: true,
    };
    return { value: empty, recordCount: 0, asOf: env.now, weakestInputAgeDays: 0 };
  }
  const result = await runRulesEngineForProperty(env.propertyId, {
    now: env.now,
    dryRun: true,
    verbose: false,
  });
  return {
    value: result,
    recordCount: result.rooms_evaluated,
    asOf: env.now,
    weakestInputAgeDays: 0,
  };
};

// ─── Phase 2A: the hotel's own trailing record ───────────────────────────────
//
// Four feeds, all built the same way: read the hotel's own rows through
// `scopedDb` (which pre-applies the hotel filter, so there is no unfiltered
// builder to forget it on), convert every timestamp to a HOTEL-LOCAL calendar
// date and every dollar amount to cents ONCE, at this edge, and hand the
// detectors plain arrays they can reason about without a clock or a currency.
//
// ON `asOf` AND `weakestInputAgeDays`
// These read live and cover through the moment they run, so our KNOWLEDGE is
// current even when the newest row in it is nine days old. That nine-day
// silence is the finding, not a caveat on it — stamping the feed as stale would
// make the absence detector degrade exactly the claim it exists to make.
//
// ON THE OVERLAP
// `operating_rhythm` re-reads work-order and inventory-count timestamps that
// two other feeds also read. That is deliberate: folding the streams into the
// baseline feeds would mean the absence detector declares three feeds, and the
// runner skips a detector when ANY declared feed misses its minimum — so a
// hotel with no work orders would lose the inventory-count watch too. Four
// small indexed reads a night is the cheaper mistake.

/** 14 weeks: one current window, twelve baseline windows, and slack. */
const HISTORY_WINDOW_DAYS = 98;

/** Hard ceilings so one strange hotel cannot pull an unbounded result set. */
const MAX_ROWS = 20_000;

interface QueryResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/** Unwrap a PostgREST result or throw, so the runner records a feed failure. */
function rowsOf<T>(result: QueryResult<T>, what: string): T[] {
  if (result.error) throw new Error(`${what} read failed: ${result.error.message}`);
  return result.data ?? [];
}

/** The ISO instant `HISTORY_WINDOW_DAYS` before now. */
function windowStartIso(now: Date): string {
  return new Date(now.getTime() - HISTORY_WINDOW_DAYS * MS_PER_DAY).toISOString();
}

/** A timestamp column as the hotel's own calendar date, or null. */
function localDateOf(value: unknown, timezone: string | null): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return propertyLocalToday(at, timezone);
}

/** Numeric columns arrive as number or string depending on the driver. */
function numberOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'string' ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : null;
}

/**
 * What the hotel spent restocking, per day, from its own delivery log.
 * Correction rows are summed in with receipts — a correction is the ledger
 * retracting a mistyped delivery, so the net is the truth and dropping it would
 * leave a phantom spike that the baseline would then learn as normal.
 */
const loadSupplySpendHistory: FeedLoader<'supply_spend_history'> = async (env) => {
  const result = (await scopedDb(env.propertyId)
    .from('inventory_orders')
    .select('received_at, total_cost, unit_cost, quantity')
    .gte('received_at', windowStartIso(env.now))
    .order('received_at', { ascending: true })
    .limit(MAX_ROWS)) as unknown as QueryResult<Record<string, unknown>>;

  const points: DailySeriesPoint[] = [];
  for (const row of rowsOf(result, 'inventory_orders')) {
    const date = localDateOf(row.received_at, env.timezone);
    if (!date) continue;
    let cents = dollarsToCents(numberOf(row.total_cost));
    if (cents === null) {
      const unitCost = numberOf(row.unit_cost);
      const quantity = numberOf(row.quantity);
      cents = unitCost !== null && quantity !== null ? dollarsToCents(unitCost * quantity) : null;
    }
    if (cents === null) continue;
    points.push({ date, value: cents });
  }

  const days = collapseByDate(points);
  return {
    value: {
      days,
      coverageStartDate: earliestDate(days.map((d) => d.date)),
      windowDays: HISTORY_WINDOW_DAYS,
    },
    recordCount: days.length,
    asOf: env.now,
    weakestInputAgeDays: 0,
  };
};

/**
 * Work orders the hotel opened, per day, plus what it has actually paid to fix
 * things. The repair costs are the ONLY honest basis for "what is a work order
 * worth here" — when the hotel has never recorded one, the detector says
 * nothing about money rather than borrowing a number from somewhere else.
 */
const loadWorkOrderHistory: FeedLoader<'work_order_history'> = async (env) => {
  const result = (await scopedDb(env.propertyId)
    .from('work_orders')
    .select('created_at, repair_cost')
    .gte('created_at', windowStartIso(env.now))
    .order('created_at', { ascending: true })
    .limit(MAX_ROWS)) as unknown as QueryResult<Record<string, unknown>>;

  const points: DailySeriesPoint[] = [];
  const repairCostCentsSamples: number[] = [];
  for (const row of rowsOf(result, 'work_orders')) {
    const date = localDateOf(row.created_at, env.timezone);
    if (date) points.push({ date, value: 1 });
    const cents = dollarsToCents(numberOf(row.repair_cost));
    if (cents !== null && cents > 0) repairCostCentsSamples.push(cents);
  }

  const createdPerDay = collapseByDate(points);
  return {
    value: {
      createdPerDay,
      repairCostCentsSamples,
      coverageStartDate: earliestDate(createdPerDay.map((d) => d.date)),
      windowDays: HISTORY_WINDOW_DAYS,
    },
    recordCount: points.length,
    asOf: env.now,
    weakestInputAgeDays: 0,
  };
};

/**
 * Which places in the hotel keep producing work orders.
 *
 * READS `work_orders`, THE HOTEL'S OWN BOARD — not `pms_work_orders_v2`.
 * The operational-signal layer's maintenance aggregator reads the PMS mirror,
 * which is empty fleet-wide since the robot was decommissioned, so its
 * "repeated maintenance in room X" pattern has nothing to fire on. The board
 * staff actually type into is `work_orders`, and that is what this loads. Both
 * feeds exist and neither one changed; they answer the same question about
 * different sources, and only one of them currently has data.
 *
 * The location string is carried through VERBATIM (see LocationWorkOrders).
 * Grouping is exact-match on the stored text, so "Room 214" and "room 214" are
 * two places — deliberately. Normalising them would make Staxis write a ticket
 * onto a location spelled differently from the one the card named, and a
 * manager cannot audit a grouping they cannot see.
 */
const loadRoomWorkOrderHistory: FeedLoader<'room_work_order_history'> = async (env) => {
  const result = (await scopedDb(env.propertyId)
    .from('work_orders')
    .select('room_number, status, repair_cost, created_at')
    .gte('created_at', windowStartIso(env.now))
    .order('created_at', { ascending: true })
    .limit(MAX_ROWS)) as unknown as QueryResult<Record<string, unknown>>;

  const byLocation = new Map<string, LocationWorkOrders>();
  const repairCostCentsSamples: number[] = [];
  const allDates: string[] = [];
  let counted = 0;

  for (const row of rowsOf(result, 'work_orders')) {
    const cents = dollarsToCents(numberOf(row.repair_cost));
    if (cents !== null && cents > 0) repairCostCentsSamples.push(cents);

    const location = typeof row.room_number === 'string' ? row.room_number.trim() : '';
    const date = localDateOf(row.created_at, env.timezone);
    if (!location || !date) continue;
    allDates.push(date);
    counted += 1;

    const current = byLocation.get(location) ?? {
      location,
      total: 0,
      stillOpen: 0,
      lastDate: date,
    };
    current.total += 1;
    // 'submitted' / 'assigned' / 'in_progress' all read as open on the board
    // (db-mappers.ts STATUS_FROM_DB); only 'resolved' is done. An absent status
    // is an open ticket, matching the mapper's own fallback.
    if (String(row.status ?? 'submitted') !== 'resolved') current.stillOpen += 1;
    if (date > current.lastDate) current.lastDate = date;
    byLocation.set(location, current);
  }

  const locations = [...byLocation.values()].sort((a, b) =>
    a.location < b.location ? -1 : a.location > b.location ? 1 : 0,
  );

  return {
    value: {
      locations,
      repairCostCentsSamples,
      coverageStartDate: earliestDate(allDates),
      windowDays: HISTORY_WINDOW_DAYS,
    },
    recordCount: counted,
    asOf: env.now,
    weakestInputAgeDays: 0,
  };
};

interface CountRow {
  item_id: string;
  item_name: string | null;
  counted_stock: unknown;
  counted_at: string;
}

/**
 * How fast the hotel is actually going through each item, measured between its
 * own consecutive counts:
 *
 *   used = stock at the earlier count + delivered - discarded - stock at the later count
 *
 * Deliberately the same arithmetic as `inventory_observed_rate_v` (0086/0293),
 * including its two sanity gates: at least a day between counts, and never a
 * negative consumption. It is recomputed here rather than read from the view
 * because the detector needs the intervals themselves, not a per-count rate.
 */
const loadInventoryUsageHistory: FeedLoader<'inventory_usage_history'> = async (env) => {
  const db = scopedDb(env.propertyId);
  const sinceIso = windowStartIso(env.now);

  const [countsResult, ordersResult, discardsResult, itemsResult] = await Promise.all([
    db
      .from('inventory_counts')
      .select('item_id, item_name, counted_stock, counted_at')
      .gte('counted_at', sinceIso)
      .order('counted_at', { ascending: true })
      .limit(MAX_ROWS) as unknown as Promise<QueryResult<CountRow>>,
    db
      .from('inventory_orders')
      .select('item_id, quantity, unit_cost, received_at')
      .gte('received_at', sinceIso)
      .limit(MAX_ROWS) as unknown as Promise<QueryResult<Record<string, unknown>>>,
    db
      .from('inventory_discards')
      .select('item_id, quantity, discarded_at')
      .gte('discarded_at', sinceIso)
      .limit(MAX_ROWS) as unknown as Promise<QueryResult<Record<string, unknown>>>,
    // `reorder_at` and `reorder_lead_days` are the two numbers the reorder-point
    // action needs, and they are read HERE rather than at execution time so the
    // plan is frozen against the same picture the card was written from.
    db
      .from('inventory')
      .select('id, name, unit, reorder_at, reorder_lead_days')
      .limit(MAX_ROWS) as unknown as Promise<QueryResult<Record<string, unknown>>>,
  ]);

  const counts = rowsOf(countsResult, 'inventory_counts');
  const orders = rowsOf(ordersResult, 'inventory_orders');
  const discards = rowsOf(discardsResult, 'inventory_discards');
  const items = rowsOf(itemsResult, 'inventory');

  const unitById = new Map<string, string>();
  const nameById = new Map<string, string>();
  const reorderAtById = new Map<string, number>();
  const leadDaysById = new Map<string, number>();
  for (const item of items) {
    const id = typeof item.id === 'string' ? item.id : null;
    if (!id) continue;
    if (typeof item.unit === 'string') unitById.set(id, item.unit);
    if (typeof item.name === 'string') nameById.set(id, item.name);
    const reorderAt = numberOf(item.reorder_at);
    if (reorderAt !== null) reorderAtById.set(id, reorderAt);
    const leadDays = numberOf(item.reorder_lead_days);
    if (leadDays !== null) leadDaysById.set(id, leadDays);
  }

  /** Movements per item, as (instant, quantity) so a window sum is a filter. */
  const movements = (
    rows: Array<Record<string, unknown>>,
    timeColumn: string,
  ): Map<string, Array<{ at: number; quantity: number }>> => {
    const byItem = new Map<string, Array<{ at: number; quantity: number }>>();
    for (const row of rows) {
      const itemId = typeof row.item_id === 'string' ? row.item_id : null;
      const quantity = numberOf(row.quantity);
      const raw = row[timeColumn];
      if (!itemId || quantity === null || typeof raw !== 'string') continue;
      const at = new Date(raw).getTime();
      if (Number.isNaN(at)) continue;
      const list = byItem.get(itemId) ?? [];
      list.push({ at, quantity });
      byItem.set(itemId, list);
    }
    return byItem;
  };

  const ordersByItem = movements(orders, 'received_at');
  const discardsByItem = movements(discards, 'discarded_at');

  const unitCostByItem = new Map<string, number[]>();
  for (const row of orders) {
    const itemId = typeof row.item_id === 'string' ? row.item_id : null;
    const cents = dollarsToCents(numberOf(row.unit_cost));
    if (!itemId || cents === null || cents <= 0) continue;
    const list = unitCostByItem.get(itemId) ?? [];
    list.push(cents);
    unitCostByItem.set(itemId, list);
  }

  const countsByItem = new Map<string, CountRow[]>();
  for (const row of counts) {
    if (typeof row.item_id !== 'string') continue;
    const list = countsByItem.get(row.item_id) ?? [];
    list.push(row);
    countsByItem.set(row.item_id, list);
  }

  const sumBetween = (
    list: Array<{ at: number; quantity: number }> | undefined,
    afterExclusive: number,
    throughInclusive: number,
  ): number => {
    let total = 0;
    for (const m of list ?? []) {
      if (m.at > afterExclusive && m.at <= throughInclusive) total += m.quantity;
    }
    return total;
  };

  const usageItems: InventoryItemUsage[] = [];
  let intervalCount = 0;
  for (const [itemId, itemCounts] of countsByItem) {
    const ordered = [...itemCounts].sort((a, b) =>
      a.counted_at < b.counted_at ? -1 : a.counted_at > b.counted_at ? 1 : 0,
    );
    const intervals: UsageInterval[] = [];
    for (let i = 1; i < ordered.length; i += 1) {
      const older = ordered[i - 1];
      const newer = ordered[i];
      const olderAt = new Date(older.counted_at).getTime();
      const newerAt = new Date(newer.counted_at).getTime();
      const olderStock = numberOf(older.counted_stock);
      const newerStock = numberOf(newer.counted_stock);
      const endDate = localDateOf(newer.counted_at, env.timezone);
      if (olderStock === null || newerStock === null || !endDate) continue;

      const days = (newerAt - olderAt) / MS_PER_DAY;
      if (!(days >= 1)) continue;

      const unitsUsed =
        olderStock +
        sumBetween(ordersByItem.get(itemId), olderAt, newerAt) -
        sumBetween(discardsByItem.get(itemId), olderAt, newerAt) -
        newerStock;
      if (!(unitsUsed >= 0)) continue;

      intervals.push({ endDate, days, unitsUsed });
    }
    if (intervals.length === 0) continue;
    intervalCount += intervals.length;
    usageItems.push({
      itemId,
      itemName: nameById.get(itemId) ?? ordered[ordered.length - 1].item_name ?? 'this item',
      unit: unitById.get(itemId) ?? 'units',
      intervals,
      unitCostCentsSamples: unitCostByItem.get(itemId) ?? [],
      reorderAt: reorderAtById.get(itemId) ?? null,
      reorderLeadDays: leadDaysById.get(itemId) ?? null,
    });
  }

  usageItems.sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));

  const allEndDates = usageItems.flatMap((item) => item.intervals.map((i) => i.endDate));
  return {
    value: {
      items: usageItems,
      coverageStartDate: earliestDate(
        counts.map((c) => localDateOf(c.counted_at, env.timezone)).filter((d): d is string => !!d),
      ) ?? earliestDate(allEndDates),
      windowDays: HISTORY_WINDOW_DAYS,
    },
    recordCount: intervalCount,
    asOf: env.now,
    weakestInputAgeDays: 0,
  };
};

/**
 * The things this hotel does over and over, and the days it did them. No
 * expected cadence is configured anywhere — the detector learns each rhythm
 * from these dates alone, because a "linen should be counted every 3 days"
 * that nobody at the hotel chose is a number the hotel will rightly resent.
 */
const loadOperatingRhythm: FeedLoader<'operating_rhythm'> = async (env) => {
  const db = scopedDb(env.propertyId);
  const sinceIso = windowStartIso(env.now);
  const sinceDate = propertyLocalToday(
    new Date(env.now.getTime() - HISTORY_WINDOW_DAYS * MS_PER_DAY),
    env.timezone,
  );

  const [countsResult, logsResult, workOrdersResult] = await Promise.all([
    db
      .from('inventory_counts')
      .select('counted_at, variance_value')
      .gte('counted_at', sinceIso)
      .limit(MAX_ROWS) as unknown as Promise<QueryResult<Record<string, unknown>>>,
    db
      .from('daily_logs')
      .select('date')
      .gte('date', sinceDate)
      .limit(MAX_ROWS) as unknown as Promise<QueryResult<Record<string, unknown>>>,
    db
      .from('work_orders')
      .select('created_at')
      .gte('created_at', sinceIso)
      .limit(MAX_ROWS) as unknown as Promise<QueryResult<Record<string, unknown>>>,
  ]);

  const countRows = rowsOf(countsResult, 'inventory_counts');
  const countDates: string[] = [];
  const varianceCents: number[] = [];
  for (const row of countRows) {
    const date = localDateOf(row.counted_at, env.timezone);
    if (date) countDates.push(date);
    // What counting actually turns up here: stock the books could not account
    // for, in this hotel's own dollars. The sign does not matter — a count that
    // finds 40 units too FEW and one that finds 40 too many are both the ledger
    // being wrong by the same amount.
    const cents = dollarsToCents(numberOf(row.variance_value));
    if (cents !== null && Math.abs(cents) > 0) varianceCents.push(Math.abs(cents));
  }

  const logDates: string[] = [];
  for (const row of rowsOf(logsResult, 'daily_logs')) {
    if (typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(row.date)) {
      logDates.push(row.date.slice(0, 10));
    }
  }

  const workOrderDates: string[] = [];
  for (const row of rowsOf(workOrdersResult, 'work_orders')) {
    const date = localDateOf(row.created_at, env.timezone);
    if (date) workOrderDates.push(date);
  }

  const streams: ActivityStream[] = [
    {
      id: 'inventory_counts',
      label: 'counting inventory',
      dates: countDates,
      worthCentsSamples: varianceCents,
      worthBasis: 'stock the books could not account for',
    },
    {
      id: 'daily_log_closings',
      // Deliberately not "closing out the daily log": these rows are written by
      // the nightly seal job as often as by a person, and a card that blames
      // the front desk for a cron outage is a card nobody trusts twice. The
      // data is missing either way, and that is what the sentence says.
      label: 'recording the daily numbers',
      dates: logDates,
      worthCentsSamples: [],
      worthBasis: null,
    },
    {
      id: 'work_order_flow',
      label: 'logging maintenance',
      dates: workOrderDates,
      worthCentsSamples: [],
      worthBasis: null,
    },
  ];

  return {
    value: {
      streams,
      coverageStartDate: earliestDate(streams.flatMap((s) => s.dates)),
      windowDays: HISTORY_WINDOW_DAYS,
    },
    recordCount: streams.reduce((total, s) => total + new Set(s.dates).size, 0),
    asOf: env.now,
    weakestInputAgeDays: 0,
  };
};

/**
 * The upkeep schedules this hotel typed into Maintenance → Preventive.
 *
 * THE ONLY FEED THAT IS CONFIGURATION RATHER THAN HISTORY, and the reason the
 * preventive detector can speak on a hotel with three weeks of data when every
 * baseline detector has to stay quiet: nothing here is inferred. The cadence and
 * the last-done date are both things a human at this hotel asserted, so counting
 * forward off them invents nothing. There is no window and no coverage floor —
 * a schedule typed in yesterday is complete information about itself.
 *
 * SECTION-GATED, like the cleaning plan. A hotel with Maintenance switched off
 * has said it does not use this part of Staxis, and counting its upkeep
 * schedules forward behind its back would be the same overreach as evaluating
 * its housekeeping rules.
 *
 * `recordCount` is the number of schedules that can be reasoned about AT ALL —
 * a positive frequency and a usable id. A hotel with no schedules loads a real,
 * empty feed with `recordCount: 0`, and the detector's declared minimum then
 * skips it with a reason, which is what makes "nobody has set any up" a counted
 * silence instead of an indistinguishable blank.
 */
const loadPreventiveSchedule: FeedLoader<'preventive_schedule'> = async (env) => {
  if (!isSectionEnabled(env.enabledSections, 'maintenance')) {
    return {
      value: { tasks: [], asOfDate: env.businessDate },
      recordCount: 0,
      asOf: env.now,
      weakestInputAgeDays: 0,
    };
  }

  const result = (await scopedDb(env.propertyId)
    .from('preventive_tasks')
    .select('id, name, area, frequency_days, last_completed_at, called_at, called_by')
    .order('name', { ascending: true })
    .limit(MAX_ROWS)) as unknown as QueryResult<Record<string, unknown>>;

  const tasks: PreventiveScheduleEntry[] = [];
  for (const row of rowsOf(result, 'preventive_tasks')) {
    const id = typeof row.id === 'string' ? row.id : '';
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const frequencyDays = Math.round(numberOf(row.frequency_days) ?? 0);
    // A schedule with no id, no name or a non-positive cadence cannot produce a
    // due date that means anything. Dropped rather than guessed at.
    if (!id || !name || frequencyDays < 1) continue;

    const lastDoneDate = localDateOf(row.last_completed_at, env.timezone);
    const area = typeof row.area === 'string' && row.area.trim() ? row.area.trim() : null;
    const calledDate = localDateOf(row.called_at, env.timezone);

    tasks.push({
      id,
      name,
      area,
      frequencyDays,
      lastDoneDate,
      lastDoneAtIso: typeof row.last_completed_at === 'string' ? row.last_completed_at : null,
      // Null exactly when the hotel has never recorded a completion. The
      // detector, not this loader, decides what that silence means.
      nextDueDate: lastDoneDate ? addDaysInTz(lastDoneDate, frequencyDays) : null,
      calledDate,
      calledBy:
        calledDate && typeof row.called_by === 'string' && row.called_by.trim()
          ? row.called_by.trim()
          : null,
    });
  }

  return {
    value: { tasks, asOfDate: env.businessDate },
    recordCount: tasks.length,
    // A schedule is true as of now: it is what the hotel currently says its
    // rhythms are, not a measurement taken at some earlier moment.
    asOf: env.now,
    weakestInputAgeDays: 0,
  };
};

export const FEED_LOADERS: { [K in FeedId]: FeedLoader<K> } = {
  operational_signals: loadOperationalSignals,
  nudge_drafts: loadNudgeDrafts,
  cleaning_plan: loadCleaningPlan,
  supply_spend_history: loadSupplySpendHistory,
  work_order_history: loadWorkOrderHistory,
  room_work_order_history: loadRoomWorkOrderHistory,
  inventory_usage_history: loadInventoryUsageHistory,
  operating_rhythm: loadOperatingRhythm,
  preventive_schedule: loadPreventiveSchedule,
};

/**
 * Load the requested feeds for one hotel. Failure-isolated: a feed that throws
 * becomes a recorded failure, and only the detectors that DECLARED it are
 * skipped. One broken source must not silence the whole night.
 */
export async function loadFeeds(
  feeds: readonly FeedId[],
  env: FeedLoadEnv,
): Promise<Partial<Record<FeedId, FeedOutcome>>> {
  const out: Partial<Record<FeedId, FeedOutcome>> = {};
  await Promise.all(
    feeds.map(async (feed) => {
      try {
        out[feed] = (await FEED_LOADERS[feed](env)) as FeedOutcome;
      } catch (e) {
        out[feed] = { error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  return out;
}

/** The per-hotel facts every loader needs. One read, not four. */
export async function resolveLoadEnv(propertyId: string, now: Date): Promise<FeedLoadEnv> {
  const { data } = await supabaseAdmin
    .from('properties')
    .select('timezone, enabled_sections')
    .eq('id', propertyId)
    .maybeSingle();
  const timezone = (data?.timezone as string | null) ?? null;
  return {
    propertyId,
    now,
    timezone,
    businessDate: propertyLocalToday(now, timezone),
    enabledSections: (data?.enabled_sections as EnabledSections) ?? null,
  };
}
