import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseExclusiveBudgetKey,
  formatInventoryDateKey,
  formatInventoryMonthKey,
  inventoryDateKeyInZone,
  inventoryCloseWindow,
  inventoryMonthEndDateKey,
  inventoryMonthKeyInZone,
  inventoryOpeningPosition,
  inventoryUsageCents,
  isMonthKey,
  periodicWeightedAverageCents,
  purchaseSource,
  shiftInventoryDateKey,
  shiftInventoryMonthKey,
  validatePurchaseSelection,
  type InventoryMonthCloseHistoryRow,
} from '../inventory-month-close';

describe('inventory month-close calendar windows', () => {
  it('uses property-local calendar midnights across spring DST', () => {
    const window = inventoryCloseWindow('2026-03', 'America/Chicago');
    assert.equal(window.monthStart.toISOString(), '2026-03-01T06:00:00.000Z');
    assert.equal(window.countWindowStart.toISOString(), '2026-03-31T05:00:00.000Z');
    assert.equal(window.endExclusive.toISOString(), '2026-04-01T05:00:00.000Z');
    assert.equal(window.graceEndExclusive.toISOString(), '2026-04-04T05:00:00.000Z');
    assert.equal(window.closeAvailableOn, '2026-04-01');
  });

  it('does not assume fixed 24-hour offsets across fall DST', () => {
    const window = inventoryCloseWindow('2026-11', 'America/Chicago');
    assert.equal(window.monthStart.toISOString(), '2026-11-01T05:00:00.000Z');
    assert.equal(window.countWindowStart.toISOString(), '2026-11-30T06:00:00.000Z');
    assert.equal(window.endExclusive.toISOString(), '2026-12-01T06:00:00.000Z');
  });

  it('accepts only canonical month keys', () => {
    assert.equal(isMonthKey('2026-07'), true);
    assert.equal(isMonthKey('2026-7'), false);
    assert.equal(isMonthKey('2026-13'), false);
  });

  it('uses the hotel calendar at international date boundaries', () => {
    const instant = new Date('2026-07-31T12:30:00.000Z');
    assert.equal(inventoryDateKeyInZone(instant, 'Pacific/Kiritimati'), '2026-08-01');
    assert.equal(inventoryMonthKeyInZone(instant, 'Pacific/Kiritimati'), '2026-08');
    assert.equal(inventoryDateKeyInZone(instant, 'America/Los_Angeles'), '2026-07-31');
    assert.equal(inventoryMonthKeyInZone(instant, 'America/Los_Angeles'), '2026-07');
  });

  it('does calendar-key arithmetic without browser timezone drift', () => {
    assert.equal(shiftInventoryDateKey('2028-03-01', -1), '2028-02-29');
    assert.equal(shiftInventoryMonthKey('2026-01', -1), '2025-12');
    assert.equal(inventoryMonthEndDateKey('2028-02'), '2028-02-29');
    assert.equal(formatInventoryMonthKey('2026-07', 'en'), 'July 2026');
    assert.equal(formatInventoryDateKey('2026-07-19', 'en'), 'Jul 19');
  });
});

describe('inventory month-close purchase confirmation', () => {
  it('requires a positive manual total and reserves explicit $0 for zero', () => {
    assert.deepEqual(validatePurchaseSelection('manual_total', 1), { manualPurchaseCents: 1, error: null });
    assert.match(validatePurchaseSelection('manual_total', 0).error ?? '', /positive integer/i);
    assert.deepEqual(validatePurchaseSelection('zero', undefined), { manualPurchaseCents: null, error: null });
    assert.match(validatePurchaseSelection('zero', 0).error ?? '', /only valid with manual_total/i);
  });

  it('does not coerce unknown purchase sources', () => {
    assert.equal(purchaseSource('logged_deliveries'), 'logged_deliveries');
    assert.equal(purchaseSource('manual_total'), 'manual_total');
    assert.equal(purchaseSource('zero'), 'zero');
    assert.equal(purchaseSource('none'), null);
  });
});

describe('inventory month-close valuation and allocation', () => {
  it('uses periodic weighted-average cost for itemized logged deliveries', () => {
    assert.equal(periodicWeightedAverageCents({
      openingQuantity: 100,
      openingValueCents: 10_000,
      purchaseQuantity: 10,
      purchaseValueCents: 2_000,
    }), 12_000 / 110);
    assert.equal(periodicWeightedAverageCents({
      openingQuantity: 0,
      openingValueCents: 0,
      purchaseQuantity: 0,
      purchaseValueCents: 0,
    }), null);
  });

  it('computes actual usage independently from purchase spend and shelf value', () => {
    assert.equal(inventoryUsageCents(80_000, 25_000, 67_500), 37_500);
  });

  it('adds pre-existing discovered stock to opening inventory, never purchases', () => {
    assert.deepEqual(inventoryOpeningPosition({
      hasOpeningSnapshot: false,
      adjustmentQuantity: 10,
      adjustmentUnitCostCents: 250,
    }), {
      quantity: 10,
      unitCostCents: 250,
      valueCents: 2_500,
      adjustmentValueCents: 2_500,
      adjustmentApplied: true,
    });
    assert.equal(inventoryUsageCents(2_500, 0, 1_500), 1_000);
    const correctedExisting = inventoryOpeningPosition({
      hasOpeningSnapshot: true,
      snapshotQuantity: 4,
      snapshotUnitCostCents: 100,
      snapshotValueCents: 400,
      adjustmentQuantity: 10,
      adjustmentUnitCostCents: 250,
    });
    assert.equal(correctedExisting.quantity, 14);
    assert.equal(correctedExisting.valueCents, 2_900);
    assert.equal(correctedExisting.adjustmentValueCents, 2_500);
    assert.equal(correctedExisting.adjustmentApplied, true);
    assert.equal(correctedExisting.unitCostCents, 2_900 / 14);
  });

  it('chooses one deterministic custom budget section and retains all mappings', () => {
    assert.deepEqual(chooseExclusiveBudgetKey('housekeeping', [
      { id: 'bbbb', sort: 2 },
      { id: 'zzzz', sort: 1 },
      { id: 'aaaa', sort: 1 },
    ]), {
      budgetKey: 'section:aaaa',
      orderedSectionIds: ['aaaa', 'zzzz', 'bbbb'],
      multiplyMapped: true,
    });
    assert.deepEqual(chooseExclusiveBudgetKey('breakfast', []), {
      budgetKey: 'breakfast',
      orderedSectionIds: [],
      multiplyMapped: false,
    });
  });

  it('keeps an incomplete logged subtotal distinct in history', () => {
    const row: InventoryMonthCloseHistoryRow = {
      closeId: 'close-1',
      month: '2026-07',
      status: 'open',
      isPartial: false,
      budgetComparisonAvailable: false,
      purchaseSource: null,
      allocationMode: null,
      beginningCents: 10_000,
      openingAdjustmentCents: 0,
      purchasesCents: null,
      loggedPurchaseCents: null,
      knownLoggedPurchaseCents: 2_500,
      endingCents: null,
      actualUsageCents: null,
      byCategory: null,
      byItem: null,
      byBudgetKey: null,
      usageBudgetMode: null,
      usageBudgetTotalCents: null,
      usageBudgetByKey: null,
      complete: false,
      closedAt: null,
    };
    assert.equal(row.loggedPurchaseCents, null);
    assert.equal(row.knownLoggedPurchaseCents, 2_500);
  });
});
