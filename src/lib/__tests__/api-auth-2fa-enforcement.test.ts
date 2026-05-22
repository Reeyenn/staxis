/**
 * Tests for the server-side 2FA enforcement added to requireSession() in
 * the 2026-05-22 auth audit (Phase 1).
 *
 * What this guarantees:
 *   - A valid Supabase JWT alone is NOT sufficient — the staxis_device
 *     cookie must also match a non-expired row in trusted_devices for
 *     the caller's account. This is the load-bearing check that closes
 *     the "attacker with leaked password calls signInWithPassword and
 *     uses the JWT directly" attack vector.
 *   - The skip_2fa demo bypass still works EXACTLY as before for the
 *     non-admin investor account (test / testhk / testfd at Comfort
 *     Suites).
 *   - skip_2fa is REFUSED for admin role even if env gate + allowlist
 *     are configured to permit it. Defense in depth against config
 *     drift on SKIP_2FA_USER_IDS.
 *   - DISABLE_SERVER_2FA_ENFORCEMENT=true is the break-glass kill
 *     switch — when set, enforcement bypasses with a CRITICAL log.
 *   - Fail-closed on any DB error.
 *   - { enforce2FA: false } opt-out works for auth-flow callers.
 *
 * Strategy: monkey-patch supabaseAdmin.auth.getUser AND supabaseAdmin.from
 * to control JWT validation + the accounts/trusted_devices lookups
 * independently. Mock requests carry both Authorization headers and
 * staxis_device cookies.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { hashDeviceToken, TRUST_COOKIE_NAME } from '@/lib/trusted-device';

// ─── Test-time mocking ───────────────────────────────────────────────────

type GetUserResult = Awaited<ReturnType<typeof supabaseAdmin.auth.getUser>>;
type GetUserFn = typeof supabaseAdmin.auth.getUser;
type FromFn = typeof supabaseAdmin.from;

const originalGetUser: GetUserFn = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);

interface AccountRow {
  id: string;
  skip_2fa: boolean;
  role: string;
  property_access: string[] | null;
}

interface DeviceRow {
  id: string;
  expires_at: string;
  absolute_expires_at: string | null;
}

interface MockState {
  user: { id: string; email?: string | null } | null;
  userError: { message: string; status?: number; name?: string } | null;
  account: AccountRow | null;
  accountError: { message: string } | null;
  device: DeviceRow | null;
  deviceError: { message: string } | null;
  throwOnAccountsQuery: boolean;
  throwOnDevicesQuery: boolean;
  insertedEvents: Array<{ event_type: string; metadata: Record<string, unknown> }>;
}

const state: MockState = {
  user: null,
  userError: null,
  account: null,
  accountError: null,
  device: null,
  deviceError: null,
  throwOnAccountsQuery: false,
  throwOnDevicesQuery: false,
  insertedEvents: [],
};

beforeEach(() => {
  state.user = null;
  state.userError = null;
  state.account = null;
  state.accountError = null;
  state.device = null;
  state.deviceError = null;
  state.throwOnAccountsQuery = false;
  state.throwOnDevicesQuery = false;
  state.insertedEvents = [];
  // Preserve env state but ensure break-glass is OFF by default.
  delete process.env.DISABLE_SERVER_2FA_ENFORCEMENT;

  supabaseAdmin.auth.getUser = (async () => ({
    data: { user: state.user as { id: string; email?: string | null } | null },
    error: state.userError,
  })) as unknown as GetUserFn;

  // Two-table mock. .from('accounts')... and .from('trusted_devices')...
  // both return chainable builders that resolve to maybeSingle / insert.
  // @ts-expect-error monkey-patch singleton
  supabaseAdmin.from = (table: string) => {
    if (table === 'accounts') {
      return {
        select: (_cols: string) => ({
          eq: (_col: string, _val: string) => ({
            maybeSingle: async () => {
              if (state.throwOnAccountsQuery) throw new Error('accounts query threw');
              return { data: state.account, error: state.accountError };
            },
          }),
        }),
      };
    }
    if (table === 'trusted_devices') {
      return {
        select: (_cols: string) => ({
          eq: (_col1: string, _val1: string) => ({
            eq: (_col2: string, _val2: string) => ({
              maybeSingle: async () => {
                if (state.throwOnDevicesQuery) throw new Error('devices query threw');
                return { data: state.device, error: state.deviceError };
              },
            }),
          }),
        }),
      };
    }
    if (table === 'app_events') {
      return {
        insert: async (row: { event_type: string; metadata: Record<string, unknown> }) => {
          state.insertedEvents.push(row);
          return { error: null };
        },
      };
    }
    throw new Error(`unexpected table in test mock: ${table}`);
  };
});

afterEach(() => {
  supabaseAdmin.auth.getUser = originalGetUser;
  supabaseAdmin.from = originalFrom;
  delete process.env.DISABLE_SERVER_2FA_ENFORCEMENT;
  delete process.env.SKIP_2FA_ENABLED;
  delete process.env.SKIP_2FA_USER_IDS;
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function mintJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.test-signature`;
}

function mockReq(opts: { auth?: string; deviceCookie?: string } = {}): NextRequest {
  const cookies = new Map<string, { value: string }>();
  if (opts.deviceCookie) cookies.set(TRUST_COOKIE_NAME, { value: opts.deviceCookie });
  const headers = new Headers();
  if (opts.auth) headers.set('authorization', opts.auth);
  return {
    url: 'https://staxis.test/api/protected',
    headers: {
      get: (name: string) => headers.get(name),
    },
    cookies: {
      get: (name: string) => cookies.get(name) ?? undefined,
    },
  } as unknown as NextRequest;
}

const USER_ID = '11111111-2222-3333-4444-555555555555';
const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const FUTURE = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const PAST = () => new Date(Date.now() - 60 * 1000).toISOString();
const validJwt = () => mintJwt({
  sub: USER_ID,
  exp: Math.floor(Date.now() / 1000) + 3600,
  iss: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co',
});

function ok(user = { id: USER_ID, email: 'staff@example.com' }): void {
  state.user = user;
  state.userError = null;
}

// ─── Tests: device-cookie path ───────────────────────────────────────────

describe('requireSession — device-trust enforcement', () => {
  test('valid JWT + matching trusted_devices row + not expired → 200', async () => {
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager', property_access: ['hotel-1'] };
    state.device = { id: 'dev-1', expires_at: FUTURE(), absolute_expires_at: FUTURE() };
    const cookie = 'a'.repeat(64);
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}`, deviceCookie: cookie }));
    assert.equal(result.ok, true, 'expected requireSession to succeed');
    if (result.ok) assert.equal(result.userId, USER_ID);
  });

  test('valid JWT + NO device cookie → 401 requires_2fa (core attack-vector block)', async () => {
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager', property_access: ['hotel-1'] };
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}` }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.response.status, 401);
      const body = await result.response.json();
      assert.equal(body.code, 'requires_2fa');
      assert.equal(body.reason, 'no_cookie');
    }
  });

  test('valid JWT + cookie present but no matching trusted_devices row → 401 (forged cookie)', async () => {
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager', property_access: ['hotel-1'] };
    state.device = null;
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}`, deviceCookie: 'forged' }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.code, 'requires_2fa');
      assert.equal(body.reason, 'cookie_invalid');
    }
  });

  test('valid JWT + device row with expires_at in the past → 401 cookie_expired', async () => {
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager', property_access: ['hotel-1'] };
    state.device = { id: 'dev-1', expires_at: PAST(), absolute_expires_at: FUTURE() };
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}`, deviceCookie: 'x'.repeat(64) }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.reason, 'cookie_expired');
    }
  });

  test('valid JWT + device row with absolute_expires_at in the past → 401 absolute_cap_reached', async () => {
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager', property_access: ['hotel-1'] };
    state.device = { id: 'dev-1', expires_at: FUTURE(), absolute_expires_at: PAST() };
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}`, deviceCookie: 'x'.repeat(64) }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.reason, 'absolute_cap_reached');
    }
  });

  test('valid JWT + device row missing absolute_expires_at → fail closed (migration 0153 not applied)', async () => {
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager', property_access: ['hotel-1'] };
    state.device = { id: 'dev-1', expires_at: FUTURE(), absolute_expires_at: null };
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}`, deviceCookie: 'x'.repeat(64) }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.reason, 'absolute_cap_reached');
    }
  });
});

// ─── Tests: skip_2fa path (demo / investor account) ──────────────────────

describe('requireSession — skip_2fa bypass', () => {
  test('skip_2fa user in allowlist, non-admin, scoped property_access → 200 (demo works)', async () => {
    process.env.SKIP_2FA_ENABLED = 'true';
    process.env.SKIP_2FA_USER_IDS = USER_ID;
    ok();
    state.account = {
      id: ACCOUNT_ID,
      skip_2fa: true,
      role: 'general_manager',
      property_access: ['comfort-suites-uuid'],
    };
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}` }));
    assert.equal(result.ok, true, 'demo bypass should succeed for non-admin allowlisted user');
    // Confirm the success was logged as skip_2fa_used (audit trail).
    const used = state.insertedEvents.find((e) => e.event_type === 'auth.skip_2fa_used');
    assert.ok(used, 'auth.skip_2fa_used event should be written');
  });

  test('skip_2fa user NOT in allowlist → 401 requires_2fa', async () => {
    process.env.SKIP_2FA_ENABLED = 'true';
    process.env.SKIP_2FA_USER_IDS = '99999999-9999-9999-9999-999999999999';  // different uuid
    ok();
    state.account = {
      id: ACCOUNT_ID,
      skip_2fa: true,
      role: 'general_manager',
      property_access: ['hotel-1'],
    };
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}` }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.code, 'requires_2fa');
      assert.equal(body.reason, 'skip_2fa_not_allowlisted');
    }
    const blocked = state.insertedEvents.find((e) => e.event_type === 'auth.skip_2fa_account_not_allowlisted');
    assert.ok(blocked, 'auth.skip_2fa_account_not_allowlisted should be logged');
  });

  test('SKIP_2FA_ENABLED not "true" → 401 requires_2fa even when allowlisted', async () => {
    process.env.SKIP_2FA_ENABLED = 'false';
    process.env.SKIP_2FA_USER_IDS = USER_ID;
    ok();
    state.account = {
      id: ACCOUNT_ID,
      skip_2fa: true,
      role: 'general_manager',
      property_access: ['hotel-1'],
    };
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}` }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.reason, 'skip_2fa_blocked_by_env');
    }
  });

  test('skip_2fa + role="admin" → 401 requires_2fa (privileged refusal) even with full allowlist', async () => {
    // The config-drift footgun: admin row accidentally has skip_2fa=true,
    // AND their uuid is in the env allowlist. Privileged refusal MUST
    // override the success path here.
    process.env.SKIP_2FA_ENABLED = 'true';
    process.env.SKIP_2FA_USER_IDS = USER_ID;
    ok();
    state.account = {
      id: ACCOUNT_ID,
      skip_2fa: true,
      role: 'admin',
      property_access: [],
    };
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}` }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.code, 'requires_2fa');
      assert.equal(body.reason, 'skip_2fa_refused_privileged');
    }
    const refused = state.insertedEvents.find((e) => e.event_type === 'auth.skip_2fa_refused_privileged');
    assert.ok(refused, 'auth.skip_2fa_refused_privileged event must be logged for incident review');
    assert.equal(refused?.metadata.role, 'admin');
  });

  test('skip_2fa + property_access includes "*" → 401 requires_2fa (privileged refusal)', async () => {
    // Belt-and-suspenders for any future convention that stores '*' as a
    // magic uuid for "all properties." Today property_access is uuid[] so
    // this is a no-op, but the JS-layer .includes('*') is kept on
    // purpose.
    process.env.SKIP_2FA_ENABLED = 'true';
    process.env.SKIP_2FA_USER_IDS = USER_ID;
    ok();
    state.account = {
      id: ACCOUNT_ID,
      skip_2fa: true,
      role: 'general_manager',
      property_access: ['*'],
    };
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}` }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.reason, 'skip_2fa_refused_privileged');
    }
  });
});

// ─── Tests: opt-out + break-glass ────────────────────────────────────────

describe('requireSession — opt-out + break-glass', () => {
  test('{ enforce2FA: false } + no device cookie → 200 (auth-flow opt-out path)', async () => {
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager', property_access: ['hotel-1'] };
    const result = await requireSession(
      mockReq({ auth: `Bearer ${validJwt()}` }),
      { enforce2FA: false },
    );
    assert.equal(result.ok, true);
  });

  test('DISABLE_SERVER_2FA_ENFORCEMENT="true" + no device cookie → 200 (break-glass)', async () => {
    process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager', property_access: ['hotel-1'] };
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}` }));
    assert.equal(result.ok, true, 'break-glass var should disable enforcement entirely');
  });
});

// ─── Tests: fail-closed ──────────────────────────────────────────────────

describe('requireSession — fail closed on DB errors', () => {
  test('accounts lookup returns error → 401 requires_2fa (no silent open gate)', async () => {
    ok();
    state.accountError = { message: 'connection reset' };
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}` }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.code, 'requires_2fa');
      assert.equal(body.reason, 'db_error');
    }
  });

  test('accounts lookup throws → 401 requires_2fa (caught, never propagates)', async () => {
    ok();
    state.throwOnAccountsQuery = true;
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}` }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.reason, 'db_error');
    }
  });

  test('no accounts row for the JWT user (orphan) → 401 requires_2fa', async () => {
    ok();
    state.account = null;
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}` }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.reason, 'no_account_row');
    }
  });

  test('trusted_devices lookup returns error → 401 requires_2fa', async () => {
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager', property_access: ['hotel-1'] };
    state.deviceError = { message: 'connection reset' };
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}`, deviceCookie: hashDeviceToken('x') }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.reason, 'db_error');
    }
  });
});
