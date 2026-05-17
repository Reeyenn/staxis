/**
 * Tests for src/lib/idempotency.ts — Stripe-style request dedup.
 *
 * Routes that send SMS, write to billing, or do other expensive non-
 * idempotent work look the caller's Idempotency-Key up here BEFORE
 * doing the work. A regression — e.g. malformed keys hitting the cache
 * instead of being rejected — could cause a single SMS to be sent twice,
 * a Stripe customer to be created twice, etc. The cost is real money.
 *
 * Validation rules (pinned by these tests):
 *   - No header → no-key (legacy callers / internal cron bypass dedup)
 *   - Empty / whitespace-only → no-key
 *   - > 256 chars → no-key (abuse protection)
 *   - Non-[A-Za-z0-9_-] characters → no-key (path-traversal-like input)
 *   - DB lookup errors → first (don't fail; possibly double-send is
 *     better than refusing all sends)
 *   - Different route with same key → first (key reuse is not a hit)
 *   - Expired entry → first
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { checkIdempotency, recordIdempotency } from '@/lib/idempotency';
import { supabaseAdmin } from '@/lib/supabase-admin';

// ─── Mock infra ──────────────────────────────────────────────────────────

type FromFn = typeof supabaseAdmin.from;
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);

type CacheRow = {
  response: unknown;
  status_code: number;
  expires_at: string;
  route: string;
} | null;

let selectResult: { data: CacheRow; error: { message: string } | null } = {
  data: null,
  error: null,
};
let throwOnSelect = false;
let inserted: Record<string, unknown> | null = null;
let throwOnInsert = false;

beforeEach(() => {
  selectResult = { data: null, error: null };
  throwOnSelect = false;
  inserted = null;
  throwOnInsert = false;
  // @ts-expect-error monkey-patching singleton for the test
  supabaseAdmin.from = (table: string) => {
    if (table !== 'idempotency_log') {
      throw new Error(`unexpected table: ${table}`);
    }
    return {
      // checkIdempotency chain:  .from(...).select(...).eq('key', x).maybeSingle()
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => {
            if (throwOnSelect) throw new Error('connection lost');
            return selectResult;
          },
        }),
      }),
      // recordIdempotency chain: .from(...).insert(...)
      insert: async (row: Record<string, unknown>) => {
        if (throwOnInsert) throw new Error('insert failed');
        inserted = row;
        return { data: null, error: null };
      },
    };
  };
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

function reqWith(headers: Record<string, string>): NextRequest {
  return new Request('https://staxis.test/api/example', { headers }) as unknown as NextRequest;
}

// ─── checkIdempotency: validation gating ─────────────────────────────────

describe('checkIdempotency — key validation (callers without a header)', () => {
  test('no Idempotency-Key header → no-key', async () => {
    const result = await checkIdempotency(reqWith({}), 'send-shift-confirmations');
    assert.equal(result.kind, 'no-key');
  });

  test('empty key → no-key', async () => {
    const result = await checkIdempotency(reqWith({ 'idempotency-key': '' }), 'send-shift-confirmations');
    assert.equal(result.kind, 'no-key');
  });

  test('whitespace-only key → no-key', async () => {
    const result = await checkIdempotency(reqWith({ 'idempotency-key': '    ' }), 'send-shift-confirmations');
    assert.equal(result.kind, 'no-key');
  });

  test('key > 256 chars → no-key (abuse protection)', async () => {
    const long = 'a'.repeat(257);
    const result = await checkIdempotency(reqWith({ 'idempotency-key': long }), 'send-shift-confirmations');
    assert.equal(result.kind, 'no-key');
  });

  test('key with invalid characters → no-key (rejects path-traversal-like input)', async () => {
    // Allowed chars: [A-Za-z0-9_-]. '/' and '..' must be rejected.
    const result = await checkIdempotency(reqWith({ 'idempotency-key': '../etc/passwd' }), 'send-shift-confirmations');
    assert.equal(result.kind, 'no-key');
  });

  test('header is case-insensitive (Idempotency-Key vs idempotency-key)', async () => {
    const result = await checkIdempotency(
      reqWith({ 'Idempotency-Key': 'valid-key-123' }),
      'send-shift-confirmations',
    );
    // HTTP headers are case-insensitive — we should reach the DB lookup.
    assert.equal(result.kind, 'first');
  });
});

// ─── checkIdempotency: cache states ──────────────────────────────────────

describe('checkIdempotency — cache lookup', () => {
  test('first time we see this key → first with the key value', async () => {
    selectResult = { data: null, error: null };
    const result = await checkIdempotency(
      reqWith({ 'idempotency-key': 'unique-key-xyz' }),
      'send-shift-confirmations',
    );
    assert.equal(result.kind, 'first');
    if (result.kind === 'first') {
      assert.equal(result.key, 'unique-key-xyz');
    }
  });

  test('cache hit on same route → cached with the prior response', async () => {
    const oneHourFromNow = new Date(Date.now() + 3600 * 1000).toISOString();
    selectResult = {
      data: {
        response: { ok: true, sent: 12 },
        status_code: 200,
        expires_at: oneHourFromNow,
        route: 'send-shift-confirmations',
      },
      error: null,
    };
    const result = await checkIdempotency(
      reqWith({ 'idempotency-key': 'unique-key-xyz' }),
      'send-shift-confirmations',
    );
    assert.equal(result.kind, 'cached');
    if (result.kind === 'cached') {
      assert.equal(result.response.status, 200);
      const body = await result.response.json();
      assert.deepEqual(body, { ok: true, sent: 12 });
    }
  });

  test('cache hit on DIFFERENT route → first (key reuse across routes is not a hit)', async () => {
    const oneHourFromNow = new Date(Date.now() + 3600 * 1000).toISOString();
    selectResult = {
      data: {
        response: { ok: true, sent: 12 },
        status_code: 200,
        expires_at: oneHourFromNow,
        route: 'send-shift-confirmations',  // different route!
      },
      error: null,
    };
    const result = await checkIdempotency(
      reqWith({ 'idempotency-key': 'unique-key-xyz' }),
      'create-checkout',  // caller asks about THIS route
    );
    assert.equal(result.kind, 'first');
  });

  test('expired cache entry → first', async () => {
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    selectResult = {
      data: {
        response: { ok: true },
        status_code: 200,
        expires_at: oneHourAgo,
        route: 'send-shift-confirmations',
      },
      error: null,
    };
    const result = await checkIdempotency(
      reqWith({ 'idempotency-key': 'stale-key-zzz' }),
      'send-shift-confirmations',
    );
    assert.equal(result.kind, 'first');
  });

  test('cache lookup returns error → first (do not block real work)', async () => {
    selectResult = { data: null, error: { message: 'connection terminated' } };
    const result = await checkIdempotency(
      reqWith({ 'idempotency-key': 'valid-key-abc' }),
      'send-shift-confirmations',
    );
    // Possibly double-sending is better than refusing all sends.
    assert.equal(result.kind, 'first');
  });

  test('cache lookup throws → first (never propagates)', async () => {
    throwOnSelect = true;
    const result = await checkIdempotency(
      reqWith({ 'idempotency-key': 'valid-key-abc' }),
      'send-shift-confirmations',
    );
    assert.equal(result.kind, 'first');
  });
});

// ─── recordIdempotency ───────────────────────────────────────────────────

describe('recordIdempotency — cache write', () => {
  test('inserts the response into idempotency_log with all expected columns', async () => {
    await recordIdempotency(
      'key-abc',
      'send-shift-confirmations',
      { ok: true, sent: 5 },
      200,
      'pid-property-123',
    );
    assert.ok(inserted, 'insert must have been called');
    assert.equal(inserted!.key, 'key-abc');
    assert.equal(inserted!.route, 'send-shift-confirmations');
    assert.deepEqual(inserted!.response, { ok: true, sent: 5 });
    assert.equal(inserted!.status_code, 200);
    assert.equal(inserted!.property_id, 'pid-property-123');
  });

  test('property_id falls back to null when caller omits pid', async () => {
    await recordIdempotency('key-abc', 'route', { ok: true }, 200);
    assert.equal(inserted!.property_id, null);
  });

  test('insert error is swallowed (must not break the route)', async () => {
    // The caller has already done the work — if we couldn't cache the
    // result, that's annoying but not fatal. The next retry just re-does
    // the work.
    throwOnInsert = true;
    // Asserting "does not throw" by not wrapping in try/catch.
    await recordIdempotency('key-abc', 'route', { ok: true }, 200, 'pid-1');
  });
});
