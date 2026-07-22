import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  clearOwnershipTransferAttempt,
  findOwnershipTransferAttempt,
  getOrCreateOwnershipTransferAttempt,
} from '@/lib/ownership-transfer-attempt';

const HOTEL = '11111111-1111-4111-8111-111111111111';
const PERSON = '22222222-2222-4222-8222-222222222222';
const FIRST_OPERATION = '33333333-3333-4333-8333-333333333333';
const SECOND_OPERATION = '44444444-4444-4444-8444-444444444444';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe('ownership transfer operation persistence', () => {
  test('reuses the same operation UUID after a simulated reload/lost response', () => {
    const storage = new MemoryStorage();
    const first = getOrCreateOwnershipTransferAttempt(
      storage, HOTEL, PERSON, 'planned handoff', () => FIRST_OPERATION,
    );

    // A new call represents a fresh component instance after navigation or
    // reload. The UUID factory must not run for the same unresolved transfer.
    const afterReload = getOrCreateOwnershipTransferAttempt(
      storage,
      HOTEL,
      PERSON,
      'ignored on replay',
      () => {
        throw new Error('must reuse the durable operation ID');
      },
    );
    assert.deepEqual(afterReload, first);
  });

  test('clears only the exact terminal operation and then creates a fresh UUID', () => {
    const storage = new MemoryStorage();
    getOrCreateOwnershipTransferAttempt(storage, HOTEL, PERSON, null, () => FIRST_OPERATION);

    clearOwnershipTransferAttempt(storage, HOTEL, PERSON, SECOND_OPERATION);
    assert.equal(
      getOrCreateOwnershipTransferAttempt(storage, HOTEL, PERSON, null, () => SECOND_OPERATION).operationId,
      FIRST_OPERATION,
      'an unrelated response must not clear the in-flight transfer',
    );

    clearOwnershipTransferAttempt(storage, HOTEL, PERSON, FIRST_OPERATION);
    assert.equal(
      getOrCreateOwnershipTransferAttempt(storage, HOTEL, PERSON, null, () => SECOND_OPERATION).operationId,
      SECOND_OPERATION,
    );
  });

  test('different hotels or targets cannot overwrite another unresolved operation', () => {
    const storage = new MemoryStorage();
    getOrCreateOwnershipTransferAttempt(storage, HOTEL, PERSON, null, () => FIRST_OPERATION);
    const changed = getOrCreateOwnershipTransferAttempt(
      storage,
      '55555555-5555-4555-8555-555555555555',
      PERSON,
      null,
      () => SECOND_OPERATION,
    );
    assert.equal(changed.operationId, SECOND_OPERATION);
    assert.equal(
      getOrCreateOwnershipTransferAttempt(
        storage,
        HOTEL,
        PERSON,
        null,
        () => { throw new Error('the first tab operation must still exist'); },
      ).operationId,
      FIRST_OPERATION,
    );
  });

  test('finds the submitted operation after reload without knowing its UUID', () => {
    const storage = new MemoryStorage();
    getOrCreateOwnershipTransferAttempt(
      storage, HOTEL, PERSON, 'same reason', () => FIRST_OPERATION,
    );
    const restored = findOwnershipTransferAttempt(storage, HOTEL, [
      '66666666-6666-4666-8666-666666666666',
      PERSON,
    ]);
    assert.deepEqual(restored, {
      propertyId: HOTEL,
      newOwnerAccountId: PERSON,
      operationId: FIRST_OPERATION,
      reason: 'same reason',
    });
  });
});
