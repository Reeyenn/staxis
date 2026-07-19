import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  clearInlineAddAttempt,
  createFrozenInlineAddAttempt,
  findInlineAddCommittedItem,
  InlineAddAttemptPersistenceError,
  inlineAddAttemptMarker,
  inlineAddAttemptStorageKey,
  loadInlineAddAttempt,
  persistInlineAddAttempt,
} from '@/app/inventory/_components/overlays/count-save';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    values,
  };
}

const attempt = createFrozenInlineAddAttempt({
  propertyId: 'property-a',
  requestId: 'request-a',
  startedAt: '2026-07-15T19:00:00.000Z',
  scope: 'general',
  nameInput: '  Bath towels  ',
  quantityInput: '05.0',
  parInput: '20',
  costInput: '1.25',
  openingAdjustmentConfirmed: true,
});

describe('CountSheet durable inline add', () => {
  test('freezes both exact form inputs and one canonical insert payload', () => {
    assert.equal(attempt.nameInput, '  Bath towels  ');
    assert.equal(attempt.quantityInput, '05.0');
    assert.equal(attempt.name, 'Bath towels');
    assert.equal(attempt.quantity, 5);
    assert.equal(attempt.parLevel, 20);
    assert.equal(attempt.unitCost, 1.25);
    assert.equal(attempt.openingAdjustmentConfirmed, true);
    assert.equal(attempt.category, 'housekeeping');
    assert.equal(inlineAddAttemptMarker(attempt.requestId), 'staxis:inline-count-add:request-a');
  });

  test('will not classify positive discovered stock without confirmation and cost', () => {
    const base = {
      propertyId: 'property-a', requestId: 'request-b',
      startedAt: '2026-07-15T19:00:00.000Z', scope: 'all' as const,
      nameInput: 'Soap', quantityInput: '3', parInput: '5', costInput: '2',
    };
    assert.throws(
      () => createFrozenInlineAddAttempt({ ...base, openingAdjustmentConfirmed: false }),
      /pre-existing opening inventory/i,
    );
    assert.throws(
      () => createFrozenInlineAddAttempt({
        ...base,
        costInput: '',
        openingAdjustmentConfirmed: true,
      }),
      /unit cost/i,
    );
  });

  test('survives remount with the same request marker and form values', () => {
    const storage = memoryStorage();
    persistInlineAddAttempt(attempt, storage);
    assert.deepEqual(loadInlineAddAttempt('property-a', storage), attempt);
    assert.equal(loadInlineAddAttempt('property-b', storage), null);

    clearInlineAddAttempt('property-a', storage);
    assert.equal(storage.values.has(inlineAddAttemptStorageKey('property-a')), false);
  });

  test('throws before send when storage is unavailable, throws, or silently drops the envelope', () => {
    assert.throws(
      () => persistInlineAddAttempt(attempt, null),
      (err) => err instanceof InlineAddAttemptPersistenceError
        && err.code === 'INLINE_ADD_ATTEMPT_NOT_DURABLE',
    );

    assert.throws(() => persistInlineAddAttempt(attempt, {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
      removeItem: () => {},
    }), InlineAddAttemptPersistenceError);

    let removed = false;
    assert.throws(() => persistInlineAddAttempt(attempt, {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => { removed = true; },
    }), InlineAddAttemptPersistenceError);
    assert.equal(removed, true);
  });

  test('rejects a modified persisted payload instead of retrying different fields', () => {
    const storage = memoryStorage();
    storage.setItem(inlineAddAttemptStorageKey('property-a'), JSON.stringify({
      ...attempt,
      quantity: 500,
    }));
    assert.equal(loadInlineAddAttempt('property-a', storage), null);
  });

  test('only the exact tagged row in the same property resolves an ambiguous insert', () => {
    const marker = inlineAddAttemptMarker(attempt.requestId);
    const committed = { id: 'item-new', propertyId: 'property-a', notes: marker };
    assert.equal(findInlineAddCommittedItem(attempt, [
      { id: 'wrong-property', propertyId: 'property-b', notes: marker },
      { id: 'wrong-marker', propertyId: 'property-a', notes: 'ordinary note' },
      committed,
    ]), committed);
    assert.equal(findInlineAddCommittedItem(attempt, []), null);
  });
});
