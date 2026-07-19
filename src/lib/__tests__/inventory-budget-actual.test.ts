import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  inventoryBudgetBand,
  inventoryBudgetComparisonCap,
  inventoryBudgetPeriodsFromDashboard,
  inventoryPurchaseEvidence,
  inventoryBudgetSnapshotCap,
  resolveInventoryBudgetActual,
  type InventoryBudgetActualInput,
} from '../inventory-budget-actual';
import type { InventoryBudgetActualPeriod } from '../inventory-budget-actual';
import type { InventoryMonthCloseDashboard } from '../inventory-month-close';

const closed: InventoryBudgetActualInput = {
  status: 'closed',
  isPartial: false,
  allocation: 'itemized',
  actualUsageValue: 850,
  byBudgetKey: { housekeeping: 500, maintenance: 350 },
};

describe('resolveInventoryBudgetActual', () => {
  it('never compares an open month to budget', () => {
    assert.deepEqual(
      resolveInventoryBudgetActual({ ...closed, status: 'open', actualUsageValue: null }, 'total'),
      { state: 'pending', value: null },
    );
  });

  it('never compares a partial first period to a full monthly budget', () => {
    assert.deepEqual(
      resolveInventoryBudgetActual({ ...closed, isPartial: true }, 'total'),
      { state: 'partial', value: null },
    );
  });

  it('allows a manual purchase total only against the whole-inventory budget', () => {
    const totalOnly = { ...closed, allocation: 'total_only' as const, byBudgetKey: null };
    assert.deepEqual(resolveInventoryBudgetActual(totalOnly, 'total'), { state: 'complete', value: 850 });
    assert.deepEqual(resolveInventoryBudgetActual(totalOnly, 'housekeeping'), { state: 'unallocated', value: null });
  });

  it('returns exclusive itemized budget buckets and a real zero for an empty bucket', () => {
    assert.deepEqual(resolveInventoryBudgetActual(closed, 'housekeeping'), { state: 'complete', value: 500 });
    assert.deepEqual(resolveInventoryBudgetActual(closed, 'breakfast'), { state: 'complete', value: 0 });
  });
});

describe('inventoryBudgetBand', () => {
  it('classifies only a supplied closed actual', () => {
    assert.equal(inventoryBudgetBand(0, 500), 'nocap');
    assert.equal(inventoryBudgetBand(1000, 799), 'ok');
    assert.equal(inventoryBudgetBand(1000, 800), 'near');
    assert.equal(inventoryBudgetBand(1000, 1001), 'over');
  });
});

describe('inventory budget presentation evidence', () => {
  const period: InventoryBudgetActualPeriod = {
    ...closed,
    monthStart: '2026-06-01',
    usageBudgetMode: null,
    usageBudgetTotalValue: null,
    usageBudgetByKey: null,
    purchasesValue: null,
    loggedPurchasesComplete: true,
    loggedPurchasesValue: 0,
  };

  it('never borrows a mutable planning cap for a legacy closed actual', () => {
    assert.equal(inventoryBudgetComparisonCap(period, 'total', 999), null);
    assert.equal(
      inventoryBudgetComparisonCap({ ...period, status: 'open' }, 'total', 999),
      999,
    );
  });

  it('distinguishes missing period evidence from a confirmed logged zero', () => {
    assert.equal(inventoryPurchaseEvidence(null), null);
    assert.deepEqual(inventoryPurchaseEvidence(period), { state: 'logged', value: 0 });
  });
});

describe('inventoryBudgetPeriodsFromDashboard', () => {
  it('converts cents once and lets the live month replace stale history', () => {
    const dashboard: InventoryMonthCloseDashboard = {
      propertyId: 'property-1',
      month: '2026-07',
      timezone: 'America/Chicago',
      status: 'open',
      closeId: 'close-1',
      canStart: false,
      canClose: false,
      closeAvailableOn: '2026-08-01',
      window: {
        monthStart: '2026-07-01T05:00:00.000Z',
        endExclusive: '2026-08-01T05:00:00.000Z',
        graceEndExclusive: '2026-08-04T05:00:00.000Z',
        activityStartAt: '2026-07-01T05:00:00.000Z',
      },
      isPartial: false,
      budgetComparisonAvailable: false,
      baselineAt: '2026-07-01T05:00:00.000Z',
      closedAt: null,
      closedByName: null,
      notes: null,
      // The open dashboard may preview logged purchases in the equation, but
      // that preview must never become "confirmed at close" presentation data.
      totals: { beginningCents: 100_00, openingAdjustmentCents: 0, purchasesCents: 25_00, endingCents: null, actualUsageCents: null },
      purchase: {
        source: null,
        allocationMode: null,
        loggedDeliveryCount: 2,
        loggedPurchaseCents: 25_00,
        knownLoggedPurchaseCents: 25_00,
        uncostedDeliveryCount: 0,
        manualPurchaseCents: null,
        // Status is authoritative: even a malformed/open payload cannot expose
        // this number as an immutable close confirmation.
        confirmedPurchaseCents: 25_00,
      },
      completeness: { complete: false, readyToClose: false, blockers: [], warnings: [] },
      items: [],
      byCategory: null,
      byItem: null,
      byBudgetKey: null,
      usageBudgetMode: null,
      usageBudgetTotalCents: null,
      usageBudgetByKey: null,
      history: [
        {
          closeId: 'stale-live-row', month: '2026-07', status: 'closed', isPartial: false,
          budgetComparisonAvailable: true, purchaseSource: 'zero', allocationMode: 'itemized',
          beginningCents: 1, openingAdjustmentCents: 0, purchasesCents: 0, loggedPurchaseCents: 0,
          knownLoggedPurchaseCents: 0, endingCents: 0, actualUsageCents: 1,
          byCategory: { housekeeping: 1, maintenance: 0, breakfast: 0 },
          byItem: {}, byBudgetKey: { housekeeping: 1 }, complete: true,
          usageBudgetMode: 'sections', usageBudgetTotalCents: 1,
          usageBudgetByKey: { housekeeping: 1 },
          closedAt: '2026-08-01T06:00:00.000Z',
        },
        {
          closeId: 'close-0', month: '2026-06', status: 'closed', isPartial: false,
          budgetComparisonAvailable: true, purchaseSource: 'logged_deliveries', allocationMode: 'itemized',
          beginningCents: 100_00, openingAdjustmentCents: 0, purchasesCents: 60_00, loggedPurchaseCents: 60_00,
          knownLoggedPurchaseCents: 60_00, endingCents: 75_00, actualUsageCents: 85_00,
          byCategory: { housekeeping: 50_00, maintenance: 35_00, breakfast: 0 },
          byItem: { 'item-1': 50_00 }, byBudgetKey: { housekeeping: 50_00, maintenance: 35_00 },
          usageBudgetMode: 'sections', usageBudgetTotalCents: 100_00,
          usageBudgetByKey: { housekeeping: 60_00, maintenance: 40_00 },
          complete: true, closedAt: '2026-07-01T06:00:00.000Z',
        },
      ],
    };

    assert.deepEqual(inventoryBudgetPeriodsFromDashboard(dashboard), [
      {
        monthStart: '2026-07-01', status: 'open', isPartial: false, allocation: 'pending',
        actualUsageValue: null, byBudgetKey: null, purchasesValue: null, loggedPurchasesValue: 25,
        loggedPurchasesComplete: true, usageBudgetMode: null, usageBudgetTotalValue: null,
        usageBudgetByKey: null,
      },
      {
        monthStart: '2026-06-01', status: 'closed', isPartial: false, allocation: 'itemized',
        actualUsageValue: 85, byBudgetKey: { housekeeping: 50, maintenance: 35 },
        purchasesValue: 60, loggedPurchasesValue: 60, loggedPurchasesComplete: true,
        usageBudgetMode: 'sections', usageBudgetTotalValue: 100,
        usageBudgetByKey: { housekeeping: 60, maintenance: 40 },
      },
    ]);
  });

  it('keeps an incomplete logged subtotal visibly incomplete', () => {
    const dashboard = {
      propertyId: 'property-1', month: '2026-07', timezone: 'America/Chicago',
      status: 'open', closeId: 'close-1', canStart: false, canClose: false,
      closeAvailableOn: '2026-08-01',
      window: {
        monthStart: '2026-07-01T05:00:00.000Z', endExclusive: '2026-08-01T05:00:00.000Z',
        graceEndExclusive: '2026-08-04T05:00:00.000Z', activityStartAt: '2026-07-01T05:00:00.000Z',
      },
      isPartial: false, budgetComparisonAvailable: false, baselineAt: '2026-07-01T05:00:00.000Z',
      closedAt: null, closedByName: null, notes: null,
      totals: { beginningCents: 10_000, openingAdjustmentCents: 0, purchasesCents: null, endingCents: null, actualUsageCents: null },
      purchase: {
        source: null, allocationMode: null, loggedDeliveryCount: 2,
        loggedPurchaseCents: null, knownLoggedPurchaseCents: 2_500,
        uncostedDeliveryCount: 1, manualPurchaseCents: null, confirmedPurchaseCents: null,
      },
      completeness: { complete: false, readyToClose: false, blockers: [], warnings: [] },
      items: [], byCategory: null, byItem: null, byBudgetKey: null,
      usageBudgetMode: null, usageBudgetTotalCents: null, usageBudgetByKey: null,
      history: [],
    } satisfies InventoryMonthCloseDashboard;
    assert.equal(inventoryBudgetPeriodsFromDashboard(dashboard)[0].loggedPurchasesValue, 25);
    assert.equal(inventoryBudgetPeriodsFromDashboard(dashboard)[0].loggedPurchasesComplete, false);
  });

  it('resolves a closed period against its frozen cap, not a live budget row', () => {
    const period = inventoryBudgetPeriodsFromDashboard({
      ...({} as InventoryMonthCloseDashboard),
      propertyId: 'property-1', month: '2026-06', timezone: 'UTC', status: 'closed',
      closeId: 'close-1', canStart: false, canClose: false, closeAvailableOn: '2026-07-01',
      window: {
        monthStart: '2026-06-01T00:00:00.000Z', endExclusive: '2026-07-01T00:00:00.000Z',
        graceEndExclusive: '2026-07-04T00:00:00.000Z', activityStartAt: '2026-06-01T00:00:00.000Z',
      },
      isPartial: false, budgetComparisonAvailable: true, baselineAt: '2026-06-01T00:00:00.000Z',
      closedAt: '2026-07-01T01:00:00.000Z', closedByName: 'Manager', notes: null,
      totals: { beginningCents: 10_000, openingAdjustmentCents: 0, purchasesCents: 2_000, endingCents: 8_000, actualUsageCents: 4_000 },
      purchase: {
        source: 'logged_deliveries', allocationMode: 'itemized', loggedDeliveryCount: 1,
        loggedPurchaseCents: 2_000, knownLoggedPurchaseCents: 2_000, uncostedDeliveryCount: 0,
        manualPurchaseCents: null, confirmedPurchaseCents: 2_000,
      },
      completeness: { complete: true, readyToClose: false, blockers: [], warnings: [] },
      items: [], byCategory: null, byItem: null, byBudgetKey: { housekeeping: 4_000 },
      usageBudgetMode: 'sections', usageBudgetTotalCents: 5_000,
      usageBudgetByKey: { housekeeping: 5_000 }, history: [],
    })[0];

    assert.equal(inventoryBudgetSnapshotCap(period, 'total'), 50);
    assert.equal(inventoryBudgetSnapshotCap(period, 'housekeeping'), 50);
    assert.equal(inventoryBudgetSnapshotCap(period, 'maintenance'), 0);
  });
});
