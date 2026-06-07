/**
 * Unit tests for callerManagesHotel — the management-with-access predicate
 * that gates the PMS onboarding wizard routes (/api/pms/save-credentials,
 * /api/pms/onboard, /api/pms/job-status) after migration 0273.
 *
 * Security contract:
 *   - owner / general_manager WITH the hotel in property_access → true
 *   - admin → true for ANY hotel (manages the whole fleet)
 *   - staff roles (front_desk / housekeeping / maintenance) → ALWAYS false,
 *     even with the hotel in property_access (they must not write PMS creds)
 *   - owner/GM WITHOUT the hotel in property_access → false
 *   - missing account / lookup error → false (fail closed)
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { callerManagesHotel } from '@/lib/team-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';

type FromFn = typeof supabaseAdmin.from;
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);

interface State {
  account: { role: string; property_access: string[] | null } | null;
  error: { message: string } | null;
}
const state: State = { account: null, error: null };

const HOTEL = 'hotel-A';
const OTHER_HOTEL = 'hotel-B';
const UID = 'auth-uid-1';

beforeEach(() => {
  state.account = null;
  state.error = null;
  // @ts-expect-error monkey-patch
  supabaseAdmin.from = (table: string) => {
    if (table === 'accounts') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: state.account, error: state.error }),
          }),
        }),
      };
    }
    return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
  };
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

describe('callerManagesHotel', () => {
  test('owner WITH access → true', async () => {
    state.account = { role: 'owner', property_access: [HOTEL] };
    assert.equal(await callerManagesHotel(UID, HOTEL), true);
  });

  test('general_manager WITH access → true', async () => {
    state.account = { role: 'general_manager', property_access: [OTHER_HOTEL, HOTEL] };
    assert.equal(await callerManagesHotel(UID, HOTEL), true);
  });

  test('admin → true for any hotel (no property_access needed)', async () => {
    state.account = { role: 'admin', property_access: [] };
    assert.equal(await callerManagesHotel(UID, HOTEL), true);
  });

  test('front_desk WITH access → false (staff cannot manage PMS)', async () => {
    state.account = { role: 'front_desk', property_access: [HOTEL] };
    assert.equal(await callerManagesHotel(UID, HOTEL), false);
  });

  test('housekeeping WITH access → false', async () => {
    state.account = { role: 'housekeeping', property_access: [HOTEL] };
    assert.equal(await callerManagesHotel(UID, HOTEL), false);
  });

  test('maintenance WITH access → false', async () => {
    state.account = { role: 'maintenance', property_access: [HOTEL] };
    assert.equal(await callerManagesHotel(UID, HOTEL), false);
  });

  test('owner WITHOUT this hotel in access → false', async () => {
    state.account = { role: 'owner', property_access: [OTHER_HOTEL] };
    assert.equal(await callerManagesHotel(UID, HOTEL), false);
  });

  test('owner with null property_access → false', async () => {
    state.account = { role: 'owner', property_access: null };
    assert.equal(await callerManagesHotel(UID, HOTEL), false);
  });

  test('missing account → false (fail closed)', async () => {
    state.account = null;
    assert.equal(await callerManagesHotel(UID, HOTEL), false);
  });

  test('lookup error → false (fail closed)', async () => {
    state.account = null;
    state.error = { message: 'boom' };
    assert.equal(await callerManagesHotel(UID, HOTEL), false);
  });
});
