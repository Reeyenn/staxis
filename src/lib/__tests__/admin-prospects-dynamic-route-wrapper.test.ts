/**
 * Contract + runtime coverage for the dynamic Prospects PATCH/DELETE wrapper
 * consumer. The tests make route-context access and handler ordering visible
 * without reaching production data stores except for the mocked DELETE path.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { NextRequest } from 'next/server';

import {
  DELETE as deleteProspect,
  PATCH as patchProspect,
} from '@/app/api/admin/prospects/[id]/route';
import type { RouteContext } from '@/lib/api-route';
import { supabaseAdmin } from '@/lib/supabase-admin';

type ProspectRouteContext = RouteContext<{ id: string }>;
type FromHandler = (table: string) => unknown;

const BATCH_ROUTE = 'src/app/api/admin/prospects/[id]/route.ts';
const WRAPPER = 'src/lib/api-route.ts';
const PROSPECT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const savedEnv = {
  disable2fa: process.env.DISABLE_SERVER_2FA_ENFORCEMENT,
  nodeEnv: process.env.NODE_ENV,
  vercelEnv: process.env.VERCEL_ENV,
};

afterEach(() => {
  supabaseAdmin.auth.getUser = originalGetUser;
  supabaseAdmin.from = originalFrom;
  if (savedEnv.disable2fa === undefined) delete (process.env as Record<string, string | undefined>).DISABLE_SERVER_2FA_ENFORCEMENT;
  else process.env.DISABLE_SERVER_2FA_ENFORCEMENT = savedEnv.disable2fa;
  if (savedEnv.nodeEnv === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
  else (process.env as Record<string, string>).NODE_ENV = savedEnv.nodeEnv;
  if (savedEnv.vercelEnv === undefined) delete (process.env as Record<string, string | undefined>).VERCEL_ENV;
  else process.env.VERCEL_ENV = savedEnv.vercelEnv;
});

function request(
  url: string,
  options: { authorization?: string; requestId?: string; method?: string; body?: string } = {},
): NextRequest {
  const headers = new Headers();
  if (options.authorization !== undefined) headers.set('authorization', options.authorization);
  if (options.requestId !== undefined) headers.set('x-request-id', options.requestId);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest(url, {
    method: options.method ?? 'GET',
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
          assert.equal(value, '11111111-1111-1111-1111-111111111111');
          return {
            maybeSingle: async () => ({
              data: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', role: 'admin', active: true },
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
    data: { user: { id: '11111111-1111-1111-1111-111111111111', email: 'admin@example.com' } },
    error: null,
  })) as typeof supabaseAdmin.auth.getUser;
  // @ts-expect-error test replaces the singleton dependency seam
  supabaseAdmin.from = (table: string) => {
    if (table === 'accounts') return accountQuery();
    return fromHandler(table);
  };
}

function rejectingContext(reads: { getter: number; awaited: number }): ProspectRouteContext {
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

function delayedParams(events: string[]): Promise<{ id: string }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      events.push('params');
      resolve({ id: PROSPECT_ID });
    }, 0);
  });
}

describe('dynamic admin Prospects wrapper consumer', () => {
  test('pins the typed params pass-through and dynamic route contract', async () => {
    const wrapper = await readFile(WRAPPER, 'utf8');
    const route = await readFile(BATCH_ROUTE, 'utf8');
    assert.match(wrapper, /export type RouteContext/);
    assert.match(wrapper, /routeContext\?: RouteContext<TParams>/);
    assert.match(wrapper, /routeContext \? \{ params: routeContext\.params \} : \{\}/);
    assert.doesNotMatch(wrapper, /await routeContext\.params/);
    assert.match(route, /defineRoute<AdminGateResult, unknown, \{ id: string \}>/);
    assert.match(route, /const \{ id \} = await ctx\.params/);
    assert.doesNotMatch(route, /from ['\"]@\/lib\/admin-auth['\"]/);
    assert.doesNotMatch(route, /getOrMintRequestId/);
    assert.match(route, /export const maxDuration = 15/);
  });

  test('unauthorized requests do not touch params or PATCH body', async () => {
    const patchReads = { getter: 0, awaited: 0 };
    let bodyRead = false;
    const patchRequest = request('https://staxis.test/api/admin/prospects/' + PROSPECT_ID, {
      method: 'PATCH',
      body: '{}',
    });
    (patchRequest as unknown as { json: () => Promise<unknown> }).json = async () => {
      bodyRead = true;
      throw new Error('body should not be read');
    };

    const patchResponse = await patchProspect(patchRequest, rejectingContext(patchReads));
    assert.equal(patchResponse.status, 401);
    assert.equal(patchReads.getter, 0);
    assert.equal(patchReads.awaited, 0);
    assert.equal(bodyRead, false);

    const deleteReads = { getter: 0, awaited: 0 };
    const deleteResponse = await deleteProspect(
      request('https://staxis.test/api/admin/prospects/' + PROSPECT_ID, { method: 'DELETE' }),
      rejectingContext(deleteReads),
    );
    assert.equal(deleteResponse.status, 401);
    assert.equal(deleteReads.getter, 0);
    assert.equal(deleteReads.awaited, 0);
  });

  test('authorized PATCH awaits params before parsing body and preserves validation response', async () => {
    const events: string[] = [];
    authorizeAdmin();
    const patchRequest = request('https://staxis.test/api/admin/prospects/' + PROSPECT_ID, {
      authorization: 'Bearer test-token',
      requestId: 'patch-test-id',
      method: 'PATCH',
      body: '{}',
    });
    (patchRequest as unknown as { json: () => Promise<unknown> }).json = async () => {
      events.push('body');
      return {};
    };

    const response = await patchProspect(patchRequest, { params: delayedParams(events) });
    assert.deepEqual(events, ['params', 'body']);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'no fields to update');
    assert.equal(body.requestId, 'patch-test-id');
  });

  test('authorized DELETE awaits params before store and audit side effects', async () => {
    const events: string[] = [];
    authorizeAdmin((table) => {
      if (table === 'prospects') {
        events.push('prospects');
        return {
          delete: () => {
            events.push('delete');
            return {
              eq: async (column: string, value: string) => {
                events.push('eq:' + column + ':' + value);
                return { error: null };
              },
            };
          },
        };
      }
      if (table === 'admin_audit_log') {
        events.push('audit');
        return {
          insert: async () => {
            events.push('audit-insert');
            return { error: null };
          },
        };
      }
      assert.fail('unexpected store access: ' + table);
    });

    const response = await deleteProspect(
      request('https://staxis.test/api/admin/prospects/' + PROSPECT_ID, {
        authorization: 'Bearer test-token',
        requestId: 'delete-test-id',
        method: 'DELETE',
      }),
      { params: delayedParams(events) },
    );
    assert.deepEqual(events, ['params', 'prospects', 'delete', 'eq:id:' + PROSPECT_ID, 'audit', 'audit-insert']);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.data, { deleted: true });
    assert.equal(body.requestId, 'delete-test-id');
  });

  test('authorized rejected params still propagate and prevent PATCH body parsing', async () => {
    authorizeAdmin();
    const reads = { getter: 0, awaited: 0 };
    let bodyRead = false;
    const patchRequest = request('https://staxis.test/api/admin/prospects/' + PROSPECT_ID, {
      authorization: 'Bearer test-token',
      method: 'PATCH',
      body: '{}',
    });
    (patchRequest as unknown as { json: () => Promise<unknown> }).json = async () => {
      bodyRead = true;
      return {};
    };

    await assert.rejects(
      patchProspect(patchRequest, rejectingContext(reads)),
      /params rejected/,
    );
    assert.equal(reads.getter, 1);
    assert.equal(reads.awaited, 1);
    assert.equal(bodyRead, false);
  });
});
