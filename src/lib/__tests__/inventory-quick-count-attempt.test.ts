import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  QuickCountStorageError,
  clearQuickCountAttempt,
  isDefinitiveQuickCountFailure,
  loadQuickCountAttempts,
  persistQuickCountAttempt,
  quickCountAttemptStorageKey,
  quickCountItemStorageKey,
  type FrozenQuickCountAttempt,
} from '../inventory-quick-count-attempt';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function attempt(itemId: string, requestId: string, countedStock: number): FrozenQuickCountAttempt {
  return {
    version: 1,
    userId: 'user-a',
    propertyId: 'property-a',
    itemId,
    requestId,
    countedAt: '2026-07-15T20:00:00.000Z',
    countedBy: 'Field tester',
    row: {
      itemId,
      expectedStock: 7,
      countedStock,
      estimatedStock: 6.5,
      notes: 'ledger quick count',
    },
  };
}

describe('durable quick-count envelopes', () => {
  test('round-trips the complete frozen RPC payload for multiple items', () => {
    const storage = memoryStorage();
    const first = attempt('item-a', 'request-a', 8);
    const second = attempt('item-b', 'request-b', 3);
    persistQuickCountAttempt(first, storage);
    persistQuickCountAttempt(second, storage);

    assert.deepEqual(loadQuickCountAttempts('property-a', storage), [first, second]);
    assert.deepEqual(loadQuickCountAttempts('property-a', storage)[0].row, {
      itemId: 'item-a', expectedStock: 7, countedStock: 8,
      estimatedStock: 6.5, notes: 'ledger quick count',
    });
  });

  test('replaces one item without changing another pending envelope', () => {
    const storage = memoryStorage();
    persistQuickCountAttempt(attempt('item-a', 'request-a', 8), storage);
    persistQuickCountAttempt(attempt('item-b', 'request-b', 3), storage);
    const replacement = attempt('item-a', 'request-a2', 9);
    persistQuickCountAttempt(replacement, storage);

    assert.deepEqual(loadQuickCountAttempts('property-a', storage), [
      replacement, attempt('item-b', 'request-b', 3),
    ]);
  });

  test('a failed replacement retires only that item and can never replay its obsolete envelope', () => {
    const storage = memoryStorage();
    const first = attempt('item-a', 'request-a', 8);
    const other = attempt('item-b', 'request-b', 3);
    persistQuickCountAttempt(first, storage);
    persistQuickCountAttempt(other, storage);

    const itemKey = quickCountItemStorageKey('property-a', 'item-a');
    const setItem = storage.setItem;
    storage.setItem = (key: string, value: string) => {
      if (key === itemKey && value.includes('request-a2')) return; // silent drop
      setItem(key, value);
    };
    assert.throws(
      () => persistQuickCountAttempt(attempt('item-a', 'request-a2', 9), storage),
      (error) => error instanceof QuickCountStorageError && error.supersededRetired,
    );
    assert.deepEqual(loadQuickCountAttempts('property-a', storage), [other]);
  });

  test('cleanup cannot delete a newer request for the same item', () => {
    const storage = memoryStorage();
    const newer = attempt('item-a', 'request-new', 9);
    persistQuickCountAttempt(newer, storage);
    assert.equal(clearQuickCountAttempt('property-a', 'item-a', 'request-old', storage), true);
    assert.deepEqual(loadQuickCountAttempts('property-a', storage), [newer]);
    assert.equal(clearQuickCountAttempt('property-a', 'item-a', 'request-new', storage), true);
    assert.deepEqual(loadQuickCountAttempts('property-a', storage), []);
  });

  test('fails closed when durable storage is unavailable or rejects a write', () => {
    const value = attempt('item-a', 'request-a', 8);
    assert.throws(() => persistQuickCountAttempt(value, null), QuickCountStorageError);
    assert.throws(() => persistQuickCountAttempt(value, {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
      removeItem: () => {},
    }), QuickCountStorageError);
    assert.throws(() => persistQuickCountAttempt(value, {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    }), QuickCountStorageError);
  });

  test('rejects malformed stored payloads and classifies only coded failures as definitive', () => {
    const storage = memoryStorage();
    storage.setItem(quickCountAttemptStorageKey('property-a'), JSON.stringify(['item-a']));
    storage.setItem(quickCountItemStorageKey('property-a', 'item-a'), JSON.stringify({
      ...attempt('item-a', 'request-a', 8),
      row: { itemId: 'item-a', expectedStock: 7, countedStock: -1 },
    }));
    assert.throws(() => loadQuickCountAttempts('property-a', storage), QuickCountStorageError);
    assert.equal(isDefinitiveQuickCountFailure({ code: '40001' }), true);
    assert.equal(isDefinitiveQuickCountFailure({ code: '23505' }), true);
    assert.equal(isDefinitiveQuickCountFailure({ code: 'PGRST202' }), true);
    assert.equal(isDefinitiveQuickCountFailure({ code: 'ECONNRESET' }), false);
    assert.equal(isDefinitiveQuickCountFailure({ code: 'EPIPE' }), false);
    assert.equal(isDefinitiveQuickCountFailure({ code: 'NETWORK_ERROR' }), false);
    assert.equal(isDefinitiveQuickCountFailure(new Error('network disconnected')), false);
  });

  test('the ledger persists before dispatch and always replays the frozen row', () => {
    const source = readFileSync(
      new URL('../../app/inventory/_components/InventoryShell.tsx', import.meta.url),
      'utf8',
    );
    const quickHandler = source.slice(
      source.indexOf('const onQuickCount = useCallback'),
      source.indexOf('// Reconcile: once a realtime snapshot'),
    );
    const persistAt = quickHandler.indexOf('persistQuickCountAttempt(attempt);');
    const dispatchAt = quickHandler.indexOf('void submitQuickCountAttempt(attempt);');

    assert.ok(persistAt >= 0, 'tap envelope must be durable before its debounce starts');
    assert.ok(dispatchAt > persistAt, 'quick count must not dispatch before persistence');
    assert.match(source, /await saveInventoryCountAtomic\([\s\S]*?\[attempt\.row\],\s*\);/);
    assert.doesNotMatch(source, /decideQuickCountWrite/);
    assert.match(source, /activePropertyIdRef\.current === attempt\.propertyId/);
  });
});
