/**
 * Tests for requireHeartbeatSecret in src/lib/api-auth.ts.
 *
 * Mirrors api-auth-cron-secret.test.ts. The gate guards /api/claude-heartbeat,
 * which previously had no auth and wrote to claude_sessions via the
 * service-role client (a random internet caller could pollute the table).
 * If this gate ever silently passes-through in production, the surface
 * reopens; conversely a broken constant-time compare leaks the secret
 * via response timing across many calls.
 *
 * env-var reads happen at CALL time, so we just save/restore between tests.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { requireHeartbeatSecret } from '@/lib/api-auth';

const ENV_KEYS = ['HEARTBEAT_SECRET', 'VERCEL_ENV', 'NODE_ENV'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else (process.env as Record<string, string>)[k] = saved[k]!;
  }
});

function reqWith(authHeader: string | null): NextRequest {
  const init: { headers?: Record<string, string> } = {};
  if (authHeader !== null) init.headers = { authorization: authHeader };
  return new Request('https://staxis.test/api/claude-heartbeat', init) as unknown as NextRequest;
}

describe('requireHeartbeatSecret — happy path', () => {
  test('correct Bearer token returns null (caller continues)', () => {
    process.env.HEARTBEAT_SECRET = 'right-heartbeat-secret-xyz';
    const result = requireHeartbeatSecret(reqWith('Bearer right-heartbeat-secret-xyz'));
    assert.equal(result, null);
  });
});

describe('requireHeartbeatSecret — rejection', () => {
  test('wrong secret returns 401', async () => {
    process.env.HEARTBEAT_SECRET = 'right-heartbeat-secret-xyz';
    const result = requireHeartbeatSecret(reqWith('Bearer wrong-secret-abc'));
    assert.notEqual(result, null);
    assert.equal(result!.status, 401);
    const body = await result!.json();
    assert.equal(body.error, 'unauthorized');
  });

  test('missing Authorization header returns 401', () => {
    process.env.HEARTBEAT_SECRET = 'right-heartbeat-secret-xyz';
    const result = requireHeartbeatSecret(reqWith(null));
    assert.equal(result!.status, 401);
  });

  test('Bearer prefix missing returns 401', () => {
    process.env.HEARTBEAT_SECRET = 'right-heartbeat-secret-xyz';
    const result = requireHeartbeatSecret(reqWith('right-heartbeat-secret-xyz'));
    assert.equal(result!.status, 401);
  });

  test('length mismatch does not throw (constant-time safety)', () => {
    process.env.HEARTBEAT_SECRET = 'short';
    const result = requireHeartbeatSecret(reqWith('Bearer dramatically-longer-than-the-real-secret'));
    assert.equal(result!.status, 401);
  });

  test('empty Bearer token returns 401', () => {
    process.env.HEARTBEAT_SECRET = 'right-heartbeat-secret-xyz';
    const result = requireHeartbeatSecret(reqWith('Bearer '));
    assert.equal(result!.status, 401);
  });

  test('distinct from CRON_SECRET — supplying cron secret value is rejected', () => {
    // The whole point of having a separate env var is rotation independence.
    // If somebody plumbs CRON_SECRET into the heartbeat hook by mistake, it
    // should fail closed, not silently fall back to that other channel.
    process.env.HEARTBEAT_SECRET = 'heartbeat-only-secret';
    const result = requireHeartbeatSecret(reqWith('Bearer cron-only-secret'));
    assert.equal(result!.status, 401);
  });
});

describe('requireHeartbeatSecret — env behavior', () => {
  test('dev (NODE_ENV=test, no HEARTBEAT_SECRET) passes through (null)', () => {
    delete process.env.HEARTBEAT_SECRET;
    delete process.env.VERCEL_ENV;
    (process.env as Record<string, string>).NODE_ENV = 'test';
    const result = requireHeartbeatSecret(reqWith('anything'));
    assert.equal(result, null);
  });

  test('Vercel prod with HEARTBEAT_SECRET unset returns 500 (fails closed)', async () => {
    delete process.env.HEARTBEAT_SECRET;
    process.env.VERCEL_ENV = 'production';
    (process.env as Record<string, string>).NODE_ENV = 'production';
    const result = requireHeartbeatSecret(reqWith('Bearer whatever'));
    assert.equal(result!.status, 500);
    const body = await result!.json();
    assert.equal(body.error, 'server misconfigured');
  });

  test('Vercel preview with HEARTBEAT_SECRET unset passes through (smoke tests)', () => {
    delete process.env.HEARTBEAT_SECRET;
    process.env.VERCEL_ENV = 'preview';
    (process.env as Record<string, string>).NODE_ENV = 'production';
    const result = requireHeartbeatSecret(reqWith('Bearer whatever'));
    assert.equal(result, null);
  });

  test('non-Vercel prod (e.g. Railway/Fly) with HEARTBEAT_SECRET unset returns 500', async () => {
    delete process.env.HEARTBEAT_SECRET;
    delete process.env.VERCEL_ENV;
    (process.env as Record<string, string>).NODE_ENV = 'production';
    const result = requireHeartbeatSecret(reqWith('Bearer whatever'));
    assert.equal(result!.status, 500);
  });
});
