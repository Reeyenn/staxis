/**
 * Tests for userHasPropertyAccess in src/lib/api-auth.ts.
 *
 * This single boolean function is the difference between hotel A's GM
 * reading hotel A's rooms vs. accidentally reading hotel B's rooms. Every
 * /api/* mutation that takes a property_id calls it after requireSession.
 * If it regresses to "always return true", that's an instant cross-tenant
 * data-leak. If it regresses to "always return false", every authenticated
 * action 403s in prod with no obvious cause.
 *
 * Strategy: monkey-patch supabaseAdmin.from to return a chainable mock
 * that responds to .select().eq().maybeSingle() — the exact chain the
 * function uses against the accounts table.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { userHasPropertyAccess } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';

// ─── Mock infrastructure ─────────────────────────────────────────────────

type AccountsRow = {
  role: 'admin' | 'general_manager' | 'housekeeping' | 'owner' | null;
  property_access: string[] | null;
} | null;

type FromFn = typeof supabaseAdmin.from;
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);

let nextResult: { data: AccountsRow; error: { message: string } | null } = {
  data: null,
  error: null,
};
let fromCalls: { table: string; uid: string }[] = [];
let throwOnQuery = false;

beforeEach(() => {
  nextResult = { data: null, error: null };
  fromCalls = [];
  throwOnQuery = false;
  // @ts-expect-error monkey-patching the singleton for the test
  supabaseAdmin.from = (table: string) => {
    // The function chain we mimic: .from('accounts').select('role, property_access').eq('data_user_id', userId).maybeSingle()
    return {
      select: (_cols: string) => ({
        eq: (_col: string, val: string) => ({
          maybeSingle: async () => {
            fromCalls.push({ table, uid: val });
            if (throwOnQuery) throw new Error('connection reset');
            return nextResult;
          },
        }),
      }),
    };
  };
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

const PID_A = '00000000-0000-0000-0000-0000000000aa';
const PID_B = '00000000-0000-0000-0000-0000000000bb';
const UID = '11111111-2222-3333-4444-555555555555';

// ─── Tests ───────────────────────────────────────────────────────────────

describe('userHasPropertyAccess — admin role', () => {
  test('admin role with empty property_access → true (admins access all)', async () => {
    nextResult = { data: { role: 'admin', property_access: [] }, error: null };
    assert.equal(await userHasPropertyAccess(UID, PID_A), true);
  });

  test('admin role with null property_access → true', async () => {
    nextResult = { data: { role: 'admin', property_access: null }, error: null };
    assert.equal(await userHasPropertyAccess(UID, PID_A), true);
  });

  test('admin role with specific properties → true regardless of pid', async () => {
    // Admins should pass even if their property_access is somehow stale.
    nextResult = { data: { role: 'admin', property_access: [PID_B] }, error: null };
    assert.equal(await userHasPropertyAccess(UID, PID_A), true);
  });
});

describe('userHasPropertyAccess — non-admin gating', () => {
  test('non-admin with pid in property_access → true', async () => {
    nextResult = { data: { role: 'general_manager', property_access: [PID_A, PID_B] }, error: null };
    assert.equal(await userHasPropertyAccess(UID, PID_A), true);
    assert.equal(await userHasPropertyAccess(UID, PID_B), true);
  });

  test('non-admin with wildcard "*" in property_access → true', async () => {
    nextResult = { data: { role: 'general_manager', property_access: ['*'] }, error: null };
    assert.equal(await userHasPropertyAccess(UID, PID_A), true);
    assert.equal(await userHasPropertyAccess(UID, PID_B), true);
  });

  test('non-admin without pid → false (cross-tenant gate)', async () => {
    // The load-bearing assertion: a GM at hotel A cannot read hotel B's
    // rooms even if they trick the route into accepting pid=B.
    nextResult = { data: { role: 'general_manager', property_access: [PID_A] }, error: null };
    assert.equal(await userHasPropertyAccess(UID, PID_B), false);
  });

  test('non-admin with empty property_access → false', async () => {
    nextResult = { data: { role: 'housekeeping', property_access: [] }, error: null };
    assert.equal(await userHasPropertyAccess(UID, PID_A), false);
  });

  test('non-admin with null property_access → false', async () => {
    nextResult = { data: { role: 'housekeeping', property_access: null }, error: null };
    assert.equal(await userHasPropertyAccess(UID, PID_A), false);
  });
});

describe('userHasPropertyAccess — error paths (fail closed)', () => {
  test('no accounts row → false', async () => {
    nextResult = { data: null, error: null };
    assert.equal(await userHasPropertyAccess(UID, PID_A), false);
  });

  test('Supabase returns an error → false', async () => {
    nextResult = { data: null, error: { message: 'permission denied' } };
    assert.equal(await userHasPropertyAccess(UID, PID_A), false);
  });

  test('query throws → false (caught, never propagates)', async () => {
    // A throwing supabase call must never escape — the calling route would
    // 500 instead of 403 and the user sees a confusing error.
    throwOnQuery = true;
    assert.equal(await userHasPropertyAccess(UID, PID_A), false);
  });
});

describe('userHasPropertyAccess — query shape', () => {
  test('queries the accounts table keyed by data_user_id', async () => {
    nextResult = { data: { role: 'admin', property_access: null }, error: null };
    await userHasPropertyAccess(UID, PID_A);
    assert.equal(fromCalls.length, 1);
    assert.equal(fromCalls[0].table, 'accounts');
    assert.equal(fromCalls[0].uid, UID);
  });
});
