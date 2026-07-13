// Regression tests for the ReorderPanel cart seeding
// (src/app/inventory/_components/overlays/reorder-cart.ts).
//
// Bug fixed: the panel rebuilt its cart from defaults whenever the realtime
// inventory subscription refetched (fresh-identity recs array), so a
// housekeeper saving a count on another device silently reverted the GM's
// checked lines and typed quantities mid-order. Seeding is now additive while
// the panel stays open: existing lines (user edits) are always preserved.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  seedCartState,
  type SeedableRec,
} from '@/app/inventory/_components/overlays/reorder-cart';

const recs: SeedableRec[] = [
  { itemId: 'towels', urgency: 'now', burnSource: 'ml', suggestQty: 24 },
  { itemId: 'soap', urgency: 'now', burnSource: 'fallback-60d', suggestQty: 12 },
  { itemId: 'coffee', urgency: 'soon', burnSource: 'rule-occupancy', suggestQty: 6 },
];

describe('seedCartState — first open', () => {
  test('rebuilds from defaults, discarding stale previous-session state', () => {
    const stale = { towels: { checked: true, qty: 99 } };
    const next = seedCartState(recs, stale, true);
    assert.deepEqual(next.towels, { checked: true, qty: 24 }); // now + ml → pre-checked
    assert.deepEqual(next.soap, { checked: false, qty: 12 }); // fallback → not pre-checked
    assert.deepEqual(next.coffee, { checked: false, qty: 6 }); // soon → not pre-checked
  });

  test('only urgent items with REAL signal (ml / rule-occupancy) are pre-checked', () => {
    const next = seedCartState(
      [
        { itemId: 'a', urgency: 'now', burnSource: 'rule-occupancy', suggestQty: 1 },
        { itemId: 'b', urgency: 'now', burnSource: 'no-data', suggestQty: 1 },
        { itemId: 'c', urgency: 'ok', burnSource: 'ml', suggestQty: 1 },
      ],
      {},
      true,
    );
    assert.equal(next.a.checked, true);
    assert.equal(next.b.checked, false);
    assert.equal(next.c.checked, false);
  });
});

describe('seedCartState — while the panel stays open (realtime refetch)', () => {
  test('preserves the user’s ticked lines and typed quantities', () => {
    const userEdits = {
      towels: { checked: false, qty: 24 }, // GM un-ticked the pre-check
      soap: { checked: true, qty: 30 }, // GM ticked + typed a quantity
      coffee: { checked: false, qty: 6 },
    };
    const next = seedCartState(recs, userEdits, false);
    assert.deepEqual(next, userEdits);
  });

  test('seeds defaults only for recs that do not have a line yet', () => {
    const prev = { towels: { checked: true, qty: 48 } };
    const next = seedCartState(recs, prev, false);
    assert.deepEqual(next.towels, { checked: true, qty: 48 }); // untouched
    assert.deepEqual(next.soap, { checked: false, qty: 12 }); // newly seeded
    assert.deepEqual(next.coffee, { checked: false, qty: 6 }); // newly seeded
  });

  test('does not mutate the previous state object', () => {
    const prev = { towels: { checked: true, qty: 48 } };
    seedCartState(recs, prev, false);
    assert.deepEqual(prev, { towels: { checked: true, qty: 48 } });
    assert.equal(Object.keys(prev).length, 1);
  });
});
