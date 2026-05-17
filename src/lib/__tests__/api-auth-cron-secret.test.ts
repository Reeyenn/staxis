/**
 * Tests for requireCronSecret in src/lib/api-auth.ts.
 *
 * This is the gate for ~25 cron endpoints + ~40 admin endpoints. If it
 * ever silently passes-through in production (e.g. CRON_SECRET env var
 * dropped during a redeploy), every admin/cron route becomes open to the
 * internet. Conversely, a broken constant-time comparison leaks the
 * secret over many requests through response timing.
 *
 * The function reads env vars at CALL time (not at import time), so we
 * don't need dynamic imports — just save/restore process.env between
 * tests.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { requireCronSecret } from '@/lib/api-auth';

// Save the env-vars we mutate, restore after each test.
const ENV_KEYS = ['CRON_SECRET', 'VERCEL_ENV', 'NODE_ENV'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    // NODE_ENV is typed as readonly in modern @types/node; assign via index.
    else (process.env as Record<string, string>)[k] = saved[k]!;
  }
});

function reqWith(authHeader: string | null): NextRequest {
  const init: { headers?: Record<string, string> } = {};
  if (authHeader !== null) init.headers = { authorization: authHeader };
  // NextRequest extends Request; for these helpers we only need
  // headers.get + url. Cast through unknown to satisfy the type.
  return new Request('https://staxis.test/api/cron/x', init) as unknown as NextRequest;
}

describe('requireCronSecret — happy path', () => {
  test('correct Bearer token returns null (caller continues)', () => {
    process.env.CRON_SECRET = 'right-secret-123';
    const result = requireCronSecret(reqWith('Bearer right-secret-123'));
    assert.equal(result, null);
  });
});

describe('requireCronSecret — rejection', () => {
  test('wrong secret returns 401', async () => {
    process.env.CRON_SECRET = 'right-secret-123';
    const result = requireCronSecret(reqWith('Bearer wrong-secret-xyz'));
    assert.notEqual(result, null);
    assert.equal(result!.status, 401);
    const body = await result!.json();
    assert.equal(body.error, 'unauthorized');
  });

  test('missing Authorization header returns 401', async () => {
    process.env.CRON_SECRET = 'right-secret-123';
    const result = requireCronSecret(reqWith(null));
    assert.equal(result!.status, 401);
  });

  test('Bearer prefix missing returns 401', () => {
    process.env.CRON_SECRET = 'right-secret-123';
    const result = requireCronSecret(reqWith('right-secret-123')); // no "Bearer "
    assert.equal(result!.status, 401);
  });

  test('length mismatch does not throw (constant-time safety)', () => {
    process.env.CRON_SECRET = 'short';
    // timingSafeEqual would throw on length mismatch — the function must
    // pre-check lengths to keep the catch a defense-in-depth, not a
    // requirement.
    const result = requireCronSecret(reqWith('Bearer dramatically-longer-than-the-real-secret'));
    assert.equal(result!.status, 401);
  });

  test('empty Bearer token returns 401', () => {
    process.env.CRON_SECRET = 'right-secret-123';
    const result = requireCronSecret(reqWith('Bearer '));
    assert.equal(result!.status, 401);
  });
});

describe('requireCronSecret — env behavior', () => {
  test('dev (NODE_ENV=test, no CRON_SECRET) passes through (null)', () => {
    delete process.env.CRON_SECRET;
    delete process.env.VERCEL_ENV;
    (process.env as Record<string, string>).NODE_ENV = 'test';
    const result = requireCronSecret(reqWith('anything'));
    assert.equal(result, null);
  });

  test('Vercel prod with CRON_SECRET unset returns 500 (fails closed)', async () => {
    delete process.env.CRON_SECRET;
    process.env.VERCEL_ENV = 'production';
    (process.env as Record<string, string>).NODE_ENV = 'production';
    const result = requireCronSecret(reqWith('Bearer whatever'));
    assert.equal(result!.status, 500);
    const body = await result!.json();
    assert.equal(body.error, 'server misconfigured');
  });

  test('Vercel preview with CRON_SECRET unset passes through (smoke tests)', () => {
    delete process.env.CRON_SECRET;
    process.env.VERCEL_ENV = 'preview';
    (process.env as Record<string, string>).NODE_ENV = 'production';
    const result = requireCronSecret(reqWith('Bearer whatever'));
    assert.equal(result, null);
  });

  test('non-Vercel prod (e.g. Railway/Fly) with CRON_SECRET unset returns 500', async () => {
    delete process.env.CRON_SECRET;
    delete process.env.VERCEL_ENV;
    (process.env as Record<string, string>).NODE_ENV = 'production';
    const result = requireCronSecret(reqWith('Bearer whatever'));
    assert.equal(result!.status, 500);
  });
});
