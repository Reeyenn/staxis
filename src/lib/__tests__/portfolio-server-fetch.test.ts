/**
 * Tests for src/lib/portfolio/server-fetch.ts — focused on the cross-
 * property authorization gate.
 *
 * The security guarantee: a caller cannot enumerate properties they
 * don't have access to by passing arbitrary IDs in the `requested`
 * argument. resolveAccessiblePropertyIds must INTERSECT the requested
 * list with the caller's `accounts.property_access` array (or return
 * the full table for admin / wildcard).
 *
 * The supabaseAdmin singleton is monkey-patched per test so each
 * scenario controls the `accounts` / `properties` reads independently.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { resolveAccessiblePropertyIds } from '@/lib/portfolio/server-fetch';

type FromFn = typeof supabaseAdmin.from;
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);

// Per-test fixture: what to return when `accounts` is queried, and
// what to return when `properties` is queried.
let accountsRow: { role: string; property_access: string[] } | null = null;
let propertiesRows: Array<{ id: string }> = [];

function installMock() {
  // @ts-expect-error monkey-patching singleton for the test
  supabaseAdmin.from = (table: string) => {
    if (table === 'accounts') {
      return {
        select: (_cols: string) => ({
          eq: (_col: string, _val: string) => ({
            maybeSingle: async () => ({
              data: accountsRow,
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'properties') {
      const queryBuilder = {
        select: (_cols: string) => ({
          // .in() (used when caller is non-admin) → returns the filter
          // applied to the canned list. We don't expect this branch to
          // be exercised in the resolveAccessiblePropertyIds tests, but
          // we ship it so other callers (e.g. the /properties route
          // test if/when we add one) get a sane mock.
          in: (_col: string, ids: string[]) => Promise.resolve({
            data: propertiesRows.filter(r => ids.includes(r.id)),
            error: null,
          }),
          // .select() with no follow-up (admin path) → all rows.
          then: (cb: (v: { data: Array<{ id: string }>; error: null }) => unknown) =>
            Promise.resolve({ data: propertiesRows, error: null }).then(cb),
        }),
      };
      // The await-on-builder path used by admin lookup awaits the
      // .select(...) chain directly. Returning the builder lets both
      // `.select().in()` and `await .select()` paths work.
      return queryBuilder;
    }
    throw new Error(`unexpected table in test: ${table}`);
  };
}

beforeEach(installMock);
afterEach(() => { supabaseAdmin.from = originalFrom; });

describe('resolveAccessiblePropertyIds — access control', () => {
  test('non-admin: requested list is INTERSECTED with property_access', async () => {
    accountsRow = { role: 'owner', property_access: ['p-a', 'p-b'] };
    propertiesRows = [];   // admin path not used

    // User has p-a, p-b. They asked for p-a, p-c. The intersection is
    // just p-a — p-c silently drops out (no enumeration leak).
    const out = await resolveAccessiblePropertyIds('u1', ['p-a', 'p-c']);
    assert.deepEqual(out, ['p-a']);
  });

  test('non-admin: empty property_access → empty result', async () => {
    accountsRow = { role: 'owner', property_access: [] };
    const out = await resolveAccessiblePropertyIds('u1', ['p-a', 'p-b']);
    assert.deepEqual(out, []);
  });

  test('non-admin: no `requested` → returns the full property_access list', async () => {
    accountsRow = { role: 'owner', property_access: ['p-a', 'p-b', 'p-c'] };
    const out = await resolveAccessiblePropertyIds('u1');
    assert.deepEqual(out, ['p-a', 'p-b', 'p-c']);
  });

  test('admin role: full property list, regardless of property_access array', async () => {
    accountsRow = { role: 'admin', property_access: [] };
    propertiesRows = [{ id: 'p-x' }, { id: 'p-y' }, { id: 'p-z' }];
    const out = await resolveAccessiblePropertyIds('u1');
    assert.deepEqual(out.sort(), ['p-x', 'p-y', 'p-z']);
  });

  test('wildcard property_access: full property list', async () => {
    accountsRow = { role: 'owner', property_access: ['*'] };
    propertiesRows = [{ id: 'p-x' }, { id: 'p-y' }];
    const out = await resolveAccessiblePropertyIds('u1');
    assert.deepEqual(out.sort(), ['p-x', 'p-y']);
  });

  test('no accounts row → no properties (e.g. user mid-onboarding)', async () => {
    accountsRow = null;
    const out = await resolveAccessiblePropertyIds('u1');
    assert.deepEqual(out, []);
  });

  test('duplicate ids in `requested` are deduplicated', async () => {
    accountsRow = { role: 'owner', property_access: ['p-a', 'p-b'] };
    const out = await resolveAccessiblePropertyIds('u1', ['p-a', 'p-a', 'p-b']);
    assert.deepEqual(out, ['p-a', 'p-b']);
  });

  test('request-order preserved (filtered)', async () => {
    accountsRow = { role: 'owner', property_access: ['p-a', 'p-b', 'p-c'] };
    const out = await resolveAccessiblePropertyIds('u1', ['p-c', 'p-a', 'p-b']);
    assert.deepEqual(out, ['p-c', 'p-a', 'p-b']);
  });

  test('attacker passes IDs they DO NOT own → silent filter, no error', async () => {
    // Scenario: caller has Hotel A only. They craft a request asking
    // for [Hotel A, Hotel B, Hotel C]. The function MUST return
    // [Hotel A] without throwing or signaling the existence of B/C.
    accountsRow = { role: 'owner', property_access: ['hotel-a'] };
    const out = await resolveAccessiblePropertyIds('attacker', ['hotel-a', 'hotel-b', 'hotel-c']);
    assert.deepEqual(out, ['hotel-a']);
  });
});
