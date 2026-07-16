import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  InventoryItemCreatePersistenceError,
  clearInventoryItemCreateAttempt,
  createFrozenInventoryItemAttempt,
  inventoryItemCreateMarker,
  isDefinitiveInventoryItemCreateFailure,
  loadInventoryItemCreateAttempt,
  persistInventoryItemCreateAttempt,
} from '../inventory-item-create-attempt';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function attempt() {
  return createFrozenInventoryItemAttempt({
    propertyId: 'property-a',
    requestId: 'request-a',
    itemId: 'item-a',
    startedAt: '2026-07-15T20:00:00.000Z',
    nameInput: '  Bath towels  ',
    category: 'housekeeping',
    customCategoryId: null,
    currentStockInput: '24',
    parLevelInput: '40',
    unitCostInput: '2.50',
    vendorInput: '  Linen Co  ',
    vendorId: 'vendor-a',
    includeUnitCost: true,
  });
}

describe('primary Add Item durable retry envelope', () => {
  test('round-trips raw form fields and the immutable canonical insert', () => {
    const storage = memoryStorage();
    const value = attempt();
    persistInventoryItemCreateAttempt(value, storage);

    assert.deepEqual(loadInventoryItemCreateAttempt('property-a', storage), value);
    assert.equal(value.name, 'Bath towels');
    assert.equal(value.currentStock, 24);
    assert.equal(value.unitCost, 2.5);
    assert.equal(value.vendorName, 'Linen Co');
    assert.equal(inventoryItemCreateMarker(value.requestId), 'staxis:add-item:request-a');
  });

  test('fails before insert when storage is missing, throws, or silently drops writes', () => {
    const value = attempt();
    assert.throws(
      () => persistInventoryItemCreateAttempt(value, null),
      InventoryItemCreatePersistenceError,
    );
    assert.throws(() => persistInventoryItemCreateAttempt(value, {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
      removeItem: () => {},
    }), InventoryItemCreatePersistenceError);
    assert.throws(() => persistInventoryItemCreateAttempt(value, {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    }), InventoryItemCreatePersistenceError);
  });

  test('cleanup cannot erase a newer request for the same property', () => {
    const storage = memoryStorage();
    const newer = { ...attempt(), requestId: 'request-new', itemId: 'item-new' };
    persistInventoryItemCreateAttempt(newer, storage);
    clearInventoryItemCreateAttempt('property-a', 'request-old', storage);
    assert.deepEqual(loadInventoryItemCreateAttempt('property-a', storage), newer);
    clearInventoryItemCreateAttempt('property-a', 'request-new', storage);
    assert.equal(loadInventoryItemCreateAttempt('property-a', storage), null);
  });

  test('rejects a stored canonical payload that no longer matches its raw fields', () => {
    const storage = memoryStorage();
    storage.setItem('staxis:inventory-item-create-attempt:property-a', JSON.stringify({
      ...attempt(),
      currentStock: 2400,
    }));
    assert.equal(loadInventoryItemCreateAttempt('property-a', storage), null);
    assert.throws(
      () => persistInventoryItemCreateAttempt({ ...attempt(), name: 'Changed' }, storage),
      InventoryItemCreatePersistenceError,
    );
  });

  test('does not retain financial input when the user cannot save it', () => {
    const value = createFrozenInventoryItemAttempt({
      propertyId: 'property-a', requestId: 'request-a', itemId: 'item-a',
      startedAt: '2026-07-15T20:00:00.000Z', nameInput: 'Soap',
      category: 'housekeeping', customCategoryId: null,
      currentStockInput: '.', parLevelInput: '-1', unitCostInput: '99',
      vendorInput: '', vendorId: null, includeUnitCost: false,
    });
    assert.equal(value.currentStock, 0);
    assert.equal(value.parLevel, 0);
    assert.equal(value.unitCost, null);
  });

  test('keeps transport-coded errors ambiguous but releases database rejections', () => {
    assert.equal(isDefinitiveInventoryItemCreateFailure({ code: '23505' }), true);
    assert.equal(isDefinitiveInventoryItemCreateFailure({ code: 'PGRST116' }), true);
    assert.equal(isDefinitiveInventoryItemCreateFailure({ code: 'ECONNRESET' }), false);
    assert.equal(isDefinitiveInventoryItemCreateFailure({ code: 'EPIPE' }), false);
    assert.equal(isDefinitiveInventoryItemCreateFailure({ code: 'NETWORK_ERROR' }), false);
  });
});
