/**
 * Contract + runtime coverage for the dynamic AI-control config action routes.
 * The tests exercise the real wrapper and admin gate while keeping stores and
 * provider work behind explicit mocked seams.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { NextRequest } from 'next/server';

import { POST as activateConfig } from '@/app/api/admin/ai-control/configs/[id]/activate/route';
import { POST as rollbackConfig } from '@/app/api/admin/ai-control/configs/[id]/rollback/route';
import { POST as validateConfig } from '@/app/api/admin/ai-control/configs/[id]/validate/route';
import type { RouteContext } from '@/lib/api-route';
import { supabaseAdmin } from '@/lib/supabase-admin';

type DynamicRouteContext = RouteContext<{ id: string }>;
type DynamicRoute = (req: NextRequest, context?: DynamicRouteContext) => Promise<Response>;
type FromHandler = (table: string) => unknown;
type RpcResult = { data: unknown; error: { message: string } | null };
type RpcHandler = (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;

const BATCH = [
  {
    name: 'activate',
    path: 'src/app/api/admin/ai-control/configs/[id]/activate/route.ts',
    handler: activateConfig as DynamicRoute,
  },
  {
    name: 'rollback',
    path: 'src/app/api/admin/ai-control/configs/[id]/rollback/route.ts',
    handler: rollbackConfig as DynamicRoute,
  },
  {
    name: 'validate',
    path: 'src/app/api/admin/ai-control/configs/[id]/validate/route.ts',
    handler: validateConfig as DynamicRoute,
  },
] as const;

const VALID_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const savedEnv = {
  disable2fa: process.env.DISABLE_SERVER_2FA_ENFORCEMENT,
  nodeEnv: process.env.NODE_ENV,
  vercelEnv: process.env.VERCEL_ENV,
};

afterEach(() => {
  supabaseAdmin.auth.getUser = originalGetUser;
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  if (savedEnv.disable2fa === undefined) delete (process.env as Record<string, string | undefined>).DISABLE_SERVER_2FA_ENFORCEMENT;
  else process.env.DISABLE_SERVER_2FA_ENFORCEMENT = savedEnv.disable2fa;
  if (savedEnv.nodeEnv === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
  else (process.env as Record<string, string>).NODE_ENV = savedEnv.nodeEnv;
  if (savedEnv.vercelEnv === undefined) delete (process.env as Record<string, string | undefined>).VERCEL_ENV;
  else process.env.VERCEL_ENV = savedEnv.vercelEnv;
});

function request(
  url: string,
  options: { authorization?: string; requestId?: string; body?: string } = {},
): NextRequest {
  const headers = new Headers();
  if (options.authorization !== undefined) headers.set('authorization', options.authorization);
  if (options.requestId !== undefined) headers.set('x-request-id', options.requestId);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest(url, {
    method: 'POST',
    headers,
    body: options.body,
  });
}

function accountQuery() {
  return {
    select: (columns: string) => {
      assert.equal(columns, 'id, role, active');
      return {
        eq: (column: string, value: string) => {
          assert.equal(column, 'data_user_id');
          assert.equal(value, USER_ID);
          return {
            maybeSingle: async () => ({
              data: { id: ACCOUNT_ID, role: 'admin', active: true },
              error: null,
            }),
          };
        },
      };
    },
  };
}

function authorizeAdmin(fromHandler: FromHandler = (table) => {
  assert.fail('unexpected store access: ' + table);
}) {
  process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';
  (process.env as Record<string, string>).NODE_ENV = 'test';
  delete process.env.VERCEL_ENV;

  supabaseAdmin.auth.getUser = (async () => ({
    data: { user: { id: USER_ID, email: 'admin@example.com' } },
    error: null,
  })) as typeof supabaseAdmin.auth.getUser;
  // @ts-expect-error test replaces the singleton dependency seam
  supabaseAdmin.from = (table: string) => {
    if (table === 'accounts') return accountQuery();
    return fromHandler(table);
  };
}

function installRpc(handler: RpcHandler): void {
  // @ts-expect-error test replaces the singleton dependency seam
  supabaseAdmin.rpc = handler;
}

function observeJson(req: NextRequest, events: string[], value: unknown): { read: () => boolean } {
  let bodyRead = false;
  (req as unknown as { json: () => Promise<unknown> }).json = async () => {
    bodyRead = true;
    events.push('body');
    if (value instanceof Error) throw value;
    return value;
  };
  return { read: () => bodyRead };
}

function delayedParams(events: string[], id = VALID_ID): Promise<{ id: string }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      events.push('params');
      resolve({ id });
    }, 0);
  });
}

function rejectingContext(reads: { getter: number; awaited: number }): DynamicRouteContext {
  return {
    get params() {
      reads.getter += 1;
      return {
        then: (_resolve: unknown, reject: (reason: Error) => unknown) => {
          reads.awaited += 1;
          return reject(new Error('params rejected'));
        },
      } as Promise<{ id: string }>;
    },
  };
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('dynamic admin AI-control config wrapper batch', () => {
  test('all three dynamic handlers use the shared wrapper and retain metadata', async () => {
    for (const route of BATCH) {
      const source = await readFile(route.path, 'utf8');
      assert.match(source, /import \{ defineRoute, adminGate \} from ['"]@\/lib\/api-route['"]/);
      assert.match(source, /export const POST = defineRoute<AdminGateResult, unknown, \{ id: string \}>/);
      assert.match(source, /const \{ id \} = await ctx\.params/);
      assert.doesNotMatch(source, /requireAdmin|getOrMintRequestId/);
      assert.match(source, /export const runtime = ['"]nodejs['"]/);
      assert.match(source, /export const dynamic = ['"]force-dynamic['"]/);
      assert.match(source, /aiControlError\(error, ctx\.requestId\)/);
      assert.match(source, /NO_STORE_HEADERS/);
    }

    const activate = await readFile(BATCH[0].path, 'utf8');
    const rollback = await readFile(BATCH[1].path, 'utf8');
    const validate = await readFile(BATCH[2].path, 'utf8');
    assert.match(activate, /action: 'ai\.config\.activate'/);
    assert.match(rollback, /action: 'ai\.config\.rollback'/);
    assert.match(validate, /export const maxDuration = 30/);
    assert.match(validate, /checkAndIncrementRateLimit\(/);
    assert.match(validate, /hashToRateLimitKey\(`admin-ai-control:\$\{ctx\.accountId\}`\)/);
    assert.doesNotMatch(validate, /ctx\.req\.json/);
  });

  test('unauthorized requests do not touch params, body, rate limit, or stores', async () => {
    let rpcCalls = 0;
    installRpc(async () => {
      rpcCalls += 1;
      throw new Error('rate limit should not run');
    });
    supabaseAdmin.from = () => {
      assert.fail('store should not run before admin auth');
    };

    for (const route of BATCH) {
      const reads = { getter: 0, awaited: 0 };
      const events: string[] = [];
      const req = request(`https://staxis.test/api/admin/ai-control/configs/${VALID_ID}/${route.name}`, {
        body: '{}',
      });
      const body = observeJson(req, events, {});
      const response = await route.handler(req, rejectingContext(reads));
      assert.equal(response.status, 401, route.name);
      assert.equal(reads.getter, 0, route.name);
      assert.equal(reads.awaited, 0, route.name);
      assert.equal(body.read(), false, route.name);
      assert.deepEqual(events, [], route.name);
    }
    assert.equal(rpcCalls, 0);
  });

  test('authorized activate and rollback preserve params-before-body validation order', async () => {
    for (const [name, handler, expectedError] of [
      ['activate', activateConfig as DynamicRoute, 'expectedActiveId is required (use null when no database version is active)'],
      ['rollback', rollbackConfig as DynamicRoute, 'expectedActiveId is required'],
    ] as const) {
      const events: string[] = [];
      authorizeAdmin();
      installRpc(async () => {
        assert.fail('rate limit should not run for activate or rollback');
      });
      const req = request(`https://staxis.test/api/admin/ai-control/configs/${VALID_ID}/${name}`, {
        authorization: 'Bearer test-token',
        requestId: `${name}-test-id`,
        body: '{}',
      });
      const body = observeJson(req, events, {});
      const response = await handler(req, { params: delayedParams(events) });
      assert.deepEqual(events, ['params', 'body'], name);
      assert.equal(body.read(), true);
      assert.equal(response.status, 400, name);
      assert.equal(response.headers.get('cache-control'), 'no-store', name);
      const json = await responseBody(response);
      assert.equal(json.ok, false);
      assert.equal(json.error, expectedError);
      assert.equal(json.code, 'validation_failed');
      assert.equal(json.requestId, `${name}-test-id`);
    }
  });

  test('authorized validate preserves params-before-rate-limit ordering and 429 behavior', async () => {
    const events: string[] = [];
    const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
    authorizeAdmin();
    installRpc(async (fn, args) => {
      events.push('rate-limit');
      rpcCalls.push({ fn, args });
      return { data: 31, error: null };
    });
    const req = request(`https://staxis.test/api/admin/ai-control/configs/${VALID_ID}/validate`, {
      authorization: 'Bearer test-token',
      requestId: 'validate-test-id',
      body: '{}',
    });
    const body = observeJson(req, events, {});
    const response = await validateConfig(req, { params: delayedParams(events) });
    assert.deepEqual(events, ['params', 'rate-limit']);
    assert.equal(body.read(), false);
    assert.equal(response.status, 429);
    assert.match(response.headers.get('retry-after') ?? '', /^\d+$/);
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].fn, 'staxis_api_limit_hit');
    assert.equal(rpcCalls[0].args.p_endpoint, 'admin-ai-config-validate');
    assert.match(String(rpcCalls[0].args.p_property_id), /^[0-9a-f-]{36}$/);
    const json = await responseBody(response);
    assert.equal(json.error, 'rate_limited');
    assert.match(String(json.detail), /^31\/30 for this property/);
  });

  test('authorized invalid IDs stop body and rate-limit work for every method', async () => {
    for (const route of BATCH) {
      const events: string[] = [];
      authorizeAdmin();
      let rpcCalls = 0;
      installRpc(async () => {
        rpcCalls += 1;
        throw new Error('rate limit should follow ID validation');
      });
      const req = request(`https://staxis.test/api/admin/ai-control/configs/not-a-uuid/${route.name}`, {
        authorization: 'Bearer test-token',
        requestId: `${route.name}-invalid-id`,
        body: '{}',
      });
      const body = observeJson(req, events, {});
      const response = await route.handler(req, { params: delayedParams(events, 'not-a-uuid') });
      assert.deepEqual(events, ['params'], route.name);
      assert.equal(body.read(), false, route.name);
      assert.equal(response.status, 400, route.name);
      assert.equal(response.headers.get('cache-control'), 'no-store', route.name);
      const json = await responseBody(response);
      assert.equal(json.error, 'id is not a valid UUID');
      assert.equal(json.code, 'validation_failed');
      assert.equal(json.requestId, `${route.name}-invalid-id`);
      assert.equal(rpcCalls, 0, route.name);
    }
  });

  test('authorized rejected params propagate before body, rate limit, or service work', async () => {
    for (const route of BATCH) {
      const reads = { getter: 0, awaited: 0 };
      const events: string[] = [];
      authorizeAdmin();
      let rpcCalls = 0;
      installRpc(async () => {
        rpcCalls += 1;
        throw new Error('rate limit should follow params');
      });
      const req = request(`https://staxis.test/api/admin/ai-control/configs/${VALID_ID}/${route.name}`, {
        authorization: 'Bearer test-token',
        body: '{}',
      });
      const body = observeJson(req, events, {});
      await assert.rejects(
        route.handler(req, rejectingContext(reads)),
        /params rejected/,
        route.name,
      );
      assert.equal(reads.getter, 1, route.name);
      assert.equal(reads.awaited, 1, route.name);
      assert.equal(body.read(), false, route.name);
      assert.deepEqual(events, [], route.name);
      assert.equal(rpcCalls, 0, route.name);
    }
  });

  test('authorized service errors retain aiControlError mapping and no-store envelopes', async () => {
    const events: string[] = [];
    authorizeAdmin((table) => {
      if (table === 'ai_feature_config_versions') {
        return {
          select: () => ({
            eq: (column: string, value: string) => {
              assert.equal(column, 'id');
              assert.equal(value, VALID_ID);
              return {
                maybeSingle: async () => {
                  events.push('store');
                  return { data: null, error: null };
                },
              };
            },
          }),
        };
      }
      assert.fail('unexpected store access: ' + table);
    });
    installRpc(async (fn) => {
      assert.equal(fn, 'staxis_api_limit_hit');
      events.push('rate-limit');
      return { data: 1, error: null };
    });

    for (const [name, handler] of [
      ['activate', activateConfig as DynamicRoute],
      ['rollback', rollbackConfig as DynamicRoute],
    ] as const) {
      events.length = 0;
      const req = request(`https://staxis.test/api/admin/ai-control/configs/${VALID_ID}/${name}`, {
        authorization: 'Bearer test-token',
        requestId: `${name}-error-id`,
        body: JSON.stringify({ expectedActiveId: null, reason: 'valid reason' }),
      });
      observeJson(req, events, { expectedActiveId: null, reason: 'valid reason' });
      const response = await handler(req, { params: delayedParams(events) });
      assert.deepEqual(events, ['params', 'body', 'store'], name);
      assert.equal(response.status, 404, name);
      assert.equal(response.headers.get('cache-control'), 'no-store', name);
      const json = await responseBody(response);
      assert.equal(json.error, 'AI config version not found.');
      assert.equal(json.code, 'not_found');
      assert.equal(json.requestId, `${name}-error-id`);
    }

    events.length = 0;
    const validateRequest = request(`https://staxis.test/api/admin/ai-control/configs/${VALID_ID}/validate`, {
      authorization: 'Bearer test-token',
      requestId: 'validate-error-id',
    });
    const validateResponse = await validateConfig(validateRequest, { params: delayedParams(events) });
    assert.deepEqual(events, ['params', 'rate-limit', 'store']);
    assert.equal(validateResponse.status, 404);
    assert.equal(validateResponse.headers.get('cache-control'), 'no-store');
    const validateJson = await responseBody(validateResponse);
    assert.equal(validateJson.error, 'AI config version not found.');
    assert.equal(validateJson.code, 'not_found');
    assert.equal(validateJson.requestId, 'validate-error-id');
  });
});
