/**
 * Tests for src/lib/api-ratelimit.ts — the per-endpoint hourly cap that
 * stops a runaway SMS loop, scripted email-bombing, or PMS-onboard abuse
 * from burning through real money or hitting Twilio/Resend's downstream
 * limits.
 *
 * Three load-bearing surfaces:
 *   ipToRateLimitKey       — pure: SHA-256 → UUID-shaped string
 *   checkAndIncrementRateLimit — mocks supabaseAdmin.rpc
 *   rateLimitedResponse    — pure: builds a 429 with Retry-After
 *
 * The fail-open behavior is intentional but quiet — production must NOT
 * block all SMS sends because the rate-limit RPC hiccuped. These tests
 * pin the fail-open response so a future "fix" that flips it to fail-closed
 * (which would brick SMS across the fleet at 3am) lands as a red diff.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  ipToRateLimitKey,
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  NO_PROPERTY_RATE_LIMIT_KEY,
} from '@/lib/api-ratelimit';
import { supabaseAdmin } from '@/lib/supabase-admin';

// ─── Mock infra for supabaseAdmin.rpc ────────────────────────────────────

type RpcFn = typeof supabaseAdmin.rpc;
const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);

let rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let nextRpcResult: { data: unknown; error: { message: string } | null } = {
  data: 1,
  error: null,
};
let throwOnRpc = false;

beforeEach(() => {
  rpcCalls = [];
  nextRpcResult = { data: 1, error: null };
  throwOnRpc = false;
  // @ts-expect-error monkey-patching singleton for the test
  supabaseAdmin.rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (throwOnRpc) throw new Error('connection reset');
    return nextRpcResult;
  };
});

afterEach(() => {
  supabaseAdmin.rpc = originalRpc;
});

// ─── ipToRateLimitKey ────────────────────────────────────────────────────

describe('ipToRateLimitKey — IP → UUID-shaped key', () => {
  test('null / undefined / empty IP → NO_PROPERTY_RATE_LIMIT_KEY (shared bucket)', () => {
    assert.equal(ipToRateLimitKey(null), NO_PROPERTY_RATE_LIMIT_KEY);
    assert.equal(ipToRateLimitKey(undefined), NO_PROPERTY_RATE_LIMIT_KEY);
    assert.equal(ipToRateLimitKey(''), NO_PROPERTY_RATE_LIMIT_KEY);
    assert.equal(ipToRateLimitKey('   '), NO_PROPERTY_RATE_LIMIT_KEY);
  });

  test('deterministic — same IP always maps to same key', () => {
    const a = ipToRateLimitKey('203.0.113.42');
    const b = ipToRateLimitKey('203.0.113.42');
    assert.equal(a, b);
  });

  test('case-insensitive (IPv6 hex digits)', () => {
    // SHA-256 is case-sensitive, but the function lowercases first.
    assert.equal(
      ipToRateLimitKey('2001:DB8::1'),
      ipToRateLimitKey('2001:db8::1'),
    );
  });

  test('whitespace is trimmed before hashing', () => {
    assert.equal(
      ipToRateLimitKey('  203.0.113.42  '),
      ipToRateLimitKey('203.0.113.42'),
    );
  });

  test('different IPs produce different keys', () => {
    assert.notEqual(
      ipToRateLimitKey('203.0.113.42'),
      ipToRateLimitKey('203.0.113.43'),
    );
  });

  test('result has UUID shape (api_limits.property_id column accepts it)', () => {
    const key = ipToRateLimitKey('203.0.113.42');
    // 8-4-4-4-12 hex digits joined by dashes.
    assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('NO_PROPERTY_RATE_LIMIT_KEY is the all-zeros UUID', () => {
    // Lock the sentinel value — DB rows might already reference it.
    assert.equal(NO_PROPERTY_RATE_LIMIT_KEY, '00000000-0000-0000-0000-000000000000');
  });
});

// ─── checkAndIncrementRateLimit ──────────────────────────────────────────

describe('checkAndIncrementRateLimit — Postgres-backed counter', () => {
  test('current count under cap → allowed', async () => {
    nextRpcResult = { data: 3, error: null };
    const result = await checkAndIncrementRateLimit('pms-onboard', NO_PROPERTY_RATE_LIMIT_KEY);
    assert.equal(result.allowed, true);
  });

  test('current count equal to cap → allowed (cap is "more than", not "equal or more")', async () => {
    nextRpcResult = { data: 5, error: null }; // pms-onboard cap = 5
    const result = await checkAndIncrementRateLimit('pms-onboard', NO_PROPERTY_RATE_LIMIT_KEY);
    assert.equal(result.allowed, true);
  });

  test('current count over cap → denied with retryAfterSec / current / cap', async () => {
    nextRpcResult = { data: 6, error: null }; // pms-onboard cap = 5
    const result = await checkAndIncrementRateLimit('pms-onboard', NO_PROPERTY_RATE_LIMIT_KEY);
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.equal(result.current, 6);
      assert.equal(result.cap, 5);
      assert.ok(result.retryAfterSec >= 1, 'retryAfterSec must be >= 1');
      assert.ok(result.retryAfterSec <= 3600, 'retryAfterSec must be at most one hour');
    }
  });

  // Fail-open vs fail-closed: 2026-05-17 audit (Flow 2 #6 / Flow 3 #5)
  // switched billing-impacting endpoints (Twilio, Claude, Resend) to
  // fail-CLOSED on RPC error/throw, because a Postgres hiccup leaving
  // the rate limiter wide open is fleet-wide spend exposure. Non-billing
  // endpoints (read paths, schedule autosave) still fail OPEN because
  // blocking them just inconveniences legitimate users without limiting
  // a real downside. The two pairs of tests pin both behaviors so a
  // future refactor that homogenizes the branch lands as a red diff.

  test('RPC error → billing endpoint FAILS CLOSED', async () => {
    nextRpcResult = { data: null, error: { message: 'connection terminated' } };
    const result = await checkAndIncrementRateLimit('email-transactional', NO_PROPERTY_RATE_LIMIT_KEY);
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.equal(result.retryAfterSec, 60);
    }
  });

  test('RPC throws → billing endpoint FAILS CLOSED', async () => {
    throwOnRpc = true;
    const result = await checkAndIncrementRateLimit('email-transactional', NO_PROPERTY_RATE_LIMIT_KEY);
    assert.equal(result.allowed, false);
  });

  test('AI Control Center provider probes are capped and fail closed', async () => {
    nextRpcResult = { data: 31, error: null };
    const capped = await checkAndIncrementRateLimit('admin-ai-config-validate', NO_PROPERTY_RATE_LIMIT_KEY);
    assert.equal(capped.allowed, false);
    if (!capped.allowed) assert.equal(capped.cap, 30);

    nextRpcResult = { data: null, error: { message: 'connection terminated' } };
    const unavailable = await checkAndIncrementRateLimit('admin-ai-config-validate', NO_PROPERTY_RATE_LIMIT_KEY);
    assert.equal(unavailable.allowed, false, 'billable validation probes must fail closed');
  });

  test('RPC error → non-billing endpoint fails OPEN so read paths never brick', async () => {
    nextRpcResult = { data: null, error: { message: 'connection terminated' } };
    const result = await checkAndIncrementRateLimit('worklist-read', NO_PROPERTY_RATE_LIMIT_KEY);
    assert.equal(result.allowed, true);
  });

  test('RPC throws → non-billing endpoint fails OPEN', async () => {
    throwOnRpc = true;
    const result = await checkAndIncrementRateLimit('worklist-read', NO_PROPERTY_RATE_LIMIT_KEY);
    assert.equal(result.allowed, true);
  });

  test('passes endpoint name + property + hour bucket to staxis_api_limit_hit RPC', async () => {
    await checkAndIncrementRateLimit('email-transactional', 'pid-abc');
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].fn, 'staxis_api_limit_hit');
    assert.equal(rpcCalls[0].args.p_endpoint, 'email-transactional');
    assert.equal(rpcCalls[0].args.p_property_id, 'pid-abc');
    // hour_bucket is YYYY-MM-DDTHH — 13 chars from ISO string
    const hb = rpcCalls[0].args.p_hour_bucket as string;
    assert.match(hb, /^\d{4}-\d{2}-\d{2}T\d{2}$/);
  });

  test('different endpoints use the configured cap independently', async () => {
    // pms-onboard cap = 5
    nextRpcResult = { data: 6, error: null };
    const onboard = await checkAndIncrementRateLimit('pms-onboard', NO_PROPERTY_RATE_LIMIT_KEY);
    assert.equal(onboard.allowed, false);
    if (!onboard.allowed) assert.equal(onboard.cap, 5);

    // worklist-read cap = 3600
    nextRpcResult = { data: 3599, error: null };
    const sync = await checkAndIncrementRateLimit('worklist-read', NO_PROPERTY_RATE_LIMIT_KEY);
    assert.equal(sync.allowed, true);

    nextRpcResult = { data: 3601, error: null };
    const syncOver = await checkAndIncrementRateLimit('worklist-read', NO_PROPERTY_RATE_LIMIT_KEY);
    assert.equal(syncOver.allowed, false);
    if (!syncOver.allowed) assert.equal(syncOver.cap, 3600);
  });
});

// ─── per-staff subKey (public SMS-link routes) ───────────────────────────
//
// 2026-06-26 — laundry/engineer public routes moved from per-PROPERTY (raw pid)
// to per-STAFF buckets so one worker / a replayed link can't 429 the whole
// hotel. The FK-safe mechanism: keep pid RAW (api_limits.property_id FK to
// properties stays valid) and fold staffId into the endpoint TEXT column. The
// cap + the billing-fail-closed decision MUST still key on the BASE endpoint —
// if they keyed on the composite, HOURLY_CAPS[composite] is undefined (cap
// silently disabled) and BILLING_IMPACTING.has(composite) is false (a billing
// route silently flips fail-OPEN). These tests pin that.

describe('checkAndIncrementRateLimit — per-staff subKey', () => {
  test('subKey folds into p_endpoint while pid stays the RAW property id (FK-safe)', async () => {
    nextRpcResult = { data: 1, error: null };
    await checkAndIncrementRateLimit('engineer-bootstrap', 'real-pid', { subKey: 'staff-uuid' });
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].args.p_property_id, 'real-pid', 'pid must stay raw (FK to properties)');
    assert.equal(rpcCalls[0].args.p_endpoint, 'engineer-bootstrap:staff-uuid');
  });

  test('cap still resolves from the BASE endpoint when a subKey is present', async () => {
    nextRpcResult = { data: 1201, error: null }; // engineer-bootstrap cap = 1200
    const result = await checkAndIncrementRateLimit('engineer-bootstrap', 'pid', { subKey: 'staff' });
    assert.equal(result.allowed, false, 'cap must come from the base endpoint, not the (undefined) composite');
    if (!result.allowed) assert.equal(result.cap, 1200);
  });

  test('billing endpoint still FAILS CLOSED on RPC error even with a subKey', async () => {
    nextRpcResult = { data: null, error: { message: 'connection terminated' } };
    const result = await checkAndIncrementRateLimit('engineer-vision', 'pid', { subKey: 'staff' });
    assert.equal(result.allowed, false, 'engineer-vision is billing — subKey must not bypass fail-closed');
  });

  test('no subKey → p_endpoint is the base string verbatim (backward-compatible)', async () => {
    nextRpcResult = { data: 1, error: null };
    await checkAndIncrementRateLimit('laundry-bootstrap', 'pid');
    assert.equal(rpcCalls[0].args.p_endpoint, 'laundry-bootstrap');
  });
});

// ─── QR phone handoff ────────────────────────────────────────────────────

describe('checkAndIncrementRateLimit — phone pairing caps', () => {
  test('registers finite caps for every mutating pairing endpoint', async () => {
    const cases = [
      ['auth-phone-pairing-create', 10],
      ['auth-phone-pairing-claim', 30],
      ['auth-phone-pairing-resend', 10],
      ['auth-phone-pairing-verify', 30],
      ['auth-phone-pairing-complete', 10],
    ] as const;

    for (const [endpoint, cap] of cases) {
      nextRpcResult = { data: cap + 1, error: null };
      const result = await checkAndIncrementRateLimit(endpoint, NO_PROPERTY_RATE_LIMIT_KEY);
      assert.equal(result.allowed, false, `${endpoint} must deny above ${cap}/hr`);
      if (!result.allowed) assert.equal(result.cap, cap);
    }
  });

  test('email-sending claim/resend fail closed when the limiter is unavailable', async () => {
    nextRpcResult = { data: null, error: { message: 'connection terminated' } };
    assert.equal(
      (await checkAndIncrementRateLimit('auth-phone-pairing-claim', NO_PROPERTY_RATE_LIMIT_KEY)).allowed,
      false,
    );
    assert.equal(
      (await checkAndIncrementRateLimit('auth-phone-pairing-resend', NO_PROPERTY_RATE_LIMIT_KEY)).allowed,
      false,
    );
  });
});

// ─── rateLimitedResponse ─────────────────────────────────────────────────

describe('rateLimitedResponse — 429 builder', () => {
  test('returns HTTP 429', () => {
    const res = rateLimitedResponse(6, 5, 1800);
    assert.equal(res.status, 429);
  });

  test('attaches Retry-After header in seconds', () => {
    const res = rateLimitedResponse(6, 5, 1800);
    assert.equal(res.headers.get('Retry-After'), '1800');
  });

  test('JSON body includes error code and explanatory detail', async () => {
    const res = rateLimitedResponse(6, 5, 1800);
    const body = await res.json();
    assert.equal(body.error, 'rate_limited');
    assert.match(body.detail, /6\/5/);
    assert.match(body.detail, /1800s/);
  });

  test('Content-Type is application/json', () => {
    const res = rateLimitedResponse(6, 5, 1800);
    assert.equal(res.headers.get('Content-Type'), 'application/json');
  });
});

// ─── HOURLY_CAPS regression floors ───────────────────────────────────────
//
// Regression guard for Codex post-shipment review A2 (2026-05-21). The
// housekeeper page polls /api/housekeeper/rooms every 4 seconds via
// subscribeToRoomsForStaff (src/lib/db/housekeeper-helpers.ts).
// Legitimate worst-case foreground use is 900/hr from polling alone,
// plus realtime-triggered refetches plus action-driven refetches.
// The original 600/hr cap shipped broken — real housekeepers got
// 429'd after ~40 min of normal use. Raised to 3600.

describe('HOURLY_CAPS floors — housekeeper-rooms accommodates 4s polling', () => {
  test('housekeeper-rooms cap allows >= 3000 hits in an hour', async () => {
    nextRpcResult = { data: 3000, error: null };
    const result = await checkAndIncrementRateLimit(
      'housekeeper-rooms',
      '11111111-1111-1111-1111-111111111111',
    );
    assert.equal(
      result.allowed, true,
      '3000th hit must still be allowed (cap must accommodate 4s polling + realtime + action refetches)',
    );
  });
});
