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
    setAsideInput: '03',
    parLevelInput: '40',
    unitCostInput: '2.50',
    vendorInput: '  Linen Co  ',
    vendorId: 'vendor-a',
    includeUnitCost: true,
    openingAdjustmentConfirmed: true,
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
    assert.equal(value.setAsideInput, '03');
    assert.equal(value.setAside, 3);
    assert.equal(value.unitCost, 2.5);
    assert.equal(value.openingAdjustmentConfirmed, true);
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
    storage.setItem('staxis:inventory-item-create-attempt:property-a', JSON.stringify({
      ...attempt(),
      setAside: 30,
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
      currentStockInput: '.', setAsideInput: '', parLevelInput: '-1', unitCostInput: '99',
      vendorInput: '', vendorId: null, includeUnitCost: false,
      openingAdjustmentConfirmed: false,
    });
    assert.equal(value.currentStock, 0);
    assert.equal(value.setAside, 0);
    assert.equal(value.parLevel, 0);
    assert.equal(value.unitCost, null);
  });

  test('requires explicit, costed opening-inventory provenance for positive stock', () => {
    const base = {
      propertyId: 'property-a', requestId: 'request-a', itemId: 'item-a',
      startedAt: '2026-07-15T20:00:00.000Z', nameInput: 'Soap',
      category: 'housekeeping' as const, customCategoryId: null,
      currentStockInput: '5', setAsideInput: '1', parLevelInput: '8', unitCostInput: '1.25',
      vendorInput: '', vendorId: null, includeUnitCost: true,
    };
    assert.throws(
      () => createFrozenInventoryItemAttempt({ ...base, openingAdjustmentConfirmed: false }),
      /pre-existing opening inventory/i,
    );
    assert.throws(
      () => createFrozenInventoryItemAttempt({
        ...base,
        unitCostInput: '',
        openingAdjustmentConfirmed: true,
      }),
      /unit cost/i,
    );
  });

  test('rejects Set Aside above On Hand', () => {
    assert.throws(() => createFrozenInventoryItemAttempt({
        propertyId: 'property-a', requestId: 'request-a', itemId: 'item-a',
        startedAt: '2026-07-15T20:00:00.000Z', nameInput: 'Towels',
        category: 'housekeeping', customCategoryId: null,
        currentStockInput: '4', setAsideInput: '5', parLevelInput: '8',
        unitCostInput: '1.25', vendorInput: '', vendorId: null,
        includeUnitCost: true, openingAdjustmentConfirmed: true,
      }),
      /cannot exceed on-hand/i,
    );
  });

  test('upgrades legacy retries without changing their item or request identity', () => {
    const storage = memoryStorage();
    const current = attempt();
    const {
      setAsideInput: _setAsideInput,
      setAside: _setAside,
      openingAdjustmentConfirmed: _openingAdjustmentConfirmed,
      ...withoutV3Fields
    } = current;
    void _setAsideInput;
    void _setAside;
    void _openingAdjustmentConfirmed;
    const v1 = { ...withoutV3Fields, version: 1 };
    storage.setItem('staxis:inventory-item-create-attempt:property-a', JSON.stringify(v1));

    const upgradedV1 = loadInventoryItemCreateAttempt('property-a', storage);
    assert.equal(upgradedV1?.version, 3);
    assert.equal(upgradedV1?.requestId, current.requestId);
    assert.equal(upgradedV1?.itemId, current.itemId);
    assert.equal(upgradedV1?.setAsideInput, '0');
    assert.equal(upgradedV1?.setAside, 0);
    assert.equal(upgradedV1?.openingAdjustmentConfirmed, false);

    const v2 = {
      ...withoutV3Fields,
      version: 2,
      openingAdjustmentConfirmed: current.openingAdjustmentConfirmed,
    };
    storage.setItem('staxis:inventory-item-create-attempt:property-a', JSON.stringify(v2));
    const upgradedV2 = loadInventoryItemCreateAttempt('property-a', storage);
    assert.equal(upgradedV2?.version, 3);
    assert.equal(upgradedV2?.requestId, current.requestId);
    assert.equal(upgradedV2?.itemId, current.itemId);
    assert.equal(upgradedV2?.setAsideInput, '0');
    assert.equal(upgradedV2?.setAside, 0);
    assert.equal(upgradedV2?.openingAdjustmentConfirmed, true);

    storage.setItem('staxis:inventory-item-create-attempt:property-a', JSON.stringify({
      ...v2,
      setAsideInput: '4',
    }));
    assert.equal(loadInventoryItemCreateAttempt('property-a', storage), null);
  });

  test('keeps transport-coded errors ambiguous but releases database rejections', () => {
    assert.equal(isDefinitiveInventoryItemCreateFailure({ code: '23505' }), true);
    assert.equal(isDefinitiveInventoryItemCreateFailure({ code: 'PGRST116' }), true);
    assert.equal(isDefinitiveInventoryItemCreateFailure({ code: 'ECONNRESET' }), false);
    assert.equal(isDefinitiveInventoryItemCreateFailure({ code: 'EPIPE' }), false);
    assert.equal(isDefinitiveInventoryItemCreateFailure({ code: 'NETWORK_ERROR' }), false);
  });
});
