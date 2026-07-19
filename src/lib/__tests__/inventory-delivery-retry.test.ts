import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  clearDeliveryAttempt,
  DELIVERY_ATTEMPT_PERSISTENCE_ERROR,
  DeliveryAttemptPersistenceError,
  isDefinitiveDeliveryFailure,
  loadDeliveryAttempt,
  numberedInvoiceSaveBlocked,
  persistDeliveryAttempt,
  retainOrCreateDeliveryAttempt,
} from '../../app/inventory/_components/overlays/scan-commit';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('delivery retry envelope', () => {
  test('an unresolved attempt wins over every edited draft field', () => {
    const original = retainOrCreateDeliveryAttempt(null, {
      kind: 'manual',
      propertyId: 'property-a',
      requestId: '5c69de7a-7164-4f9c-aa51-2f1f5ccb8533',
      receivedAt: new Date('2026-07-15T16:00:00.000Z'),
      vendorName: '  Acme  ',
      notes: '  First payload  ',
      lines: [{ lineKey: 'towels:0', itemId: 'towels', quantity: 4 }],
    });

    const retained = retainOrCreateDeliveryAttempt(original, {
      kind: 'manual',
      propertyId: 'property-a',
      requestId: '8fc15262-9884-42ab-8a12-4f02bd8443f4',
      receivedAt: new Date('2026-07-16T16:00:00.000Z'),
      vendorName: 'Different vendor',
      notes: 'Edited payload',
      lines: [{ lineKey: 'soap:0', itemId: 'soap', quantity: 99 }],
    });

    assert.strictEqual(retained, original);
    assert.equal(retained.requestId, '5c69de7a-7164-4f9c-aa51-2f1f5ccb8533');
    assert.equal(retained.receivedAt, '2026-07-15T16:00:00.000Z');
    assert.equal(retained.vendorName, 'Acme');
    assert.equal(retained.notes, 'First payload');
    assert.deepEqual(retained.lines, [
      { lineKey: 'towels:0', itemId: 'towels', quantity: 4 },
    ]);
  });

  test('persists the exact envelope across remounts and clears only when resolved', () => {
    const storage = memoryStorage();
    const attempt = retainOrCreateDeliveryAttempt(null, {
      kind: 'scan',
      propertyId: 'property-a',
      requestId: '49bd08af-8ff2-40b1-9de4-553c54bfb988',
      receivedAt: new Date('2026-07-15T18:30:00.000Z'),
      vendorName: 'Supply Co',
      notes: 'Invoice scan · inv#123@supply co',
      lines: [{ lineKey: 'line-1', itemId: 'soap', quantity: 8, unitCost: 2.25 }],
    });

    persistDeliveryAttempt(attempt, storage);
    assert.deepEqual(loadDeliveryAttempt('scan', 'property-a', storage), attempt);
    assert.equal(loadDeliveryAttempt('manual', 'property-a', storage), null);

    clearDeliveryAttempt('scan', 'property-a', storage);
    assert.equal(loadDeliveryAttempt('scan', 'property-a', storage), null);
  });

  test('fails closed when durable storage is unavailable, throws, or drops the write', () => {
    const attempt = retainOrCreateDeliveryAttempt(null, {
      kind: 'manual', propertyId: 'property-a', requestId: 'request-a',
      receivedAt: new Date('2026-07-15T18:30:00.000Z'),
      lines: [{ lineKey: 'line-1', itemId: 'soap', quantity: 1 }],
    });
    const blockedStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    const droppingStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const isPersistenceError = (error: unknown) => {
      assert.ok(error instanceof DeliveryAttemptPersistenceError);
      assert.equal(error.code, DELIVERY_ATTEMPT_PERSISTENCE_ERROR);
      return true;
    };

    assert.throws(() => persistDeliveryAttempt(attempt, null), isPersistenceError);
    assert.throws(() => persistDeliveryAttempt(attempt, blockedStorage), isPersistenceError);
    assert.throws(() => persistDeliveryAttempt(attempt, droppingStorage), isPersistenceError);
    assert.doesNotThrow(() => clearDeliveryAttempt('manual', 'property-a', blockedStorage));
    assert.equal(loadDeliveryAttempt('manual', 'property-a', blockedStorage), null);
    // A pre-send persistence rejection never mutates the in-memory draft; the
    // sheet releases this unsent envelope and leaves its visible fields editable.
    assert.equal(attempt.requestId, 'request-a');
    assert.deepEqual(attempt.lines, [{ lineKey: 'line-1', itemId: 'soap', quantity: 1 }]);
  });

  test('rejects a malformed draft before it can become an ambiguous attempt', () => {
    assert.throws(() => retainOrCreateDeliveryAttempt(null, {
      kind: 'scan', propertyId: 'property-a', requestId: 'request-never-sent',
      receivedAt: new Date('2026-07-15T18:30:00.000Z'),
      lines: [{ lineKey: 'line-1', itemId: 'soap', quantity: 0 }],
    }), /Delivery quantity/);
  });

  test('rejects a corrupted stored payload or fingerprint before retry', () => {
    const storage = memoryStorage();
    const value = retainOrCreateDeliveryAttempt(null, {
      kind: 'manual', propertyId: 'property-a', requestId: 'request-a',
      receivedAt: new Date('2026-07-15T18:30:00.000Z'),
      lines: [{ lineKey: 'line-1', itemId: 'soap', quantity: 1 }],
    });
    storage.setItem('staxis:inventory-delivery-attempt:manual:property-a', JSON.stringify({
      ...value,
      lines: [{ lineKey: 'line-1', itemId: 'soap', quantity: 1000 }],
    }));
    assert.equal(loadDeliveryAttempt('manual', 'property-a', storage), null);
    assert.throws(
      () => persistDeliveryAttempt({ ...value, fingerprint: 'changed' }, storage),
      DeliveryAttemptPersistenceError,
    );
  });

  test('only a concrete server rejection releases an ambiguous retry lock', () => {
    assert.equal(isDefinitiveDeliveryFailure(new DeliveryAttemptPersistenceError()), true);
    assert.equal(isDefinitiveDeliveryFailure(new DeliveryAttemptPersistenceError(), true), false);
    assert.equal(isDefinitiveDeliveryFailure({ code: '23505', message: 'duplicate' }), true);
    assert.equal(isDefinitiveDeliveryFailure({ code: 'P0001' }), true);
    assert.equal(isDefinitiveDeliveryFailure({ code: 'PGRST202' }), true);
    assert.equal(isDefinitiveDeliveryFailure({ code: 'ECONNRESET' }), false);
    assert.equal(isDefinitiveDeliveryFailure({ code: 'EPIPE' }), false);
    assert.equal(isDefinitiveDeliveryFailure({ code: 'NETWORK_ERROR' }), false);
    assert.equal(isDefinitiveDeliveryFailure({ code: '   ' }), false);
    assert.equal(isDefinitiveDeliveryFailure(new Error('Failed to fetch')), false);
    assert.equal(isDefinitiveDeliveryFailure(null), false);
  });

  test('both additive delivery paths persist before send and unlock definitive pre-send errors', () => {
    const commitSource = readFileSync(fileURLToPath(new URL(
      '../../app/inventory/_components/overlays/scan-commit.ts', import.meta.url,
    )), 'utf8');
    const deliverySource = readFileSync(fileURLToPath(new URL(
      '../../app/inventory/_components/overlays/DeliverySheet.tsx', import.meta.url,
    )), 'utf8');
    const scanSource = readFileSync(fileURLToPath(new URL(
      '../../app/inventory/_components/overlays/ScanInvoiceSheet.tsx', import.meta.url,
    )), 'utf8');

    const scanPersist = commitSource.indexOf('persistDeliveryAttempt(progress.attempt);');
    const scanSend = commitSource.indexOf('await submitFrozenDeliveryAttempt(progress.attempt, ctx);');
    const manualPersist = deliverySource.indexOf('persistDeliveryAttempt(attempt);');
    const manualSend = deliverySource.indexOf('await submitFrozenDeliveryAttempt(attempt,');
    assert.ok(scanPersist >= 0 && scanSend >= 0 && scanPersist < scanSend);
    assert.ok(manualPersist >= 0 && manualSend >= 0 && manualPersist < manualSend);
    assert.match(commitSource, /receiveInventoryDeliveryAtomic\(\s*ctx\.uid,[\s\S]*?attempt\.propertyId,/);
    assert.match(
      deliverySource,
      /if \(isDefinitiveDeliveryFailure\(err, retryLocked\)\) \{[\s\S]*?setRetryLocked\(false\);/,
    );
    assert.match(
      scanSource,
      /if \(isDefinitiveDeliveryFailure\(e, retryLocked\)\) \{[\s\S]*?setRetryLocked\(false\);/,
    );
  });
});

describe('numbered invoice hard block', () => {
  test('fails closed for duplicate, pending, or unavailable history checks', () => {
    assert.equal(numberedInvoiceSaveBlocked({
      invoiceNumber: 'INV-123', checking: true, duplicate: false, checkFailed: false,
    }), true);
    assert.equal(numberedInvoiceSaveBlocked({
      invoiceNumber: 'INV-123', checking: false, duplicate: true, checkFailed: false,
    }), true);
    assert.equal(numberedInvoiceSaveBlocked({
      invoiceNumber: 'INV-123', checking: false, duplicate: false, checkFailed: true,
    }), true);
    assert.equal(numberedInvoiceSaveBlocked({
      invoiceNumber: 'INV-123', checking: false, duplicate: false, checkFailed: false,
    }), false);
    assert.equal(numberedInvoiceSaveBlocked({
      invoiceNumber: null, checking: true, duplicate: true, checkFailed: true,
    }), false);
  });

  test('the sheets wire close/edit locks and the field-test history block', () => {
    const deliverySource = readFileSync(fileURLToPath(new URL(
      '../../app/inventory/_components/overlays/DeliverySheet.tsx', import.meta.url,
    )), 'utf8');
    const scanSource = readFileSync(fileURLToPath(new URL(
      '../../app/inventory/_components/overlays/ScanInvoiceSheet.tsx', import.meta.url,
    )), 'utf8');

    assert.match(deliverySource, /if \(saving \|\| retryLocked\) return;/);
    assert.match(deliverySource, /disabled=\{saving \|\| retryLocked\}/);
    assert.match(scanSource, /if \(phase === 'committing' \|\| retryLocked\) return;/);
    assert.match(scanSource, /listInventoryOrders\(user\.uid, activePropertyId, 2000\)/);
    assert.match(scanSource, /actionable === 0 \|\| duplicateBlocked/);
    assert.match(scanSource, /await retryCommit\(progressRef\.current/);
    assert.match(scanSource, /invoiceDateFromReceivedAt\(restored\.receivedAt, timezone\)/);
    assert.match(scanSource, /propertyTimezone: timezone/);
    assert.doesNotMatch(scanSource, /restored\?\.receivedAt\.slice\(0, 10\)/);
  });
});
