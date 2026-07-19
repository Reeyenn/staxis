/** Regression guards for hotel-delete/account-link serialization. */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const route = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'admin', 'properties', 'delete', 'route.ts'),
  'utf8',
);
const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0325_organization_access_foundation.sql'),
  'utf8',
);

describe('admin property deletion race containment', () => {
  test('uses one transactional RPC and rechecks the typed name under its row lock', () => {
    assert.match(route, /staxis_delete_property_and_legacy_accounts/);
    assert.match(route, /p_confirmed_name: confirmName \|\| null/);
    assert.doesNotMatch(route, /p_allow_live/);
    assert.match(migration, /confirmed hotel name does not match the locked hotel name/);
  });

  test('follows account-to-property lock order before deleting the hotel', () => {
    const fn = migration.match(
      /create or replace function public\.staxis_delete_property_and_legacy_accounts[\s\S]*?\n\$\$;/,
    )?.[0] ?? '';
    const accountLock = fn.indexOf('from public.accounts account');
    const propertyLock = fn.indexOf('from public.properties property');
    const propertyDelete = fn.indexOf('delete from public.properties');
    assert.ok(accountLock >= 0, 'expected the global account-row lock');
    assert.ok(propertyLock > accountLock, 'property lock must follow account locks');
    assert.ok(propertyDelete > propertyLock, 'property deletion must follow both lock phases');
  });

  test('account reconciliation rejects a hotel UUID that vanished while waiting', () => {
    const trigger = migration.match(
      /create or replace function public\._staxis_reconcile_account_trigger[\s\S]*?\n\$\$;/,
    )?.[0] ?? '';
    assert.match(trigger, /for update/);
    assert.match(trigger, /account property access references a missing hotel/);
    assert.match(trigger, /errcode = '23503'/);
  });
});
