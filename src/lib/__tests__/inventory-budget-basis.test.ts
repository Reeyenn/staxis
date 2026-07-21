import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromInventoryBudgetRow, toInventoryBudgetRow } from '../db-mappers';

describe('inventory budget basis mapping', () => {
  it('classifies a mixed-version legacy row as a purchase budget', () => {
    const budget = fromInventoryBudgetRow({
      property_id: 'property-1',
      category: 'housekeeping',
      month_start: '2026-06-01',
      budget_cents: 25_000,
    });
    assert.equal(budget.basis, 'purchases');
  });

  it('round-trips an explicit usage budget without changing its meaning', () => {
    const budget = fromInventoryBudgetRow({
      property_id: 'property-1',
      category: 'total',
      basis: 'usage',
      month_start: '2026-06-01',
      budget_cents: 30_000,
    });
    assert.equal(budget.basis, 'usage');
    assert.equal(toInventoryBudgetRow(budget).basis, 'usage');
  });
});

describe('inventory usage-budget UI contract', () => {
  const panel = readFileSync(join(
    process.cwd(),
    'src/app/inventory/_components/overlays/BudgetsPanel.tsx',
  ), 'utf8');
  const shell = readFileSync(join(
    process.cwd(),
    'src/app/inventory/_components/InventoryShell.tsx',
  ), 'utf8');
  const dataAccess = readFileSync(join(
    process.cwd(),
    'src/lib/db/inventory-budgets.ts',
  ), 'utf8');

  it('filters planning values to usage rows and visibly acknowledges legacy purchase caps', () => {
    assert.match(panel, /budget\.basis === 'usage'/);
    assert.match(panel, /budget\.basis === 'purchases'/);
    assert.match(panel, /legacyPurchaseCapsNotice/);
    assert.match(panel, /Older purchase budgets are kept for reference/);
  });

  it('keeps the Inventory shell summary and every new save on the usage basis', () => {
    assert.match(shell, /b\.basis !== 'usage'/);
    assert.match(dataAccess, /basis: 'usage'/);
    assert.match(dataAccess, /property_id,category,month_start,basis/);
  });

  it('keeps the monthly limits section concise without the removed helper paragraph', () => {
    assert.match(panel, /<BudgetSection title=\{bp\.setLimitsTitle\}>/);
    assert.doesNotMatch(panel, /setLimitsSub/);
    assert.doesNotMatch(panel, /Choose a month and year/);
  });

  it('keeps the budget method chooser concise without its helper paragraph', () => {
    assert.match(panel, /<BudgetSection title=\{bp\.chooseMethodTitle\}>/);
    assert.doesNotMatch(panel, /chooseMethodSub/);
    assert.doesNotMatch(panel, /Use one monthly limit for all inventory/);
  });

  it('shares one compact row for Add section and Copy to year', () => {
    assert.match(
      panel,
      /data-budget-row-actions="true"[\s\S]*?bp\.addSection[\s\S]*?bp\.copyMonthToYear\(MONTHS\[month\], year\)/,
    );
    assert.equal(
      (panel.match(/bp\.copyMonthToYear\(MONTHS\[month\], year\)/g) ?? []).length,
      1,
    );
  });

  it('places the pending budget notice after the final history section', () => {
    const historySection = panel.indexOf('<BudgetSection contained title={bp.compareMonthsTitle}');
    const pendingNotice = panel.indexOf('data-budget-pending-notice="bottom"');
    assert.ok(historySection >= 0);
    assert.ok(pendingNotice > historySection);
    assert.equal((panel.match(/data-budget-pending-notice="bottom"/g) ?? []).length, 1);
  });

  it('keeps the current-month review concise and explains why usage is pending', () => {
    assert.match(panel, /actualPendingShort: 'Pending'/);
    assert.match(panel, /actualPendingReason: 'Usage is calculated when the month closes\.'/);
    assert.match(panel, /isCurrentMonth \? undefined : bp\.reviewSelectedSub/);
    assert.doesNotMatch(panel, /reviewCurrentSub/);
    assert.match(panel, /noBudgetsYet: 'No budget set\.'/);
  });
});
