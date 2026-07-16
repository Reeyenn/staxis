import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  clearInventoryCountAttempt,
  hasDefinitiveDatabaseFailure,
  InventoryCountAttemptPersistenceError,
  inventoryCountAttemptStorageKey,
  loadInventoryCountAttempt,
  persistInventoryCountAttempt,
  type FrozenInventoryCountAttempt,
} from '../inventory-count-attempt';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    values,
  };
}

const attempt: FrozenInventoryCountAttempt = {
  version: 1,
  propertyId: 'property-a',
  fingerprint: 'item-a=12',
  requestId: 'request-a',
  countedAt: '2026-07-15T18:00:00.000Z',
  countedBy: 'Field tester',
  rows: [{ itemId: 'item-a', expectedStock: 5, countedStock: 12 }],
};

describe('durable inventory count retry', () => {
  test('restores the exact UUID, timestamp, baseline, and count after remount', () => {
    const storage = memoryStorage();
    persistInventoryCountAttempt(attempt, storage);
    assert.deepEqual(loadInventoryCountAttempt('property-a', storage), attempt);
    clearInventoryCountAttempt('property-a', storage);
    assert.equal(storage.values.has(inventoryCountAttemptStorageKey('property-a')), false);
  });

  test('rejects malformed or cross-property persisted envelopes', () => {
    const storage = memoryStorage();
    storage.setItem(inventoryCountAttemptStorageKey('property-a'), JSON.stringify({
      ...attempt,
      rows: [{ itemId: 'item-a', expectedStock: Number.NaN, countedStock: 12 }],
    }));
    assert.equal(loadInventoryCountAttempt('property-a', storage), null);

    persistInventoryCountAttempt(attempt, storage);
    assert.equal(loadInventoryCountAttempt('property-b', storage), null);
  });

  test('only coded database responses release an exact retry envelope', () => {
    assert.equal(hasDefinitiveDatabaseFailure(new InventoryCountAttemptPersistenceError()), true);
    assert.equal(hasDefinitiveDatabaseFailure(new InventoryCountAttemptPersistenceError(), true), false);
    assert.equal(hasDefinitiveDatabaseFailure({ code: '40001' }), true);
    assert.equal(hasDefinitiveDatabaseFailure({ code: '23505' }), true);
    assert.equal(hasDefinitiveDatabaseFailure({ code: 'PGRST202' }), true);
    assert.equal(hasDefinitiveDatabaseFailure({ code: 'ECONNRESET' }), false);
    assert.equal(hasDefinitiveDatabaseFailure({ code: 'EPIPE' }), false);
    assert.equal(hasDefinitiveDatabaseFailure({ code: 'NETWORK_ERROR' }), false);
    assert.equal(hasDefinitiveDatabaseFailure(new Error('network disconnected')), false);
  });

  test('fails closed before the count RPC when storage is unavailable or drops writes', () => {
    assert.throws(
      () => persistInventoryCountAttempt(attempt, null),
      InventoryCountAttemptPersistenceError,
    );
    assert.throws(() => persistInventoryCountAttempt(attempt, {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
      removeItem: () => {},
    }), InventoryCountAttemptPersistenceError);
    let removed = false;
    assert.throws(() => persistInventoryCountAttempt(attempt, {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => { removed = true; },
    }), InventoryCountAttemptPersistenceError);
    assert.equal(removed, true);
  });

  test('CountSheet verifies the durable envelope before dispatching the RPC', () => {
    const source = readFileSync(
      new URL('../../app/inventory/_components/overlays/CountSheet.tsx', import.meta.url),
      'utf8',
    );
    const persistAt = source.indexOf('persistInventoryCountAttempt(attempt);');
    const sendAt = source.indexOf('await saveInventoryCountAtomic(');
    assert.ok(persistAt >= 0 && sendAt > persistAt);
    assert.match(source, /await saveInventoryCountAtomic\(\s*user\.uid,\s*attempt\.propertyId,/);
  });
});
