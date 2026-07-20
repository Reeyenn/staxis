import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inventoryMonthCloseMutationReceipt,
  isCurrentMonthCloseMutation,
  normalizeMonthCloseDashboard,
  normalizeMonthCloseDashboardForProperty,
  normalizeMonthCloseMutationReceipt,
} from '../inventory-month-close-contract';

function validDashboard(): Record<string, unknown> {
  return {
    propertyId: 'property-1',
    month: '2026-07',
    timezone: 'America/Chicago',
    status: 'open',
    canStart: false,
    canClose: false,
    closeAvailableOn: '2026-08-01',
    closeId: 'close-1',
    isPartial: true,
    budgetComparisonAvailable: false,
    baselineAt: '2026-07-01T05:00:00.000Z',
    closedAt: null,
    closedByName: null,
    window: {
      monthStart: '2026-07-01T05:00:00.000Z',
      endExclusive: '2026-08-01T05:00:00.000Z',
      graceEndExclusive: '2026-08-04T05:00:00.000Z',
      activityStartAt: '2026-07-01T05:00:00.000Z',
    },
    totals: {
      beginningCents: 10000,
      openingAdjustmentCents: 0,
      purchasesCents: 2000,
      endingCents: null,
      actualUsageCents: null,
    },
    purchase: {
      source: null,
      allocationMode: null,
      loggedDeliveryCount: 2,
      loggedPurchaseCents: 2000,
      knownLoggedPurchaseCents: 2000,
      uncostedDeliveryCount: 0,
      manualPurchaseCents: null,
      confirmedPurchaseCents: null,
    },
    completeness: { complete: false, readyToClose: false, blockers: [], warnings: [] },
    items: [{
      itemId: 'item-1',
      itemName: 'Queen sheets',
      archivedAt: null,
      endingQuantity: null,
      beginningUnitCostCents: 1075,
      endingUnitCostCents: 1075,
      physicalUnitCostCents: null,
      endingCountedAt: null,
    }],
  };
}

test('month close accepts a complete dashboard contract', () => {
  assert.ok(normalizeMonthCloseDashboard({ data: { dashboard: validDashboard() } }));
});

test('month close rejects missing financial evidence instead of creating fake zeroes', () => {
  const missingTotals = validDashboard();
  delete missingTotals.totals;
  assert.equal(normalizeMonthCloseDashboard(missingTotals), null);

  const partialPurchase = validDashboard();
  delete (partialPurchase.purchase as Record<string, unknown>).knownLoggedPurchaseCents;
  assert.equal(normalizeMonthCloseDashboard(partialPurchase), null);

  const invalidCount = validDashboard();
  (invalidCount.purchase as Record<string, unknown>).loggedDeliveryCount = -1;
  assert.equal(normalizeMonthCloseDashboard(invalidCount), null);

  const missingItems = validDashboard();
  delete missingItems.items;
  assert.equal(normalizeMonthCloseDashboard(missingItems), null);

  const missingCompleteness = validDashboard();
  delete missingCompleteness.completeness;
  assert.equal(normalizeMonthCloseDashboard(missingCompleteness), null);
});

test('month close rejects invented issue messages and invalid hotel timezones', () => {
  const badIssue = validDashboard();
  (badIssue.completeness as Record<string, unknown>).blockers = [{ code: 'missing_cost' }];
  assert.equal(normalizeMonthCloseDashboard(badIssue), null);

  const badTimezone = validDashboard();
  badTimezone.timezone = 'hotel-local-time';
  assert.equal(normalizeMonthCloseDashboard(badTimezone), null);
});

test('month close rejects a complete dashboard for a different hotel', () => {
  assert.ok(normalizeMonthCloseDashboardForProperty(validDashboard(), 'property-1'));
  assert.equal(normalizeMonthCloseDashboardForProperty(validDashboard(), 'property-2'), null);
});

test('month close validates the committed-without-dashboard receipt', () => {
  const receipt = inventoryMonthCloseMutationReceipt({
    propertyId: 'property-1',
    month: '2026-07',
    action: 'close',
    mutationRequestId: 'request-1',
  });
  assert.deepEqual(normalizeMonthCloseMutationReceipt({ data: receipt }), receipt);
  assert.equal(normalizeMonthCloseMutationReceipt({
    data: { ...receipt, mutationRequestId: null },
  }), null);
  assert.equal(normalizeMonthCloseMutationReceipt({
    data: { ...receipt, dashboard: {} },
  }), null);
});

test('month close ignores a save response after a hotel switch or newer save', () => {
  const scope = { propertyId: 'property-1', sequence: 7 };
  assert.equal(isCurrentMonthCloseMutation(scope, 'property-1', 7), true);
  assert.equal(isCurrentMonthCloseMutation(scope, 'property-2', 7), false);
  assert.equal(isCurrentMonthCloseMutation(scope, 'property-1', 8), false);
});
