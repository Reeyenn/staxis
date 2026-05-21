/**
 * Tests for /api/save-fcm-token UUID validation (audit-02 F-07).
 *
 * Background: the route is unauthenticated (housekeepers hit it
 * via a magic-link URL). Its capability check is the (pid, staffId)
 * UUID pair — staffId must belong to a staff row whose
 * property_id === pid. The audit-02 fix replaced a length-only
 * check with `validateUuid()` so malformed inputs get a 400 from
 * the validator instead of bleeding into the DB and surfacing as
 * an indistinguishable 404. These tests pin that contract.
 *
 * Mock surface: the route imports supabaseAdmin at module load
 * but only CALLS it AFTER the UUID validation passes. So a request
 * with a non-UUID input never reaches the DB. We exercise that
 * pre-DB validation branch without touching supabase.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { POST } from '@/app/api/save-fcm-token/route';

function reqWith(body: unknown): NextRequest {
  return new Request('https://staxis.test/api/save-fcm-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe('save-fcm-token UUID validation (audit-02 F-07)', () => {
  test('non-UUID staffId returns 400 from validator (not 404 from DB)', async () => {
    const res = await POST(reqWith({
      pid: '00000000-0000-0000-0000-000000000000',
      staffId: 'not-a-uuid-just-a-string',
    }));
    assert.equal(res.status, 400);
    const body = await res.json();
    // Validator's error format names the offending field — proves we
    // hit the validator branch, not the DB-not-found branch.
    assert.match(JSON.stringify(body), /staffId/);
  });

  test('non-UUID pid returns 400 from validator', async () => {
    const res = await POST(reqWith({
      pid: 'short',
      staffId: '00000000-0000-0000-0000-000000000000',
    }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(JSON.stringify(body), /pid/);
  });

  test('missing staffId returns 400', async () => {
    const res = await POST(reqWith({ pid: '00000000-0000-0000-0000-000000000000' }));
    assert.equal(res.status, 400);
  });

  test('invalid JSON returns 400 before validation', async () => {
    const res = await POST(new Request('https://staxis.test/api/save-fcm-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    }) as unknown as NextRequest);
    assert.equal(res.status, 400);
  });
});
