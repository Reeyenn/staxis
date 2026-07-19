import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { InventoryMonthCloseHistoryRow } from '../inventory-month-close';
import type { InventoryItem, InventoryOrder } from '../../types';
import {
  buildHistoryEvents,
  historyEventsForViewer,
  type HistoryEvent,
} from '../../app/inventory/_components/history-events';

function closeRow(
  overrides: Partial<InventoryMonthCloseHistoryRow> = {},
): InventoryMonthCloseHistoryRow {
  return {
    closeId: 'close-1',
    month: '2026-06',
    status: 'closed',
    isPartial: false,
    budgetComparisonAvailable: true,
    purchaseSource: 'logged_deliveries',
    allocationMode: 'itemized',
    beginningCents: 100_00,
    openingAdjustmentCents: 0,
    purchasesCents: 50_00,
    loggedPurchaseCents: 50_00,
    knownLoggedPurchaseCents: 50_00,
    endingCents: 70_00,
    actualUsageCents: 80_00,
    byCategory: { housekeeping: 80_00, maintenance: 0, breakfast: 0 },
    byItem: { 'item-1': 80_00 },
    byBudgetKey: { housekeeping: 80_00 },
    usageBudgetMode: 'sections',
    usageBudgetTotalCents: 100_00,
    usageBudgetByKey: { housekeeping: 100_00 },
    complete: true,
    closedAt: '2026-07-01T06:30:00.000Z',
    ...overrides,
  };
}

function deliveryRow(
  id: string,
  totalCost?: number,
  overrides: Partial<InventoryOrder> = {},
): InventoryOrder {
  return {
    id,
    propertyId: 'property-1',
    itemId: `item-${id}`,
    itemName: `Item ${id}`,
    quantity: 1,
    totalCost,
    vendorName: 'Vendor',
    orderedAt: new Date('2026-06-15T12:00:00.000Z'),
    receivedAt: new Date('2026-06-15T12:00:00.000Z'),
    notes: 'Manual delivery',
    ...overrides,
  };
}

function itemRow(id: string, createdAt: string): InventoryItem {
  return {
    id,
    propertyId: 'property-1',
    name: `Item ${id}`,
    category: 'housekeeping',
    currentStock: 1,
    parLevel: 1,
    unit: 'each',
    updatedAt: null,
    createdAt: new Date(createdAt),
  };
}

describe('inventory History property-day grouping', () => {
  it('groups item additions by the hotel day, not the runtime calendar', () => {
    const events = buildHistoryEvents(
      [],
      [],
      [
        itemRow('before-utc-midnight', '2026-06-30T23:30:00.000Z'),
        itemRow('after-utc-midnight', '2026-07-01T00:30:00.000Z'),
      ],
      [],
      'America/Los_Angeles',
    );

    assert.equal(events.length, 1);
    assert.equal(events[0].id, 'added:2026-06-30');
    assert.deepEqual(events[0].lines.map((line) => line.name), [
      'Item after-utc-midnight',
      'Item before-utc-midnight',
    ]);
  });
});

describe('inventory History delivery cost completeness', () => {
  it('carries an exact subtotal only when every delivery line has a usable cost', () => {
    const event = buildHistoryEvents(
      [],
      [deliveryRow('one', 12.5), deliveryRow('two', 7.5)],
      [],
    )[0];

    assert.equal(event.kind, 'delivery');
    assert.equal(event.amount, 20);
    assert.deepEqual(event.deliveryCost, { knownSubtotal: 20, complete: true });
  });

  it('carries the known subtotal and marks the event incomplete when any cost is missing', () => {
    const event = buildHistoryEvents(
      [],
      [deliveryRow('known', 12.5), deliveryRow('missing')],
      [],
    )[0];

    assert.equal(event.amount, 12.5);
    assert.deepEqual(event.deliveryCost, { knownSubtotal: 12.5, complete: false });
    assert.deepEqual(event.lines.map((line) => line.amount), [12.5, undefined]);
  });

  it('falls back to quantity times unit cost when the stored total is absent', () => {
    const event = buildHistoryEvents(
      [],
      [deliveryRow('fallback', undefined, { quantity: 4, unitCost: 2.5 })],
      [],
    )[0];

    assert.equal(event.amount, 10);
    assert.deepEqual(event.deliveryCost, { knownSubtotal: 10, complete: true });
    assert.equal(event.lines[0].amount, 10);
  });

  it('represents an entirely uncosted delivery as an incomplete zero known subtotal', () => {
    const event = buildHistoryEvents([], [deliveryRow('missing')], [])[0];

    assert.equal(event.amount, 0);
    assert.deepEqual(event.deliveryCost, { knownSubtotal: 0, complete: false });
  });
});

describe('inventory History month-close events', () => {
  it('adds only closed snapshots and keeps the accounting equation separate', () => {
    const events = buildHistoryEvents([], [], [], [
      closeRow({ closeId: 'open', status: 'open', complete: false, closedAt: null }),
      closeRow(),
    ]);

    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'monthClose');
    assert.equal(events[0].amount, 80);
    assert.deepEqual(events[0].lines, []);
    assert.deepEqual(events[0].monthClose, {
      month: '2026-06',
      isPartial: false,
      budgetComparisonAvailable: true,
      allocationMode: 'itemized',
      purchaseSource: 'logged_deliveries',
      beginningAmount: 100,
      openingAdjustmentAmount: 0,
      purchasesAmount: 50,
      loggedPurchaseAmount: 50,
      knownLoggedPurchaseAmount: 50,
      endingAmount: 70,
      actualUsageAmount: 80,
    });
  });

  it('discloses pre-existing shelf stock added to beginning inventory after baseline', () => {
    const event = buildHistoryEvents([], [], [], [closeRow({
      beginningCents: 125_00,
      openingAdjustmentCents: 25_00,
    })])[0];

    assert.equal(event.monthClose?.beginningAmount, 125);
    assert.equal(event.monthClose?.openingAdjustmentAmount, 25);
  });

  it('preserves partial/total-only state and incomplete logged-cost subtotal', () => {
    const event = buildHistoryEvents([], [], [], [closeRow({
      closeId: 'partial-manual',
      isPartial: true,
      budgetComparisonAvailable: false,
      purchaseSource: 'manual_total',
      allocationMode: 'total_only',
      loggedPurchaseCents: null,
      knownLoggedPurchaseCents: 12_34,
      byCategory: null,
      byItem: null,
      byBudgetKey: null,
    })])[0];

    assert.equal(event.monthClose?.isPartial, true);
    assert.equal(event.monthClose?.allocationMode, 'total_only');
    assert.equal(event.monthClose?.loggedPurchaseAmount, null);
    assert.equal(event.monthClose?.knownLoggedPurchaseAmount, 12.34);
  });

  it('removes close money from a non-finance viewer without dropping normal history', () => {
    const close = buildHistoryEvents([], [], [], [closeRow()])[0];
    const normal: HistoryEvent = {
      id: 'added:2026-06-01',
      kind: 'itemsAdded',
      date: new Date('2026-06-01T12:00:00.000Z'),
      who: null,
      byAssistant: false,
      invoiceNumber: null,
      lines: [{ name: 'Towels' }],
      amount: null,
    };

    assert.deepEqual(historyEventsForViewer([close, normal], false), [normal]);
    assert.deepEqual(historyEventsForViewer([close, normal], true), [close, normal]);
  });
});
