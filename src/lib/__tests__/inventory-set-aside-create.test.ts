import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { fromInventoryRow, toInventoryRow } from '../db-mappers';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

describe('inventory Set Aside create/edit contract', () => {
  test('main Add Item restores, freezes, and inserts Set Aside', () => {
    const sheet = source('src', 'app', 'inventory', '_components', 'overlays', 'AddItemSheet.tsx');

    assert.match(sheet, /setSetAsideInput\(restored\?\.setAsideInput \?\? '0'\)/);
    assert.match(sheet, /createFrozenInventoryItemAttempt\(\{[\s\S]*?setAsideInput,[\s\S]*?\}\)/);
    assert.match(sheet, /currentStock: attempt\.currentStock,[\s\S]*?setAside: attempt\.setAside,/);
    assert.match(sheet, /if \(setAsideNum > onHandForSubset\)/);
    assert.match(sheet, /<Field label=\{ais\.setAside\} tip=\{setAsideTip\(lang\)\}>/);
    assert.doesNotMatch(sheet, /\{isEdit && \([\s\S]{0,300}<Field label=\{ais\.setAside\}/);
  });

  test('an unrelated edit omits Set Aside while a deliberate change sends it', () => {
    const sheet = source('src', 'app', 'inventory', '_components', 'overlays', 'AddItemSheet.tsx');

    assert.match(sheet, /setAsideBaselineRef/);
    assert.match(sheet, /const setAsideChanged = setAsideNum !== setAsideBaselineRef\.current/);
    assert.match(sheet, /\.\.\.\(setAsideChanged \? \{ setAside: setAsideNum \} : \{\}\)/);
  });

  test('non-financial subscriptions retain operational Set Aside data', () => {
    const inventoryDb = source('src', 'lib', 'db', 'inventory.ts');

    assert.match(
      inventoryDb,
      /custom_category_id,current_stock,set_aside,par_level/,
    );
  });

  test('database mapper round-trips Set Aside independently of financial fields', () => {
    assert.equal(toInventoryRow({ setAside: 7 }).set_aside, 7);
    const item = fromInventoryRow({
      id: 'item-a',
      property_id: 'property-a',
      name: 'Bath towels',
      category: 'housekeeping',
      current_stock: 12,
      set_aside: 7,
      par_level: 20,
      unit: 'each',
    });
    assert.equal(item.setAside, 7);
  });
});
