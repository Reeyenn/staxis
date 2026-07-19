import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInventoryCompareActual } from '../inventory-compare-actual';
import type { InventoryMonthCloseHistoryRow } from '../inventory-month-close';

function close(
  month: string,
  overrides: Partial<InventoryMonthCloseHistoryRow> = {},
): InventoryMonthCloseHistoryRow {
  return {
    closeId: `close-${month}`,
    month,
    status: 'closed',
    isPartial: false,
    budgetComparisonAvailable: true,
    purchaseSource: 'logged_deliveries',
    allocationMode: 'itemized',
    beginningCents: 100_000,
    openingAdjustmentCents: 0,
    purchasesCents: 20_000,
    loggedPurchaseCents: 20_000,
    knownLoggedPurchaseCents: 20_000,
    endingCents: 90_000,
    actualUsageCents: 30_000,
    byCategory: null,
    byItem: null,
    byBudgetKey: null,
    usageBudgetMode: 'sections',
    usageBudgetTotalCents: 50_000,
    usageBudgetByKey: { housekeeping: 50_000 },
    complete: true,
    closedAt: `${month}-28T12:00:00.000Z`,
    ...overrides,
  };
}

describe('inventory compare actuals', () => {
  it('starts year availability at the first month-close history row', () => {
    const result = resolveInventoryCompareActual({
      basis: 'years',
      from: '2026-01-01',
      to: '2026-12-31',
      currentMonth: '2026-08',
      closes: [close('2026-07'), close('2026-06')],
    });

    // January–May predate the month-close baseline and are not missing data.
    assert.deepEqual(result, {
      actualUsageValue: 600,
      confirmedPurchasesValue: 400,
      actualUsageStatus: 'complete',
      closedMonths: 2,
      expectedMonths: 2,
      windowMonths: 7,
    });
  });

  it('reports a pending year when a post-baseline ended month has no close', () => {
    const result = resolveInventoryCompareActual({
      basis: 'years',
      from: '2026-01-01',
      to: '2026-12-31',
      currentMonth: '2026-09',
      closes: [close('2026-06'), close('2026-08')],
    });

    assert.equal(result.actualUsageStatus, 'pending');
    assert.equal(result.closedMonths, 2);
    assert.equal(result.expectedMonths, 3);
    assert.equal(result.windowMonths, 8);
    assert.equal(result.actualUsageValue, null);
  });

  it('does not invent year availability before any close baseline exists', () => {
    const result = resolveInventoryCompareActual({
      basis: 'years',
      from: '2026-01-01',
      to: '2026-12-31',
      currentMonth: '2026-09',
      closes: [],
    });

    assert.equal(result.actualUsageStatus, 'pending');
    assert.equal(result.expectedMonths, 0);
    assert.equal(result.closedMonths, 0);
    assert.equal(result.windowMonths, 8);
  });

  it('propagates partial-period honesty when all expected months are closed', () => {
    const result = resolveInventoryCompareActual({
      basis: 'years',
      from: '2026-01-01',
      to: '2026-12-31',
      currentMonth: '2026-08',
      closes: [close('2026-06', { isPartial: true }), close('2026-07')],
    });

    assert.equal(result.actualUsageStatus, 'partial');
    assert.equal(result.actualUsageValue, 600);
  });

  it('requires an exact calendar month for month actuals', () => {
    const closed = close('2026-06');
    assert.equal(resolveInventoryCompareActual({
      basis: 'months',
      from: '2026-06-01',
      to: '2026-06-30',
      currentMonth: '2026-08',
      closes: [closed],
    }).actualUsageStatus, 'complete');
    assert.equal(resolveInventoryCompareActual({
      basis: 'months',
      from: '2026-06-02',
      to: '2026-06-30',
      currentMonth: '2026-08',
      closes: [closed],
    }).actualUsageStatus, 'unavailable');
  });
});
