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
  inventoryMonthCloseMutationFailure,
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
import {
  inventoryBaselineConflictsWithCount,
  inventoryCorrectionEffectAppliedToItem,
  inventoryMovementConflictsWithCount,
} from '../db/inventory-month-closes';

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

describe('inventory month-close recovery errors', () => {
  it('makes timezone changes explicit and requires a safe rebaseline', () => {
    assert.deepEqual(inventoryMonthCloseMutationFailure({
      code: '23514',
      message: 'property timezone changed after this period opened; rebaseline the current month',
    }), {
      status: 409,
      code: 'month_close_timezone_changed',
      message: 'The property timezone changed after this period opened. Nothing was closed. An administrator must rebaseline the current month before usage can be recorded safely.',
    });
  });

  it('distinguishes missed count evidence from activity that requires a recount', () => {
    const missing = inventoryMonthCloseMutationFailure({
      code: '22023',
      message: 'one complete physical-count session must cover every active period-end item in the ending-count window',
    });
    assert.equal(missing.code, 'month_close_ending_count_required');
    assert.match(missing.message, /remains unclosed/i);

    const moved = inventoryMonthCloseMutationFailure({
      code: '22023',
      message: 'next-month activity occurred before a grace-period ending count',
    });
    assert.equal(moved.code, 'month_close_recount_required');
    assert.match(moved.message, /new complete count/i);
  });

  it('labels a start baseline count separately from an ending count', () => {
    const error = {
      code: '22023',
      message: 'one current complete physical-count session is required for every active item',
    };
    const baseline = inventoryMonthCloseMutationFailure(error, 'start');
    assert.equal(baseline.code, 'month_close_baseline_count_required');
    assert.match(baseline.message, /start this baseline/i);
    assert.doesNotMatch(baseline.message, /ending-count window/i);

    const ending = inventoryMonthCloseMutationFailure(error, 'close');
    assert.equal(ending.code, 'month_close_ending_count_required');
  });

  it('never presents an unknown dependency failure as a valid close result', () => {
    const failure = inventoryMonthCloseMutationFailure(new Error('connection reset'));
    assert.equal(failure.status, 500);
    assert.equal(failure.code, 'internal_error');
    assert.match(failure.message, /nothing was changed/i);
  });
});

describe('inventory month-close durable movement eligibility', () => {
  const base = {
    activityStartAt: '2026-06-01T00:00:00Z',
    endAt: '2026-07-01T00:00:00Z',
    discards: [],
    laterCounts: [],
  };

  it('rejects a backdated stock event committed after an in-month count', () => {
    assert.equal(inventoryMovementConflictsWithCount({
      ...base,
      countedAt: '2026-06-30T12:00:00Z',
      countActivitySequence: 100,
      orders: [{
        occurredAt: '2026-06-15T12:00:00Z',
        activitySequence: 101,
        changedLiveStock: true,
      }],
    }), true);
  });

  it('ignores unapplied correction evidence and legitimate next-period work', () => {
    assert.equal(inventoryMovementConflictsWithCount({
      ...base,
      countedAt: '2026-06-30T12:00:00Z',
      countActivitySequence: 100,
      orders: [
        { occurredAt: '2026-06-15T12:00:00Z', activitySequence: 101, changedLiveStock: false },
        { occurredAt: '2026-07-01T12:00:00Z', activitySequence: 102, changedLiveStock: true },
      ],
    }), false);
  });

  it('rejects a later same-period one-item recount', () => {
    assert.equal(inventoryMovementConflictsWithCount({
      ...base,
      countedAt: '2026-06-30T12:00:00Z',
      countActivitySequence: 100,
      orders: [],
      laterCounts: [{ countedAt: '2026-06-30T13:00:00Z', activitySequence: 105 }],
    }), true);
  });

  it('keeps a grace count valid after later next-period work but rejects pre-count work', () => {
    const grace = {
      ...base,
      countedAt: '2026-07-01T12:00:00Z',
      countActivitySequence: 100,
    };
    assert.equal(inventoryMovementConflictsWithCount({
      ...grace,
      orders: [{
        occurredAt: '2026-07-02T12:00:00Z',
        activitySequence: 101,
        changedLiveStock: true,
      }],
    }), false);
    assert.equal(inventoryMovementConflictsWithCount({
      ...grace,
      orders: [{
        occurredAt: '2026-07-01T10:00:00Z',
        activitySequence: 101,
        changedLiveStock: true,
      }],
    }), true);
  });

  it('uses durable ordering for the opening baseline and ignores cost-only corrections', () => {
    const opening = {
      countedAt: '2026-07-19T12:00:00Z',
      countActivitySequence: 100,
      discards: [],
      laterCounts: [],
    };
    assert.equal(inventoryBaselineConflictsWithCount({
      ...opening,
      orders: [{
        occurredAt: '2026-07-18T12:00:00Z',
        activitySequence: 101,
        changedLiveStock: true,
      }],
    }), true, 'a backdated stock write committed after the count requires recount');
    assert.equal(inventoryBaselineConflictsWithCount({
      ...opening,
      orders: [{
        occurredAt: '2026-07-18T12:00:00Z',
        activitySequence: 101,
        changedLiveStock: false,
      }],
    }), false, 'cost-only correction evidence does not invalidate stock');
    assert.equal(inventoryBaselineConflictsWithCount({
      ...opening,
      orders: [],
      laterCounts: [{ activitySequence: 102 }],
    }), true, 'a later count supersedes the selected complete session');
  });

  it('treats an audited empty correction effect as cost-only and malformed evidence as unknown', () => {
    assert.equal(inventoryCorrectionEffectAppliedToItem([], 'item-a'), false);
    assert.equal(inventoryCorrectionEffectAppliedToItem([
      { itemId: 'item-b', applied: false },
    ], 'item-a'), false);
    assert.equal(inventoryCorrectionEffectAppliedToItem([
      { itemId: 'item-a', applied: true },
    ], 'item-a'), true);
    assert.equal(inventoryCorrectionEffectAppliedToItem([{ itemId: 'item-a' }], 'item-a'), null);
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
