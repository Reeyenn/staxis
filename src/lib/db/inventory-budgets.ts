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

import type { InventoryBudget, InventoryBudgetSection, InventoryCategory } from '@/types';
import { supabase, logErr, asRecordRows } from './_common';
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

// ─── Custom budget sections (0306) ─────────────────────────────────────────
// A hotel-defined section = name + the item ids whose orders count toward it.
// Budget dollars for a section live in inventory_budgets keyed 'section:<id>'.

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

/** Delete a custom section AND its budget rows (they'd orphan otherwise). */
export async function deleteInventoryBudgetSection(
  _uid: string,
  pid: string,
  sectionId: string,
): Promise<void> {
  const { error: budgetErr } = await supabase
    .from('inventory_budgets')
    .delete()
    .eq('property_id', pid)
    .eq('category', sectionBudgetKey(sectionId));
  if (budgetErr) { logErr('deleteInventoryBudgetSection/budgets', budgetErr); throw budgetErr; }
  const { error } = await supabase
    .from('inventory_budget_sections')
    .delete()
    .eq('property_id', pid)
    .eq('id', sectionId);
  if (error) { logErr('deleteInventoryBudgetSection', error); throw error; }
}

export interface MonthSpendDetail {
  /** Dollars spent per app category. Always has all three keys. */
  byCat: Record<InventoryCategory, number>;
  /** Dollars spent per inventory item id (for custom-section sums). */
  byItem: Record<string, number>;
  /** Dollars spent across ALL orders this month (incl. category-less rows). */
  total: number;
}

/**
 * Sum month-to-date inventory_orders spend, broken down by inventory category
 * AND by item (custom budget sections sum the items mapped to them). Used to
 * compute remaining budget for the Smart Reorder List, the month strip, and
 * the Accounting page. We join inventory_orders → inventory to read the
 * item's category at order time.
 *
 * Returns dollars (numeric); byCat defaults to 0 for missing buckets.
 */
export async function monthToDateSpendDetail(
  _uid: string,
  pid: string,
  monthStart: Date,
  monthEndExclusive: Date,
): Promise<MonthSpendDetail> {
  const { data, error } = await supabase
    .from('inventory_orders')
    .select('total_cost, quantity, unit_cost, item_id, inventory!inner(category)')
    .eq('property_id', pid)
    .gte('received_at', monthStart.toISOString())
    .lt('received_at', monthEndExclusive.toISOString());
  if (error) { logErr('monthToDateSpendDetail', error); throw error; }

  const byCat: Record<InventoryCategory, number> = {
    housekeeping: 0,
    maintenance: 0,
    breakfast: 0,
  };
  const byItem: Record<string, number> = {};
  let total = 0;

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
    const totalCost = r.total_cost != null
      ? Number(r.total_cost)
      : (r.unit_cost != null && r.quantity != null ? Number(r.unit_cost) * Number(r.quantity) : 0);
    total += totalCost;
    if (r.item_id) byItem[r.item_id] = (byItem[r.item_id] ?? 0) + totalCost;
    if (cat && cat in byCat) byCat[cat] += totalCost;
  }

  return { byCat, byItem, total };
}

/** Back-compat wrapper — category buckets only. */
export async function monthToDateSpendByCategory(
  uid: string,
  pid: string,
  monthStart: Date,
  monthEndExclusive: Date,
): Promise<Record<InventoryCategory, number>> {
  return (await monthToDateSpendDetail(uid, pid, monthStart, monthEndExclusive)).byCat;
}
