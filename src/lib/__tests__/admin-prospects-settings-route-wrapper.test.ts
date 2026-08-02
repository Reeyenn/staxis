/**
 * Contract + runtime coverage for the static prospects/settings admin batch.
 * Runtime calls stop at admin auth or route validation so they do not reach
 * production data stores, setting writes, prospect inserts, or audit writes.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { NextRequest } from 'next/server';

import { GET as getProspects, POST as postProspects } from '@/app/api/admin/prospects/route';
import { GET as getSettings, POST as postSettings } from '@/app/api/admin/settings/route';
import { supabaseAdmin } from '@/lib/supabase-admin';

const BATCH = [
  'src/app/api/admin/prospects/route.ts',
  'src/app/api/admin/settings/route.ts',
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

function authorizeAdmin() {
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
}

describe('static admin prospects/settings wrapper batch', () => {
  test('every converted route uses the shared wrapper and keeps static metadata', async () => {
    for (const path of BATCH) {
      const source = await readFile(path, 'utf8');
      assert.match(source, /import \{ defineRoute, adminGate \} from ['"]@\/lib\/api-route['"]/);
      assert.doesNotMatch(source, /from ['"]@\/lib\/admin-auth['"]/);
      assert.doesNotMatch(source, /getOrMintRequestId/);
      assert.match(source, /export const runtime = ['"]nodejs['"]/);
      assert.match(source, /export const dynamic = ['"]force-dynamic['"]/);
      if (path.endsWith('/prospects/route.ts')) {
        assert.match(source, /export const maxDuration = 15/);
      }
    }
  });

  test('every converted method preserves the unauthorized admin short-circuit', async () => {
    const responses = await Promise.all([
      getProspects(request('https://staxis.test/api/admin/prospects')),
      postProspects(request('https://staxis.test/api/admin/prospects', {
        method: 'POST',
        body: '{not-json',
      })),
      getSettings(request('https://staxis.test/api/admin/settings')),
      postSettings(request('https://staxis.test/api/admin/settings', {
        method: 'POST',
        body: '{not-json',
      })),
    ]);

    for (const response of responses) {
      assert.equal(response.status, 401);
      const body = await response.json();
      assert.equal(body.code, 'missing_token');
      assert.equal(body.error, 'missing bearer token');
    }
  });

  test('authorized POST validation preserves status, envelopes, and request IDs', async () => {
    authorizeAdmin();

    const prospectResponse = await postProspects(request(
      'https://staxis.test/api/admin/prospects',
      { authorization: 'Bearer test-token', requestId: 'prospect-test-id', method: 'POST', body: '{}' },
    ));
    assert.equal(prospectResponse.status, 400);
    const prospectBody = await prospectResponse.json();
    assert.equal(prospectBody.ok, false);
    assert.equal(prospectBody.error, 'hotelName is required');
    assert.equal(prospectBody.requestId, 'prospect-test-id');

    const settingsResponse = await postSettings(request(
      'https://staxis.test/api/admin/settings',
      { authorization: 'Bearer test-token', requestId: 'settings-test-id', method: 'POST', body: '{}' },
    ));
    assert.equal(settingsResponse.status, 400);
    const settingsBody = await settingsResponse.json();
    assert.equal(settingsBody.ok, false);
    assert.equal(settingsBody.error, 'twoFactorEnabled must be a boolean');
    assert.equal(settingsBody.code, 'validation_failed');
    assert.equal(settingsBody.requestId, 'settings-test-id');
  });
});
