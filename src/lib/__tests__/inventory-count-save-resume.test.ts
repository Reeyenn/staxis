// Regression tests for the CountSheet save-resume helpers
// (src/app/inventory/_components/overlays/count-save.ts).
//
// Bug fixed: a partially-failed count save had no resume bookkeeping — a
// retry after the "Saving the count failed" alert re-inserted the already-
// saved count rows and duplicated the auto "stock-up" orders. The sheet now
// keys a SaveProgress object on an entries fingerprint (same entries → resume
// the failed step; edited entries → fresh attempt) and computes stock-up
// deltas from the freshly-fetched stock.
//
// Follow-up bug: the edit-then-retry path. Editing ANY entry after a partial
// failure used to discard the whole SaveProgress and re-run every step for
// every item — duplicating count rows and stock-up orders for the untouched
// items. unchangedItemIds diffs the old and new fingerprints so the sheet can
// carry per-item completion forward for entries the user didn't edit.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  entriesFingerprint,
  computeStockUps,
  unchangedItemIds,
} from '@/app/inventory/_components/overlays/count-save';

describe('entriesFingerprint', () => {
  test('same entries produce the same fingerprint (retry resumes)', () => {
    const a = entriesFingerprint({ x: { value: '5' }, y: { value: '2' } });
    const b = entriesFingerprint({ x: { value: '5' }, y: { value: '2' } });
    assert.equal(a, b);
  });

  test('order-insensitive: key insertion order does not change the fingerprint', () => {
    const a = entriesFingerprint({ x: { value: '5' }, y: { value: '2' } });
    const b = entriesFingerprint({ y: { value: '2' }, x: { value: '5' } });
    assert.equal(a, b);
  });

  test('editing a value changes the fingerprint (fresh attempt)', () => {
    const a = entriesFingerprint({ x: { value: '5' } });
    const b = entriesFingerprint({ x: { value: '6' } });
    assert.notEqual(a, b);
  });

  test('empty (skipped) entries are ignored', () => {
    const a = entriesFingerprint({ x: { value: '5' }, y: { value: '' } });
    const b = entriesFingerprint({ x: { value: '5' } });
    assert.equal(a, b);
  });

  test('adding a new counted item changes the fingerprint', () => {
    const a = entriesFingerprint({ x: { value: '5' } });
    const b = entriesFingerprint({ x: { value: '5' }, y: { value: '1' } });
    assert.notEqual(a, b);
  });
});

describe('computeStockUps', () => {
  const counted = [
    { id: 'a', pageLoadStock: 10, countedStock: 14 }, // up 4 vs fresh 10
    { id: 'b', pageLoadStock: 8, countedStock: 5 }, // down — consumption, no order
    { id: 'c', pageLoadStock: 3, countedStock: 6 }, // fresh missing → page-load baseline
  ];

  test('positive delta vs FRESH stock produces a stock-up', () => {
    const ups = computeStockUps(counted, { a: 10, b: 8 });
    assert.deepEqual(
      ups.map((u) => ({ id: u.id, delta: u.delta })),
      [
        { id: 'a', delta: 4 },
        { id: 'c', delta: 3 },
      ],
    );
  });

  test('fresh stock wins over the stale page-load value (delivery logged mid-count)', () => {
    // Page-load said 10, but a delivery was logged in-app → fresh says 14.
    // Counting 14 must NOT re-log the same goods as a phantom stock-up.
    const ups = computeStockUps(
      [{ id: 'a', pageLoadStock: 10, countedStock: 14 }],
      { a: 14 },
    );
    assert.equal(ups.length, 0);
  });

  test('equal or lower counts never create orders', () => {
    const ups = computeStockUps(
      [
        { id: 'a', pageLoadStock: 5, countedStock: 5 },
        { id: 'b', pageLoadStock: 5, countedStock: 0 },
      ],
      { a: 5, b: 5 },
    );
    assert.equal(ups.length, 0);
  });

  test('a first-ever count establishes stock without fabricating a delivery', () => {
    const out = computeStockUps([
      {
        id: 'new-catalog-item',
        pageLoadStock: 0,
        countedStock: 50,
        stockUpEligible: false,
      },
    ], { 'new-catalog-item': 0 });
    assert.deepEqual(out, []);
  });

  test('extra fields on counted items are carried through (the sheet keeps item refs)', () => {
    const ups = computeStockUps(
      [{ id: 'a', pageLoadStock: 1, countedStock: 3, item: { name: 'Towels' } }],
      { a: 1 },
    );
    assert.equal(ups[0].item.name, 'Towels');
    assert.equal(ups[0].delta, 2);
  });
});

describe('unchangedItemIds (edit-then-retry carries completion forward)', () => {
  const fpOf = (entries: Record<string, string>) =>
    entriesFingerprint(
      Object.fromEntries(Object.entries(entries).map(([id, value]) => [id, { value }])),
    );

  test('editing one entry leaves every other id in the unchanged set', () => {
    const prev = fpOf({ a: '5', b: '2', c: '7' });
    const next = fpOf({ a: '5', b: '3', c: '7' }); // b corrected after the alert
    assert.deepEqual([...unchangedItemIds(prev, next)].sort(), ['a', 'c']);
  });

  test('identical fingerprints → everything unchanged (plain-retry equivalence)', () => {
    const fp = fpOf({ a: '5', b: '2' });
    assert.deepEqual([...unchangedItemIds(fp, fp)].sort(), ['a', 'b']);
  });

  test('a newly counted item is NOT unchanged (its steps must run)', () => {
    const prev = fpOf({ a: '5' });
    const next = fpOf({ a: '5', b: '1' });
    assert.deepEqual([...unchangedItemIds(prev, next)], ['a']);
  });

  test('an entry cleared after the failure simply drops out (nothing carried, nothing run)', () => {
    const prev = fpOf({ a: '5', b: '2' });
    const next = fpOf({ a: '5' });
    assert.deepEqual([...unchangedItemIds(prev, next)], ['a']);
  });

  test('no previous attempt (empty fingerprint) → nothing unchanged', () => {
    assert.equal(unchangedItemIds('', fpOf({ a: '5' })).size, 0);
    assert.equal(unchangedItemIds(fpOf({ a: '5' }), '').size, 0);
  });

  test('decimal values compare exactly ("5" vs "5.0" counts as an edit)', () => {
    const prev = fpOf({ a: '5' });
    const next = fpOf({ a: '5.0' });
    assert.equal(unchangedItemIds(prev, next).size, 0);
  });
});
