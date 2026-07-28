import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import type { NextRequest } from 'next/server';

import { GET } from '@/app/api/cron/run-management-patterns/route';

function request(query = '', secret = process.env.CRON_SECRET ?? ''): NextRequest {
  return new Request(`https://staxis.test/api/cron/run-management-patterns${query}`, {
    headers: { authorization: `Bearer ${secret}` },
  }) as unknown as NextRequest;
}

describe('management-pattern shadow route boundary', () => {
  for (const parameter of ['active=true', 'projection=true', 'projectionMode=active']) {
    test(`rejects caller-controlled ${parameter} before organization discovery`, async () => {
      const response = await GET(request(`?${parameter}`));
      assert.equal(response.status, 400);
      const body = await response.json() as { error?: string };
      assert.match(body.error ?? '', /projection cannot be selected/i);
    });
  }

  test('is deliberately absent from the production cron schedule during shadow validation', () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
      crons?: Array<{ path?: string }>;
    };
    assert.equal(
      (config.crons ?? []).some((cron) => cron.path === '/api/cron/run-management-patterns'),
      false,
    );
  });

  test('source contains no active projection invocation', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'app', 'api', 'cron', 'run-management-patterns', 'route.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /projectManagementPattern|projectActiveRun|project_management_pattern_run/);
    assert.match(source, /projectionMode:\s*'shadow'/);
  });
});
