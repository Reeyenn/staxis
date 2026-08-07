// Two things the self-serve report hub has to get right about inventory:
//
//  1. The reorder list has to call an item the same thing the Inventory board
//     calls it. It used to be one shade redder at both boundaries, because the
//     classification was written inline with `<=` on 0.3 and 0.7 instead of the
//     house rule's `>=`. Exactly 70% of par printed "Low" next to a green pill,
//     and exactly 30% printed "Critical" next to an amber one.
//
//  2. A money report has to honor the per-hotel Financials switch. `run_reports`
//     keeps line staff out of the hub, but `view_financials` is a separate
//     switch an admin can turn off for one manager at one hotel; without a
//     second check that manager could still download the hotel's budgets,
//     purchases and usage dollars as a spreadsheet.
//
// These exercise the real registry entries and the real producers rather than
// reading their source.

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { getReportDefinition, listCatalog } from '@/lib/reports/catalog';
import { reportAccessDecision, visibleReportCatalog } from '@/lib/reports/catalog/gate';
import { stockStatus } from '@/lib/stock-status';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { ReportContext, ReportRow } from '@/lib/reports/catalog/types';

const PID = '00000000-0000-0000-0000-0000000000f1';

const CTX: ReportContext = {
  propertyId: PID,
  from: '2026-07-01',
  to: '2026-07-31',
  timezone: 'America/Chicago',
};

interface ItemRow {
  name: string;
  category: string;
  current_stock: number | null;
  par_level: number | null;
  reorder_at: number | null;
}

let itemRows: ItemRow[] = [];
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

/** Permissive read chain: every filter is a no-op, awaiting yields the rows. */
function chain(rows: unknown[]) {
  const result = { data: rows, error: null };
  const api: Record<string, unknown> = {
    select: () => api, eq: () => api, is: () => api, in: () => api,
    gte: () => api, lt: () => api, lte: () => api, order: () => api, limit: () => api,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return api;
}

beforeEach(() => {
  itemRows = [];
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => chain(table === 'inventory' ? itemRows : []);
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

async function runLowStock(): Promise<{ rows: ReportRow[]; stats: Record<string, string> }> {
  const def = getReportDefinition('inventory-low-stock');
  assert.ok(def, 'inventory-low-stock is registered');
  const result = await def.run(CTX);
  const stats: Record<string, string> = {};
  for (const stat of result.stats ?? []) stats[stat.label.en] = stat.value;
  return { rows: result.rows, stats };
}

function item(name: string, stock: number, par: number, reorderAt: number | null = null): ItemRow {
  return { name, category: 'housekeeping', current_stock: stock, par_level: par, reorder_at: reorderAt };
}

describe('inventory-low-stock report labels', () => {
  test('never contradicts the status the Inventory board paints', async () => {
    itemRows = [
      item('AtSeventy', 70, 100, 70),
      item('BelowSeventy', 69, 100, 70),
      item('AtThirty', 30, 100, 70),
      item('BelowThirty', 29, 100, 70),
      item('Empty', 0, 100, 70),
    ];
    const { rows } = await runLowStock();
    const boardLabel: Record<string, string> = { good: 'Reorder', low: 'Low', critical: 'Critical' };

    assert.equal(rows.length, 5, 'every item is at or below its reorder point');
    for (const row of rows) {
      const expected = boardLabel[stockStatus(Number(row.onHand), Number(row.par))];
      assert.equal(row.status, expected, `${String(row.item)} disagrees with the board`);
    }

    const byItem = new Map(rows.map((row) => [String(row.item), row.status]));
    // The two boundaries the inline rule got backwards.
    assert.equal(byItem.get('AtSeventy'), 'Reorder');   // 70% of par is Good, not Low
    assert.equal(byItem.get('AtThirty'), 'Low');        // 30% of par is Low, not Critical
    assert.equal(byItem.get('BelowSeventy'), 'Low');
    assert.equal(byItem.get('BelowThirty'), 'Critical');
    assert.equal(byItem.get('Empty'), 'Critical');
  });

  test('the Critical and Low tallies count the same rows the table shows', async () => {
    itemRows = [
      item('AtSeventy', 70, 100, 70),
      item('AtThirty', 30, 100, 70),
      item('BelowThirty', 29, 100, 70),
    ];
    const { rows, stats } = await runLowStock();
    const tally = (label: string) => rows.filter((row) => row.status === label).length;

    assert.equal(stats.Critical, String(tally('Critical')));
    assert.equal(stats.Low, String(tally('Low')));
    assert.equal(stats.Critical, '1');
    assert.equal(stats.Low, '1');
    assert.equal(stats['Below reorder'], '3');
  });

  test('an item with no par level but nothing on the shelf still reads Critical', async () => {
    itemRows = [item('NoPar', 0, 0, null)];
    const { rows } = await runLowStock();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'Critical');
  });
});

describe('report hub money gate', () => {
  test('the inventory usage report is declared money-bearing', () => {
    const spend = getReportDefinition('inventory-spend');
    assert.ok(spend);
    assert.equal(spend.requiresFinancials, true);
  });

  test('a manager without Financials at this hotel cannot run it', () => {
    const spend = getReportDefinition('inventory-spend');
    assert.ok(spend);
    assert.equal(
      reportAccessDecision(spend, { canViewFinancials: false }),
      'financials_required',
    );
    assert.equal(reportAccessDecision(spend, { canViewFinancials: true }), 'allowed');
  });

  test('the reorder list carries no money, so it stays available', () => {
    const lowStock = getReportDefinition('inventory-low-stock');
    assert.ok(lowStock);
    assert.notEqual(lowStock.requiresFinancials, true);
    assert.equal(reportAccessDecision(lowStock, { canViewFinancials: false }), 'allowed');
  });

  test('the hub does not offer a report it would then refuse to run', () => {
    const restricted = visibleReportCatalog(listCatalog(), { canViewFinancials: false });
    const keys = restricted.map((entry) => entry.key);
    assert.equal(keys.includes('inventory-spend'), false);
    assert.equal(keys.includes('inventory-low-stock'), true);

    const full = visibleReportCatalog(listCatalog(), { canViewFinancials: true });
    assert.equal(full.length, listCatalog().length);
    assert.equal(full.map((entry) => entry.key).includes('inventory-spend'), true);
  });

  test('every catalog entry states whether it carries money', () => {
    for (const entry of listCatalog()) {
      assert.equal(typeof entry.requiresFinancials, 'boolean', `${entry.key} is undeclared`);
    }
  });
});
