/**
 * The way-back ENDPOINT, not just the policy behind it.
 *
 * admin-account-switch.test.ts proves performAdminReturn refuses a caller who
 * is not the switched-into session. This file proves the ROUTE actually asks
 * who is calling and hands that answer over, because that seam is where the
 * whole protection lives: POST /api/auth/admin-switch-return is deliberately
 * outside /api/admin/*, so if it stopped resolving the caller it would silently
 * become an unauthenticated endpoint that returns a platform admin's one-time
 * login token to whoever holds a cookie.
 *
 * The scenario each case is built from is the 2026-08-07 audit finding: an
 * admin switches into a demo person, then signs out or hands the machine over.
 * The httpOnly cookie is still on the browser and still inside its two hours.
 *
 * It needs a route-level harness (mocked supabaseAdmin + a duck-typed
 * NextRequest, the shape check-trust-refuses-privileged.test.ts established)
 * rather than the dependency injection the policy tests use, so it lives in
 * its own file instead of inside the pure-policy suite.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { DELETE, POST } from '@/app/api/auth/admin-switch-return/route';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { invalidateTwoFactorCache } from '@/lib/two-factor';
import {
  deriveReturnTokenKey,
  mintReturnToken,
  RETURN_COOKIE_NAME,
  RETURN_HINT_COOKIE_NAME,
  RETURN_TOKEN_TTL_MS,
  RETURN_TOKEN_VERSION,
} from '@/lib/admin-account-switch';

// ─── Fixture world ──────────────────────────────────────────────────────────

const ADMIN_ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
const ADMIN_AUTH = '00000000-0000-4000-8000-0000000000a2';
const DEMO_ACCOUNT = 'aaaa0000-0000-4000-8000-000000000001';
const DEMO_AUTH = 'aaaa0000-0000-4000-8000-0000000000f1';
const STRANGER_AUTH = '99999999-9999-4999-8999-000000000001';

/**
 * What a signed-out browser presents: a token that resolves to nobody. Used
 * instead of sending no Authorization header at all so the assertion never
 * depends on requireSession's next/headers cookie fallback, which has no
 * request context inside the test runner. The "no header whatsoever" shape is
 * covered at the policy level (presenterAuthUserId: null) in
 * admin-account-switch.test.ts.
 */
const STALE_JWT = 'signed-out-and-gone';

const ACCOUNT_ROWS: Record<string, Record<string, unknown>> = {
  [ADMIN_ACCOUNT]: {
    id: ADMIN_ACCOUNT,
    username: 'reeyen',
    display_name: 'Reeyen Patel',
    role: 'admin',
    active: true,
    data_user_id: ADMIN_AUTH,
    skip_2fa: false,
  },
  [DEMO_ACCOUNT]: {
    id: DEMO_ACCOUNT,
    username: 'qa.maria',
    display_name: 'Maria Delgado',
    role: 'general_manager',
    active: true,
    data_user_id: DEMO_AUTH,
    skip_2fa: true,
  },
};

const signingKey = deriveReturnTokenKey(process.env.SUPABASE_SERVICE_ROLE_KEY as string);

function returnCookie(overrides: Record<string, unknown> = {}): string {
  const now = Date.now();
  return mintReturnToken(
    {
      v: RETURN_TOKEN_VERSION,
      adminAuthUserId: ADMIN_AUTH,
      adminAccountId: ADMIN_ACCOUNT,
      targetAccountId: DEMO_ACCOUNT,
      adminTokenHash: 'admin-one-time-token-hash',
      jti: `jti-${Math.random().toString(16).slice(2)}`,
      iat: now,
      exp: now + RETURN_TOKEN_TTL_MS,
      ...overrides,
    } as Parameters<typeof mintReturnToken>[0],
    signingKey,
  );
}

// ─── Mocking ────────────────────────────────────────────────────────────────

type GetUserFn = typeof supabaseAdmin.auth.getUser;
type FromFn = typeof supabaseAdmin.from;
type RpcFn = typeof supabaseAdmin.rpc;
const originalGetUser: GetUserFn = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);

interface World {
  /** Bearer token → the auth user it resolves to. Anything else is invalid. */
  sessions: Map<string, string>;
  claimedJtis: Set<string>;
  events: Array<{ event_type: string; user_id: string | null; metadata: Record<string, unknown> }>;
}
const world: World = { sessions: new Map(), claimedJtis: new Set(), events: [] };

beforeEach(() => {
  world.sessions = new Map([['demo-jwt', DEMO_AUTH], ['admin-jwt', ADMIN_AUTH], ['stranger-jwt', STRANGER_AUTH]]);
  world.claimedJtis = new Set();
  world.events = [];
  invalidateTwoFactorCache();

  supabaseAdmin.auth.getUser = (async (token?: string) => {
    const userId = token ? world.sessions.get(token) : undefined;
    return userId
      ? { data: { user: { id: userId, email: `${userId}@staxis.test` } }, error: null }
      : { data: { user: null }, error: { message: 'invalid token', status: 401 } };
  }) as unknown as GetUserFn;

  supabaseAdmin.rpc = (async (fn: string, args: { p_key?: string }) => {
    if (fn !== 'claim_idempotency_key') throw new Error(`unexpected rpc: ${fn}`);
    const key = String(args?.p_key ?? '');
    if (world.claimedJtis.has(key)) return { data: [{ claimed: false }], error: null };
    world.claimedJtis.add(key);
    return { data: [{ claimed: true }], error: null };
  }) as unknown as RpcFn;

  // @ts-expect-error monkey-patch
  supabaseAdmin.from = (table: string) => {
    if (table === 'app_settings') {
      // Global human-2FA switch OFF, so requireSession's device-trust step
      // short-circuits and this file tests identity, not the 2FA wall.
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { two_factor_enabled: false }, error: null }) }),
        }),
      };
    }
    if (table === 'accounts') {
      return {
        select: () => ({
          eq: (_column: string, value: string) => ({
            maybeSingle: async () => ({ data: ACCOUNT_ROWS[value] ?? null, error: null }),
          }),
        }),
      };
    }
    if (table === 'idempotency_log') {
      return { update: () => ({ eq: async () => ({ error: null }) }) };
    }
    if (table === 'app_events') {
      return {
        insert: async (row: { event_type: string; user_id: string | null; metadata: Record<string, unknown> }) => {
          world.events.push(row);
          return { error: null };
        },
      };
    }
    throw new Error(`unexpected table: ${table}`);
  };
});

afterEach(() => {
  supabaseAdmin.auth.getUser = originalGetUser;
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  invalidateTwoFactorCache();
});

function mockReq(opts: { cookie?: string | null; jwt?: string | null; method?: string }) {
  const headers = new Headers({ host: 'staxis.test' });
  if (opts.jwt) headers.set('authorization', `Bearer ${opts.jwt}`);
  const cookies = new Map<string, { value: string }>();
  if (opts.cookie) cookies.set(RETURN_COOKIE_NAME, { value: opts.cookie });
  return {
    url: 'https://staxis.test/api/auth/admin-switch-return',
    method: opts.method ?? 'POST',
    headers: { get: (name: string) => headers.get(name) },
    cookies: { get: (name: string) => cookies.get(name) ?? undefined },
    json: async () => ({}),
  } as unknown as import('next/server').NextRequest;
}

function clearedCookieNames(res: { headers: Headers }): string[] {
  return res.headers
    .getSetCookie()
    .filter((line) => /(^|;\s*)Max-Age=0(;|$)/i.test(line))
    .map((line) => line.split('=')[0]);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/auth/admin-switch-return — the cookie is not a bearer credential', () => {
  test('a signed-out browser holding a valid cookie gets no admin token', async () => {
    const res = await POST(mockReq({ cookie: returnCookie(), jwt: STALE_JWT }));
    const body = await res.json();

    assert.equal(res.status, 403);
    assert.equal(body.ok, false);
    assert.equal(body.data, undefined, 'no token hash may cross the response boundary');
    assert.equal(
      JSON.stringify(body).includes('admin-one-time-token-hash'),
      false,
      'the admin one-time login token must not appear anywhere in the refusal',
    );
  });

  test('a different person signed in on that browser gets no admin token', async () => {
    const res = await POST(mockReq({ cookie: returnCookie(), jwt: 'stranger-jwt' }));
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.equal(body.data, undefined);
  });

  test('a refused caller does not burn the way back', async () => {
    const cookie = returnCookie();
    const refused = await POST(mockReq({ cookie, jwt: STALE_JWT }));
    assert.equal(refused.status, 403);
    assert.equal(world.claimedJtis.size, 0);

    const allowed = await POST(mockReq({ cookie, jwt: 'demo-jwt' }));
    const body = await allowed.json();
    assert.equal(allowed.status, 200);
    assert.equal(body.data.tokenHash, 'admin-one-time-token-hash');
  });

  test('the demo session the switch created gets the admin back, once', async () => {
    const cookie = returnCookie();

    const first = await POST(mockReq({ cookie, jwt: 'demo-jwt' }));
    const firstBody = await first.json();
    assert.equal(first.status, 200);
    assert.equal(firstBody.data.tokenHash, 'admin-one-time-token-hash');
    assert.equal(firstBody.data.displayName, 'Reeyen Patel');
    assert.deepEqual(
      clearedCookieNames(first).sort(),
      [RETURN_COOKIE_NAME, RETURN_HINT_COOKIE_NAME].sort(),
      'a used way back must be cleared from the browser',
    );

    const replay = await POST(mockReq({ cookie, jwt: 'demo-jwt' }));
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).data, undefined);
  });

  test('the trail names both ends of the switch', async () => {
    await POST(mockReq({ cookie: returnCookie(), jwt: 'demo-jwt' }));
    const entry = world.events.find((e) => e.event_type === 'admin.account_switch_return');
    assert.ok(entry, 'a successful return must leave a record');
    assert.equal(entry?.user_id, ADMIN_AUTH);
    assert.equal(entry?.metadata.accountId, ADMIN_ACCOUNT);
    assert.equal(entry?.metadata.switchedFromAccountId, DEMO_ACCOUNT);
  });

  test('a wrong-session attempt IS recorded, and cookie garbage is NOT', async () => {
    // The first got past the signature, so it was a token we minted and an
    // investigation would want it. The second is something anyone on the
    // internet can produce at will, and writing a row per request would hand
    // an unauthenticated caller an unbounded write into the audit table.
    await POST(mockReq({ cookie: returnCookie(), jwt: 'stranger-jwt' }));
    assert.equal(
      world.events.filter((e) => e.event_type === 'admin.account_switch_return_refused').length,
      1,
    );

    world.events = [];
    await POST(mockReq({ cookie: 'not-even-a-token', jwt: STALE_JWT }));
    await POST(mockReq({ cookie: null, jwt: STALE_JWT }));
    assert.deepEqual(world.events, []);
  });
});

describe('DELETE /api/auth/admin-switch-return — sign-out can throw the way back away', () => {
  test('clears both cookies without needing a session', async () => {
    const res = await DELETE(mockReq({ cookie: returnCookie(), jwt: null, method: 'DELETE' }));
    assert.equal(res.status, 200);
    assert.deepEqual(
      clearedCookieNames(res).sort(),
      [RETURN_COOKIE_NAME, RETURN_HINT_COOKIE_NAME].sort(),
    );
  });

  test('discarding hands back no credential of any kind', async () => {
    const res = await DELETE(mockReq({ cookie: returnCookie(), jwt: 'demo-jwt', method: 'DELETE' }));
    const body = await res.json();
    assert.equal(
      JSON.stringify(body).includes('admin-one-time-token-hash'),
      false,
      'DELETE must never redeem',
    );
    assert.equal(world.claimedJtis.size, 0, 'DELETE must never burn the token either');
  });
});
