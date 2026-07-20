import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

  it('searches item name, vendor, and id inside the selected tab', () => {
    const items = [
      item('linen-001', 'good', { name: 'King Sheets', vendor: 'Grand Harbor' }),
      item('soap-002', 'low', { name: 'Body Wash', vendor: 'Supply Co' }),
      item('linen-003', 'critical', { name: 'Pillowcases', vendor: 'Grand Harbor', cat: 'breakfast' }),
    ];

    assert.deepEqual(
      partitionMobileInventory(items, 'all', 'grand harbor').good.map(({ id }) => id),
      ['linen-001'],
    );
    assert.deepEqual(
      partitionMobileInventory(items, 'all', 'soap-002').low.map(({ id }) => id),
      ['soap-002'],
    );
    assert.equal(partitionMobileInventory(items, 'general', 'pillow').visibleCount, 0);
  });
});

describe('Mobile Inventory theme contract', () => {
  const css = readFileSync(
    new URL('../../app/inventory/_components/MobileInventoryTriage.module.css', import.meta.url),
    'utf8',
  );

  it('keeps the mobile experience light regardless of device or root theme', () => {
    assert.doesNotMatch(css, /prefers-color-scheme\s*:\s*dark/i);
    assert.doesNotMatch(css, /:global\(\.dark\)/);
    assert.match(css, /--mi-page:\s*radial-gradient\([^;]+#fff[^;]+#f0f3ef[^;]+\);/);
    assert.match(css, /--mi-surface:\s*#fff;/);
    assert.match(css, /--mi-ink:\s*#1f231c;/);
  });

  it('uses accessible secondary text tokens on the light page wash', () => {
    assert.match(css, /--mi-dim:\s*#5c625c;/);
    assert.match(css, /--mi-faint:\s*#5c625c;/);
  });
});
