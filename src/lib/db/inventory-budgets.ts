// ═══════════════════════════════════════════════════════════════════════════
// Inventory Budgets — per-property × key × month × durable basis.
//
// The live purchase ledger stays separate. Only a completed full-month
// inventory usage actual may be compared with these caps: beginning inventory
// + confirmed purchases - ending inventory. Migration 0323 preserves legacy
// purchase caps alongside new usage caps instead of reinterpreting them.
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryBudget, InventoryBudgetSection, InventoryCategory } from '@/types';
import { supabase, logErr, asRecordRows } from './_common';
import { fetchAllRows } from '../supabase-paginate';
import { inventoryPurchaseRowValue } from '../inventory-purchase-cost';
import {
  toInventoryBudgetRow,
  fromInventoryBudgetRow,
  toInventoryBudgetSectionRow,
  fromInventoryBudgetSectionRow,
} from '../db-mappers';

function normaliseMonthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function monthStartToISODate(d: Date): string {
  return normaliseMonthStart(d).toISOString().slice(0, 10);
}

export async function listInventoryBudgets(
  _uid: string,
  pid: string,
  monthStart?: Date,
): Promise<InventoryBudget[]> {
  let query = supabase
    .from('inventory_budgets')
    .select('*')
    .eq('property_id', pid)
    .order('month_start', { ascending: false });
  if (monthStart) {
    query = query.eq('month_start', monthStartToISODate(monthStart));
  }
  const { data, error } = await query;
  if (error) { logErr('listInventoryBudgets', error); throw error; }
  return (data ?? []).map(fromInventoryBudgetRow);
}

export async function upsertInventoryBudget(
  _uid: string,
  pid: string,
  budget: Pick<InventoryBudget, 'category' | 'budgetCents'> & { propertyId?: string; monthStart: Date | null; notes?: string },
): Promise<void> {
  if (!budget.monthStart) throw new Error('monthStart is required');
  const monthStart = normaliseMonthStart(budget.monthStart);
  const row = {
    ...toInventoryBudgetRow({
      ...budget,
      propertyId: pid,
      basis: 'usage',
      monthStart,
    }),
    property_id: pid,
  };
  const { error } = await supabase
    .from('inventory_budgets')
    .upsert(row, { onConflict: 'property_id,category,month_start,basis' });
  if (error) { logErr('upsertInventoryBudget', error); throw error; }
}

// ─── Custom budget sections (0306) ─────────────────────────────────────────
// A hotel-defined section = name + the item ids whose orders count toward it.
// Usage-budget dollars for a section live in inventory_budgets keyed
// 'section:<id>' with basis='usage'.

export function sectionBudgetKey(sectionId: string): string {
  return `section:${sectionId}`;
}

export async function listInventoryBudgetSections(
  _uid: string,
  pid: string,
): Promise<InventoryBudgetSection[]> {
  const { data, error } = await supabase
    .from('inventory_budget_sections')
    .select('*')
    .eq('property_id', pid)
    .order('sort', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) { logErr('listInventoryBudgetSections', error); throw error; }
  return asRecordRows(data ?? []).map(fromInventoryBudgetSectionRow);
}

/** Insert (no id) or update (id set) a custom section. Returns its id. */
export async function upsertInventoryBudgetSection(
  _uid: string,
  pid: string,
  section: { id?: string; name: string; itemIds: string[]; sort?: number },
): Promise<string> {
  const row = {
    ...toInventoryBudgetSectionRow({ ...section, propertyId: pid }),
    property_id: pid,
  };
  const { data, error } = await supabase
    .from('inventory_budget_sections')
    .upsert(row, { onConflict: 'id' })
    .select('id')
    .single();
  if (error) { logErr('upsertInventoryBudgetSection', error); throw error; }
  return String((data as { id: string }).id);
}

/** Remove the live section mapping. Historical month budget rows deliberately
 * remain: a later configuration cleanup must not erase past budget evidence. */
export async function deleteInventoryBudgetSection(
  _uid: string,
  pid: string,
  sectionId: string,
): Promise<void> {
  const { error } = await supabase
    .from('inventory_budget_sections')
    .delete()
    .eq('property_id', pid)
    .eq('id', sectionId);
  if (error) { logErr('deleteInventoryBudgetSection', error); throw error; }
}

export interface MonthSpendDetail {
  /** Known purchase dollars per app category. Always has all three keys. */
  byCat: Record<InventoryCategory, number>;
  /** Known purchase dollars per inventory item id. */
  byItem: Record<string, number>;
  /** Known purchase subtotal across all received lines this month. */
  total: number;
  /** False when any received line has no usable cost/quantity. */
  complete: boolean;
}

/**
 * Sum month-to-date received purchases, broken down by inventory category and
 * item. This is a live ledger diagnostic, never the monthly usage actual.
 *
 * Returns dollars (numeric); byCat defaults to 0 for missing buckets.
 */
export async function monthToDateSpendDetail(
  _uid: string,
  pid: string,
  monthStart: Date,
  monthEndExclusive: Date,
): Promise<MonthSpendDetail> {
  // LEFT join on inventory: an order whose item was later deleted still cost
  // real money — it must count in `total` (matching the owner's cross-property
  // spend rollup) even though it can't be attributed to a category bucket.
  // Paged: a busy month can exceed PostgREST's 1000-row response cap, which
  // would silently understate the month's spend (see supabase-paginate.ts).
  let data: unknown[];
  try {
    data = await fetchAllRows(
      (from, to) => supabase
        .from('inventory_orders')
        .select('total_cost, quantity, unit_cost, item_id, inventory(category)')
        .eq('property_id', pid)
        .gte('received_at', monthStart.toISOString())
        .lt('received_at', monthEndExclusive.toISOString())
        .order('received_at', { ascending: true })
        .range(from, to),
    );
  } catch (error) {
    logErr('monthToDateSpendDetail', error);
    throw error;
  }

  const byCat: Record<InventoryCategory, number> = {
    housekeeping: 0,
    maintenance: 0,
    breakfast: 0,
  };
  const byItem: Record<string, number> = {};
  let total = 0;
  let complete = true;

  for (const r of (data ?? []) as Array<{
    total_cost: number | null;
    quantity: number | null;
    unit_cost: number | null;
    item_id: string | null;
    inventory: { category: InventoryCategory } | null | Array<{ category: InventoryCategory }>;
  }>) {
    // PostgREST can return the joined object or an array depending on the
    // selector — handle both shapes defensively.
    const cat = Array.isArray(r.inventory)
      ? r.inventory[0]?.category
      : r.inventory?.category;
    const value = inventoryPurchaseRowValue(r);
    if (value == null) complete = false;
    const totalCost = value ?? 0;
    total += totalCost;
    if (r.item_id) byItem[r.item_id] = (byItem[r.item_id] ?? 0) + totalCost;
    if (cat && cat in byCat) byCat[cat] += totalCost;
  }

  return { byCat, byItem, total, complete };
}

/** One month's spend detail, tagged with the (local) first-of-month it covers. */
export interface MonthlySpend extends MonthSpendDetail {
  monthStart: Date;
}

/**
 * Per-month received-purchase history across a window.
 * One `inventory_orders` query over [earliestMonthStart, endExclusive), bucketed
 * into calendar months by each order's `received_at` (read in LOCAL time, to match
 * the month windows the rest of the inventory UI uses). Same MonthSpendDetail
 * shape per month (byCat / byItem / total, in DOLLARS) so the panel can reuse its
 * spend logic. Months with no orders are simply absent (caller treats as $0).
 */
export async function monthlySpendHistory(
  _uid: string,
  pid: string,
  earliestMonthStart: Date,
  endExclusive: Date,
): Promise<MonthlySpend[]> {
  // Paged — six months of delivery rows can exceed the 1000-row response cap
  // (see supabase-paginate.ts).
  let data: unknown[];
  try {
    data = await fetchAllRows(
      (from, to) => supabase
        .from('inventory_orders')
        // LEFT join — deleted-item orders still count toward each month's total
        // (see monthToDateSpendDetail).
        .select('received_at, total_cost, quantity, unit_cost, item_id, inventory(category)')
        .eq('property_id', pid)
        .gte('received_at', earliestMonthStart.toISOString())
        .lt('received_at', endExclusive.toISOString())
        .order('received_at', { ascending: true })
        .range(from, to),
    );
  } catch (error) {
    logErr('monthlySpendHistory', error);
    throw error;
  }

  const buckets = new Map<string, MonthlySpend>();
  for (const r of (data ?? []) as Array<{
    received_at: string | null;
    total_cost: number | null;
    quantity: number | null;
    unit_cost: number | null;
    item_id: string | null;
    inventory: { category: InventoryCategory } | null | Array<{ category: InventoryCategory }>;
  }>) {
    if (!r.received_at) continue;
    const dt = new Date(r.received_at);
    const key = `${dt.getFullYear()}-${dt.getMonth()}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        monthStart: new Date(dt.getFullYear(), dt.getMonth(), 1),
        byCat: { housekeeping: 0, maintenance: 0, breakfast: 0 },
        byItem: {},
        total: 0,
        complete: true,
      };
      buckets.set(key, bucket);
    }
    const cat = Array.isArray(r.inventory) ? r.inventory[0]?.category : r.inventory?.category;
    const value = inventoryPurchaseRowValue(r);
    if (value == null) bucket.complete = false;
    const totalCost = value ?? 0;
    bucket.total += totalCost;
    if (r.item_id) bucket.byItem[r.item_id] = (bucket.byItem[r.item_id] ?? 0) + totalCost;
    if (cat && cat in bucket.byCat) bucket.byCat[cat] += totalCost;
  }
  return [...buckets.values()].sort((a, b) => a.monthStart.getTime() - b.monthStart.getTime());
}
