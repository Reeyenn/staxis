// ═══════════════════════════════════════════════════════════════════════════
// Inventory Accounting Aggregate
//
// Monthly inventory accounting aggregate.
//
// For each (property, month, category) we compute:
//
//   purchases_logged = sum(inventory_orders.total_cost in the month)
//   actual_usage     = beginning + confirmed purchases - ending
//   discards_value   = sum(inventory_discards.cost_value where discarded_at in month)
//   shelf_value_now  = sum(current_stock × current unit_cost), separate from
//                      the immutable monthly beginning/ending snapshots
//   budget_remaining = budget - actual usage, but only for a full closed month
//
// Purchases are never silently substituted for usage. Missing/open closes
// return null actuals, partial first periods never compare to full budgets,
// and a manual-total close never fabricates category allocation.
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryCategory } from '@/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logErr } from './_common';
import { fetchAllRows } from '../supabase-paginate';
import { listInventoryMonthCloseHistory } from './inventory-month-closes';
import { summarizeEffectivePurchasesForProperty } from './inventory-effective-purchases';
import type { InventoryMonthCloseHistoryRow } from '../inventory-month-close';

export type InventoryActualStatus = 'pending' | 'complete' | 'partial' | 'unallocated';
export type InventoryActualAllocation = 'pending' | 'itemized' | 'total_only';

export interface InventoryProblemItem {
  itemId: string;
  itemName: string;
  /** Exact discard loss, or null when at least one discard lacks usable cost. */
  discardValue: number | null;
  /** Costed discard subtotal. When incomplete, this is a known minimum. */
  knownDiscardValue: number;
  discardsComplete: boolean;
  discardQty: number;
  /** Exact unexplained shrinkage, or null when a loss lacks usable cost. */
  unaccountedValue: number | null;
  /** Costed shrinkage subtotal. When incomplete, this is a known minimum. */
  knownUnaccountedValue: number;
  shrinkageComplete: boolean;
  /** Exact combined loss; null whenever either component is incomplete. */
  combinedValue: number | null;
  /** Sum of the two known subtotals; a known minimum when combinedValue is null. */
  knownCombinedValue: number;
  costComplete: boolean;
  /** Overall loss rank. Null when any candidate has incomplete cost evidence. */
  rank: number | null;
}

// The aggregator is server-side only (called from /api/inventory/accounting-summary
// after a session check). The caller passes a SupabaseClient — typically the
// service-role client so RLS doesn't get in the way of the joins. Tests pass
// a stubbed client.

export interface CategoryAccountingRow {
  category: InventoryCategory;
  /** Category opening/ending are unavailable without an itemized snapshot. */
  openingValue: number | null;
  receiptsValue: number;
  /** Null means at least one discard cost is missing. */
  discardsValue: number | null;
  knownDiscardsValue: number;
  discardsComplete: boolean;
  closingValue: number | null;
  actualUsageValue: number | null;
  actualUsageCents: number | null;
  /** Null means at least one negative reconciliation lacks a usable cost. */
  unaccountedShrinkageValue: number | null;
  knownUnaccountedShrinkageValue: number;
  shrinkageComplete: boolean;
  reconciliationsThisMonth: number;
  budgetCents: number | null;
  /** Compatibility alias for actualUsageCents; never purchase cents. */
  spendCents: number | null;
  remainingCents: number | null;
  vsPriorMonthDelta: number | null;
}

export interface AccountingSummary {
  monthStart: Date;
  monthEndExclusive: Date;
  totals: {
    openingValue: number | null;
    /** Logged delivery value. This is a purchase flow, not usage. */
    receiptsValue: number;
    /** Null when any logged delivery in the tracked period is missing cost. */
    loggedPurchasesValue: number | null;
    /** Explicitly incomplete subtotal when loggedPurchasesValue is null. */
    knownLoggedPurchasesValue: number;
    /** Confirmed purchases used by the close formula; null until confirmed. */
    purchasesValue: number | null;
    discardsValue: number | null;
    knownDiscardsValue: number;
    discardsComplete: boolean;
    closingValue: number | null;
    /** Live shelf value is intentionally separate from ending snapshot value. */
    liveInventoryValue: number;
    actualUsageValue: number | null;
    actualStatus: InventoryActualStatus;
    allocation: InventoryActualAllocation;
    /** True when exclusive custom budget-section keys are present. */
    hasCustomBudgetAllocation: boolean;
    isPartial: boolean;
    budgetComparisonAvailable: boolean;
    unaccountedShrinkageValue: number | null;
    knownUnaccountedShrinkageValue: number;
    shrinkageComplete: boolean;
    budgetCents: number | null;
    /** Compatibility alias for actual usage in cents. */
    spendCents: number | null;
    remainingCents: number | null;
  };
  byCategory: CategoryAccountingRow[];
  ytd: Array<{
    monthStart: string;             // YYYY-MM-01
    receiptsValue: number;
    purchasesValue: number | null;
    actualUsageValue: number | null;
    actualStatus: InventoryActualStatus;
    allocation: InventoryActualAllocation;
    isPartial: boolean;
    discardsValue: number | null;
    knownDiscardsValue: number;
    discardsComplete: boolean;
    byCategory: Record<InventoryCategory, number> | null; // actual usage $ when itemized
  }>;
  /**
   * Top problem items this month. Fully costed sets are ranked by exact combined
   * loss. If any item is uncosted, incomplete items are surfaced first for
   * remediation and no row claims an overall numeric rank.
   */
  topProblemItems: InventoryProblemItem[];
  problemItemRankingComplete: boolean;
  uncostedProblemItemCount: number;
  /** Cost-per-occupied-room: closed full-month actual usage / occupied room-nights. */
  costPerOccupiedRoom: {
    thisMonth: number | null;
    lastMonth: number | null;
    occupiedNightsThisMonth: number;
    occupiedNightsLastMonth: number;
  };
}

interface InventoryItemRow {
  id: string;
  category: InventoryCategory;
  current_stock: number | null;
  unit_cost: number | null;
}

function closeActualStatus(close: InventoryMonthCloseHistoryRow | null | undefined): InventoryActualStatus {
  if (!close || close.status !== 'closed' || close.actualUsageCents == null) return 'pending';
  if (close.isPartial) return 'partial';
  if (close.allocationMode === 'total_only') return 'unallocated';
  return 'complete';
}

/** Offset (ms) of an IANA time zone at a given UTC instant. */
function zoneOffsetMs(timeZone: string, utc: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(utc)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - utc.getTime();
}

/**
 * The UTC instants that bound a CALENDAR MONTH in an IANA time zone, plus the
 * YYYY-MM-01 key the `inventory_budgets.month_start` date column uses. The
 * Budgets overlay and every other inventory surface work in the viewer's
 * local month (see _components/month.ts); the accounting window must match or
 * an order received on the evening of the 31st lands in different months on
 * the two screens.
 */
/** The UTC instant of local midnight on a given calendar date in `timeZone`.
 *  Guess local-midnight = UTC, then correct by the zone offset; the second
 *  pass handles the rare DST transition sitting between guess and answer.
 *  The single DST-correction implementation — localMonthWindowUTC and the
 *  Compare overlay's arbitrary date ranges both build on it. */
export function localDayStartUTC(
  year: number,
  month1: number, // 1-12
  day: number,
  timeZone: string,
): Date {
  let t = Date.UTC(year, month1 - 1, day);
  for (let i = 0; i < 2; i++) t = Date.UTC(year, month1 - 1, day) - zoneOffsetMs(timeZone, new Date(t));
  return new Date(t);
}

export function localMonthWindowUTC(
  year: number,
  month1: number, // 1-12
  timeZone: string,
): { start: Date; endExclusive: Date; budgetMonthKey: string } {
  // One DST-correction implementation for the whole file — a month window is
  // just the day-1 boundary of this month and the next.
  const midnightUTC = (y: number, m1: number): Date => localDayStartUTC(y, m1, 1, timeZone);
  const nextY = month1 === 12 ? year + 1 : year;
  const nextM = month1 === 12 ? 1 : month1 + 1;
  return {
    start: midnightUTC(year, month1),
    endExclusive: midnightUTC(nextY, nextM),
    budgetMonthKey: `${year}-${String(month1).padStart(2, '0')}-01`,
  };
}

function monthKeyForInstant(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(instant);
  const year = parts.find((part) => part.type === 'year')?.value ?? String(instant.getUTCFullYear());
  const month = parts.find((part) => part.type === 'month')?.value ?? String(instant.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

/**
 * Compute the accounting summary for a property × month. The page calls this
 * via /api/inventory/accounting-summary so the aggregation runs server-side
 * with service-role auth — keeps the math out of the browser and out of RLS.
 *
 * `window` (from localMonthWindowUTC) anchors the month to the caller's time
 * zone; without it the month is bounded in UTC (legacy behavior).
 */
export async function getInventoryAccountingSummary(
  client: SupabaseClient,
  pid: string,
  monthStart: Date,
  window?: { endExclusive: Date; budgetMonthKey: string; timeZone?: string },
): Promise<AccountingSummary> {
  const monthEndExclusive = window?.endExclusive ?? new Date(Date.UTC(
    monthStart.getUTCFullYear(),
    monthStart.getUTCMonth() + 1,
    1,
  ));
  const monthStartISODate = window?.budgetMonthKey ?? monthStart.toISOString().slice(0, 10);
  const monthKey = monthStartISODate.slice(0, 7);

  // Closed accounting facts come from immutable month-close headers. Keep a
  // wider history here because this aggregate also powers past-month reports.
  const closeHistory = await listInventoryMonthCloseHistory(client, pid, 120);
  const close = closeHistory.find((row: InventoryMonthCloseHistoryRow) => row.month === monthKey) ?? null;

  // 1. Pull all inventory items for the property — we need current stock and
  //    unit cost to compute closing value.
  const { data: itemsRaw, error: itemsErr } = await client
    .from('inventory')
    .select('id, category, current_stock, unit_cost')
    .eq('property_id', pid)
    .is('archived_at', null);
  if (itemsErr) { logErr('accounting/items', itemsErr); throw itemsErr; }
  const items = (itemsRaw ?? []) as InventoryItemRow[];

  // 2-4. Receipts / discards / reconciliations in window. Paged — a busy
  // month exceeds PostgREST's 1000-row response cap (40 items × daily counts
  // ≈ 1,200 reconciliation rows), which would silently understate the money
  // totals (see supabase-paginate.ts).
  const paged = async <T,>(
    label: string,
    makePage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  ): Promise<T[]> => {
    try {
      return await fetchAllRows(makePage);
    } catch (e) {
      logErr(label, e);
      throw e;
    }
  };

  const ordersRaw = await paged('accounting/orders', (a, b) => client
    .from('inventory_orders')
    .select('id,total_cost,quantity,unit_cost,received_at,item_id,entry_kind,corrects_order_id,correction_event_id,inventory!inner(category)')
    .eq('property_id', pid)
    .gte('received_at', monthStart.toISOString())
    .lt('received_at', monthEndExclusive.toISOString())
    .order('received_at', { ascending: true })
    .range(a, b));

  // Once a logged-delivery month is closed, its purchase dimensions are
  // immutable evidence too. Reading the live inventory join for an old month
  // would let a later category edit move that historical purchase between
  // Housekeeping, Maintenance, and Breakfast. Totals would still add up, but
  // category reports would silently rewrite history.
  const closedPurchaseRows = close?.status === 'closed' && close.purchaseSource === 'logged_deliveries'
    ? await paged<{ category: InventoryCategory; value_cents: number | string }>(
        'accounting/closed-purchases',
        (a, b) => client
          .from('inventory_month_close_purchases')
          .select('category,value_cents')
          .eq('property_id', pid)
          .eq('close_id', close.closeId)
          .order('source_order_id', { ascending: true })
          .range(a, b),
      )
    : null;

  // Use the frozen close dimensions for historical loss attribution. A later
  // catalog category edit must not move a prior month's discard/shrinkage.
  const closedDimensionRows = close?.status === 'closed' && close.endingSnapshotId
    ? await paged<{ item_id: string; category: InventoryCategory }>(
        'accounting/closed-dimensions',
        (a, b) => client
          .from('inventory_month_close_snapshot_items')
          .select('item_id,category')
          .eq('snapshot_id', close.endingSnapshotId!)
          .order('item_id', { ascending: true })
          .range(a, b),
      )
    : null;
  const closedCategoryByItem = closedDimensionRows == null
    ? null
    : new Map(closedDimensionRows.map((row) => [row.item_id, row.category]));

  const discardsRaw = await paged('accounting/discards', (a, b) => client
    .from('inventory_discards')
    .select('cost_value, quantity, unit_cost, discarded_at, item_id, inventory!inner(category)')
    .eq('property_id', pid)
    .gte('discarded_at', monthStart.toISOString())
    .lt('discarded_at', monthEndExclusive.toISOString())
    .order('discarded_at', { ascending: true })
    .range(a, b));

  const recRaw = await paged('accounting/recs', (a, b) => client
    .from('inventory_reconciliations')
    .select('unaccounted_variance_value, unaccounted_variance, unit_cost, reconciled_at, item_id, inventory!inner(category)')
    .eq('property_id', pid)
    .gte('reconciled_at', monthStart.toISOString())
    .lt('reconciled_at', monthEndExclusive.toISOString())
    .order('reconciled_at', { ascending: true })
    .range(a, b));

  // 5. Live USAGE budgets for the month. Legacy rows are purchase caps and
  // must never be compared with closed usage. The date-column key comes from
  // the window (the
  // local first-of-month), not from slicing the instant — in UTC+ zones the
  // local month starts on the previous UTC calendar day.
  const { data: budgetsRaw, error: budgetErr } = await client
    .from('inventory_budgets')
    .select('category, budget_cents, basis')
    .eq('property_id', pid)
    .eq('month_start', monthStartISODate)
    .eq('basis', 'usage');
  if (budgetErr) { logErr('accounting/budgets', budgetErr); throw budgetErr; }

  // 5b. The hotel's budget mode decides which rows count (0306). Switching
  // modes deliberately preserves the other mode's rows, so reading rows
  // without the mode would let a stale 'total' row override sections-mode
  // caps (or vice versa) forever.
  const { data: propRaw, error: propErr } = await client
    .from('properties')
    .select('inventory_budget_mode')
    .eq('id', pid)
    .maybeSingle();
  if (propErr) { logErr('accounting/mode', propErr); throw propErr; }
  const liveBudgetMode = (propRaw as { inventory_budget_mode?: string } | null)?.inventory_budget_mode === 'total'
    ? 'total'
    : 'sections';

  // Budget keys are open-ended since 0306: the three categories feed the
  // per-category rows; 'total' is the whole-inventory cap; 'section:<uuid>'
  // are custom sections. A 0-cent row means "no cap" everywhere in the app —
  // map it to null here too so an untouched month never reports "over budget
  // by $spend". Per-category rows only apply in sections mode.
  const liveBudgetByKey: Record<string, number> = {};
  const catKeys: readonly string[] = ['housekeeping', 'maintenance', 'breakfast'];
  for (const b of budgetsRaw ?? []) {
    const key = String(b.category ?? '');
    const cents = Number(b.budget_cents ?? 0);
    if (cents <= 0) continue; // $0 = no cap, not a real budget
    liveBudgetByKey[key] = cents;
  }

  // A closed period owns its budget evidence. Later edits to property mode,
  // caps, or custom sections must not rewrite historical variance. Open and
  // not-yet-started periods continue to show the editable usage plan.
  const hasBudgetSnapshot = close?.status === 'closed' && close.usageBudgetMode != null;
  const budgetMode = hasBudgetSnapshot ? (close?.usageBudgetMode ?? liveBudgetMode) : liveBudgetMode;
  const budgetByKey = hasBudgetSnapshot
    ? (close?.usageBudgetByKey ?? {})
    : liveBudgetByKey;
  const liveBudgetTotalCents = budgetMode === 'total'
    ? (budgetByKey.total ?? null)
    : Object.entries(budgetByKey)
        .filter(([key]) => key !== 'total')
        .reduce<number | null>((total, [, cents]) => (total ?? 0) + cents, null);
  const monthBudgetCents = hasBudgetSnapshot
    ? (close?.usageBudgetTotalCents ?? null)
    : liveBudgetTotalCents;

  // 6. Aggregate by category.
  const empty = (): CategoryAccountingRow => ({
    category: 'housekeeping' as InventoryCategory,
    openingValue: null, receiptsValue: 0, discardsValue: 0,
    knownDiscardsValue: 0, discardsComplete: true, closingValue: null,
    actualUsageValue: null, actualUsageCents: null,
    unaccountedShrinkageValue: 0, knownUnaccountedShrinkageValue: 0,
    shrinkageComplete: true, reconciliationsThisMonth: 0,
    budgetCents: null, spendCents: null, remainingCents: null,
    vsPriorMonthDelta: null,
  });
  const cats: InventoryCategory[] = ['housekeeping', 'maintenance', 'breakfast'];
  const rows: Record<InventoryCategory, CategoryAccountingRow> = {
    housekeeping: { ...empty(), category: 'housekeeping' },
    maintenance: { ...empty(), category: 'maintenance' },
    breakfast: { ...empty(), category: 'breakfast' },
  };

  // Live shelf value is useful on today's inventory card, but it is NEVER a
  // historical ending value and never enters budget actuals.
  let liveInventoryValue = 0;
  for (const it of items) {
    if (it.unit_cost == null || it.current_stock == null) continue;
    liveInventoryValue += Number(it.current_stock) * Number(it.unit_cost);
  }

  // Receipts.
  // Audit M5: include `received_at` in the row type so the YTD loop below
  // doesn't have to double-cast `(o as unknown as { received_at: string })`.
  type OrderRow = {
    id: string;
    item_id: string;
    total_cost: number | null;
    quantity: number | null;
    unit_cost: number | null;
    entry_kind?: 'receipt' | 'correction' | string | null;
    corrects_order_id?: string | null;
    correction_event_id?: string | null;
    inventory: { category: InventoryCategory } | Array<{ category: InventoryCategory }> | null;
    received_at?: string | null;
  };
  let hasUncostedOrder = false;
  if (closedPurchaseRows != null) {
    for (const purchase of closedPurchaseRows) {
      if (!cats.includes(purchase.category)) continue;
      rows[purchase.category].receiptsValue += Number(purchase.value_cents) / 100;
    }
  } else {
    const sourceOrders = (ordersRaw ?? []) as OrderRow[];
    const purchaseSummary = await summarizeEffectivePurchasesForProperty(client, pid, sourceOrders);
    const categoryByItem = new Map<string, InventoryCategory>();
    for (const order of sourceOrders) {
      const category = Array.isArray(order.inventory) ? order.inventory[0]?.category : order.inventory?.category;
      if (category && cats.includes(category)) categoryByItem.set(order.item_id, category);
    }
    hasUncostedOrder = purchaseSummary.uncostedDeliveryCount > 0;
    for (const receipt of purchaseSummary.receipts) {
      if (receipt.voided || !receipt.itemId) continue;
      const category = categoryByItem.get(receipt.itemId);
      if (!category) {
        throw new Error(`Effective inventory receipt ${receipt.rootOrderId} has no category evidence.`);
      }
      rows[category].receiptsValue += (receipt.valueCents ?? 0) / 100;
    }
  }

  // Discards.
  type DiscardRow = {
    item_id: string;
    cost_value: number | null;
    quantity: number | null;
    unit_cost: number | null;
    inventory: { category: InventoryCategory } | Array<{ category: InventoryCategory }> | null;
  };
  for (const d of (discardsRaw ?? []) as DiscardRow[]) {
    const liveCat = Array.isArray(d.inventory) ? d.inventory[0]?.category : d.inventory?.category;
    const cat = closedCategoryByItem?.get(d.item_id) ?? liveCat;
    if (!cat || !cats.includes(cat)) continue;
    const value = d.cost_value != null
      ? Number(d.cost_value)
      : (d.unit_cost != null && d.quantity != null ? Number(d.unit_cost) * Number(d.quantity) : null);
    if (value == null) rows[cat].discardsComplete = false;
    else rows[cat].knownDiscardsValue += value;
  }

  // Reconciliations — unaccounted shrinkage in $-terms (only count negative
  // variance, since positive variance means surplus appeared, not loss).
  type RecRow = {
    item_id: string;
    unaccounted_variance_value: number | null;
    unaccounted_variance: number | null;
    unit_cost: number | null;
    inventory: { category: InventoryCategory } | Array<{ category: InventoryCategory }> | null;
  };
  for (const r of (recRaw ?? []) as RecRow[]) {
    const liveCat = Array.isArray(r.inventory) ? r.inventory[0]?.category : r.inventory?.category;
    const cat = closedCategoryByItem?.get(r.item_id) ?? liveCat;
    if (!cat || !cats.includes(cat)) continue;
    rows[cat].reconciliationsThisMonth += 1;
    const variance = r.unaccounted_variance == null ? null : Number(r.unaccounted_variance);
    const storedValue = r.unaccounted_variance_value == null ? null : Number(r.unaccounted_variance_value);
    const value = storedValue ?? (
      variance != null && variance < 0 && r.unit_cost != null
        ? variance * Number(r.unit_cost)
        : null
    );
    const isLoss = storedValue != null ? storedValue < 0 : variance != null && variance < 0;
    if (!isLoss) continue;
    if (value == null) rows[cat].shrinkageComplete = false;
    else rows[cat].knownUnaccountedShrinkageValue += Math.abs(value);
  }

  for (const cat of cats) {
    rows[cat].discardsValue = rows[cat].discardsComplete
      ? rows[cat].knownDiscardsValue
      : null;
    rows[cat].unaccountedShrinkageValue = rows[cat].shrinkageComplete
      ? rows[cat].knownUnaccountedShrinkageValue
      : null;
  }

  // Apply immutable close actuals. A manual-total close deliberately has no
  // category split, so all category actuals stay null instead of being
  // distributed by purchase share or current shelf value.
  const itemizedClose = close?.status === 'closed' && close.allocationMode === 'itemized' ? close : null;
  for (const cat of cats) {
    // Budget-key attribution is exclusive: an item assigned to a custom
    // section must not also count against its built-in category cap. Fall
    // back to category totals only for legacy snapshots where the entire
    // byBudgetKey map is absent — a missing category key in a modern map is
    // an intentional zero, not permission to double-attribute it.
    const actualCents = itemizedClose
      ? Number(itemizedClose.byBudgetKey != null
          ? itemizedClose.byBudgetKey[cat] ?? 0
          : itemizedClose.byCategory?.[cat] ?? 0)
      : null;
    rows[cat].actualUsageCents = actualCents;
    rows[cat].actualUsageValue = actualCents == null ? null : actualCents / 100;
    rows[cat].spendCents = actualCents;
    rows[cat].budgetCents = budgetMode === 'sections' ? budgetByKey[cat] ?? null : null;
    rows[cat].remainingCents = close?.budgetComparisonAvailable && actualCents != null && rows[cat].budgetCents != null
      ? rows[cat].budgetCents! - actualCents
      : null;
  }

  // 8. Twelve-month history. Orders remain a separate purchases series;
  // actual usage and category allocation come only from closed snapshots.
  // Paged: a year of delivery rows blows straight past the 1000-row cap.
  const [summaryYear, summaryMonth1] = monthKey.split('-').map(Number);
  const ytdAnchor = new Date(Date.UTC(summaryYear, summaryMonth1 - 12, 1));
  const ytdStart = window?.timeZone
    ? localDayStartUTC(ytdAnchor.getUTCFullYear(), ytdAnchor.getUTCMonth() + 1, 1, window.timeZone)
    : ytdAnchor;
  const ytdOrders = await paged('accounting/ytd-orders', (a, b) => client
    .from('inventory_orders')
    .select('id,total_cost,quantity,unit_cost,received_at,item_id,entry_kind,corrects_order_id,correction_event_id,inventory!inner(category)')
    .eq('property_id', pid)
    .gte('received_at', ytdStart.toISOString())
    .lt('received_at', monthEndExclusive.toISOString())
    .order('received_at', { ascending: true })
    .range(a, b));

  const ytdDiscards = await paged('accounting/ytd-discards', (a, b) => client
    .from('inventory_discards')
    .select('cost_value, quantity, unit_cost, discarded_at')
    .eq('property_id', pid)
    .gte('discarded_at', ytdStart.toISOString())
    .lt('discarded_at', monthEndExclusive.toISOString())
    .order('discarded_at', { ascending: true })
    .range(a, b));

  const ytdBuckets = new Map<string, {
    monthStart: string;
    receiptsValue: number;
    purchasesValue: number | null;
    actualUsageValue: number | null;
    actualStatus: InventoryActualStatus;
    allocation: InventoryActualAllocation;
    isPartial: boolean;
    discardsValue: number | null;
    knownDiscardsValue: number;
    discardsComplete: boolean;
    byCategory: Record<InventoryCategory, number> | null;
  }>();
  // Pre-fill all 12 months (so the chart has continuous bars even when zero).
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(ytdAnchor.getUTCFullYear(), ytdAnchor.getUTCMonth() + i, 1));
    const key = d.toISOString().slice(0, 10);
    ytdBuckets.set(key, {
      monthStart: key,
      receiptsValue: 0,
      purchasesValue: null,
      actualUsageValue: null,
      actualStatus: 'pending',
      allocation: 'pending',
      isPartial: false,
      discardsValue: 0,
      knownDiscardsValue: 0,
      discardsComplete: true,
      byCategory: null,
    });
  }
  const ytdPurchaseSummary = await summarizeEffectivePurchasesForProperty(
    client,
    pid,
    (ytdOrders ?? []) as OrderRow[],
  );
  for (const receipt of ytdPurchaseSummary.receipts) {
    if (!receipt.receivedAt) continue;  // skip rows without a usable receipt timestamp
    const at = new Date(receipt.receivedAt);
    const key = monthKeyForInstant(at, window?.timeZone ?? 'UTC');
    const bucket = ytdBuckets.get(key);
    if (!bucket) continue;
    bucket.receiptsValue += (receipt.valueCents ?? 0) / 100;
  }
  type YtdDiscardRow = {
    cost_value: number | null;
    quantity: number | null;
    unit_cost: number | null;
    discarded_at: string;
  };
  for (const d of (ytdDiscards ?? []) as YtdDiscardRow[]) {
    const at = new Date(d.discarded_at);
    const key = monthKeyForInstant(at, window?.timeZone ?? 'UTC');
    const bucket = ytdBuckets.get(key);
    if (!bucket) continue;
    const value = d.cost_value != null
      ? Number(d.cost_value)
      : d.unit_cost != null && d.quantity != null
        ? Number(d.unit_cost) * Number(d.quantity)
        : null;
    if (value == null) {
      bucket.discardsComplete = false;
      bucket.discardsValue = null;
    } else {
      bucket.knownDiscardsValue += value;
      if (bucket.discardsComplete) bucket.discardsValue = bucket.knownDiscardsValue;
    }
  }

  for (const historicalClose of closeHistory) {
    const bucket = ytdBuckets.get(`${historicalClose.month}-01`);
    if (!bucket || historicalClose.status !== 'closed') continue;
    bucket.purchasesValue = historicalClose.purchasesCents == null
      ? null
      : historicalClose.purchasesCents / 100;
    bucket.actualUsageValue = historicalClose.actualUsageCents == null
      ? null
      : historicalClose.actualUsageCents / 100;
    bucket.actualStatus = closeActualStatus(historicalClose);
    bucket.allocation = historicalClose.allocationMode ?? 'pending';
    bucket.isPartial = historicalClose.isPartial;
    bucket.byCategory = historicalClose.allocationMode === 'itemized' && historicalClose.byCategory
      ? {
          housekeeping: Number(historicalClose.byCategory.housekeeping ?? 0) / 100,
          maintenance: Number(historicalClose.byCategory.maintenance ?? 0) / 100,
          breakfast: Number(historicalClose.byCategory.breakfast ?? 0) / 100,
        }
      : null;
  }

  // 9. Totals. Beginning, confirmed purchases, ending, and usage all come
  // from the same immutable close header so the equation is auditable.
  const actualStatus = closeActualStatus(close);
  const closedClose = close?.status === 'closed' ? close : null;
  const actualUsageCents = closedClose?.actualUsageCents ?? null;
  const budgetComparisonAvailable = Boolean(
    closedClose?.budgetComparisonAvailable && actualUsageCents != null,
  );
  const totals = {
    openingValue: close?.beginningCents != null ? close.beginningCents / 100 : null,
    receiptsValue: cats.reduce((s, c) => s + rows[c].receiptsValue, 0),
    loggedPurchasesValue: close
      ? (close.loggedPurchaseCents == null ? null : close.loggedPurchaseCents / 100)
      : (hasUncostedOrder ? null : cats.reduce((s, c) => s + rows[c].receiptsValue, 0)),
    knownLoggedPurchasesValue: close
      ? close.knownLoggedPurchaseCents / 100
      : cats.reduce((s, c) => s + rows[c].receiptsValue, 0),
    purchasesValue: closedClose?.purchasesCents != null ? closedClose.purchasesCents / 100 : null,
    discardsValue: cats.every((cat) => rows[cat].discardsComplete)
      ? cats.reduce((sum, cat) => sum + rows[cat].knownDiscardsValue, 0)
      : null,
    knownDiscardsValue: cats.reduce((sum, cat) => sum + rows[cat].knownDiscardsValue, 0),
    discardsComplete: cats.every((cat) => rows[cat].discardsComplete),
    closingValue: closedClose?.endingCents != null ? closedClose.endingCents / 100 : null,
    liveInventoryValue,
    actualUsageValue: actualUsageCents == null ? null : actualUsageCents / 100,
    actualStatus,
    allocation: (closedClose?.allocationMode ?? 'pending') as InventoryActualAllocation,
    hasCustomBudgetAllocation:
      Object.keys(closedClose?.byBudgetKey ?? {}).some((key) => key.startsWith('section:')) ||
      Object.keys(budgetByKey).some((key) => key.startsWith('section:')),
    isPartial: Boolean(close?.isPartial),
    budgetComparisonAvailable,
    unaccountedShrinkageValue: cats.every((cat) => rows[cat].shrinkageComplete)
      ? cats.reduce((sum, cat) => sum + rows[cat].knownUnaccountedShrinkageValue, 0)
      : null,
    knownUnaccountedShrinkageValue: cats.reduce(
      (sum, cat) => sum + rows[cat].knownUnaccountedShrinkageValue,
      0,
    ),
    shrinkageComplete: cats.every((cat) => rows[cat].shrinkageComplete),
    // Mode-aware (0306): 'total' mode reads the whole-inventory row;
    // 'sections' mode sums the categories + custom sections. Null = no budget.
    budgetCents: monthBudgetCents,
    spendCents: actualUsageCents,
    remainingCents: null as number | null,
  };
  totals.remainingCents = budgetComparisonAvailable && totals.budgetCents != null && totals.spendCents != null
    ? totals.budgetCents - totals.spendCents
    : null;

  // 10. Top problem items this month — combine discards + unaccounted shrinkage by item.
  type DiscardItemRow = {
    item_id: string;
    cost_value: number | string | null;
    quantity: number | string | null;
    unit_cost: number | string | null;
    inventory: { name: string } | Array<{ name: string }> | null;
  };
  type RecItemRow = {
    item_id: string;
    unaccounted_variance_value: number | string | null;
    unaccounted_variance: number | string | null;
    unit_cost: number | string | null;
    inventory: { name: string } | Array<{ name: string }> | null;
  };
  // These rankings are part of the financial summary. Fail the whole request
  // when either dependency fails; an empty list would look like a real
  // "nothing lost" result and is not distinguishable from missing data.
  const discardsByItemRaw = await paged('accounting/problem-discards', (a, b) => client
    .from('inventory_discards')
    .select('item_id, cost_value, quantity, unit_cost, inventory!inner(name)')
    .eq('property_id', pid)
    .gte('discarded_at', monthStart.toISOString())
    .lt('discarded_at', monthEndExclusive.toISOString())
    .order('discarded_at', { ascending: true })
    .range(a, b));
  const recsByItemRaw = await paged('accounting/problem-recs', (a, b) => client
    .from('inventory_reconciliations')
    .select('item_id, unaccounted_variance_value, unaccounted_variance, unit_cost, inventory!inner(name)')
    .eq('property_id', pid)
    .gte('reconciled_at', monthStart.toISOString())
    .lt('reconciled_at', monthEndExclusive.toISOString())
    .order('reconciled_at', { ascending: true })
    .range(a, b));

  type MutableProblemItem = {
    itemId: string;
    itemName: string;
    knownDiscardValue: number;
    discardsComplete: boolean;
    discardQty: number;
    knownUnaccountedValue: number;
    shrinkageComplete: boolean;
  };
  const problemMap = new Map<string, MutableProblemItem>();
  const finiteNumber = (value: number | string | null): number | null => {
    if (value == null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const problemItem = (itemId: string, itemName: string): MutableProblemItem => {
    const existing = problemMap.get(itemId);
    if (existing) return existing;
    const created: MutableProblemItem = {
      itemId,
      itemName,
      knownDiscardValue: 0,
      discardsComplete: true,
      discardQty: 0,
      knownUnaccountedValue: 0,
      shrinkageComplete: true,
    };
    problemMap.set(itemId, created);
    return created;
  };
  for (const d of (discardsByItemRaw ?? []) as DiscardItemRow[]) {
    const name = Array.isArray(d.inventory) ? d.inventory[0]?.name : d.inventory?.name;
    if (!d.item_id || !name) continue;
    const quantity = finiteNumber(d.quantity);
    const storedValue = finiteNumber(d.cost_value);
    const unitCost = finiteNumber(d.unit_cost);
    const value = storedValue ?? (
      unitCost != null && quantity != null ? unitCost * quantity : null
    );
    const item = problemItem(d.item_id, name);
    if (value == null || value < 0) item.discardsComplete = false;
    else item.knownDiscardValue += value;
    if (quantity != null) item.discardQty += quantity;
  }
  for (const r of (recsByItemRaw ?? []) as RecItemRow[]) {
    const name = Array.isArray(r.inventory) ? r.inventory[0]?.name : r.inventory?.name;
    if (!r.item_id || !name) continue;
    const storedValue = finiteNumber(r.unaccounted_variance_value);
    const variance = finiteNumber(r.unaccounted_variance);
    const isLoss = storedValue != null ? storedValue < 0 : variance != null && variance < 0;
    if (!isLoss) continue; // only count unexplained loss, not surplus
    const unitCost = finiteNumber(r.unit_cost);
    const value = storedValue ?? (
      variance != null && unitCost != null ? variance * unitCost : null
    );
    const item = problemItem(r.item_id, name);
    if (value == null || value > 0) item.shrinkageComplete = false;
    else item.knownUnaccountedValue += Math.abs(value);
  }
  const problemItems = Array.from(problemMap.values()).map((item): InventoryProblemItem => {
    const costComplete = item.discardsComplete && item.shrinkageComplete;
    const knownCombinedValue = item.knownDiscardValue + item.knownUnaccountedValue;
    return {
      itemId: item.itemId,
      itemName: item.itemName,
      discardValue: item.discardsComplete ? item.knownDiscardValue : null,
      knownDiscardValue: item.knownDiscardValue,
      discardsComplete: item.discardsComplete,
      discardQty: item.discardQty,
      unaccountedValue: item.shrinkageComplete ? item.knownUnaccountedValue : null,
      knownUnaccountedValue: item.knownUnaccountedValue,
      shrinkageComplete: item.shrinkageComplete,
      combinedValue: costComplete ? knownCombinedValue : null,
      knownCombinedValue,
      costComplete,
      rank: null,
    };
  }).filter((item) => !item.costComplete || item.knownCombinedValue > 0);
  const incompleteProblemItems = problemItems
    .filter((item) => !item.costComplete)
    .sort((a, b) => b.knownCombinedValue - a.knownCombinedValue || a.itemName.localeCompare(b.itemName));
  const rankedProblemItems = problemItems
    .filter((item) => item.costComplete)
    .sort((a, b) => (b.combinedValue ?? 0) - (a.combinedValue ?? 0) || a.itemName.localeCompare(b.itemName));
  const problemItemRankingComplete = incompleteProblemItems.length === 0;
  const topProblemItems = (problemItemRankingComplete
    ? rankedProblemItems
    : [...incompleteProblemItems, ...rankedProblemItems]
  )
    .slice(0, 5)
    .map((item, index) => ({
      ...item,
      rank: problemItemRankingComplete ? index + 1 : null,
    }));
  const uncostedProblemItemCount = incompleteProblemItems.length;

  // 11. Cost-per-occupied-room — full closed actual usage ÷ occupied
  // room-nights. An open or partial month stays null because a partial usage
  // numerator must not be divided by a full-month occupancy denominator.
  const [currentYear, currentMonth1] = monthKey.split('-').map(Number);
  const lastMonthDate = new Date(Date.UTC(currentYear, currentMonth1 - 2, 1));
  const nextMonthDate = new Date(Date.UTC(currentYear, currentMonth1, 1));
  const lastMonthKey = `${lastMonthDate.getUTCFullYear()}-${String(lastMonthDate.getUTCMonth() + 1).padStart(2, '0')}`;
  const nextMonthKey = `${nextMonthDate.getUTCFullYear()}-${String(nextMonthDate.getUTCMonth() + 1).padStart(2, '0')}`;
  const startStr = `${lastMonthKey}-01`;
  const thisStartStr = `${monthKey}-01`;
  const endStr = `${nextMonthKey}-01`;

  const { data: occRows, error: occupancyError } = await client
    .from('daily_logs')
    .select('date, occupied')
    .eq('property_id', pid)
    .gte('date', startStr)
    .lt('date', endStr);
  if (occupancyError) {
    logErr('accounting/occupancy', occupancyError);
    throw occupancyError;
  }
  let nightsThis = 0;
  let nightsLast = 0;
  for (const r of (occRows ?? []) as Array<{ date: string; occupied: number | null }>) {
    const occ = Number(r.occupied ?? 0);
    if (r.date >= thisStartStr) nightsThis += occ;
    else nightsLast += occ;
  }

  const lastClose = closeHistory.find(
    (row: InventoryMonthCloseHistoryRow) => row.month === lastMonthKey && row.status === 'closed',
  ) ?? null;
  const thisActualForRoom = closedClose && !closedClose.isPartial && closedClose.actualUsageCents != null
    ? closedClose.actualUsageCents / 100
    : null;
  const lastActualForRoom = lastClose && !lastClose.isPartial && lastClose.actualUsageCents != null
    ? lastClose.actualUsageCents / 100
    : null;

  const costPerOccupiedRoom = {
    thisMonth: nightsThis > 0 && thisActualForRoom != null ? thisActualForRoom / nightsThis : null,
    lastMonth: nightsLast > 0 && lastActualForRoom != null ? lastActualForRoom / nightsLast : null,
    occupiedNightsThisMonth: nightsThis,
    occupiedNightsLastMonth: nightsLast,
  };

  return {
    monthStart,
    monthEndExclusive,
    totals,
    byCategory: cats.map(c => rows[c]),
    ytd: Array.from(ytdBuckets.values()).sort((a, b) => a.monthStart.localeCompare(b.monthStart)),
    topProblemItems,
    problemItemRankingComplete,
    uncostedProblemItemCount,
    costPerOccupiedRoom,
  };
}
