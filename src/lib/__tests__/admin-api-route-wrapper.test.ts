/**
 * Contract + runtime coverage for the first admin route-wrapper batch.
 *
 * The source assertions keep the mechanical conversion bounded to the four
 * static AI-control handlers. The route calls exercise the real wrapper and
 * admin gate at both the unauthorized short-circuit and authorized
 * validation seams, without reaching the model catalog or database stores.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { NextRequest } from 'next/server';

import { GET as getModels } from '@/app/api/admin/ai-control/models/route';
import { supabaseAdmin } from '@/lib/supabase-admin';

const BATCH = [
  'src/app/api/admin/ai-control/features/route.ts',
  'src/app/api/admin/ai-control/models/route.ts',
  'src/app/api/admin/ai-control/models/refresh/route.ts',
  'src/app/api/admin/ai-control/configs/route.ts',
] as const;

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

function request(url: string, authorization?: string, requestId?: string): NextRequest {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  if (requestId !== undefined) headers.set('x-request-id', requestId);
  return new NextRequest(url, { headers });
}

describe('static admin AI-control wrapper batch', () => {
  test('every converted route uses the shared wrapper and keeps its static metadata', async () => {
    for (const path of BATCH) {
      const source = await readFile(path, 'utf8');
      assert.match(source, /import \{ defineRoute, adminGate \} from ['"]@\/lib\/api-route['"]/);
      assert.doesNotMatch(source, /requireAdmin|getOrMintRequestId/);
      assert.match(source, /export const runtime = ['"]nodejs['"]/);
      assert.match(source, /export const dynamic = ['"]force-dynamic['"]/);
    }
  });

  test('unauthorized requests stop at admin auth before route validation', async () => {
    const response = await getModels(request('https://staxis.test/api/admin/ai-control/models?provider=invalid'));
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.code, 'missing_token');
    assert.equal(body.error, 'missing bearer token');
  });

  test('authorized requests retain validation status, envelope, and no-store header', async () => {
    process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';
    (process.env as Record<string, string>).NODE_ENV = 'test';
    delete process.env.VERCEL_ENV;

    supabaseAdmin.auth.getUser = (async () => ({
      data: { user: { id: '11111111-1111-1111-1111-111111111111', email: 'admin@example.com' } },
      error: null,
    })) as typeof supabaseAdmin.auth.getUser;
    // @ts-expect-error test replaces the singleton dependency seam
    supabaseAdmin.from = (table: string) => {
      assert.equal(table, 'accounts');
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
    };

    const response = await getModels(
      request(
        'https://staxis.test/api/admin/ai-control/models?provider=invalid',
        'Bearer test-token',
        'admin-test-id',
      ),
    );
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'provider must be anthropic or openai');
    assert.equal(body.code, 'validation_failed');
    assert.equal(body.requestId, 'admin-test-id');
  });
});
