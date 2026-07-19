import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateInventoryUsageRange,
  planInventoryUsageRange,
  type InventoryUsagePeriod,
} from '../reports/catalog/inventory-usage-range';

function period(overrides: Partial<InventoryUsagePeriod> = {}): InventoryUsagePeriod {
  return {
    month: '2026-06',
    actualStatus: 'complete',
    actualCents: 15_000,
    allocation: 'itemized',
    isPartial: false,
    hasCustomBudgetAllocation: false,
    budgetComparisonAvailable: true,
    purchasesCents: 8_000,
    knownPurchasesCents: 8_000,
    budgetCents: 20_000,
    discardsCents: 500,
    categories: [{
      category: 'housekeeping',
      actualCents: 15_000,
      purchasesCents: 8_000,
      budgetCents: 20_000,
      discardsCents: 500,
    }],
    ...overrides,
  };
}

describe('inventory usage report range planning', () => {
  it('uses only calendar months fully covered by the selected range', () => {
    assert.deepEqual(planInventoryUsageRange('2026-06-15', '2026-08-15'), {
      fullMonths: ['2026-07'],
      partialMonths: ['2026-06', '2026-08'],
    });
  });

  it('includes both endpoints when the range covers exact whole months', () => {
    assert.deepEqual(planInventoryUsageRange('2026-06-01', '2026-07-31'), {
      fullMonths: ['2026-06', '2026-07'],
      partialMonths: [],
    });
  });
});

describe('inventory usage report range aggregation', () => {
  it('omits pending closes instead of substituting live or purchase totals', () => {
    const plan = planInventoryUsageRange('2026-06-01', '2026-07-31');
    const result = aggregateInventoryUsageRange(plan, [
      period(),
      period({
        month: '2026-07',
        actualStatus: 'pending',
        actualCents: null,
        allocation: 'pending',
        purchasesCents: null,
        knownPurchasesCents: 3_000,
        budgetComparisonAvailable: false,
        budgetCents: null,
      }),
    ]);

    assert.equal(result.expectedMonths, 2);
    assert.equal(result.closedMonths, 1);
    assert.equal(result.pendingMonths, 1);
    assert.equal(result.actualCents, 15_000);
    assert.equal(result.purchasesCents, 8_000);
    assert.equal(result.budgetCents, 20_000);
    assert.equal(result.discardsCents, 500);
  });

  it('keeps partial first-period actuals but suppresses a full-month budget comparison', () => {
    const result = aggregateInventoryUsageRange(
      planInventoryUsageRange('2026-06-01', '2026-06-30'),
      [period({
        actualStatus: 'partial',
        isPartial: true,
        budgetComparisonAvailable: false,
      })],
    );

    assert.equal(result.actualCents, 15_000);
    assert.equal(result.partialTrackingPeriods, 1);
    assert.equal(result.budgetCents, null);
    assert.equal(result.remainingCents, null);
    assert.equal(result.categoryRowsAvailable, false);
  });

  it('preserves the total comparison but avoids misleading app-category rows for custom allocations', () => {
    const result = aggregateInventoryUsageRange(
      planInventoryUsageRange('2026-06-01', '2026-06-30'),
      [period({ hasCustomBudgetAllocation: true })],
    );

    assert.equal(result.actualCents, 15_000);
    assert.equal(result.budgetCents, 20_000);
    assert.equal(result.remainingCents, 5_000);
    assert.equal(result.customAllocationPeriods, 1);
    assert.equal(result.categoryRowsAvailable, false);
  });

  it('adds category values only when every included close is safely itemized', () => {
    const result = aggregateInventoryUsageRange(
      planInventoryUsageRange('2026-06-01', '2026-07-31'),
      [
        period(),
        period({
          month: '2026-07',
          actualCents: 9_000,
          purchasesCents: 4_000,
          knownPurchasesCents: 4_000,
          budgetCents: 10_000,
          discardsCents: 250,
          categories: [{
            category: 'housekeeping',
            actualCents: 9_000,
            purchasesCents: 4_000,
            budgetCents: 10_000,
            discardsCents: 250,
          }],
        }),
      ],
    );

    assert.equal(result.categoryRowsAvailable, true);
    assert.deepEqual(result.categories, [{
      category: 'housekeeping',
      actualCents: 24_000,
      purchasesCents: 12_000,
      budgetCents: 30_000,
      remainingCents: 6_000,
      discardsCents: 750,
      knownDiscardsCents: 750,
      discardsComplete: true,
    }]);
  });

  it('keeps an incomplete discard subtotal visibly incomplete', () => {
    const result = aggregateInventoryUsageRange(
      planInventoryUsageRange('2026-06-01', '2026-06-30'),
      [period({
        discardsCents: null,
        knownDiscardsCents: 500,
        discardsComplete: false,
        categories: [{
          category: 'housekeeping',
          actualCents: 15_000,
          purchasesCents: 8_000,
          budgetCents: 20_000,
          discardsCents: null,
          knownDiscardsCents: 500,
          discardsComplete: false,
        }],
      })],
    );

    assert.equal(result.discardsCents, null);
    assert.equal(result.knownDiscardsCents, 500);
    assert.equal(result.discardsComplete, false);
    assert.equal(result.categories[0]?.discardsCents, null);
  });
});
