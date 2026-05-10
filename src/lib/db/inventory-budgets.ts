// ═══════════════════════════════════════════════════════════════════════════
// Inventory Budgets — per-property × per-category × per-month spend cap.
//
// Drives:
//   • Smart Reorder List headroom badge ("$500 left in linen this month")
//   • Accounting page "Budget vs Actual" block
//
// Tara at Home2 thinks about her inventory order budget per category per month
// (M3 cap on linen / supplies / breakfast). We mirror that model: one row per
// (property, category, monthStart). monthStart is always the first of the
// month so MTD aggregation is a clean equality match.
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryBudget, InventoryCategory } from '@/types';
import { supabase, logErr } from './_common';
import { toInventoryBudgetRow, fromInventoryBudgetRow } from '../db-mappers';

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
      monthStart,
    }),
    property_id: pid,
  };
  const { error } = await supabase
    .from('inventory_budgets')
    .upsert(row, { onConflict: 'property_id,category,month_start' });
  if (error) { logErr('upsertInventoryBudget', error); throw error; }
}

export async function deleteInventoryBudget(
  _uid: string,
  pid: string,
  category: InventoryCategory,
  monthStart: Date,
): Promise<void> {
  const { error } = await supabase
    .from('inventory_budgets')
    .delete()
    .eq('property_id', pid)
    .eq('category', category)
    .eq('month_start', monthStartToISODate(monthStart));
  if (error) { logErr('deleteInventoryBudget', error); throw error; }
}

/**
 * Sum month-to-date inventory_orders spend, broken down by inventory category.
 * Used to compute remaining budget for the Smart Reorder List and Accounting
 * page. We join inventory_orders → inventory to read the item's category at
 * order time. Works around the lack of a denormalized category column.
 *
 * Returns dollars (numeric). Category-keyed, defaults to 0 for missing buckets.
 */
export async function monthToDateSpendByCategory(
  _uid: string,
  pid: string,
  monthStart: Date,
  monthEndExclusive: Date,
): Promise<Record<InventoryCategory, number>> {
  const { data, error } = await supabase
    .from('inventory_orders')
    .select('total_cost, quantity, unit_cost, item_id, inventory!inner(category)')
    .eq('property_id', pid)
    .gte('received_at', monthStart.toISOString())
    .lt('received_at', monthEndExclusive.toISOString());
  if (error) { logErr('monthToDateSpendByCategory', error); throw error; }

  const totals: Record<InventoryCategory, number> = {
    housekeeping: 0,
    maintenance: 0,
    breakfast: 0,
  };

  for (const r of (data ?? []) as Array<{
    total_cost: number | null;
    quantity: number | null;
    unit_cost: number | null;
    inventory: { category: InventoryCategory } | null | Array<{ category: InventoryCategory }>;
  }>) {
    // PostgREST can return the joined object or an array depending on the
    // selector — handle both shapes defensively.
    const cat = Array.isArray(r.inventory)
      ? r.inventory[0]?.category
      : r.inventory?.category;
    if (!cat || !(cat in totals)) continue;
    const totalCost = r.total_cost != null
      ? Number(r.total_cost)
      : (r.unit_cost != null && r.quantity != null ? Number(r.unit_cost) * Number(r.quantity) : 0);
    totals[cat] += totalCost;
  }

  return totals;
}
