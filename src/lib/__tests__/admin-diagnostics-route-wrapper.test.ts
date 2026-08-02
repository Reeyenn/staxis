/**
 * Contract + runtime coverage for the static admin diagnostic/observability
 * wrapper batch. Runtime calls stop at admin auth or route validation so they
 * do not reach production data stores or audit side effects.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { NextRequest } from 'next/server';

import { GET as getActivity } from '@/app/api/admin/activity/route';
import { GET as getAuditLog } from '@/app/api/admin/audit-log/route';
import { GET as getOverviewStats } from '@/app/api/admin/overview-stats/route';
import { GET as getRecentErrors } from '@/app/api/admin/recent-errors/route';
import { GET as getMlHealth } from '@/app/api/admin/ml-health/route';
import { GET as getFeedback, PATCH as patchFeedback } from '@/app/api/admin/feedback/route';
import { supabaseAdmin } from '@/lib/supabase-admin';

const BATCH = [
  'src/app/api/admin/activity/route.ts',
  'src/app/api/admin/audit-log/route.ts',
  'src/app/api/admin/overview-stats/route.ts',
  'src/app/api/admin/recent-errors/route.ts',
  'src/app/api/admin/ml-health/route.ts',
  'src/app/api/admin/feedback/route.ts',
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

describe('static admin diagnostic/observability wrapper batch', () => {
  test('every converted route uses the shared wrapper and keeps static metadata', async () => {
    for (const path of BATCH) {
      const source = await readFile(path, 'utf8');
      assert.match(source, /import \{ defineRoute, adminGate \} from ['"]@\/lib\/api-route['"]/);
      assert.doesNotMatch(source, /requireAdmin|getOrMintRequestId/);
      assert.match(source, /export const runtime = ['"]nodejs['"]/);
      assert.match(source, /export const dynamic = ['"]force-dynamic['"]/);
    }
  });

  test('every converted method preserves the unauthorized admin short-circuit', async () => {
    const responses = await Promise.all([
      getActivity(request('https://staxis.test/api/admin/activity')),
      getAuditLog(request('https://staxis.test/api/admin/audit-log?propertyId=invalid')),
      getOverviewStats(request('https://staxis.test/api/admin/overview-stats')),
      getRecentErrors(request('https://staxis.test/api/admin/recent-errors')),
      getMlHealth(request('https://staxis.test/api/admin/ml-health')),
      getFeedback(request('https://staxis.test/api/admin/feedback')),
      patchFeedback(request('https://staxis.test/api/admin/feedback', {
        method: 'PATCH',
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

  test('authorized validation seams preserve status, error envelopes, and request IDs', async () => {
    authorizeAdmin();

    const auditResponse = await getAuditLog(request(
      'https://staxis.test/api/admin/audit-log?propertyId=invalid',
      { authorization: 'Bearer test-token', requestId: 'audit-test-id' },
    ));
    assert.equal(auditResponse.status, 400);
    const auditBody = await auditResponse.json();
    assert.equal(auditBody.ok, false);
    assert.equal(auditBody.code, 'validation_failed');
    assert.equal(auditBody.requestId, 'audit-test-id');

    const mlResponse = await getMlHealth(request(
      'https://staxis.test/api/admin/ml-health',
      { authorization: 'Bearer test-token', requestId: 'ml-test-id' },
    ));
    assert.equal(mlResponse.status, 400);
    const mlBody = await mlResponse.json();
    assert.equal(mlBody.ok, false);
    assert.equal(mlBody.code, 'validation_failed');
    assert.equal(mlBody.requestId, 'ml-test-id');

    const feedbackResponse = await patchFeedback(request(
      'https://staxis.test/api/admin/feedback',
      { authorization: 'Bearer test-token', requestId: 'feedback-test-id', method: 'PATCH', body: '{}' },
    ));
    assert.equal(feedbackResponse.status, 400);
    const feedbackBody = await feedbackResponse.json();
    assert.equal(feedbackBody.ok, false);
    assert.equal(feedbackBody.error, 'id is required');
    assert.equal(feedbackBody.requestId, 'feedback-test-id');
  });
});
