/**
 * Structural regression guards for inventory retention. These deliberately
 * pin the destructive boundary: an item archive must remain an UPDATE, active
 * reads must exclude archived rows, and deleting an auth account must never
 * cascade-delete a hotel it owns.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

test('inventory item removal is a verified soft archive, never a hard delete', () => {
  const db = source('src', 'lib', 'db', 'inventory.ts');

  assert.doesNotMatch(db, /from\(['"]inventory['"]\)\.delete\(/);
  assert.match(db, /export async function archiveInventoryItem/);
  assert.match(db, /archived_at:\s*now/);
  assert.match(db, /archived_by:\s*uid/);
  assert.match(db, /\.eq\(['"]property_id['"],\s*pid\)/);
  assert.match(db, /\.is\(['"]archived_at['"],\s*null\)/);
  assert.match(db, /\.select\(['"]id['"]\)\s*\n\s*\.maybeSingle\(\)/);
  assert.match(db, /if \(!archived\)/);
});

test('inventory UI calls the archive action behind plain-language Delete copy and explains that history is kept', () => {
  const sheet = source('src', 'app', 'inventory', '_components', 'overlays', 'AddItemSheet.tsx');

  assert.match(sheet, /archiveInventoryItem/);
  assert.doesNotMatch(sheet, /deleteInventoryItem/);
  assert.match(sheet, /all count and delivery history will be kept/);
  assert.match(sheet, /todo el historial de conteos y entregas/);
  assert.match(sheet, /archive:\s*'Delete item'/);
  assert.match(sheet, /archive:\s*'Eliminar artículo'/);
  assert.match(sheet, /disappear from active inventory and totals/);
});

test('active inventory subscriptions and summaries exclude archived rows', () => {
  const inventoryDb = source('src', 'lib', 'db', 'inventory.ts');
  const homeSummary = source('src', 'app', 'api', 'home', 'summary', 'route.ts');
  const reportCatalog = source('src', 'lib', 'reports', 'catalog', 'definitions.ts');

  assert.match(inventoryDb, /\.is\(['"]archived_at['"],\s*null\)/);
  assert.match(homeSummary, /from\(['"]inventory['"]\)[\s\S]*?\.is\(['"]archived_at['"],\s*null\)/);
  assert.match(reportCatalog, /from\(['"]inventory['"]\)[\s\S]*?\.is\(['"]archived_at['"],\s*null\)/);
});

test('count history keeps enough rows for a multi-week hotel trial', () => {
  const shell = source('src', 'app', 'inventory', '_components', 'InventoryShell.tsx');
  assert.match(shell, /listInventoryCounts\(uid,\s*pid,\s*2000,/);
});

test('account deletion blocks hotel owners before deleting their auth user', () => {
  const route = source('src', 'app', 'api', 'auth', 'accounts', 'route.ts');
  const ownershipCheck = route.indexOf(".from('properties')");
  const conflict = route.indexOf('status: 409', ownershipCheck);
  const authDelete = route.indexOf('auth.admin.deleteUser', ownershipCheck);

  assert.ok(ownershipCheck >= 0, 'must query properties before account deletion');
  assert.ok(conflict > ownershipCheck, 'must return 409 when the target owns a hotel');
  assert.ok(authDelete > conflict, 'ownership guard must execute before auth deletion');
  assert.match(route, /\.eq\(['"]owner_id['"],\s*target\.data_user_id\)/);
});
