import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { NextRequest } from 'next/server';

import { POST as receiveInboundMail } from '@/app/api/pms-inbox/inbound/route';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { PMS_ROBOT_ENABLED } from '@/lib/pms/robot-status';

const root = process.cwd();
const source = (path: string): string => readFileSync(join(root, path), 'utf8');

function routeFilesUnder(path: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === 'route.ts') out.push(relative(root, full));
    }
  };
  walk(join(root, path));
  return out.sort();
}

function assertAuthenticatedRobotGuard(path: string): void {
  const text = source(path);
  const handlers = text
    .split(/(?=export async function (?:GET|POST|PATCH|DELETE)\b)/)
    .filter((part) => /^export async function (?:GET|POST|PATCH|DELETE)\b/.test(part));
  assert.ok(handlers.length > 0, `${path} should contain an API handler`);

  for (const handler of handlers) {
    const name = /export async function (GET|POST|PATCH|DELETE)/.exec(handler)?.[1] ?? 'handler';
    const authAt = handler.search(/await require(?:Admin|AdminOrCron|Session)\s*\(/);
    const guardAt = handler.indexOf('robotDecommissionedResponse(requestId)');
    assert.ok(authAt >= 0, `${path} ${name} must authenticate`);
    assert.ok(
      guardAt > authAt,
      `${path} ${name} must refuse through robotDecommissionedResponse immediately after auth`,
    );
  }
}

describe('retired PMS robot — backend route ratchet', () => {
  test('the compile-time product switch is off', () => {
    assert.equal(PMS_ROBOT_ENABLED, false);
  });

  test('every mapper, takeover, live-map, and coverage handler is authenticated then guarded', () => {
    const paths = [
      ...routeFilesUnder('src/app/api/admin/mapper'),
      ...routeFilesUnder('src/app/api/admin/live-mapper'),
      ...routeFilesUnder('src/app/api/admin/coverage'),
    ];
    for (const path of paths) assertAuthenticatedRobotGuard(path);
  });

  test('credential, session, onboarding, MFA, and robot-state routes are guarded', () => {
    const paths = [
      'src/app/api/pms/save-credentials/route.ts',
      'src/app/api/pms/onboard/route.ts',
      'src/app/api/pms/job-status/route.ts',
      'src/app/api/admin/cua-sessions/route.ts',
      'src/app/api/admin/heartbeat/route.ts',
      'src/app/api/admin/onboarding-jobs/route.ts',
      'src/app/api/admin/pms-auth-code/route.ts',
      'src/app/api/admin/pms-coverage/route.ts',
      'src/app/api/admin/pms-inbox/route.ts',
      'src/app/api/admin/mission/inbox/route.ts',
      'src/app/api/admin/regenerate-recipe/route.ts',
    ];
    for (const path of paths) assertAuthenticatedRobotGuard(path);
  });

  test('robot-only crons authenticate before returning a disabled no-op', () => {
    for (const path of [
      'src/app/api/cron/enqueue-property-pulls/route.ts',
      'src/app/api/cron/pms-backfill-missing-feeds/route.ts',
      'src/app/api/cron/expire-help-requests/route.ts',
    ]) {
      const text = source(path);
      const authAt = text.indexOf('requireCronSecret(req)');
      const guardAt = text.search(/if \(CUA_DECOMMISSIONED\)/);
      assert.ok(authAt >= 0 && guardAt > authAt, `${path} must authenticate before its no-op`);
      const guardBody = text.slice(guardAt, text.indexOf('\n  }', guardAt));
      assert.doesNotMatch(guardBody, /(?:supabaseAdmin|writeCronHeartbeat)/, `${path} no-op must not touch the database`);
    }
  });
});

describe('retired PMS robot — mixed report-era paths', () => {
  test('auth-code mail is dropped after courier auth without touching the database', async () => {
    const priorSecret = process.env.PMS_INBOX_WEBHOOK_SECRET;
    const priorDomain = process.env.PMS_INBOX_DOMAIN;
    process.env.PMS_INBOX_WEBHOOK_SECRET = 'robot-retirement-test-secret';
    process.env.PMS_INBOX_DOMAIN = 'getstaxis.com';

    const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
    const dbTouches: string[] = [];
    (supabaseAdmin as unknown as { from: unknown }).from = (table: string) => {
      dbTouches.push(table);
      throw new Error(`unexpected database access: ${table}`);
    };

    try {
      const res = await receiveInboundMail(new NextRequest('https://example.test/api/pms-inbox/inbound', {
        method: 'POST',
        headers: { authorization: 'Bearer robot-retirement-test-secret' },
        body: JSON.stringify({
          to: 'hotel@getstaxis.com',
          from: 'no-reply@okta.com',
          subject: 'Your code',
          text: '123456',
          ts: Date.now(),
        }),
      }));

      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; data: { stored: boolean; reason: string } };
      assert.equal(body.ok, true);
      assert.deepEqual(body.data, { stored: false, reason: 'robot_retired' });
      assert.deepEqual(dbTouches, []);
    } finally {
      (supabaseAdmin as unknown as { from: unknown }).from = originalFrom;
      if (priorSecret === undefined) delete process.env.PMS_INBOX_WEBHOOK_SECRET;
      else process.env.PMS_INBOX_WEBHOOK_SECRET = priorSecret;
      if (priorDomain === undefined) delete process.env.PMS_INBOX_DOMAIN;
      else process.env.PMS_INBOX_DOMAIN = priorDomain;
    }
  });

  test('the report recipient branch remains ahead of the retired auth-code no-op', () => {
    const text = source('src/app/api/pms-inbox/inbound/route.ts');
    const reportAt = text.indexOf("if (recipient.kind === 'report')");
    const retiredAt = text.indexOf('if (!PMS_ROBOT_ENABLED)', reportAt);
    const authCodeAt = text.indexOf('return handleAuthCode', retiredAt);
    assert.ok(reportAt >= 0 && retiredAt > reportAt && authCodeAt > retiredAt);
  });

  test('report feed, attachment, and retention endpoints are not globally robot-guarded', () => {
    for (const path of [
      'src/app/api/pms/feed-status/route.ts',
      'src/app/api/pms-inbox/attachment-commit/route.ts',
      'src/app/api/pms-inbox/inbound/route.ts',
      'src/app/api/cron/pms-auth-codes-purge/route.ts',
    ]) {
      assert.doesNotMatch(source(path), /robotDecommissionedResponse\s*\(/, path);
    }
  });

  test('manual room state remains writable but robot write-back enqueue is gated', () => {
    const text = source('src/lib/pms-rooms-writes.ts');
    const gateAt = text.indexOf('if (PMS_ROBOT_ENABLED)');
    const writebackReadAt = text.indexOf(".select('pms_writeback_enabled')");
    const enqueueAt = text.indexOf("supabaseAdmin.rpc('staxis_enqueue_pms_write'");
    assert.ok(gateAt >= 0 && writebackReadAt > gateAt && enqueueAt > writebackReadAt);
    assert.match(text, /p_allow_enqueue:\s*allowEnqueue/);
  });

  test('mixed Admin routes cannot fail because stale robot tables are unavailable', () => {
    const checks: Array<[string, string]> = [
      ['src/app/api/admin/list-properties/route.ts', ".from('property_sessions')"],
      ['src/app/api/admin/property-health/route.ts', ".from('scraper_credentials')"],
      ['src/app/api/admin/overview-stats/route.ts', ".from('property_sessions')"],
      ['src/app/api/admin/system-status/route.ts', ".from('onboarding_jobs')"],
    ];
    for (const [path, marker] of checks) {
      const text = source(path);
      const gateAt = text.search(/if \(!?PMS_ROBOT_ENABLED\)/);
      const markerAt = text.indexOf(marker);
      assert.ok(gateAt >= 0 && markerAt > gateAt, `${path} must gate ${marker}`);
    }
  });
});
