import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  clearInventoryOverlayDraft,
  INVENTORY_DRAFT_TTL_MS,
  inventoryOverlayDraftKey,
  loadInventoryOverlayDraft,
  persistInventoryOverlayDraft,
} from '@/app/inventory/_components/overlays/inventory-overlay-draft';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    values,
  };
}

const base = {
  kind: 'item' as const,
  userId: 'user-a',
  propertyId: 'property-a',
  scope: 'edit:item-a',
};

describe('inventory overlay drafts', () => {
  test('round-trips editable work and scopes it by user, hotel, overlay, and item', () => {
    const storage = memoryStorage();
    const data = { name: 'Bath towels', unitCost: '4.25' };
    assert.equal(persistInventoryOverlayDraft({ ...base, data }, storage, 1_000), true);
    assert.deepEqual(loadInventoryOverlayDraft<typeof data>(base, storage, 2_000), data);
    assert.equal(loadInventoryOverlayDraft({ ...base, userId: 'user-b' }, storage, 2_000), null);
    assert.equal(loadInventoryOverlayDraft({ ...base, propertyId: 'property-b' }, storage, 2_000), null);
    assert.equal(loadInventoryOverlayDraft({ ...base, scope: 'edit:item-b' }, storage, 2_000), null);

    clearInventoryOverlayDraft(base, storage);
    assert.equal(storage.values.has(inventoryOverlayDraftKey(base)), false);
  });

  test('drops expired or malformed drafts without blocking the form', () => {
    const storage = memoryStorage();
    const key = inventoryOverlayDraftKey(base);
    storage.setItem(key, JSON.stringify({ version: 1, savedAt: 1_000, data: { name: 'old' } }));
    assert.equal(loadInventoryOverlayDraft(base, storage, 1_000 + INVENTORY_DRAFT_TTL_MS + 1), null);
    assert.equal(storage.values.has(key), false);

    storage.setItem(key, '{not-json');
    assert.equal(loadInventoryOverlayDraft(base, storage, 2_000), null);
    assert.equal(storage.values.has(key), false);

    assert.equal(persistInventoryOverlayDraft({ ...base, data: {} }, {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
      removeItem: () => {},
    }), false);
  });

  test('uses session storage for cost-bearing drafts and warns on browser unload', () => {
    const helper = readFileSync(join(
      process.cwd(), 'src', 'app', 'inventory', '_components', 'overlays', 'inventory-overlay-draft.ts',
    ), 'utf8');
    const overlay = readFileSync(join(
      process.cwd(), 'src', 'app', 'inventory', '_components', 'overlays', 'Overlay.tsx',
    ), 'utf8');
    assert.match(helper, /window\.sessionStorage/);
    assert.doesNotMatch(helper, /window\.localStorage/);
    assert.match(overlay, /hasUnsavedChanges/);
    assert.match(overlay, /beforeunload/);
  });
});

describe('inventory overlay usability contracts', () => {
  test('all editable overlays persist drafts and route every modal close through their guard', () => {
    for (const file of ['AddItemSheet.tsx', 'CountSheet.tsx', 'DeliverySheet.tsx']) {
      const source = readFileSync(join(
        process.cwd(), 'src', 'app', 'inventory', '_components', 'overlays', file,
      ), 'utf8');
      assert.match(source, /persistInventoryOverlayDraft/);
      assert.match(source, /clearInventoryOverlayDraft/);
      assert.match(source, /hasUnsavedChanges=\{dirty\}/);
      assert.match(source, /onClose=\{requestClose\}/);
    }
  });

  test('heavy sheets preserve exit motion without rebuilding forever while closed', () => {
    const overlay = readFileSync(join(
      process.cwd(), 'src', 'app', 'inventory', '_components', 'overlays', 'Overlay.tsx',
    ), 'utf8');
    assert.match(overlay, /export function useOverlayPresence\(open: boolean\)/);
    assert.match(overlay, /return open \|\| present/);
    for (const file of ['CountSheet.tsx', 'DeliverySheet.tsx']) {
      const source = readFileSync(join(
        process.cwd(), 'src', 'app', 'inventory', '_components', 'overlays', file,
      ), 'utf8');
      assert.match(source, /const present = useOverlayPresence\(open\)/);
      assert.match(source, /if \(!present\) return null/);
      assert.doesNotMatch(source, /if \(!open\) return null/);
      assert.match(source, /open=\{open\}/);
    }
  });

  test('count inline Add Item carries the same operational fields as the main form', () => {
    const count = readFileSync(join(
      process.cwd(), 'src', 'app', 'inventory', '_components', 'overlays', 'CountSheet.tsx',
    ), 'utf8');
    assert.match(count, /fCategory/);
    assert.match(count, /fSetAside/);
    assert.match(count, /fVendor/);
    assert.match(count, /setAside:\s*attempt\.setAside/);
    assert.match(count, /vendorName:\s*attempt\.vendorName/);
    assert.match(count, /customCategoryId:\s*attempt\.customCategoryId/);
  });

  test('mobile cards expose the complete item editor and all mobile controls keep 44px targets', () => {
    const component = readFileSync(join(
      process.cwd(), 'src', 'app', 'inventory', '_components', 'MobileInventoryTriage.tsx',
    ), 'utf8');
    const css = readFileSync(join(
      process.cwd(), 'src', 'app', 'inventory', '_components', 'MobileInventoryTriage.module.css',
    ), 'utf8');
    const shell = readFileSync(join(
      process.cwd(), 'src', 'app', 'inventory', '_components', 'InventoryShell.tsx',
    ), 'utf8');
    assert.match(component, /onEdit\?: \(item: DisplayItem\) => void/);
    assert.match(component, /onClick=\{\(\) => onEdit\(item\)\}/);
    assert.match(shell, /<MobileInventoryTriage[\s\S]*?onEdit=\{onEditItem\}/);
    assert.match(css, /\.editButton\s*\{[\s\S]*?height:\s*44px/);
    assert.match(css, /\.stepButton\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/);
  });

  test('the removal action says Delete while retaining the soft-archive implementation', () => {
    const source = readFileSync(join(
      process.cwd(), 'src', 'app', 'inventory', '_components', 'overlays', 'AddItemSheet.tsx',
    ), 'utf8');
    assert.match(source, /archive:\s*'Delete item'/);
    assert.match(source, /disappear from active inventory and totals/);
    assert.match(source, /archiveInventoryItem/);
  });
});
