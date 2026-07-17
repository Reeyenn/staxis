/**
 * Tests for the shared route wrapper (src/lib/api-route.ts).
 *
 * The wrapper's whole reason to exist is that it must reproduce the EXACT
 * HTTP behaviour of the hand-rolled prologue/epilogue it replaces. These
 * tests pin:
 *   - body parsing order + bad-JSON fallback,
 *   - gate short-circuit (the gate's own response is returned verbatim),
 *   - envelope binding (requestId + optional headers injected; per-call
 *     status/code/details still win),
 *   - the opt-in try/catch epilogue (and that WITHOUT it, throws propagate),
 *   - the built-in gate helpers' header split.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { NextResponse } from 'next/server';
import {
  defineRoute,
  publicGate,
  type GateFail,
} from '@/lib/api-route';

// A minimal NextRequest-ish stub: only .json(), .headers.get(), .url are used
// by the wrapper + gate helpers under test.
function mkReq(opts: {
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  badJson?: boolean;
} = {}) {
  const h = new Map<string, string>(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    url: opts.url ?? 'https://x.test/api/thing',
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    json: async () => {
      if (opts.badJson) throw new SyntaxError('bad json');
      return opts.body ?? {};
    },
  } as unknown as import('next/server').NextRequest;
}

// A gate that always succeeds, carrying a fixed requestId (+ optional headers)
// plus an `extra` field to prove gate context is exposed on ctx.
type OkGateResult =
  | { ok: true; requestId: string; headers?: Record<string, string>; extra: string }
  | GateFail;
function okGate(headers?: Record<string, string>) {
  return (): OkGateResult => ({ ok: true as const, requestId: 'RID1', headers, extra: 'hi' });
}

// A gate that always rejects with a specific NextResponse.
function failGate() {
  return (): { ok: true; requestId: string } | GateFail => ({
    ok: false as const,
    response: NextResponse.json({ error: 'nope', code: 'gate_401' }, { status: 401 }),
  });
}

describe('defineRoute — gate short-circuit', () => {
  test('returns the gate response verbatim when the gate fails', async () => {
    const handler = defineRoute({
      resolve: failGate(),
      handler: () => NextResponse.json({ should: 'not run' }),
    });
    const res = await handler(mkReq());
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, { error: 'nope', code: 'gate_401' });
  });

  test('handler does NOT run when the gate fails', async () => {
    let ran = false;
    const handler = defineRoute({
      resolve: failGate(),
      handler: () => {
        ran = true;
        return NextResponse.json({});
      },
    });
    await handler(mkReq());
    assert.equal(ran, false);
  });
});

describe('defineRoute — envelope binding', () => {
  test('ctx.ok injects the gate requestId and defaults to 200', async () => {
    const handler = defineRoute({
      resolve: okGate(),
      handler: (ctx) => ctx.ok({ value: 42 }),
    });
    const res = await handler(mkReq());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.requestId, 'RID1');
    assert.deepEqual(body.data, { value: 42 });
  });

  test('ctx.ok honours a per-call status override', async () => {
    const handler = defineRoute({
      resolve: okGate(),
      handler: (ctx) => ctx.ok({ id: 'x' }, { status: 201 }),
    });
    const res = await handler(mkReq());
    assert.equal(res.status, 201);
  });

  test('ctx.err injects requestId + carries status/code/details', async () => {
    const handler = defineRoute({
      resolve: okGate(),
      handler: (ctx) =>
        ctx.err('bad thing', { status: 400, code: 'validation_failed', details: { field: 'pid' } }),
    });
    const res = await handler(mkReq());
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.requestId, 'RID1');
    assert.equal(body.error, 'bad thing');
    assert.equal(body.code, 'validation_failed');
    assert.deepEqual(body.details, { field: 'pid' });
  });

  test('gate headers are attached to bound responses', async () => {
    const handler = defineRoute({
      resolve: okGate({ 'x-request-id': 'RID1' }),
      handler: (ctx) => ctx.ok({}),
    });
    const res = await handler(mkReq());
    assert.equal(res.headers.get('x-request-id'), 'RID1');
  });

  test('NO gate headers → no x-request-id header on the response', async () => {
    const handler = defineRoute({
      resolve: okGate(undefined),
      handler: (ctx) => ctx.ok({}),
    });
    const res = await handler(mkReq());
    assert.equal(res.headers.get('x-request-id'), null);
  });

  test('gate fields are exposed on ctx (minus the ok flag)', async () => {
    let seen: unknown;
    const handler = defineRoute({
      resolve: okGate(),
      handler: (ctx) => {
        seen = (ctx as { extra?: string }).extra;
        return ctx.ok({});
      },
    });
    await handler(mkReq());
    assert.equal(seen, 'hi');
  });
});

describe('defineRoute — body parsing', () => {
  test("body:'empty' passes the parsed JSON to resolve + handler", async () => {
    let resolveBody: unknown;
    let handlerBody: unknown;
    const handler = defineRoute<{ ok: true; requestId: string }, { pid?: string }>({
      body: 'empty',
      resolve: (_req, body) => {
        resolveBody = body;
        return { ok: true as const, requestId: 'RID1' };
      },
      handler: (ctx) => {
        handlerBody = ctx.body;
        return ctx.ok({});
      },
    });
    await handler(mkReq({ body: { pid: 'p1' } }));
    assert.deepEqual(resolveBody, { pid: 'p1' });
    assert.deepEqual(handlerBody, { pid: 'p1' });
  });

  test("body:'empty' falls back to {} on bad JSON (never throws)", async () => {
    let resolveBody: unknown;
    const handler = defineRoute({
      body: 'empty',
      resolve: (_req, body) => {
        resolveBody = body;
        return { ok: true as const, requestId: 'RID1' };
      },
      handler: (ctx) => ctx.ok({}),
    });
    const res = await handler(mkReq({ badJson: true }));
    assert.equal(res.status, 200);
    assert.deepEqual(resolveBody, {});
  });

  test("body:'none' leaves body undefined and never calls .json()", async () => {
    let called = false;
    const req = mkReq();
    req.json = async () => {
      called = true;
      return {};
    };
    let handlerBody: unknown = 'sentinel';
    const handler = defineRoute({
      body: 'none',
      resolve: () => ({ ok: true as const, requestId: 'RID1' }),
      handler: (ctx) => {
        handlerBody = ctx.body;
        return ctx.ok({});
      },
    });
    await handler(req);
    assert.equal(called, false);
    assert.equal(handlerBody, undefined);
  });
});

describe('defineRoute — error epilogue', () => {
  test('WITHOUT wrapErrors, a thrown error propagates (Next default 500)', async () => {
    const handler = defineRoute({
      resolve: okGate(),
      handler: () => {
        throw new Error('boom');
      },
    });
    await assert.rejects(() => handler(mkReq()), /boom/);
  });

  test('WITH wrapErrors, a throw becomes the configured 500 envelope', async () => {
    const handler = defineRoute({
      resolve: okGate(),
      wrapErrors: { message: 'Internal server error' },
      handler: () => {
        throw new Error('boom');
      },
    });
    const res = await handler(mkReq());
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.requestId, 'RID1');
    assert.equal(body.error, 'Internal server error');
    assert.equal(body.code, 'internal_error');
  });

  test('wrapErrors status + code overrides are honoured', async () => {
    const handler = defineRoute({
      resolve: okGate(),
      wrapErrors: { message: 'failed to build spend rollup', code: 'rollup_failed' },
      handler: () => {
        throw new Error('db down');
      },
    });
    const res = await handler(mkReq());
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'failed to build spend rollup');
    assert.equal(body.code, 'rollup_failed');
  });

  test('wrapErrors.log is invoked with the thrown error (side-effect only)', async () => {
    let logged: unknown;
    const handler = defineRoute({
      resolve: okGate(),
      wrapErrors: {
        log: (e) => {
          logged = e;
        },
      },
      handler: () => {
        throw new Error('kaboom');
      },
    });
    await handler(mkReq());
    assert.ok(logged instanceof Error);
    assert.equal((logged as Error).message, 'kaboom');
  });

  test('a handler that RETURNS normally is untouched by wrapErrors', async () => {
    const handler = defineRoute({
      resolve: okGate(),
      wrapErrors: {},
      handler: (ctx) => ctx.ok({ fine: true }),
    });
    const res = await handler(mkReq());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data, { fine: true });
  });
});

describe('publicGate', () => {
  test('always ok:true with a header bag echoing the requestId', () => {
    const g = publicGate(mkReq({ headers: { 'x-request-id': 'abc123' } }));
    assert.equal(g.ok, true);
    assert.equal(g.requestId, 'abc123');
    assert.deepEqual(g.headers, { 'x-request-id': 'abc123' });
  });

  test('mints a fresh requestId when the incoming header is absent', () => {
    const g = publicGate(mkReq());
    assert.match(g.requestId, /^[a-z0-9-]{6,64}$/i);
    assert.equal(g.headers['x-request-id'], g.requestId);
  });
});
