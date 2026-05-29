/**
 * Tests for the photo shelf-count merge helper (src/lib/photo-count-merge.ts).
 * Pure logic. Pins the no-zero-fill guarantee and the exact name→id mapping.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildNameToIdMap, mergePhotoCounts, type PhotoCount } from '../photo-count-merge';

const items = [
  { id: 'a', name: 'Bath Towel' },
  { id: 'b', name: ' Hand Soap ' },
  { id: 'c', name: 'Coffee Pods' },
];

describe('buildNameToIdMap', () => {
  it('keys by canonical (case/space-insensitive) name', () => {
    const m = buildNameToIdMap(items);
    assert.equal(m.get('bath towel'), 'a');
    assert.equal(m.get('hand soap'), 'b');
  });
  it('last-wins on duplicate names', () => {
    const m = buildNameToIdMap([{ id: '1', name: 'Soap' }, { id: '2', name: 'soap' }]);
    assert.equal(m.get('soap'), '2');
  });
});

describe('mergePhotoCounts', () => {
  const map = buildNameToIdMap(items);

  it('maps counts back to item ids and preserves confidence', () => {
    const counts: PhotoCount[] = [
      { item_name: 'Bath Towel', estimated_count: 12, confidence: 'high' },
      { item_name: 'Hand Soap', estimated_count: 4, confidence: 'medium' },
    ];
    const { filled, unmatched } = mergePhotoCounts(counts, map);
    assert.deepEqual(filled, [
      { itemId: 'a', value: '12', confidence: 'high' },
      { itemId: 'b', value: '4', confidence: 'medium' },
    ]);
    assert.deepEqual(unmatched, []);
  });

  it('is case-insensitive on the returned name', () => {
    const { filled } = mergePhotoCounts([{ item_name: 'BATH TOWEL', estimated_count: 9, confidence: 'low' }], map);
    assert.deepEqual(filled, [{ itemId: 'a', value: '9', confidence: 'low' }]);
  });

  it('routes unknown names to unmatched', () => {
    const { filled, unmatched } = mergePhotoCounts([{ item_name: 'Mystery Item', estimated_count: 3, confidence: 'high' }], map);
    assert.deepEqual(filled, []);
    assert.deepEqual(unmatched, ['Mystery Item']);
  });

  it('clamps bad counts to a non-negative integer string', () => {
    const { filled } = mergePhotoCounts([
      { item_name: 'Bath Towel', estimated_count: 12.7, confidence: 'high' },
      { item_name: 'Hand Soap', estimated_count: -5, confidence: 'low' },
      { item_name: 'Coffee Pods', estimated_count: NaN, confidence: 'low' },
    ], map);
    assert.deepEqual(filled.map((f) => f.value), ['13', '0', '0']);
  });

  it('leaves un-returned items untouched (no zero-fill)', () => {
    const { filled } = mergePhotoCounts([{ item_name: 'Bath Towel', estimated_count: 5, confidence: 'high' }], map);
    assert.equal(filled.length, 1);
    assert.ok(!filled.some((f) => f.itemId === 'b' || f.itemId === 'c'));
  });
});
