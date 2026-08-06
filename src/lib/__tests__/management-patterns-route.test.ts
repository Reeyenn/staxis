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

  test('is scheduled with the rest of the layer, never on its own', () => {
    // This route was scheduled on 2026-07-29 and parked again the same day on
    // the owner's ruling. It went on for real on 2026-08-06 with its three
    // siblings, and this case flipped with it: what it guards is not "off", it
    // is "never alone". The 2026-07-29 failure was a single cron running paid
    // model passes over the seeded demo company, and one route scheduled by
    // itself is exactly what that looked like.
    const config = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };
    const scheduled = new Set((config.crons ?? []).map((cron) => cron.path));
    for (const path of [
      '/api/cron/run-management-patterns',
      '/api/cron/run-findings',
      '/api/cron/findings-sweep',
      '/api/cron/findings-janitor',
    ]) {
      assert.ok(
        scheduled.has(path),
        `${path} is not scheduled. The AI layer moves in one act: see `
        + 'docs/cron-triggers.md, "The AI master switch". Turning one of the four off '
        + 'means turning all four off.',
      );
    }
  });

  test('still excludes a company whose whole portfolio is a test hotel', () => {
    // The exclusion that makes it SAFE to schedule at all, and the thing the
    // switch must not have quietly loosened. Scheduled discovery goes through
    // the demo-portfolio filter; only an explicit organizationId can reach one.
    const source = readFileSync(
      join(process.cwd(), 'src', 'app', 'api', 'cron', 'run-management-patterns', 'route.ts'),
      'utf8',
    );
    assert.match(source, /import \{ isDemoOnlyOrganization \} from '@\/lib\/company\/demo-portfolio'/);
    assert.match(source, /demo: await isDemoOnlyOrganization\(/);
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
