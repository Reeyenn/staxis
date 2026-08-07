import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { partitionMobileInventory } from '@/app/inventory/_components/mobile-inventory-triage';
import { toDisplayItem } from '@/app/inventory/_components/adapter';
import { buildCandidate } from '@/lib/ordering/resolve';
import type { DisplayItem } from '@/app/inventory/_components/types';
import type { InventoryItem } from '@/types';

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

// The triage columns and the Ordering panel are two views of the same shelf on
// the same tab. They used to classify it with different rules (0.5/1.0 here,
// the house 70/30 there), so a par-100 item at 80 sat under "Order soon" while
// Ordering refused to put it on any order, and the same item at 40 read as a
// red Critical while Ordering called it Low. Both producers are exercised here
// so the two screens can never drift apart again.
describe('inventory status agrees with the ordering screen', () => {
  function stocked(currentStock: number, parLevel: number): InventoryItem {
    return {
      id: 'sheets',
      propertyId: 'prop',
      name: 'King Sheets',
      category: 'housekeeping',
      currentStock,
      parLevel,
      unit: 'sets',
      updatedAt: null,
      lastCountedAt: new Date('2026-08-01T00:00:00Z'),
    } as InventoryItem;
  }

  function ledgerStatus(currentStock: number, parLevel: number): DisplayItem['status'] {
    return toDisplayItem(stocked(currentStock, parLevel), {
      occupancy: null,
      dailyAverages: null,
      mlRateMap: new Map(),
      autoFillGraduated: new Set(),
    }).status;
  }

  function isOnTheOrderList(currentStock: number, parLevel: number): boolean {
    return buildCandidate(
      {
        itemId: 'sheets',
        name: 'King Sheets',
        unit: 'sets',
        onHand: currentStock,
        par: parLevel,
        category: 'housekeeping',
        customCategoryId: null,
        vendorId: null,
        vendorName: null,
        burnPerDay: null,
        burnConfidence: 'none',
        lastPriceCents: null,
        lastPriceAt: null,
        openOrder: null,
      },
      new Map(),
      new Map(),
    ) !== null;
  }

  it('classifies stock on the house 70/30 thresholds', () => {
    assert.equal(ledgerStatus(70, 100), 'good');
    assert.equal(ledgerStatus(69, 100), 'low');
    assert.equal(ledgerStatus(30, 100), 'low');
    assert.equal(ledgerStatus(29, 100), 'critical');
    assert.equal(ledgerStatus(0, 100), 'critical');
    // No par set is no judgement to make, not a shortage.
    assert.equal(ledgerStatus(5, 0), 'good');
  });

  it('never calls an item stocked while the ordering screen wants it ordered', () => {
    for (const onHand of [0, 20, 29, 30, 40, 55, 69, 70, 80, 100, 140]) {
      const status = ledgerStatus(onHand, 100);
      assert.equal(
        status === 'good',
        !isOnTheOrderList(onHand, 100),
        `${onHand} of par 100 reads "${status}" on the board but the order list disagrees`,
      );
    }
  });

  it('drops a fully stocked item out of the order columns', () => {
    const partition = partitionMobileInventory(
      [item('sheets', ledgerStatus(80, 100))],
      'all',
    );
    assert.deepEqual(partition.good.map(({ id }) => id), ['sheets']);
    assert.equal(partition.low.length, 0);
    assert.equal(partition.critical.length, 0);
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
