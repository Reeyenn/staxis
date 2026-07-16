import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeInventoryItemIds,
  filterInventoryMlRowsToActiveItems,
} from '@/lib/inventory-ml-active';

test('ML aggregates retain only rows whose item is active', () => {
  const active = activeInventoryItemIds([{ id: 'active-a' }, { id: 'active-b' }]);
  const rows = [
    { item_id: 'active-a', value: 1 },
    { item_id: 'archived-a', value: 2 },
    { item_id: null, value: 3 },
  ];

  assert.deepEqual(filterInventoryMlRowsToActiveItems(rows, active), [rows[0]]);
});

test('invalid inventory ids never enter the active set', () => {
  const active = activeInventoryItemIds([{ id: 'item-1' }, { id: null }, {}, { id: '' }]);
  assert.deepEqual([...active], ['item-1']);
});
