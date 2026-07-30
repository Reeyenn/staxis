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

describe('management-pattern scheduled route boundary', () => {
  for (const parameter of ['active=true', 'projection=true', 'projectionMode=active']) {
    test(`rejects caller-controlled ${parameter} before organization discovery`, async () => {
      const response = await GET(request(`?${parameter}`));
      assert.equal(response.status, 400);
      const body = await response.json() as { error?: string };
      assert.match(body.error ?? '', /projection cannot be selected/i);
    });
  }

  test('is unscheduled, because the AI layer goes on in one act', () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };
    assert.equal(
      (config.crons ?? []).find((cron) => cron.path === '/api/cron/run-management-patterns'),
      undefined,
      'This route was scheduled on 2026-07-29 and parked again the same day on the '
      + "owner's ruling: the whole AI layer stays off behind one master switch, and the "
      + 'only management company in production today is the seeded demo one. Do not '
      + 'schedule it on its own — docs/cron-triggers.md, "The AI master switch", turns '
      + 'this cron on together with run-findings, findings-sweep and findings-janitor.',
    );
  });

  test('updates the live legacy queue while keeping v2 projection shadow-only', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'app', 'api', 'cron', 'run-management-patterns', 'route.ts'),
      'utf8',
    );
    assert.doesNotMatch(source, /projectManagementPattern|projectActiveRun|project_management_pattern_run/);
    assert.match(source, /runPortfolioChecks\(\{ organizationId \}\)/);
    assert.match(source, /managementPatternProjectionMode:\s*'shadow'/);
    assert.match(source, /writeCronHeartbeat\('run-management-patterns'/);
    assert.match(source, /if \(failed\.length > 0\)[\s\S]*?return err\([\s\S]*?writeCronHeartbeat/);
  });
});
