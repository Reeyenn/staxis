import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inventoryPurchaseRowValue } from '../inventory-purchase-cost';

describe('inventory purchase cost completeness', () => {
  it('prefers an authoritative line total and accepts a real zero-dollar line', () => {
    assert.equal(inventoryPurchaseRowValue({ quantity: 4, unit_cost: 99, total_cost: 10 }), 10);
    assert.equal(inventoryPurchaseRowValue({ quantity: 4, unit_cost: null, total_cost: 0 }), 0);
  });

  it('uses quantity times unit cost only when both are usable', () => {
    assert.equal(inventoryPurchaseRowValue({ quantity: 4, unit_cost: 2.5, total_cost: null }), 10);
    assert.equal(inventoryPurchaseRowValue({ quantity: 4, unit_cost: 0, total_cost: null }), 0);
  });

  it('returns incomplete instead of silently turning missing or invalid cost into zero', () => {
    assert.equal(inventoryPurchaseRowValue({ quantity: 4, unit_cost: null, total_cost: null }), null);
    assert.equal(inventoryPurchaseRowValue({ quantity: 0, unit_cost: 2.5, total_cost: null }), null);
    assert.equal(inventoryPurchaseRowValue({ quantity: 4, unit_cost: -1, total_cost: null }), null);
  });

  it('accepts an explicit signed compensating correction total', () => {
    assert.equal(inventoryPurchaseRowValue({
      entry_kind: 'correction', quantity: -4, unit_cost: 2.5, total_cost: -10,
    }), -10);
    assert.equal(inventoryPurchaseRowValue({
      entry_kind: 'correction', quantity: 4, unit_cost: 2.5, total_cost: 10,
    }), 10);
    assert.equal(inventoryPurchaseRowValue({
      entry_kind: 'correction', quantity: -4, unit_cost: 2.5, total_cost: null,
    }), null);
  });
});
