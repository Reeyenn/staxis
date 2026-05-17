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

  test('RPC error → fail-open (allowed) so SMS pipeline never bricks', async () => {
    // The load-bearing assertion: if Postgres hiccups, we keep sending
    // SMS rather than going dark across the fleet.
    nextRpcResult = { data: null, error: { message: 'connection terminated' } };
    const result = await checkAndIncrementRateLimit('send-shift-confirmations', NO_PROPERTY_RATE_LIMIT_KEY);
    assert.equal(result.allowed, true);
  });

  test('RPC throws → fail-open (allowed)', async () => {
    throwOnRpc = true;
    const result = await checkAndIncrementRateLimit('send-shift-confirmations', NO_PROPERTY_RATE_LIMIT_KEY);
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

    // sync-room-assignments cap = 200
    nextRpcResult = { data: 199, error: null };
    const sync = await checkAndIncrementRateLimit('sync-room-assignments', NO_PROPERTY_RATE_LIMIT_KEY);
    assert.equal(sync.allowed, true);

    nextRpcResult = { data: 201, error: null };
    const syncOver = await checkAndIncrementRateLimit('sync-room-assignments', NO_PROPERTY_RATE_LIMIT_KEY);
    assert.equal(syncOver.allowed, false);
    if (!syncOver.allowed) assert.equal(syncOver.cap, 200);
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
