/**
 * Tests for src/lib/idempotency.ts — Stripe-style request dedup, now backed by
 * the ATOMIC claim_idempotency_key RPC (migration 0243).
 *
 * The claim is atomic, so two concurrent retries of the same key can't both
 * "win": exactly one gets 'first', the rest get 'cached' (work already done)
 * or 'in-progress' (work mid-flight → 409). A regression here can double-send
 * SMS / double-charge — real money — so these pin the behavior.
 *
 * Validation rules (unchanged, short-circuit before the RPC):
 *   - No header / empty / whitespace / >256 chars / non-[A-Za-z0-9_-] → no-key
 * Claim outcomes:
 *   - claimed=true → first
 *   - claimed=false + completed response (same route) → cached
 *   - claimed=false + {__pending__} (same route) → in-progress (409)
 *   - claimed=false + DIFFERENT route → first (cross-route reuse isn't a hit)
 *   - RPC error / throw → first (don't block real work)
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { checkIdempotency, recordIdempotency } from '@/lib/idempotency';
import { supabaseAdmin } from '@/lib/supabase-admin';

// ─── Mock infra ──────────────────────────────────────────────────────────

type FromFn = typeof supabaseAdmin.from;
type RpcFn = typeof supabaseAdmin.rpc;
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);

type ClaimRow = {
  claimed: boolean;
  existing_response: unknown;
  existing_status: number | null;
  existing_route: string | null;
};

const WON: ClaimRow = { claimed: true, existing_response: null, existing_status: null, existing_route: null };

let rpcResult: { data: ClaimRow[] | null; error: { message: string } | null } = { data: [WON], error: null };
let throwOnRpc = false;
let lastRpc: { fn: string; args: Record<string, unknown> } | null = null;

let updated: Record<string, unknown> | null = null;
let updateFilters: Array<[string, unknown]> = [];
let throwOnUpdate = false;

beforeEach(() => {
  rpcResult = { data: [WON], error: null };
  throwOnRpc = false;
  lastRpc = null;
  updated = null;
  updateFilters = [];
  throwOnUpdate = false;

  // @ts-expect-error monkey-patching singleton for the test
  supabaseAdmin.rpc = async (fn: string, args: Record<string, unknown>) => {
    lastRpc = { fn, args };
    if (throwOnRpc) throw new Error('connection lost');
    return rpcResult;
  };

  // @ts-expect-error monkey-patching singleton for the test
  supabaseAdmin.from = (table: string) => {
    if (table !== 'idempotency_log') throw new Error(`unexpected table: ${table}`);
    // recordIdempotency chain: .update(row).eq('key',k).eq('route',r) then await
    const chain = {
      eq: (col: string, val: unknown) => {
        updateFilters.push([col, val]);
        return chain;
      },
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        if (throwOnUpdate) reject(new Error('update failed'));
        else resolve({ data: null, error: null });
      },
    };
    return {
      update: (row: Record<string, unknown>) => {
        updated = row;
        return chain;
      },
    };
  };
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
});

function reqWith(headers: Record<string, string>): NextRequest {
  return new Request('https://staxis.test/api/example', { headers }) as unknown as NextRequest;
}

// ─── key validation (callers without a usable header) ────────────────────

describe('checkIdempotency — key validation', () => {
  test('no Idempotency-Key header → no-key', async () => {
    assert.equal((await checkIdempotency(reqWith({}), 'send-shift-confirmations')).kind, 'no-key');
  });

  test('empty key → no-key', async () => {
    assert.equal((await checkIdempotency(reqWith({ 'idempotency-key': '' }), 'r')).kind, 'no-key');
  });

  test('whitespace-only key → no-key', async () => {
    assert.equal((await checkIdempotency(reqWith({ 'idempotency-key': '   ' }), 'r')).kind, 'no-key');
  });

  test('key > 256 chars → no-key (abuse protection)', async () => {
    assert.equal((await checkIdempotency(reqWith({ 'idempotency-key': 'a'.repeat(257) }), 'r')).kind, 'no-key');
  });

  test('invalid characters → no-key (rejects path-traversal-like input)', async () => {
    assert.equal((await checkIdempotency(reqWith({ 'idempotency-key': '../etc/passwd' }), 'r')).kind, 'no-key');
  });

  test('valid key reaches the claim RPC (header is case-insensitive)', async () => {
    const r = await checkIdempotency(reqWith({ 'Idempotency-Key': 'valid-key-123' }), 'send-shift-confirmations');
    assert.equal(r.kind, 'first');
    assert.equal(lastRpc?.fn, 'claim_idempotency_key');
    assert.equal(lastRpc?.args.p_key, 'valid-key-123');
    assert.equal(lastRpc?.args.p_route, 'send-shift-confirmations');
  });
});

// ─── atomic claim outcomes ───────────────────────────────────────────────

describe('checkIdempotency — claim outcomes', () => {
  test('we win the claim → first (with the key)', async () => {
    rpcResult = { data: [WON], error: null };
    const r = await checkIdempotency(reqWith({ 'idempotency-key': 'k1' }), 'send-shift-confirmations');
    assert.equal(r.kind, 'first');
    if (r.kind === 'first') assert.equal(r.key, 'k1');
  });

  test('held by a completed row (same route) → cached with the stored response', async () => {
    rpcResult = {
      data: [{ claimed: false, existing_response: { ok: true, sent: 12 }, existing_status: 200, existing_route: 'send-shift-confirmations' }],
      error: null,
    };
    const r = await checkIdempotency(reqWith({ 'idempotency-key': 'k1' }), 'send-shift-confirmations');
    assert.equal(r.kind, 'cached');
    if (r.kind === 'cached') {
      assert.equal(r.response.status, 200);
      assert.deepEqual(await r.response.json(), { ok: true, sent: 12 });
    }
  });

  test('held by a pending row (same route) → in-progress (409)', async () => {
    rpcResult = {
      data: [{ claimed: false, existing_response: { __pending__: true }, existing_status: 0, existing_route: 'send-shift-confirmations' }],
      error: null,
    };
    const r = await checkIdempotency(reqWith({ 'idempotency-key': 'k1' }), 'send-shift-confirmations');
    assert.equal(r.kind, 'in-progress');
    if (r.kind === 'in-progress') {
      assert.equal(r.response.status, 409);
      const body = await r.response.json();
      assert.equal(body.code, 'IdempotencyInProgress');
      assert.equal(body.ok, false);
    }
  });

  test('key held by a DIFFERENT route → first (cross-route reuse is not a hit)', async () => {
    rpcResult = {
      data: [{ claimed: false, existing_response: { ok: true }, existing_status: 200, existing_route: 'some-other-route' }],
      error: null,
    };
    const r = await checkIdempotency(reqWith({ 'idempotency-key': 'k1' }), 'send-shift-confirmations');
    assert.equal(r.kind, 'first');
  });

  test('claim RPC returns an error → first (do not block real work)', async () => {
    rpcResult = { data: null, error: { message: 'connection terminated' } };
    const r = await checkIdempotency(reqWith({ 'idempotency-key': 'k1' }), 'send-shift-confirmations');
    assert.equal(r.kind, 'first');
  });

  test('claim RPC throws → first (never propagates)', async () => {
    throwOnRpc = true;
    const r = await checkIdempotency(reqWith({ 'idempotency-key': 'k1' }), 'send-shift-confirmations');
    assert.equal(r.kind, 'first');
  });
});

// ─── recordIdempotency: fills in the claimed row ─────────────────────────

describe('recordIdempotency — cache write (UPDATE of the claimed row)', () => {
  test('updates response/status/property_id/expires_at, filtered by key + route', async () => {
    await recordIdempotency('key-abc', 'send-shift-confirmations', { ok: true, sent: 5 }, 200, 'pid-property-123');
    assert.ok(updated, 'update must have been called');
    assert.deepEqual(updated!.response, { ok: true, sent: 5 });
    assert.equal(updated!.status_code, 200);
    assert.equal(updated!.property_id, 'pid-property-123');
    assert.equal(typeof updated!.expires_at, 'string');
    assert.deepEqual(updateFilters, [['key', 'key-abc'], ['route', 'send-shift-confirmations']]);
  });

  test('property_id falls back to null when caller omits pid', async () => {
    await recordIdempotency('key-abc', 'route', { ok: true }, 200);
    assert.equal(updated!.property_id, null);
  });

  test('update error is swallowed (must not break the route)', async () => {
    throwOnUpdate = true;
    // Asserting "does not throw" by not wrapping in try/catch.
    await recordIdempotency('key-abc', 'route', { ok: true }, 200, 'pid-1');
  });
});
