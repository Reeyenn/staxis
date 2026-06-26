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

// tsx --test runs every file in ONE process, so any process.env mutation here
// can leak into sibling files (and back). Save/restore the env we touch — and
// pin a clean, non-prod baseline each test so the break-glass honoring (which
// is now env-gated) is deterministic regardless of a leaked VERCEL_ENV or a
// CI that exports NODE_ENV=production. Mirrors api-auth-heartbeat-secret.test.
const ENV_KEYS = [
  'DISABLE_SERVER_2FA_ENFORCEMENT', 'SKIP_2FA_ENABLED', 'SKIP_2FA_USER_IDS',
  'VERCEL_ENV', 'NODE_ENV',
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

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
  // Snapshot, then pin a clean non-prod baseline: break-glass OFF, no Vercel
  // env, NODE_ENV=test (so the dev/test break-glass branch is honored unless a
  // test explicitly opts into a protected env).
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.DISABLE_SERVER_2FA_ENFORCEMENT;
  delete process.env.VERCEL_ENV;
  // Cast: @types/node types NODE_ENV as a readonly literal union; assign via an
  // index signature (same pattern as the afterEach restore loop below).
  (process.env as Record<string, string>).NODE_ENV = 'test';

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
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else (process.env as Record<string, string>)[k] = savedEnv[k]!;
  }
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
// A JWT that carries the hook-minted `mfa_verified=true` claim — i.e. a session
// that completed OTP (a mfa_verified_sessions row exists). The Door-B
// per-session fallback accepts this for NON-skip_2fa accounts.
const verifiedJwt = (claim: unknown = true) => mintJwt({
  sub: USER_ID,
  exp: Math.floor(Date.now() / 1000) + 3600,
  iss: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co',
  mfa_verified: claim,
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

// ─── Tests: per-session verification (mfa_session) Door-B fallback ───────

describe('requireSession — per-session mfa_verified fallback (unchecked "Trust this device")', () => {
  test('valid JWT WITH mfa_verified=true + NO cookie + non-skip_2fa → 200 via mfa_session', async () => {
    // The remember=false flow: the user completed OTP (so the JWT carries the
    // claim) but has no durable trusted_devices cookie. The app must still work.
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager', property_access: ['hotel-1'] };
    const result = await requireSession(mockReq({ auth: `Bearer ${verifiedJwt()}` }));
    assert.equal(result.ok, true, 'a verified session must pass Door B without a cookie');
    if (result.ok) assert.equal(result.userId, USER_ID);
  });

  test('valid JWT WITH mfa_verified=true + cookie present but NO matching row → 200 (fall-through then fallback)', async () => {
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager', property_access: ['hotel-1'] };
    state.device = null;
    const result = await requireSession(mockReq({ auth: `Bearer ${verifiedJwt()}`, deviceCookie: 'no-such-row' }));
    assert.equal(result.ok, true);
  });

  test('valid JWT WITHOUT the claim + no cookie → 401 no_cookie (fallback is claim-gated, not open)', async () => {
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager', property_access: ['hotel-1'] };
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}` }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.reason, 'no_cookie');
    }
  });

  test('mfa_verified claim as STRING "true" + no cookie → 401 (strict boolean; string is not accepted)', async () => {
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager', property_access: ['hotel-1'] };
    const result = await requireSession(mockReq({ auth: `Bearer ${verifiedJwt('true')}` }));
    assert.equal(result.ok, false, 'a string "true" claim must NOT satisfy the strict boolean check');
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.reason, 'no_cookie');
    }
  });

  test('skip_2fa account NOT allowlisted + JWT WITH mfa_verified=true + no cookie → 401 (guard: fallback must NOT fire for skip_2fa)', async () => {
    // BLOCKER guard: the hook mints mfa_verified=true for any non-admin
    // skip_2fa account from the DB column alone (no env-gate). If the fallback
    // fired here it would bypass the env-allowlist kill-switch. It must instead
    // fall through to the skip_2fa block and be blocked when not allowlisted.
    process.env.SKIP_2FA_ENABLED = 'true';
    process.env.SKIP_2FA_USER_IDS = '99999999-9999-9999-9999-999999999999';  // different uuid
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: true, role: 'general_manager', property_access: ['hotel-1'] };
    const result = await requireSession(mockReq({ auth: `Bearer ${verifiedJwt()}` }));
    assert.equal(result.ok, false, 'skip_2fa account must not slip through Door B via the claim');
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.reason, 'skip_2fa_not_allowlisted');
    }
  });

  test('absolute_cap_reached row + matching cookie + JWT WITH mfa_verified=true → still 401 (fallback does not override the cap)', async () => {
    // The cap early-returns BEFORE the fallback, so a capped device is still
    // forced to re-OTP even though the live JWT carries the claim.
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager', property_access: ['hotel-1'] };
    state.device = { id: 'dev-1', expires_at: FUTURE(), absolute_expires_at: PAST() };
    const result = await requireSession(mockReq({ auth: `Bearer ${verifiedJwt()}`, deviceCookie: 'x'.repeat(64) }));
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

  test('DISABLE_SERVER_2FA_ENFORCEMENT="true" in local dev/test + no device cookie → 200 (break-glass honored off-prod)', async () => {
    // beforeEach pins NODE_ENV='test' + no VERCEL_ENV, so this is the dev/test
    // branch — the only place the break-glass is still honored.
    process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager', property_access: ['hotel-1'] };
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}` }));
    assert.equal(result.ok, true, 'break-glass should bypass enforcement on a dev/test host');
  });

  test('FAIL-SAFE: DISABLE="true" + VERCEL_ENV=production + no cookie → 401 (flag IGNORED in prod)', async () => {
    process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';
    process.env.VERCEL_ENV = 'production';
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager', property_access: ['hotel-1'] };
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}` }));
    assert.equal(result.ok, false, 'production must NEVER silently disable 2FA via this flag');
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.code, 'requires_2fa');
      assert.equal(body.reason, 'no_cookie');
    }
  });

  test('FAIL-SAFE: DISABLE="true" + VERCEL_ENV=preview + no cookie → 401 (flag IGNORED in preview)', async () => {
    process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';
    process.env.VERCEL_ENV = 'preview';
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager', property_access: ['hotel-1'] };
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}` }));
    assert.equal(result.ok, false, 'preview deploys are publicly reachable — flag must be ignored');
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.reason, 'no_cookie');
    }
  });

  test('FAIL-SAFE: DISABLE="true" + NODE_ENV=production, no VERCEL_ENV (Fly/Railway prod) + no cookie → 401', async () => {
    process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';
    delete process.env.VERCEL_ENV;
    (process.env as Record<string, string>).NODE_ENV = 'production';
    ok();
    state.account = { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager', property_access: ['hotel-1'] };
    const result = await requireSession(mockReq({ auth: `Bearer ${validJwt()}` }));
    assert.equal(result.ok, false, 'non-Vercel prod must also ignore the flag');
    if (!result.ok) {
      const body = await result.response.json();
      assert.equal(body.reason, 'no_cookie');
    }
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
