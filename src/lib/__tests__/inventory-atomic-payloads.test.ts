import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideQuickCountWrite,
  deliveryLinesFromCommitPlan,
  inventoryPayloadFingerprint,
  toInventoryCountRpcRows,
  toInventoryDeliveryRpcLines,
} from '../inventory-atomic';
import { buildCommitPlan } from '../inventory-invoice-commit';

describe('atomic inventory count payload', () => {
  test('maps the typed count contract without client-computed ledger fields', () => {
    assert.deepEqual(toInventoryCountRpcRows([
      { itemId: 'item-a', expectedStock: 9, countedStock: 12, estimatedStock: 10.5, notes: 'Top shelf' },
      { itemId: 'item-b', expectedStock: 0, countedStock: 0 },
    ]), [
      { item_id: 'item-a', expected_stock: 9, counted_stock: 12, estimated_stock: 10.5, notes: 'Top shelf' },
      { item_id: 'item-b', expected_stock: 0, counted_stock: 0 },
    ]);
  });

  test('rejects negative/non-finite stock and duplicate item ids', () => {
    assert.throws(() => toInventoryCountRpcRows([{ itemId: 'a', expectedStock: 0, countedStock: -1 }]));
    assert.throws(() => toInventoryCountRpcRows([{ itemId: 'a', expectedStock: 0, countedStock: Number.NaN }]));
    assert.throws(() => toInventoryCountRpcRows([{ itemId: 'a', expectedStock: Number.POSITIVE_INFINITY, countedStock: 1 }]));
    assert.throws(() => toInventoryCountRpcRows([
      { itemId: 'a', expectedStock: 0, countedStock: 1 },
      { itemId: 'a', expectedStock: 0, countedStock: 2 },
    ]));
  });
});

describe('quick-count ordering', () => {
  test('writes a return to the stale snapshot after a different value just committed', () => {
    // The UI still displays 10, but the queued first write has committed 11.
    // The user's final 10 is therefore a real last-write-wins correction.
    assert.equal(decideQuickCountWrite(10, 11, 10, true), 'write');
  });

  test('skips only a confirmed local save or an otherwise-current snapshot', () => {
    assert.equal(decideQuickCountWrite(11, 11, 10, true), 'skip-saved');
    assert.equal(decideQuickCountWrite(10, undefined, 10, true), 'skip-current');
    assert.equal(decideQuickCountWrite(0, undefined, 0, false), 'write');
  });
});

describe('atomic inventory delivery payload', () => {
  test('maps existing and create lines to the RPC contract', () => {
    assert.deepEqual(toInventoryDeliveryRpcLines([
      { lineKey: 'existing', itemId: 'item-a', quantity: 12, quantityCases: 2, unitCost: 1.25 },
      {
        lineKey: 'new', itemId: null, itemName: 'New Mop', category: 'housekeeping',
        unit: 'each', parLevel: 20, quantity: 4,
      },
    ]), [
      { line_key: 'existing', item_id: 'item-a', quantity: 12, quantity_cases: 2, unit_cost: 1.25 },
      {
        line_key: 'new', item_id: null, item_name: 'New Mop', category: 'housekeeping',
        unit: 'each', par_level: 20, quantity: 4,
      },
    ]);
  });

  test('rejects invalid quantities, duplicate line keys, and incomplete creates', () => {
    assert.throws(() => toInventoryDeliveryRpcLines([{ lineKey: 'a', itemId: 'item', quantity: 0 }]));
    assert.throws(() => toInventoryDeliveryRpcLines([
      { lineKey: 'a', itemId: 'item', quantity: 1 },
      { lineKey: 'a', itemId: 'other', quantity: 1 },
    ]));
    assert.throws(() => toInventoryDeliveryRpcLines([{
      lineKey: 'new', itemId: null, itemName: '', category: 'housekeeping', unit: 'each', parLevel: 0, quantity: 1,
    }]));
  });

  test('invoice commit becomes additive lines and ignores stale absolute-stock projections', () => {
    const plan = buildCommitPlan({
      propertyTimezone: 'America/Chicago',
      vendorName: 'Acme',
      invoiceDate: '2026-07-15',
      lines: [
        {
          key: 'existing', itemName: 'Towel', decision: 'match', matchedItemId: 'item-a',
          qty: 5, onHandEstimate: 8, afterOverride: 999,
        },
        {
          key: 'new', itemName: 'Mop', decision: 'create', matchedItemId: null, qty: 3,
          newItem: { category: 'maintenance', unit: 'each', parLevel: 8 },
        },
      ],
    });
    const lines = deliveryLinesFromCommitPlan(plan);
    assert.deepEqual(lines[0], {
      lineKey: 'existing', itemId: 'item-a', quantity: 5, quantityCases: null, unitCost: undefined,
    });
    assert.deepEqual(lines[1], {
      lineKey: 'new', itemId: null, itemName: 'Mop', category: 'maintenance', unit: 'each',
      parLevel: 8, quantity: 3, quantityCases: null, unitCost: undefined,
    });
    assert.equal('finalStock' in lines[0], false);
  });

  test('fingerprint is stable for an unchanged retry and changes with quantity', () => {
    const a = [{ lineKey: 'a', itemId: 'item', quantity: 2 }];
    assert.equal(inventoryPayloadFingerprint(a), inventoryPayloadFingerprint([...a]));
    assert.notEqual(
      inventoryPayloadFingerprint(a),
      inventoryPayloadFingerprint([{ ...a[0], quantity: 3 }]),
    );
  });
});
