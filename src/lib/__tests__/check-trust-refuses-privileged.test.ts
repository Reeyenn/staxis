/**
 * Tests for the privileged-account refusal added to /api/auth/check-trust
 * in the 2026-05-22 auth audit (Phase 1, finding C2).
 *
 * Pins the behavior:
 *   - skip_2fa=true + role='admin' → bypass REFUSED, logs
 *     auth.skip_2fa_refused_privileged, falls through to cookie check.
 *     This is the load-bearing guard against config-drift on the env
 *     allowlist promoting an admin to OTP bypass.
 *   - skip_2fa=true + property_access includes '*' → also refused
 *     (belt-and-suspenders for any future "wildcard" convention).
 *   - skip_2fa=true + non-admin + scoped property_access + allowlisted
 *     → bypass GRANTED (the demo / investor flow keeps working).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { POST } from '@/app/api/auth/check-trust/route';
import { supabaseAdmin } from '@/lib/supabase-admin';

// ─── Mocking ─────────────────────────────────────────────────────────────

type GetUserFn = typeof supabaseAdmin.auth.getUser;
type FromFn = typeof supabaseAdmin.from;
type RpcFn = typeof supabaseAdmin.rpc;
const originalGetUser: GetUserFn = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);

interface MockState {
  user: { id: string } | null;
  account: {
    id: string;
    skip_2fa: boolean;
    role: string;
    property_access: string[] | null;
  } | null;
  authorityUnavailable: boolean;
  device: { id: string; expires_at: string; absolute_expires_at: string | null } | null;
  insertedEvents: Array<{ event_type: string; metadata: Record<string, unknown> }>;
}
const state: MockState = {
  user: null,
  account: null,
  authorityUnavailable: false,
  device: null,
  insertedEvents: [],
};

beforeEach(() => {
  state.user = null;
  state.account = null;
  state.authorityUnavailable = false;
  state.device = null;
  state.insertedEvents = [];

  supabaseAdmin.auth.getUser = (async () => ({
    data: { user: state.user },
    error: null,
  })) as unknown as GetUserFn;

  // The route now asks the canonical resolver for the wildcard/scoped fact.
  // Return a fully shaped DTO so this test exercises the same validation used
  // in production instead of accidentally treating an unavailable resolver as
  // a non-privileged account.
  supabaseAdmin.rpc = (async (fn: string) => {
    if (fn !== 'staxis_list_account_authorized_properties') {
      throw new Error(`unexpected rpc: ${fn}`);
    }
    if (state.authorityUnavailable) {
      return { data: null, error: { message: 'canonical authority unavailable' } };
    }
    const account = state.account;
    const propertyIds = account?.property_access?.filter((id) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
    ) ?? [];
    if (account?.property_access?.includes('*')) {
      return {
        data: {
          ok: true,
          all: true,
          authorityMode: 'legacy',
          authorityVersion: 1,
          effectiveAccessHash: 'a'.repeat(64),
          propertyIds: [],
          legacyPropertyIds: [],
          membershipPropertyIds: [],
          propertyStandings: [],
        },
        error: null,
      };
    }
    return {
      data: {
        ok: true,
        all: false,
        authorityMode: 'legacy',
        authorityVersion: 1,
        effectiveAccessHash: 'a'.repeat(64),
        propertyIds,
        legacyPropertyIds: propertyIds,
        membershipPropertyIds: [],
        propertyStandings: propertyIds.map((propertyId) => ({
          propertyId,
          operationalRole: 'general_manager',
          seesFinancials: false,
          hotelMutationAllowed: true,
          portfolioIntelligenceRead: false,
          entitlements: [{
            kind: 'legacy',
            entitlementId: propertyId,
            organizationId: null,
            membershipId: null,
            accessProfile: null,
            staxisRole: null,
            scopeType: null,
            portfolioId: null,
          }],
        })),
      },
      error: null,
    };
  }) as unknown as RpcFn;

  // @ts-expect-error monkey-patch
  supabaseAdmin.from = (table: string) => {
    if (table === 'accounts') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: state.account, error: null }),
          }),
        }),
      };
    }
    if (table === 'trusted_devices') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.device, error: null }),
            }),
          }),
        }),
        update: () => ({
          eq: async () => ({ error: null }),
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
    throw new Error(`unexpected table: ${table}`);
  };
});

afterEach(() => {
  supabaseAdmin.auth.getUser = originalGetUser;
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  delete process.env.SKIP_2FA_ENABLED;
  delete process.env.SKIP_2FA_USER_IDS;
});

// ─── Helpers ─────────────────────────────────────────────────────────────

// The check-trust route uses both req.headers.get() and req.cookies.get()
// — NextRequest provides .cookies natively, but a plain Request doesn't.
// Build a duck-typed mock that satisfies both APIs the route touches.
function mockReq(opts: { jwt: string; deviceCookie?: string }): import('next/server').NextRequest {
  const headers = new Headers({
    authorization: `Bearer ${opts.jwt}`,
    'content-type': 'application/json',
  });
  const cookies = new Map<string, { value: string }>();
  if (opts.deviceCookie) cookies.set('staxis_device', { value: opts.deviceCookie });
  // Use a NextResponse-style request shape that has the methods the route
  // actually calls. We don't go through `new Request()` because we need
  // the .cookies API which Request alone doesn't provide.
  return {
    url: 'https://staxis.test/api/auth/check-trust',
    method: 'POST',
    headers: {
      get: (name: string) => headers.get(name),
    },
    cookies: {
      get: (name: string) => cookies.get(name) ?? undefined,
    },
    json: async () => ({}),
  } as unknown as import('next/server').NextRequest;
}

const USER_ID = '11111111-2222-3333-4444-555555555555';
const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SCOPED_PROPERTY_ID = '99999999-8888-4777-8666-555555555555';
const JWT = 'header.payload.signature';

// ─── Tests ───────────────────────────────────────────────────────────────

describe('check-trust — privileged refusal', () => {
  test('skip_2fa + role=admin + allowlisted → REFUSE, log event, no { trusted: true }', async () => {
    process.env.SKIP_2FA_ENABLED = 'true';
    process.env.SKIP_2FA_USER_IDS = USER_ID;
    state.user = { id: USER_ID };
    state.account = {
      id: ACCOUNT_ID,
      skip_2fa: true,
      role: 'admin',
      property_access: [],
    };
    // No device cookie → falls through after refusal to "trusted: false".

    const res = await POST(mockReq({ jwt: JWT }));
    const body = await res.json();
    // Refusal falls through to cookie check → trusted:false (since no cookie).
    assert.equal(body.data?.trusted, false, 'admin with skip_2fa must NOT get { trusted: true }');

    const refused = state.insertedEvents.find(
      (e) => e.event_type === 'auth.skip_2fa_refused_privileged',
    );
    assert.ok(refused, 'auth.skip_2fa_refused_privileged must be logged');
    assert.equal(refused?.metadata.role, 'admin');
    assert.equal(refused?.metadata.hadWildcardAccess, false);

    // Critically: the success event must NOT be logged.
    const used = state.insertedEvents.find((e) => e.event_type === 'auth.skip_2fa_used');
    assert.equal(used, undefined, 'auth.skip_2fa_used must NOT fire for admin');
  });

  test('skip_2fa + property_access=["*"] → REFUSE, log event with hadWildcardAccess=true', async () => {
    process.env.SKIP_2FA_ENABLED = 'true';
    process.env.SKIP_2FA_USER_IDS = USER_ID;
    state.user = { id: USER_ID };
    state.account = {
      id: ACCOUNT_ID,
      skip_2fa: true,
      role: 'general_manager',
      property_access: ['*'],
    };

    const res = await POST(mockReq({ jwt: JWT }));
    const body = await res.json();
    assert.equal(body.data?.trusted, false);

    const refused = state.insertedEvents.find(
      (e) => e.event_type === 'auth.skip_2fa_refused_privileged',
    );
    assert.ok(refused);
    assert.equal(refused?.metadata.hadWildcardAccess, true);
    assert.equal(refused?.metadata.role, 'general_manager');
  });
});

describe('check-trust — demo bypass preserved (investor account regression)', () => {
  test('skip_2fa + non-admin + scoped property_access + allowlisted → { trusted: true } (demo works)', async () => {
    process.env.SKIP_2FA_ENABLED = 'true';
    process.env.SKIP_2FA_USER_IDS = USER_ID;
    state.user = { id: USER_ID };
    state.account = {
      id: ACCOUNT_ID,
      skip_2fa: true,
      role: 'general_manager',
      property_access: [SCOPED_PROPERTY_ID],
    };

    const res = await POST(mockReq({ jwt: JWT }));
    const body = await res.json();
    assert.equal(body.data?.trusted, true, 'demo bypass MUST keep working');

    const used = state.insertedEvents.find((e) => e.event_type === 'auth.skip_2fa_used');
    assert.ok(used, 'auth.skip_2fa_used must be logged for the successful bypass');
    const refused = state.insertedEvents.find(
      (e) => e.event_type === 'auth.skip_2fa_refused_privileged',
    );
    assert.equal(refused, undefined, 'refusal event MUST NOT fire for non-admin demo');
  });

  test('skip_2fa + non-admin + NOT in allowlist → blocked but NOT via privileged refusal', async () => {
    process.env.SKIP_2FA_ENABLED = 'true';
    process.env.SKIP_2FA_USER_IDS = '99999999-9999-9999-9999-999999999999';  // different uuid
    state.user = { id: USER_ID };
    state.account = {
      id: ACCOUNT_ID,
      skip_2fa: true,
      role: 'general_manager',
      property_access: [SCOPED_PROPERTY_ID],
    };

    const res = await POST(mockReq({ jwt: JWT }));
    const body = await res.json();
    assert.equal(body.data?.trusted, false);
    const notAllowlisted = state.insertedEvents.find(
      (e) => e.event_type === 'auth.skip_2fa_account_not_allowlisted',
    );
    assert.ok(notAllowlisted, 'should log the not-allowlisted event, not the privileged one');
    const refused = state.insertedEvents.find(
      (e) => e.event_type === 'auth.skip_2fa_refused_privileged',
    );
    assert.equal(refused, undefined);
  });

  test('skip_2fa + allowlisted + canonical authority unavailable → fail closed', async () => {
    process.env.SKIP_2FA_ENABLED = 'true';
    process.env.SKIP_2FA_USER_IDS = USER_ID;
    state.authorityUnavailable = true;
    state.user = { id: USER_ID };
    state.account = {
      id: ACCOUNT_ID,
      skip_2fa: true,
      role: 'general_manager',
      property_access: [SCOPED_PROPERTY_ID],
    };

    const res = await POST(mockReq({ jwt: JWT }));
    const body = await res.json();
    assert.equal(body.data?.trusted, false);
    assert.equal(
      state.insertedEvents.some((e) => e.event_type === 'auth.skip_2fa_used'),
      false,
      'an unavailable canonical snapshot must never grant the bypass',
    );
    assert.equal(
      state.insertedEvents.some((e) => e.event_type === 'auth.skip_2fa_blocked_authority_unavailable'),
      true,
    );
  });
});
