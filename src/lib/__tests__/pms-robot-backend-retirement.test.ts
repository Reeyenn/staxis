import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { NextRequest } from 'next/server';

import { POST as receiveInboundMail } from '@/app/api/pms-inbox/inbound/route';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { PMS_ROBOT_ENABLED } from '@/lib/pms/robot-status';

const root = process.cwd();
const source = (path: string): string => readFileSync(join(root, path), 'utf8');

describe('retired PMS robot — surviving report-era contract', () => {
  test('the compile-time product switch is off', () => {
    assert.equal(PMS_ROBOT_ENABLED, false);
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
