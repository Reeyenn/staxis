import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { partitionMobileInventory } from '@/app/inventory/_components/mobile-inventory-triage';
import type { DisplayItem } from '@/app/inventory/_components/types';

function item(
  id: string,
  status: DisplayItem['status'],
  overrides: Partial<DisplayItem> = {},
): DisplayItem {
  return {
    id,
    name: id,
    cat: 'housekeeping',
    customCategoryId: null,
    status,
    uncounted: false,
    daysLeft: 12,
    burnSource: 'ml',
    ...overrides,
  } as DisplayItem;
}

describe('partitionMobileInventory', () => {
  it('keeps unknown counts neutral while grouping every counted status', () => {
    const partition = partitionMobileInventory([
      item('critical', 'critical'),
      item('low', 'low'),
      item('good', 'good'),
      item('uncounted', 'critical', { uncounted: true }),
    ], 'all');

    assert.deepEqual(partition.critical.map(({ id }) => id), ['critical']);
    assert.deepEqual(partition.low.map(({ id }) => id), ['low']);
    assert.deepEqual(partition.good.map(({ id }) => id), ['good']);
    assert.deepEqual(partition.uncounted.map(({ id }) => id), ['uncounted']);
    assert.equal(partition.visibleCount, 4);
  });

  it('honors built-in and custom category filters', () => {
    const items = [
      item('housekeeping', 'good'),
      item('breakfast', 'low', { cat: 'breakfast' }),
      item('custom', 'critical', { customCategoryId: 'amenities' }),
    ];

    assert.deepEqual(
      partitionMobileInventory(items, 'general').good.map(({ id }) => id),
      ['housekeeping'],
    );
    assert.deepEqual(
      partitionMobileInventory(items, 'breakfast').low.map(({ id }) => id),
      ['breakfast'],
    );
    assert.deepEqual(
      partitionMobileInventory(items, 'custom:amenities').critical.map(({ id }) => id),
      ['custom'],
    );
  });

  it('sorts actionable signals by days left and puts fallback estimates last', () => {
    const partition = partitionMobileInventory([
      item('later', 'critical', { daysLeft: 8 }),
      item('fallback', 'critical', { daysLeft: 1, burnSource: 'fallback-60d' }),
      item('first', 'critical', { daysLeft: 2 }),
    ], 'all');

    assert.deepEqual(partition.critical.map(({ id }) => id), ['first', 'later', 'fallback']);
  });
});
