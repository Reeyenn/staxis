import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  summarizeEffectivePurchases,
  type EffectivePurchaseCorrectionInput,
  type EffectivePurchaseOrderInput,
} from '../inventory-effective-purchases';

const root = (
  id: string,
  totalCost: number | null,
  itemId = 'item-a',
): EffectivePurchaseOrderInput => ({
  id,
  item_id: itemId,
  quantity: 2,
  unit_cost: totalCost == null ? null : totalCost / 2,
  total_cost: totalCost,
  entry_kind: 'receipt',
  received_at: '2026-07-10T12:00:00.000Z',
});

const correctionLedger = (
  id: string,
  rootId: string,
  eventId: string,
  quantity: number,
  totalCost: number | null,
  itemId = 'item-a',
): EffectivePurchaseOrderInput => ({
  id,
  item_id: itemId,
  quantity,
  unit_cost: null,
  total_cost: totalCost,
  entry_kind: 'correction',
  corrects_order_id: rootId,
  correction_event_id: eventId,
  received_at: '2026-07-10T12:00:00.000Z',
});

const correction = (
  id: string,
  rootId: string,
  patch: Partial<EffectivePurchaseCorrectionInput> = {},
): EffectivePurchaseCorrectionInput => ({
  id,
  original_order_id: rootId,
  prior_correction_id: null,
  correction_kind: 'correction',
  corrected_item_id: 'item-a',
  corrected_quantity: 2,
  corrected_total_cost: 10,
  ...patch,
});

describe('effective inventory purchases', () => {
  it('turns an originally uncosted receipt into a complete corrected value', () => {
    const orders = [
      root('root-1', null),
      correctionLedger('reverse-1', 'root-1', 'fix-1', -2, null),
      correctionLedger('replace-1', 'root-1', 'fix-1', 2, 10),
    ];
    const result = summarizeEffectivePurchases(orders, [correction('fix-1', 'root-1')]);
    assert.equal(result.uncostedDeliveryCount, 0);
    assert.equal(result.loggedPurchaseCents, 1_000);
    assert.deepEqual(result.byItem.get('item-a'), { quantity: 2, cents: 1_000 });
  });

  it('keeps a terminal unknown correction incomplete without retaining the superseded known value', () => {
    const orders = [
      root('root-1', 10),
      correctionLedger('reverse-1', 'root-1', 'fix-1', -2, -10),
      correctionLedger('replace-1', 'root-1', 'fix-1', 3, null),
    ];
    const result = summarizeEffectivePurchases(orders, [correction('fix-1', 'root-1', {
      corrected_quantity: 3,
      corrected_total_cost: null,
    })]);
    assert.equal(result.uncostedDeliveryCount, 1);
    assert.equal(result.knownLoggedPurchaseCents, 0);
    assert.equal(result.loggedPurchaseCents, null);
  });

  it('treats a fully voided uncosted receipt as audited complete zero', () => {
    const orders = [
      root('root-1', null),
      correctionLedger('reverse-1', 'root-1', 'void-1', -2, null),
    ];
    const result = summarizeEffectivePurchases(orders, [correction('void-1', 'root-1', {
      correction_kind: 'void',
      corrected_item_id: null,
      corrected_quantity: 0,
      corrected_total_cost: null,
    })]);
    assert.equal(result.loggedDeliveryCount, 1);
    assert.equal(result.uncostedDeliveryCount, 0);
    assert.equal(result.loggedPurchaseCents, 0);
    assert.equal(result.receipts[0].voided, true);
  });

  it('uses the terminal correction item and rejects a disconnected chain', () => {
    const orders = [
      root('root-1', 10),
      correctionLedger('reverse-1', 'root-1', 'fix-1', -2, -10),
      correctionLedger('replace-1', 'root-1', 'fix-1', 4, 24, 'item-b'),
    ];
    const moved = summarizeEffectivePurchases(orders, [correction('fix-1', 'root-1', {
      corrected_item_id: 'item-b',
      corrected_quantity: 4,
      corrected_total_cost: 24,
    })]);
    assert.deepEqual(moved.byItem.get('item-b'), { quantity: 4, cents: 2_400 });
    assert.equal(moved.byItem.has('item-a'), false);

    assert.throws(() => summarizeEffectivePurchases(orders, [
      correction('fix-1', 'root-1'),
      correction('fix-2', 'root-1'),
    ]), /unique terminal|disconnected/i);
  });
});
