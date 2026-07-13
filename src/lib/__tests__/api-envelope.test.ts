/**
 * Tests for readEnvelope() — the client half of the API envelope
 * (src/lib/api-envelope.ts, re-exported from src/lib/api-response.ts).
 *
 * Every migrated staff page will unwrap fetch Responses through this ONE
 * function, so its edge cases (non-JSON body, 200-with-ok:false, missing
 * error string) are load-bearing for every error state in the app.
 *
 * Uses the global Response (Node 18+) — same object shape the browser hands
 * the hook.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readEnvelope } from '@/lib/api-envelope';
// The re-export from the server module must keep working — server-side
// callers and the "one module for the envelope" story depend on it.
import { readEnvelope as reExported } from '@/lib/api-response';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('readEnvelope — success path', () => {
  test('unwraps { ok:true, data } into { data }', async () => {
    const res = jsonResponse({ ok: true, requestId: 'req_1', data: { rooms: [1, 2] } });
    const result = await readEnvelope<{ rooms: number[] }>(res);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.data, { rooms: [1, 2] });
  });

  test('carries requestId through on success (support triage)', async () => {
    const res = jsonResponse({ ok: true, requestId: 'req_abc', data: 42 });
    const result = await readEnvelope<number>(res);
    assert.equal(result.requestId, 'req_abc');
  });

  test('data may legitimately be an empty array (NOT an error)', async () => {
    // The RLS bug class renders as 200 + []; the envelope layer must pass
    // it through — emptiness handling is the page's job, not transport's.
    const res = jsonResponse({ ok: true, requestId: 'req_1', data: [] });
    const result = await readEnvelope<unknown[]>(res);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.data, []);
  });

  test('re-export from @/lib/api-response is the same function', () => {
    assert.equal(reExported, readEnvelope);
  });
});

describe('readEnvelope — error paths', () => {
  test('non-2xx with envelope body surfaces the server message', async () => {
    const res = jsonResponse(
      { ok: false, requestId: 'req_e', error: 'Rate limited', code: 'rate_limited' },
      429,
    );
    const result = await readEnvelope(res);
    assert.equal(result.data, undefined);
    assert.equal(result.error, 'Rate limited');
    assert.equal(result.code, 'rate_limited');
    assert.equal(result.status, 429);
    assert.equal(result.requestId, 'req_e');
  });

  test('HTTP 200 with ok:false is STILL an error (envelope wins)', async () => {
    const res = jsonResponse({ ok: false, requestId: 'req_e', error: 'Nope' }, 200);
    const result = await readEnvelope(res);
    assert.equal(result.error, 'Nope');
    assert.equal(result.data, undefined);
  });

  test('non-JSON body (proxy HTML error page) falls back to Failed (status)', async () => {
    const res = new Response('<html>502 Bad Gateway</html>', { status: 502 });
    const result = await readEnvelope(res);
    assert.equal(result.error, 'Failed (502)');
    assert.equal(result.status, 502);
    assert.equal(result.code, undefined);
  });

  test('empty body falls back to Failed (status)', async () => {
    const res = new Response('', { status: 500 });
    const result = await readEnvelope(res);
    assert.equal(result.error, 'Failed (500)');
  });

  test('JSON error body without an error string falls back to Failed (status)', async () => {
    const res = jsonResponse({ ok: false, requestId: 'req_x' }, 403);
    const result = await readEnvelope(res);
    assert.equal(result.error, 'Failed (403)');
    assert.equal(result.status, 403);
  });

  test('empty-string error message falls back to Failed (status), not blank UI text', async () => {
    const res = jsonResponse({ ok: false, requestId: 'req_x', error: '' }, 400);
    const result = await readEnvelope(res);
    assert.equal(result.error, 'Failed (400)');
  });

  test('non-envelope JSON on a 2xx (route not yet migrated / wrong shape) is an error', async () => {
    const res = jsonResponse({ message: 'legacy shape', updated: 3 }, 200);
    const result = await readEnvelope(res);
    assert.equal(result.error, 'Failed (200)');
    assert.equal(result.data, undefined);
  });

  test('non-string code is omitted rather than passed through', async () => {
    const res = jsonResponse({ ok: false, requestId: 'r', error: 'x', code: 42 }, 400);
    const result = await readEnvelope(res);
    assert.equal(result.code, undefined);
  });

  test('never throws on malformed input (typed error result instead)', async () => {
    const res = new Response('{"truncated":', { status: 200 });
    const result = await readEnvelope(res);
    assert.equal(result.error, 'Failed (200)');
  });
});

describe('readEnvelope — fallbackError parameter', () => {
  test('replaces the generic Failed (status) when the body has no error string', async () => {
    const res = new Response('<html>502</html>', { status: 502 });
    const result = await readEnvelope(res, 'No se pudo cargar / Could not load');
    assert.equal(result.error, 'No se pudo cargar / Could not load');
    assert.equal(result.status, 502);
  });

  test('server-provided error message still wins over the fallback', async () => {
    const res = jsonResponse({ ok: false, requestId: 'r', error: 'Rate limited' }, 429);
    const result = await readEnvelope(res, 'Bespoke fallback');
    assert.equal(result.error, 'Rate limited');
  });

  test('empty-string error in the body still uses the fallback', async () => {
    const res = jsonResponse({ ok: false, requestId: 'r', error: '' }, 400);
    const result = await readEnvelope(res, 'Bespoke fallback');
    assert.equal(result.error, 'Bespoke fallback');
  });

  test('empty-string fallback is ignored (never blank UI text)', async () => {
    const res = new Response('', { status: 500 });
    const result = await readEnvelope(res, '');
    assert.equal(result.error, 'Failed (500)');
  });

  test('does not touch the success path', async () => {
    const res = jsonResponse({ ok: true, requestId: 'r', data: 7 });
    const result = await readEnvelope<number>(res, 'Bespoke fallback');
    assert.equal(result.error, undefined);
    assert.equal(result.data, 7);
  });

  test('omitted → default Failed (status) unchanged', async () => {
    const res = new Response('', { status: 503 });
    const result = await readEnvelope(res);
    assert.equal(result.error, 'Failed (503)');
  });
});
