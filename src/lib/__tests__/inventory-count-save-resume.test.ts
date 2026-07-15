// CountSheet request identity: an unchanged payload must reuse its atomic RPC
// request UUID, while an operator edit starts a distinct request.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { entriesFingerprint } from '@/app/inventory/_components/overlays/count-save';

describe('entriesFingerprint', () => {
  test('same entries produce the same fingerprint for an idempotent retry', () => {
    const a = entriesFingerprint({ x: { value: '5' }, y: { value: '2' } });
    const b = entriesFingerprint({ x: { value: '5' }, y: { value: '2' } });
    assert.equal(a, b);
  });

  test('key insertion order does not change the fingerprint', () => {
    const a = entriesFingerprint({ x: { value: '5' }, y: { value: '2' } });
    const b = entriesFingerprint({ y: { value: '2' }, x: { value: '5' } });
    assert.equal(a, b);
  });

  test('editing, adding, or clearing a count changes the payload identity', () => {
    const base = entriesFingerprint({ x: { value: '5' }, y: { value: '2' } });
    assert.notEqual(base, entriesFingerprint({ x: { value: '6' }, y: { value: '2' } }));
    assert.notEqual(base, entriesFingerprint({ x: { value: '5' }, y: { value: '2' }, z: { value: '1' } }));
    assert.notEqual(base, entriesFingerprint({ x: { value: '5' }, y: { value: '' } }));
  });

  test('empty entries are excluded from the database payload identity', () => {
    assert.equal(
      entriesFingerprint({ x: { value: '5' }, y: { value: '' } }),
      entriesFingerprint({ x: { value: '5' } }),
    );
  });

  test('equivalent numeric spellings share one idempotency identity', () => {
    assert.equal(
      entriesFingerprint({ x: { value: '5' } }),
      entriesFingerprint({ x: { value: '5.0' } }),
    );
  });
});
