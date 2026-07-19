import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getInventoryAccountingSummary, localMonthWindowUTC } from '../db/inventory-accounting';

type Result = { data: unknown[] | Record<string, unknown> | null; error: null };

const closedManualTotal = {
  id: 'close-1',
  property_id: 'property-1',
  month_start: '2026-06-01',
  timezone: 'America/Chicago',
  status: 'closed',
  month_start_at: '2026-06-01T05:00:00.000Z',
  end_at: '2026-07-01T05:00:00.000Z',
  grace_end_at: '2026-07-04T05:00:00.000Z',
  count_window_start_at: '2026-06-24T05:00:00.000Z',
  activity_start_at: '2026-06-01T05:00:00.000Z',
  is_partial: false,
  budget_comparison_available: true,
  opening_snapshot_id: 'snapshot-open',
  ending_snapshot_id: 'snapshot-end',
  purchase_source: 'manual_total',
  allocation_mode: 'total_only',
  manual_purchase_cents: 5_000,
  known_logged_purchase_cents: 999,
  logged_purchase_cents: 999,
  confirmed_purchase_cents: 5_000,
  logged_delivery_count: 1,
  uncosted_delivery_count: 0,
  beginning_value_cents: 10_000,
  ending_value_cents: 7_000,
  actual_usage_cents: 8_000,
  by_category: null,
  by_item: null,
  by_budget_key: null,
  usage_budget_mode: 'total',
  usage_budget_total_cents: 10_000,
  usage_budget_by_key: { total: 10_000 },
  quality_flags: [],
  baseline_at: '2026-06-01T05:00:00.000Z',
  closed_at: '2026-07-01T06:00:00.000Z',
  closed_by_name: 'Manager',
  notes: null,
};

let activeClose: Record<string, unknown> = closedManualTotal;
let closedPurchaseRows: unknown[] = [];
let closedDimensionRows: unknown[] = [];
let discardRows: unknown[] = [];
let reconciliationRows: unknown[] = [];

function rowsFor(table: string, selected: string): unknown[] {
  if (table === 'inventory_month_closes') return [activeClose];
  if (table === 'inventory_month_close_purchases') return closedPurchaseRows;
  if (table === 'inventory_month_close_snapshot_items') return closedDimensionRows;
  if (table === 'inventory_discards') return discardRows;
  if (table === 'inventory_reconciliations') return reconciliationRows;
  if (table === 'inventory') {
    return [{ id: 'item-1', category: 'housekeeping', current_stock: 10, unit_cost: 2 }];
  }
  if (table === 'inventory_orders' && selected.includes('inventory!inner(category)')) {
    return [{
      total_cost: 9.99,
      quantity: 1,
      unit_cost: 9.99,
      received_at: '2026-06-10T12:00:00.000Z',
      item_id: 'item-1',
      inventory: { category: 'housekeeping', name: 'Bath towels' },
    }];
  }
  // The editable plan has changed since close. Historical accounting must
  // still use the close-time $100 snapshot above.
  if (table === 'inventory_budgets') return [{ category: 'housekeeping', budget_cents: 30_000, basis: 'usage' }];
  if (table === 'properties') return [{ inventory_budget_mode: 'sections' }];
  return [];
}

const eqCalls: Array<{ table: string; column: string; value: unknown }> = [];

class FakeQuery implements PromiseLike<Result> {
  private selected = '';

  constructor(private readonly table: string) {}

  select(columns: string) { this.selected = columns; return this; }
  eq(column: string, value: unknown) {
    eqCalls.push({ table: this.table, column, value });
    return this;
  }
  is() { return this; }
  gte() { return this; }
  lt() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }

  async maybeSingle(): Promise<Result> {
    return { data: (rowsFor(this.table, this.selected)[0] as Record<string, unknown> | undefined) ?? null, error: null };
  }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const result: Result = { data: rowsFor(this.table, this.selected), error: null };
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }
}

const client = {
  from(table: string) { return new FakeQuery(table); },
} as unknown as SupabaseClient;

describe('inventory accounting monthly close', () => {
  it('keeps shelf value and purchases separate from closed actual usage', async () => {
    activeClose = closedManualTotal;
    closedPurchaseRows = [];
    closedDimensionRows = [];
    discardRows = [];
    reconciliationRows = [];
    eqCalls.length = 0;
    const window = localMonthWindowUTC(2026, 6, 'America/Chicago');
    const summary = await getInventoryAccountingSummary(client, 'property-1', window.start, {
      endExclusive: window.endExclusive,
      budgetMonthKey: window.budgetMonthKey,
      timeZone: 'America/Chicago',
    });

    assert.equal(summary.totals.liveInventoryValue, 20);
    assert.equal(summary.totals.openingValue, 100);
    assert.equal(summary.totals.receiptsValue, 9.99);
    assert.equal(summary.totals.purchasesValue, 50);
    assert.equal(summary.totals.closingValue, 70);
    assert.equal(summary.totals.actualUsageValue, 80);
    assert.equal(summary.totals.spendCents, 8_000);
    assert.equal(summary.totals.budgetCents, 10_000);
    assert.equal(summary.totals.remainingCents, 2_000);
    assert.equal(summary.totals.actualStatus, 'unallocated');
    assert.equal(summary.totals.allocation, 'total_only');
    assert.ok(summary.byCategory.every((row) => row.actualUsageValue == null));
    assert.ok(eqCalls.some((call) => (
      call.table === 'inventory_budgets' && call.column === 'basis' && call.value === 'usage'
    )), 'accounting must ask PostgREST only for usage-budget rows');
  });

  it('uses frozen purchase categories after a logged-delivery month closes', async () => {
    activeClose = {
      ...closedManualTotal,
      purchase_source: 'logged_deliveries',
      allocation_mode: 'itemized',
      by_category: { housekeeping: 0, maintenance: 8_000, breakfast: 0 },
      by_budget_key: { housekeeping: 0, maintenance: 8_000, breakfast: 0 },
    };
    // The live inventory join above now says housekeeping, but the immutable
    // close evidence says this purchase belonged to maintenance at close.
    closedPurchaseRows = [{ category: 'maintenance', value_cents: 999 }];
    closedDimensionRows = [];
    discardRows = [];
    reconciliationRows = [];

    const window = localMonthWindowUTC(2026, 6, 'America/Chicago');
    const summary = await getInventoryAccountingSummary(client, 'property-1', window.start, {
      endExclusive: window.endExclusive,
      budgetMonthKey: window.budgetMonthKey,
      timeZone: 'America/Chicago',
    });

    assert.equal(summary.byCategory.find((row) => row.category === 'housekeeping')?.receiptsValue, 0);
    assert.equal(summary.byCategory.find((row) => row.category === 'maintenance')?.receiptsValue, 9.99);
  });

  it('does not double-attribute custom-section usage to its built-in category', async () => {
    activeClose = {
      ...closedManualTotal,
      purchase_source: 'zero',
      allocation_mode: 'itemized',
      by_category: { housekeeping: 8_000, maintenance: 0, breakfast: 0 },
      by_budget_key: { 'section:linen-closet': 8_000 },
    };
    closedPurchaseRows = [];
    closedDimensionRows = [];
    discardRows = [];
    reconciliationRows = [];

    const window = localMonthWindowUTC(2026, 6, 'America/Chicago');
    const summary = await getInventoryAccountingSummary(client, 'property-1', window.start, {
      endExclusive: window.endExclusive,
      budgetMonthKey: window.budgetMonthKey,
      timeZone: 'America/Chicago',
    });

    assert.equal(summary.byCategory.find((row) => row.category === 'housekeeping')?.actualUsageCents, 0);
    assert.equal(summary.totals.actualUsageValue, 80);
    assert.equal(summary.totals.hasCustomBudgetAllocation, true);
  });

  it('uses frozen loss categories and marks missing loss costs incomplete', async () => {
    activeClose = {
      ...closedManualTotal,
      purchase_source: 'zero',
      allocation_mode: 'itemized',
    };
    closedPurchaseRows = [];
    closedDimensionRows = [{ item_id: 'item-1', category: 'maintenance' }];
    discardRows = [{
      item_id: 'item-1',
      cost_value: null,
      quantity: 2,
      unit_cost: null,
      discarded_at: '2026-06-12T12:00:00.000Z',
      inventory: { category: 'housekeeping', name: 'Bath towels' },
    }];
    reconciliationRows = [{
      item_id: 'item-1',
      unaccounted_variance_value: null,
      unaccounted_variance: -3,
      unit_cost: null,
      reconciled_at: '2026-06-13T12:00:00.000Z',
      inventory: { category: 'housekeeping', name: 'Bath towels' },
    }];

    const window = localMonthWindowUTC(2026, 6, 'America/Chicago');
    const summary = await getInventoryAccountingSummary(client, 'property-1', window.start, {
      endExclusive: window.endExclusive,
      budgetMonthKey: window.budgetMonthKey,
      timeZone: 'America/Chicago',
    });

    const maintenance = summary.byCategory.find((row) => row.category === 'maintenance');
    assert.equal(maintenance?.discardsValue, null);
    assert.equal(maintenance?.discardsComplete, false);
    assert.equal(maintenance?.unaccountedShrinkageValue, null);
    assert.equal(maintenance?.shrinkageComplete, false);
    assert.equal(summary.totals.discardsValue, null);
    assert.equal(summary.totals.shrinkageComplete, false);
    assert.equal(summary.problemItemRankingComplete, false);
    assert.equal(summary.uncostedProblemItemCount, 1);
    assert.deepEqual(summary.topProblemItems, [{
      itemId: 'item-1',
      itemName: 'Bath towels',
      discardValue: null,
      knownDiscardValue: 0,
      discardsComplete: false,
      discardQty: 2,
      unaccountedValue: null,
      knownUnaccountedValue: 0,
      shrinkageComplete: false,
      combinedValue: null,
      knownCombinedValue: 0,
      costComplete: false,
      rank: null,
    }]);
  });

  it('surfaces uncosted items before exact rows without claiming a loss rank', async () => {
    activeClose = closedManualTotal;
    closedPurchaseRows = [];
    closedDimensionRows = [];
    discardRows = [{
      item_id: 'uncosted',
      cost_value: null,
      quantity: 2,
      unit_cost: null,
      discarded_at: '2026-06-12T12:00:00.000Z',
      inventory: { category: 'housekeeping', name: 'Uncosted towels' },
    }, {
      item_id: 'uncosted',
      cost_value: 8,
      quantity: 1,
      unit_cost: 8,
      discarded_at: '2026-06-12T13:00:00.000Z',
      inventory: { category: 'housekeeping', name: 'Uncosted towels' },
    }, {
      item_id: 'costed',
      cost_value: 40,
      quantity: 4,
      unit_cost: 10,
      discarded_at: '2026-06-13T12:00:00.000Z',
      inventory: { category: 'housekeeping', name: 'Costed towels' },
    }];
    reconciliationRows = [{
      item_id: 'uncosted',
      unaccounted_variance_value: null,
      unaccounted_variance: -3,
      unit_cost: 2,
      reconciled_at: '2026-06-14T12:00:00.000Z',
      inventory: { category: 'housekeeping', name: 'Uncosted towels' },
    }];

    const window = localMonthWindowUTC(2026, 6, 'America/Chicago');
    const summary = await getInventoryAccountingSummary(client, 'property-1', window.start, {
      endExclusive: window.endExclusive,
      budgetMonthKey: window.budgetMonthKey,
      timeZone: 'America/Chicago',
    });

    assert.equal(summary.problemItemRankingComplete, false);
    assert.equal(summary.uncostedProblemItemCount, 1);
    assert.equal(summary.topProblemItems[0]?.itemId, 'uncosted');
    assert.equal(summary.topProblemItems[0]?.discardValue, null);
    assert.equal(summary.topProblemItems[0]?.knownDiscardValue, 8);
    assert.equal(summary.topProblemItems[0]?.unaccountedValue, 6);
    assert.equal(summary.topProblemItems[0]?.knownCombinedValue, 14);
    assert.equal(summary.topProblemItems[0]?.combinedValue, null);
    assert.equal(summary.topProblemItems[0]?.rank, null);
    assert.equal(summary.topProblemItems[1]?.itemId, 'costed');
    assert.equal(summary.topProblemItems[1]?.combinedValue, 40);
    assert.equal(summary.topProblemItems[1]?.rank, null);
  });

  it('ranks fully costed problem items by exact combined loss', async () => {
    activeClose = closedManualTotal;
    closedPurchaseRows = [];
    closedDimensionRows = [];
    discardRows = [{
      item_id: 'smaller',
      cost_value: 10,
      quantity: 1,
      unit_cost: 10,
      discarded_at: '2026-06-12T12:00:00.000Z',
      inventory: { category: 'housekeeping', name: 'Smaller loss' },
    }, {
      item_id: 'larger',
      cost_value: 40,
      quantity: 4,
      unit_cost: 10,
      discarded_at: '2026-06-13T12:00:00.000Z',
      inventory: { category: 'housekeeping', name: 'Larger loss' },
    }];
    reconciliationRows = [{
      item_id: 'smaller',
      unaccounted_variance_value: null,
      unaccounted_variance: -5,
      unit_cost: 1,
      reconciled_at: '2026-06-14T12:00:00.000Z',
      inventory: { category: 'housekeeping', name: 'Smaller loss' },
    }];

    const window = localMonthWindowUTC(2026, 6, 'America/Chicago');
    const summary = await getInventoryAccountingSummary(client, 'property-1', window.start, {
      endExclusive: window.endExclusive,
      budgetMonthKey: window.budgetMonthKey,
      timeZone: 'America/Chicago',
    });

    assert.equal(summary.problemItemRankingComplete, true);
    assert.equal(summary.uncostedProblemItemCount, 0);
    assert.deepEqual(summary.topProblemItems.map((item) => ({
      id: item.itemId,
      combined: item.combinedValue,
      rank: item.rank,
    })), [
      { id: 'larger', combined: 40, rank: 1 },
      { id: 'smaller', combined: 15, rank: 2 },
    ]);
  });
});
