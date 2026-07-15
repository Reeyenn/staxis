import assert from 'node:assert/strict';
import test from 'node:test';
import { groupInventoryCountsByEvent, inventoryCountEventKey } from '@/lib/inventory-history';

type CountStub = {
  id: string;
  countSessionId?: string;
  countedAt: Date | null;
};

const at = (iso: string) => new Date(iso);

test('countSessionId keeps one atomic count together even when row timestamps differ', () => {
  const counts: CountStub[] = [
    { id: 'a', countSessionId: 'session-1', countedAt: at('2026-07-15T10:00:00.000Z') },
    { id: 'b', countSessionId: 'session-1', countedAt: at('2026-07-15T10:00:00.042Z') },
  ];

  assert.deepEqual(groupInventoryCountsByEvent(counts).map((g) => g.map((c) => c.id)), [['a', 'b']]);
});

test('different sessions stay separate even when their timestamps are identical', () => {
  const timestamp = at('2026-07-15T10:00:00.000Z');
  const counts: CountStub[] = [
    { id: 'a', countSessionId: 'session-1', countedAt: timestamp },
    { id: 'b', countSessionId: 'session-2', countedAt: timestamp },
  ];

  assert.equal(groupInventoryCountsByEvent(counts).length, 2);
});

test('legacy rows without a session id retain exact-timestamp grouping', () => {
  const timestamp = at('2026-07-15T10:00:00.000Z');
  const counts: CountStub[] = [
    { id: 'a', countedAt: timestamp },
    { id: 'b', countedAt: at(timestamp.toISOString()) },
    { id: 'c', countedAt: at('2026-07-15T10:00:01.000Z') },
  ];

  assert.deepEqual(groupInventoryCountsByEvent(counts).map((g) => g.map((c) => c.id)), [['a', 'b'], ['c']]);
});

test('session and legacy keys have separate namespaces and malformed undated rows are ignored', () => {
  const timestamp = at('2026-07-15T10:00:00.000Z');
  assert.notEqual(
    inventoryCountEventKey({ countSessionId: timestamp.toISOString(), countedAt: timestamp }),
    inventoryCountEventKey({ countedAt: timestamp }),
  );
  assert.equal(inventoryCountEventKey({ countSessionId: 'session-1', countedAt: null }), null);
});
