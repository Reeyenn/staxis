import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InventoryDeliveryCorrection, InventoryOrder } from '@/types';
import {
  inventoryDeliveryCorrectionRootChunks,
  mergeInventoryDeliveryCorrections,
} from '../inventory-delivery-corrections';

const root: InventoryOrder = {
  id: 'order-a', propertyId: 'hotel-a', itemId: 'item-a', itemName: 'Towels',
  quantity: 5, unitCost: 2, totalCost: 10, receivedAt: new Date('2026-07-19T10:00:00Z'),
};

function correction(overrides: Partial<InventoryDeliveryCorrection>): InventoryDeliveryCorrection {
  return {
    id: 'correction-z', propertyId: 'hotel-a', requestId: 'request-a', lineKey: 'line-a',
    originalOrderId: 'order-a', kind: 'correction', reason: 'Wrong quantity',
    correctedAt: new Date('2026-07-19T11:00:00Z'), correctedBy: 'Maria',
    previousItemId: 'item-a', previousItemName: 'Towels', previousQuantity: 5,
    previousUnitCost: 2, previousTotalCost: 10,
    correctedItemId: 'item-a', correctedItemName: 'Towels', correctedQuantity: 3,
    correctedUnitCost: 2, correctedTotalCost: 6,
    stockEffect: [], createdAt: new Date('2026-07-19T11:00:01Z'),
    ...overrides,
  };
}

test('effective delivery read model uses the latest immutable correction', () => {
  const first = correction({});
  const second = correction({
    id: 'correction-a', priorCorrectionId: first.id, reason: 'Actually never arrived',
    kind: 'void', previousQuantity: 3, previousTotalCost: 6,
    correctedItemId: null, correctedItemName: null, correctedQuantity: 0,
    correctedUnitCost: null, correctedTotalCost: null,
    // Equal server timestamps + reverse lexical ids prove the prior-id chain,
    // not timestamp/UUID guessing, chooses the effective terminal event.
    correctedAt: new Date('2026-07-19T12:00:00Z'), createdAt: new Date('2026-07-19T11:00:01Z'),
  });
  const [effective] = mergeInventoryDeliveryCorrections([root], [second, first]);
  assert.equal(effective.rootOrderId, root.id);
  assert.equal(effective.status, 'voided');
  assert.equal(effective.effectiveItemId, null);
  assert.equal(effective.effectiveQuantity, 0);
  assert.equal(effective.correctionCount, 2);
  assert.equal(effective.lastCorrection?.reason, 'Actually never arrived');
  assert.equal(effective.lastCorrection?.correctedBy, 'Maria');
});

test('uncorrected delivery remains active with an explicit root id', () => {
  const [effective] = mergeInventoryDeliveryCorrections([root], []);
  assert.equal(effective.status, 'active');
  assert.equal(effective.rootOrderId, root.id);
  assert.equal(effective.effectiveItemId, root.itemId);
  assert.equal(effective.effectiveTotalCost, 10);
  assert.equal(effective.lastCorrection, null);
});

test('501 delivery roots are split below the database 500-root limit', () => {
  const roots = Array.from({ length: 501 }, (_, index) => `order-${index}`);
  const chunks = inventoryDeliveryCorrectionRootChunks([...roots, roots[0]]);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [400, 101]);
  assert.deepEqual(chunks.flat(), roots);
  assert.ok(chunks.every((chunk) => chunk.length <= 500));
});
