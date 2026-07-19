import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clearInventoryOperationAttempt,
  loadInventoryOperationAttempt,
  persistInventoryOperationAttempt,
  type InventoryOperationAttemptStorage,
} from '../inventory-operation-attempt';

function memoryStorage(): InventoryOperationAttemptStorage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

const scope = {
  kind: 'stock-loss' as const,
  userId: 'user-1',
  propertyId: 'property-1',
  scope: 'item-1',
};

const validate = (value: unknown) => {
  if (!value || typeof value !== 'object' || typeof (value as { requestId?: unknown }).requestId !== 'string') return null;
  return value as { requestId: string; quantity: number };
};

describe('durable inventory operation attempts', () => {
  it('writes and reads back the exact request-keyed envelope', () => {
    const storage = memoryStorage();
    const attempt = { requestId: 'request-1', quantity: 2 };
    assert.equal(persistInventoryOperationAttempt(scope, attempt, storage, 10), true);
    assert.deepEqual(loadInventoryOperationAttempt(scope, validate, storage), attempt);
  });

  it('does not overwrite a prior unresolved request and resolves oldest first', () => {
    const storage = memoryStorage();
    persistInventoryOperationAttempt(scope, { requestId: 'request-1', quantity: 2 }, storage, 10);
    persistInventoryOperationAttempt(scope, { requestId: 'request-2', quantity: 3 }, storage, 20);
    assert.equal(loadInventoryOperationAttempt(scope, validate, storage)?.requestId, 'request-1');
    clearInventoryOperationAttempt(scope, 'request-1', storage);
    assert.equal(loadInventoryOperationAttempt(scope, validate, storage)?.requestId, 'request-2');
  });

  it('fails closed when storage silently drops the envelope', () => {
    const storage: InventoryOperationAttemptStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    assert.equal(persistInventoryOperationAttempt(scope, { requestId: 'request-1', quantity: 2 }, storage), false);
  });
});
