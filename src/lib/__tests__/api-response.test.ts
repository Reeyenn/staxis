/**
 * Response-envelope shape tests for src/lib/api-response.ts.
 *
 * Every /api/* route returns this envelope; the client writes ONE error
 * handler against it. A regression here (e.g. requestId stops propagating,
 * or `code` leaks into success bodies) cascades into broken Sentry triage
 * + silent UI error states. These tests pin the shape.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ok, err, buildOkBody, ApiErrorCode } from '@/lib/api-response';

const RID = 'req_test_abc123';

describe('ok() — success envelope', () => {
  test('defaults to HTTP 200', async () => {
    const res = ok({ value: 1 }, { requestId: RID });
    assert.equal(res.status, 200);
  });

  test('status override is respected', async () => {
    const res = ok({ id: 'x' }, { requestId: RID, status: 201 });
    assert.equal(res.status, 201);
  });

  test('body shape is { ok:true, requestId, data }', async () => {
    const res = ok({ value: 42 }, { requestId: RID });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.requestId, RID);
    assert.deepEqual(body.data, { value: 42 });
    // Success bodies must NOT carry error/code/details.
    assert.equal('error' in body, false);
    assert.equal('code' in body, false);
    assert.equal('details' in body, false);
  });

  test('requestId propagates verbatim (Sentry triage depends on this)', async () => {
    const res = ok({}, { requestId: 'req_unique_zzz' });
    const body = await res.json();
    assert.equal(body.requestId, 'req_unique_zzz');
  });

  test('custom headers are attached to the response', () => {
    const res = ok({}, { requestId: RID, headers: { 'X-Test': 'yes' } });
    assert.equal(res.headers.get('X-Test'), 'yes');
  });

  test('arbitrary payload shapes pass through unchanged', async () => {
    const payload = { rooms: [1, 2, 3], total: 3, nested: { a: 'b' } };
    const res = ok(payload, { requestId: RID });
    const body = await res.json();
    assert.deepEqual(body.data, payload);
  });
});

describe('buildOkBody() — plain-object variant for idempotency cache', () => {
  test('returns the same shape as ok() but without wrapping in NextResponse', () => {
    const body = buildOkBody({ value: 'cached' }, RID);
    assert.deepEqual(body, { ok: true, requestId: RID, data: { value: 'cached' } });
  });

  test('result is JSON-serializable (must round-trip through idempotency_log)', () => {
    const body = buildOkBody({ a: 1, b: [2, 3] }, RID);
    const roundTripped = JSON.parse(JSON.stringify(body));
    assert.deepEqual(roundTripped, body);
  });
});

describe('err() — error envelope', () => {
  test('defaults to HTTP 500', async () => {
    const res = err('boom', { requestId: RID });
    assert.equal(res.status, 500);
  });

  test('status override is respected (e.g. 400 / 401 / 429)', () => {
    assert.equal(err('bad', { requestId: RID, status: 400 }).status, 400);
    assert.equal(err('nope', { requestId: RID, status: 401 }).status, 401);
    assert.equal(err('slow down', { requestId: RID, status: 429 }).status, 429);
  });

  test('body shape is { ok:false, requestId, error, code?, details? }', async () => {
    const res = err('rate limited', {
      requestId: RID,
      status: 429,
      code: 'rate_limited',
      details: { retryAfter: 30 },
    });
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.requestId, RID);
    assert.equal(body.error, 'rate limited');
    assert.equal(body.code, 'rate_limited');
    assert.deepEqual(body.details, { retryAfter: 30 });
  });

  test('omits code when not provided (no empty-string leak)', async () => {
    const res = err('plain error', { requestId: RID });
    const body = await res.json();
    assert.equal('code' in body, false);
  });

  test('omits details when not provided', async () => {
    const res = err('plain error', { requestId: RID, code: 'x' });
    const body = await res.json();
    assert.equal('details' in body, false);
  });

  test('requestId propagates on error path too', async () => {
    const res = err('boom', { requestId: 'req_err_xyz' });
    const body = await res.json();
    assert.equal(body.requestId, 'req_err_xyz');
  });

  test('custom headers (e.g. Retry-After) are attached', () => {
    const res = err('rate limited', {
      requestId: RID,
      status: 429,
      headers: { 'Retry-After': '30' },
    });
    assert.equal(res.headers.get('Retry-After'), '30');
  });
});

describe('ApiErrorCode — stable machine-readable codes', () => {
  test('exposes the documented finite set', () => {
    // If a code is renamed, the client switch statement silently falls
    // through to the default. Lock the strings.
    assert.equal(ApiErrorCode.Unauthorized, 'unauthorized');
    assert.equal(ApiErrorCode.Forbidden, 'forbidden');
    assert.equal(ApiErrorCode.NotFound, 'not_found');
    assert.equal(ApiErrorCode.ValidationFailed, 'validation_failed');
    assert.equal(ApiErrorCode.RateLimited, 'rate_limited');
    assert.equal(ApiErrorCode.IdempotencyConflict, 'idempotency_conflict');
    assert.equal(ApiErrorCode.UpstreamFailure, 'upstream_failure');
    assert.equal(ApiErrorCode.InternalError, 'internal_error');
  });
});
