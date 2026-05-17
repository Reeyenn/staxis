// ═══════════════════════════════════════════════════════════════════════════
// Inventory Accounting Aggregate
//
// First slice of an in-app accounting module. Hotels do their accounting
// inside Staxis instead of exporting to outside tools (M3). This aggregate
// powers the new /inventory/accounting page.
//
// For each (property, month, category) we compute:
//
//   opening_value    = sum(closing_value of items at start of month)
//                      = sum(current_stock at month_start * unit_cost)
//                      ≈ closing_value of prior month
//   receipts_value   = sum(inventory_orders.total_cost where received_at in month)
//   discards_value   = sum(inventory_discards.cost_value where discarded_at in month)
//   consumption_estimate_value = (estimated consumption units × unit_cost)
//                      ≈ opening + receipts - closing - discards
//   closing_value    = sum(current_stock NOW * unit_cost)   for the current month
//                      OR derived from the next-month opening for past months
//   budget_total     = inventory_budgets.budget_cents for that month
//   budget_remaining = budget_total - receipts (cents)
//
// We deliberately keep the math defensive: any item without unit_cost
// contributes $0 (we don't fabricate values from null). This matches Tara's
// expectation that "items I never priced don't show up on the financial
// statement."
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryCategory } from '@/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logErr } from './_common';

// The aggregator is server-side only (called from /api/inventory/accounting-summary
// after a session check). The caller passes a SupabaseClient — typically the
// service-role client so RLS doesn't get in the way of the joins. Tests pass
// a stubbed client.

export interface CategoryAccountingRow {
  category: InventoryCategory;
  openingValue: number;
  receiptsValue: number;
  discardsValue: number;
  closingValue: number;
  unaccountedShrinkageValue: number;   // sum of inventory_reconciliations unaccounted_variance_value (negative ones)
  reconciliationsThisMonth: number;
  budgetCents: number | null;
  spendCents: number;                   // = receiptsValue × 100
  remainingCents: number | null;
  vsPriorMonthDelta: number;            // closingValue − priorMonthClosingValue
}

export interface AccountingSummary {
  monthStart: Date;
  monthEndExclusive: Date;
  totals: {
    openingValue: number;
    receiptsValue: number;
    discardsValue: number;
    closingValue: number;
    unaccountedShrinkageValue: number;
    budgetCents: number | null;
    spendCents: number;
    remainingCents: number | null;
  };
  byCategory: CategoryAccountingRow[];
  ytd: Array<{
    monthStart: string;             // YYYY-MM-01
    receiptsValue: number;
    discardsValue: number;
    byCategory: Record<InventoryCategory, number>; // receipts $ per category
  }>;
  /** Top problem items this month — sorted by combined loss ($ discards + $ unaccounted shrinkage). */
  topProblemItems: Array<{
    itemId: string;
    itemName: string;
    discardValue: number;
    discardQty: number;
    unaccountedValue: number;       // sum of negative reconciliation variance values
  }>;
  /** Cost-per-occupied-room: receipts $ / occupied room-nights. Null when no occupancy data. */
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

/**
 * Compute the accounting summary for a property × month. The page calls this
 * via /api/inventory/accounting-summary so the aggregation runs server-side
 * with service-role auth — keeps the math out of the browser and out of RLS.
 */
export async function getInventoryAccountingSummary(
  client: SupabaseClient,
  pid: string,
  monthStart: Date,
): Promise<AccountingSummary> {
  const monthEndExclusive = new Date(Date.UTC(
    monthStart.getUTCFullYear(),
    monthStart.getUTCMonth() + 1,
    1,
  ));

  // 1. Pull all inventory items for the property — we need current stock and
  //    unit cost to compute closing value.
  const { data: itemsRaw, error: itemsErr } = await client
    .from('inventory')
    .select('id, category, current_stock, unit_cost')
    .eq('property_id', pid);
  if (itemsErr) { logErr('accounting/items', itemsErr); throw itemsErr; }
  const items = (itemsRaw ?? []) as InventoryItemRow[];

  // 2. Receipts in window (per category).
  const { data: ordersRaw, error: ordersErr } = await client
    .from('inventory_orders')
    .select('total_cost, quantity, unit_cost, received_at, item_id, inventory!inner(category)')
    .eq('property_id', pid)
    .gte('received_at', monthStart.toISOString())
    .lt('received_at', monthEndExclusive.toISOString());
  if (ordersErr) { logErr('accounting/orders', ordersErr); throw ordersErr; }

  // 3. Discards in window (per category via item lookup).
  const { data: discardsRaw, error: discErr } = await client
    .from('inventory_discards')
    .select('cost_value, quantity, unit_cost, discarded_at, item_id, inventory!inner(category)')
    .eq('property_id', pid)
    .gte('discarded_at', monthStart.toISOString())
    .lt('discarded_at', monthEndExclusive.toISOString());
  if (discErr) { logErr('accounting/discards', discErr); throw discErr; }

  // 4. Reconciliations in window (unaccounted shrinkage $).
  const { data: recRaw, error: recErr } = await client
    .from('inventory_reconciliations')
    .select('unaccounted_variance_value, reconciled_at, item_id, inventory!inner(category)')
    .eq('property_id', pid)
    .gte('reconciled_at', monthStart.toISOString())
    .lt('reconciled_at', monthEndExclusive.toISOString());
  if (recErr) { logErr('accounting/recs', recErr); throw recErr; }

  // 5. Budgets for the month.
  const monthStartISODate = monthStart.toISOString().slice(0, 10);
  const { data: budgetsRaw, error: budgetErr } = await client
    .from('inventory_budgets')
    .select('category, budget_cents')
    .eq('property_id', pid)
    .eq('month_start', monthStartISODate);
  if (budgetErr) { logErr('accounting/budgets', budgetErr); throw budgetErr; }

  const budgetByCat: Partial<Record<InventoryCategory, number>> = {};
  for (const b of budgetsRaw ?? []) {
    budgetByCat[b.category as InventoryCategory] = Number(b.budget_cents ?? 0);
  }

  // 6. Aggregate by category.
  const empty = (): CategoryAccountingRow => ({
    category: 'housekeeping' as InventoryCategory,
    openingValue: 0, receiptsValue: 0, discardsValue: 0, closingValue: 0,
    unaccountedShrinkageValue: 0, reconciliationsThisMonth: 0,
    budgetCents: null, spendCents: 0, remainingCents: null,
    vsPriorMonthDelta: 0,
  });
  const cats: InventoryCategory[] = ['housekeeping', 'maintenance', 'breakfast'];
  const rows: Record<InventoryCategory, CategoryAccountingRow> = {
    housekeeping: { ...empty(), category: 'housekeeping' },
    maintenance: { ...empty(), category: 'maintenance' },
    breakfast: { ...empty(), category: 'breakfast' },
  };

  // Closing value = current stock × unit cost (rough — we don't have a
  // historical "stock as of date" column so for past months this approximates
  // to NOW). Still better than nothing for the v1 view.
  for (const it of items) {
    if (it.unit_cost == null || it.current_stock == null) continue;
    const cat = it.category;
    if (!cats.includes(cat)) continue;
    rows[cat].closingValue += Number(it.current_stock) * Number(it.unit_cost);
  }

  // Receipts.
  // Audit M5: include `received_at` in the row type so the YTD loop below
  // doesn't have to double-cast `(o as unknown as { received_at: string })`.
  type OrderRow = {
    total_cost: number | null;
    quantity: number | null;
    unit_cost: number | null;
    inventory: { category: InventoryCategory } | Array<{ category: InventoryCategory }> | null;
    received_at?: string | null;
  };
  for (const o of (ordersRaw ?? []) as OrderRow[]) {
    const cat = Array.isArray(o.inventory) ? o.inventory[0]?.category : o.inventory?.category;
    if (!cat || !cats.includes(cat)) continue;
    const total = o.total_cost != null
      ? Number(o.total_cost)
      : (o.unit_cost != null && o.quantity != null ? Number(o.unit_cost) * Number(o.quantity) : 0);
    rows[cat].receiptsValue += total;
  }

  // Discards.
  type DiscardRow = {
    cost_value: number | null;
    quantity: number | null;
    unit_cost: number | null;
    inventory: { category: InventoryCategory } | Array<{ category: InventoryCategory }> | null;
  };
  for (const d of (discardsRaw ?? []) as DiscardRow[]) {
    const cat = Array.isArray(d.inventory) ? d.inventory[0]?.category : d.inventory?.category;
    if (!cat || !cats.includes(cat)) continue;
    const v = d.cost_value != null
      ? Number(d.cost_value)
      : (d.unit_cost != null && d.quantity != null ? Number(d.unit_cost) * Number(d.quantity) : 0);
    rows[cat].discardsValue += v;
  }

  // Reconciliations — unaccounted shrinkage in $-terms (only count negative
  // variance, since positive variance means surplus appeared, not loss).
  type RecRow = {
    unaccounted_variance_value: number | null;
    inventory: { category: InventoryCategory } | Array<{ category: InventoryCategory }> | null;
  };
  for (const r of (recRaw ?? []) as RecRow[]) {
    const cat = Array.isArray(r.inventory) ? r.inventory[0]?.category : r.inventory?.category;
    if (!cat || !cats.includes(cat)) continue;
    rows[cat].reconciliationsThisMonth += 1;
    const v = Number(r.unaccounted_variance_value ?? 0);
    if (v < 0) rows[cat].unaccountedShrinkageValue += Math.abs(v);
  }

  // Apply budgets + spend.
  for (const cat of cats) {
    rows[cat].spendCents = Math.round(rows[cat].receiptsValue * 100);
    rows[cat].budgetCents = budgetByCat[cat] ?? null;
    rows[cat].remainingCents = rows[cat].budgetCents != null
      ? rows[cat].budgetCents! - rows[cat].spendCents
      : null;
  }

  // 7. Opening value ≈ closing value of prior month. We compute it as
  //    closing_value(now) − receipts(this month) + discards(this month) +
  //    consumption(this month). Since we don't have direct consumption, we
  //    approximate opening = closing - receipts + discards (treating
  //    consumption as 0 for the v1 — accountants can sanity-check).
  for (const cat of cats) {
    rows[cat].openingValue = Math.max(0,
      rows[cat].closingValue - rows[cat].receiptsValue + rows[cat].discardsValue,
    );
    // Prior-month delta is the change in closing value vs the running
    // approximation of last month's closing (= this month's opening).
    rows[cat].vsPriorMonthDelta = rows[cat].closingValue - rows[cat].openingValue;
  }

  // 8. YTD spend by month and category — last 12 months including current.
  const ytdStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() - 11, 1));
  const { data: ytdOrders, error: ytdErr } = await client
    .from('inventory_orders')
    .select('total_cost, quantity, unit_cost, received_at, inventory!inner(category)')
    .eq('property_id', pid)
    .gte('received_at', ytdStart.toISOString())
    .lt('received_at', monthEndExclusive.toISOString());
  if (ytdErr) { logErr('accounting/ytd-orders', ytdErr); throw ytdErr; }

  const { data: ytdDiscards, error: ytdDErr } = await client
    .from('inventory_discards')
    .select('cost_value, discarded_at')
    .eq('property_id', pid)
    .gte('discarded_at', ytdStart.toISOString())
    .lt('discarded_at', monthEndExclusive.toISOString());
  if (ytdDErr) { logErr('accounting/ytd-discards', ytdDErr); throw ytdDErr; }

  const ytdBuckets = new Map<string, {
    monthStart: string;
    receiptsValue: number;
    discardsValue: number;
    byCategory: Record<InventoryCategory, number>;
  }>();
  // Pre-fill all 12 months (so the chart has continuous bars even when zero).
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(ytdStart.getUTCFullYear(), ytdStart.getUTCMonth() + i, 1));
    const key = d.toISOString().slice(0, 10);
    ytdBuckets.set(key, {
      monthStart: key,
      receiptsValue: 0,
      discardsValue: 0,
      byCategory: { housekeeping: 0, maintenance: 0, breakfast: 0 },
    });
  }
  for (const o of (ytdOrders ?? []) as OrderRow[]) {
    const cat = Array.isArray(o.inventory) ? o.inventory[0]?.category : o.inventory?.category;
    if (!cat || !cats.includes(cat)) continue;
    if (!o.received_at) continue;  // skip rows without a usable receipt timestamp
    const at = new Date(o.received_at);
    const key = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const bucket = ytdBuckets.get(key);
    if (!bucket) continue;
    const total = o.total_cost != null
      ? Number(o.total_cost)
      : (o.unit_cost != null && o.quantity != null ? Number(o.unit_cost) * Number(o.quantity) : 0);
    bucket.receiptsValue += total;
    bucket.byCategory[cat] += total;
  }
  type YtdDiscardRow = { cost_value: number | null; discarded_at: string };
  for (const d of (ytdDiscards ?? []) as YtdDiscardRow[]) {
    const at = new Date(d.discarded_at);
    const key = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const bucket = ytdBuckets.get(key);
    if (!bucket) continue;
    bucket.discardsValue += Number(d.cost_value ?? 0);
  }

  // 9. Totals.
  const totals = {
    openingValue: cats.reduce((s, c) => s + rows[c].openingValue, 0),
    receiptsValue: cats.reduce((s, c) => s + rows[c].receiptsValue, 0),
    discardsValue: cats.reduce((s, c) => s + rows[c].discardsValue, 0),
    closingValue: cats.reduce((s, c) => s + rows[c].closingValue, 0),
    unaccountedShrinkageValue: cats.reduce((s, c) => s + rows[c].unaccountedShrinkageValue, 0),
    budgetCents: cats.reduce<number | null>((s, c) => {
      const b = rows[c].budgetCents;
      if (b == null) return s;
      return (s ?? 0) + b;
    }, null),
    spendCents: cats.reduce((s, c) => s + rows[c].spendCents, 0),
    remainingCents: null as number | null,
  };
  totals.remainingCents = totals.budgetCents != null ? totals.budgetCents - totals.spendCents : null;

  // 10. Top problem items this month — combine discards + unaccounted shrinkage by item.
  type DiscardItemRow = {
    item_id: string;
    cost_value: number | null;
    quantity: number | null;
    unit_cost: number | null;
    inventory: { name: string } | Array<{ name: string }> | null;
  };
  type RecItemRow = {
    item_id: string;
    unaccounted_variance_value: number | null;
    inventory: { name: string } | Array<{ name: string }> | null;
  };
  const { data: discardsByItemRaw } = await client
    .from('inventory_discards')
    .select('item_id, cost_value, quantity, unit_cost, inventory!inner(name)')
    .eq('property_id', pid)
    .gte('discarded_at', monthStart.toISOString())
    .lt('discarded_at', monthEndExclusive.toISOString());
  const { data: recsByItemRaw } = await client
    .from('inventory_reconciliations')
    .select('item_id, unaccounted_variance_value, inventory!inner(name)')
    .eq('property_id', pid)
    .gte('reconciled_at', monthStart.toISOString())
    .lt('reconciled_at', monthEndExclusive.toISOString());

  const problemMap = new Map<string, { itemId: string; itemName: string; discardValue: number; discardQty: number; unaccountedValue: number }>();
  for (const d of (discardsByItemRaw ?? []) as DiscardItemRow[]) {
    const name = Array.isArray(d.inventory) ? d.inventory[0]?.name : d.inventory?.name;
    if (!d.item_id || !name) continue;
    const v = d.cost_value != null
      ? Number(d.cost_value)
      : (d.unit_cost != null && d.quantity != null ? Number(d.unit_cost) * Number(d.quantity) : 0);
    const prev = problemMap.get(d.item_id) ?? { itemId: d.item_id, itemName: name, discardValue: 0, discardQty: 0, unaccountedValue: 0 };
    prev.discardValue += v;
    prev.discardQty += Number(d.quantity ?? 0);
    problemMap.set(d.item_id, prev);
  }
  for (const r of (recsByItemRaw ?? []) as RecItemRow[]) {
    const name = Array.isArray(r.inventory) ? r.inventory[0]?.name : r.inventory?.name;
    if (!r.item_id || !name) continue;
    const v = Number(r.unaccounted_variance_value ?? 0);
    if (v >= 0) continue; // only count unexplained loss, not surplus
    const prev = problemMap.get(r.item_id) ?? { itemId: r.item_id, itemName: name, discardValue: 0, discardQty: 0, unaccountedValue: 0 };
    prev.unaccountedValue += Math.abs(v);
    problemMap.set(r.item_id, prev);
  }
  const topProblemItems = Array.from(problemMap.values())
    .filter(p => (p.discardValue + p.unaccountedValue) > 0)
    .sort((a, b) => (b.discardValue + b.unaccountedValue) - (a.discardValue + a.unaccountedValue))
    .slice(0, 5);

  // 11. Cost-per-occupied-room — receipts ÷ occupied room-nights for this and last month.
  const lastMonthStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() - 1, 1));
  const startStr = lastMonthStart.toISOString().slice(0, 10);
  const thisStartStr = monthStart.toISOString().slice(0, 10);
  const endStr = monthEndExclusive.toISOString().slice(0, 10);

  const { data: occRows } = await client
    .from('daily_logs')
    .select('date, occupied')
    .eq('property_id', pid)
    .gte('date', startStr)
    .lt('date', endStr);
  let nightsThis = 0;
  let nightsLast = 0;
  for (const r of (occRows ?? []) as Array<{ date: string; occupied: number | null }>) {
    const occ = Number(r.occupied ?? 0);
    if (r.date >= thisStartStr) nightsThis += occ;
    else nightsLast += occ;
  }

  // Last-month receipts for the comparison ratio.
  const { data: lastReceiptsRaw } = await client
    .from('inventory_orders')
    .select('total_cost, quantity, unit_cost')
    .eq('property_id', pid)
    .gte('received_at', lastMonthStart.toISOString())
    .lt('received_at', monthStart.toISOString());
  let lastReceipts = 0;
  for (const o of (lastReceiptsRaw ?? []) as Array<{ total_cost: number | null; quantity: number | null; unit_cost: number | null }>) {
    lastReceipts += o.total_cost != null
      ? Number(o.total_cost)
      : (o.unit_cost != null && o.quantity != null ? Number(o.unit_cost) * Number(o.quantity) : 0);
  }

  const costPerOccupiedRoom = {
    thisMonth: nightsThis > 0 ? totals.receiptsValue / nightsThis : null,
    lastMonth: nightsLast > 0 ? lastReceipts / nightsLast : null,
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
    costPerOccupiedRoom,
  };
}
