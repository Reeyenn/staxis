/**
 * Tests for GET /api/auth/join-codes — privileged-code read filter.
 *
 * Migration 0273 makes single-use owner/general_manager codes mintable +
 * redeemable. This route lists a hotel's join codes for any verifyTeamManager
 * caller (owner / GM / admin) and uses the service-role client, which BYPASSES
 * the hotel_join_codes RLS that hides privileged rows from the browser client.
 *
 * Security contract: a NON-admin manager (e.g. a GM invited during onboarding)
 * must NEVER see an admin-issued owner/GM code's raw value here — otherwise
 * they could read a pending owner invite and redeem it to take over the
 * still-unclaimed hotel. Admins (trusted, fleet-wide) still see everything.
 *
 * Mock pattern mirrors pms-save-credentials.test.ts: stub getUser +
 * accounts + trusted_devices so requireSession/verifyTeamManager succeed,
 * then return mixed rows from hotel_join_codes and assert the filter.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase-admin';

type FromFn = typeof supabaseAdmin.from;
type GetUserFn = typeof supabaseAdmin.auth.getUser;
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalGetUser: GetUserFn = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

const HOTEL = '22222222-2222-2222-2222-222222222222';
const UID = '11111111-1111-1111-1111-111111111111';

// All codes that exist for the hotel (owner + GM + staff + new-flow).
const ALL_CODES = [
  { id: 'c1', code: 'OWNER-SECRET', role: 'owner', expires_at: 'x', max_uses: 1, used_count: 0, created_at: 'x', revoked_at: null },
  { id: 'c2', code: 'GM-SECRET', role: 'general_manager', expires_at: 'x', max_uses: 1, used_count: 0, created_at: 'x', revoked_at: null },
  { id: 'c3', code: 'STAFF-SHARED', role: 'housekeeping', expires_at: 'x', max_uses: 100, used_count: 3, created_at: 'x', revoked_at: null },
  { id: 'c4', code: 'NEWFLOW', role: null, expires_at: 'x', max_uses: 100, used_count: 0, created_at: 'x', revoked_at: null },
];

const state = { role: 'general_manager' as string };

beforeEach(() => {
  state.role = 'general_manager';

  supabaseAdmin.auth.getUser = (async () => ({
    data: { user: { id: UID, email: 'mgr@hotel.test' } },
    error: null,
  })) as unknown as GetUserFn;

  supabaseAdmin.from = ((table: string) => {
    const builder: any = {
      select() { return builder; },
      eq() { return builder; },
      is() { return builder; },
      order: async () => {
        if (table === 'hotel_join_codes') return { data: ALL_CODES, error: null };
        return { data: [], error: null };
      },
      maybeSingle: async () => {
        if (table === 'accounts') {
          return {
            data: { id: 'acct-1', skip_2fa: false, role: state.role, property_access: [HOTEL] },
            error: null,
          };
        }
        if (table === 'trusted_devices') {
          return {
            data: {
              id: 'device-1',
              expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
              absolute_expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    };
    return builder;
  }) as unknown as FromFn;
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.auth.getUser = originalGetUser;
});

function makeReq(): NextRequest {
  const headers = new Headers({
    authorization: 'Bearer fake-jwt-the-mock-accepts-anything',
    'content-type': 'application/json',
  });
  const cookies = new Map<string, { value: string }>([
    ['staxis_device', { value: 'a'.repeat(64) }],
  ]);
  return {
    url: `https://staxis.test/api/auth/join-codes?hotelId=${HOTEL}`,
    method: 'GET',
    headers,
    cookies: { get: (n: string) => cookies.get(n) ?? undefined },
  } as unknown as NextRequest;
}

describe('GET /api/auth/join-codes — privileged-code filter', () => {
  test('a GM never sees owner/GM code rows (only staff + new-flow)', async () => {
    state.role = 'general_manager';
    const { GET } = await import('@/app/api/auth/join-codes/route');
    const res = await GET(makeReq());
    assert.equal(res.status, 200);
    const body = await res.json();
    const codes = body.data.codes as Array<{ code: string; role: string | null }>;
    const roles = codes.map((c) => c.role);
    assert.ok(!roles.includes('owner'), 'owner code must NOT be returned to a GM');
    assert.ok(!roles.includes('general_manager'), 'GM code must NOT be returned to a GM');
    // The secret owner code value must be absent entirely.
    assert.ok(!codes.some((c) => c.code === 'OWNER-SECRET'));
    // Staff + new-flow codes are still listed (the route's real purpose).
    assert.deepEqual(codes.map((c) => c.code).sort(), ['NEWFLOW', 'STAFF-SHARED']);
  });

  test('an owner (non-admin) also does not see owner/GM rows', async () => {
    state.role = 'owner';
    const { GET } = await import('@/app/api/auth/join-codes/route');
    const res = await GET(makeReq());
    assert.equal(res.status, 200);
    const body = await res.json();
    const codes = body.data.codes as Array<{ role: string | null }>;
    assert.ok(!codes.some((c) => c.role === 'owner' || c.role === 'general_manager'));
  });

  test('an admin sees ALL codes (trusted, fleet-wide management)', async () => {
    state.role = 'admin';
    const { GET } = await import('@/app/api/auth/join-codes/route');
    const res = await GET(makeReq());
    assert.equal(res.status, 200);
    const body = await res.json();
    const codes = body.data.codes as Array<{ code: string }>;
    assert.equal(codes.length, 4, 'admin sees owner + GM + staff + new-flow');
    assert.ok(codes.some((c) => c.code === 'OWNER-SECRET'));
  });
});
