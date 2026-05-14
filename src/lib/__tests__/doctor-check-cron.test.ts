/**
 * Tests for decideDoctorCheckAlert in
 * src/app/api/cron/doctor-check/route.ts — the pure function that
 * decides whether the hourly health watchdog should fire a Sentry
 * alert and what payload to include.
 *
 * Round 13, 2026-05-13. Built after the silent ANTHROPIC_API_KEY
 * outage to make sure ANY failing doctor check buzzes Reeyen's phone
 * within the hour. The decision logic is pulled out of the route
 * handler so we can test it without spinning up next/server or the
 * full DoctorReport shape.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideDoctorCheckAlert,
  type DoctorCheckSummary,
} from '@/app/api/cron/doctor-check/route';

function makeReport(
  checks: DoctorCheckSummary['checks'],
  overrides?: Partial<DoctorCheckSummary>,
): DoctorCheckSummary {
  return {
    ok: checks.every(c => c.status === 'ok' || c.status === 'skipped'),
    commitSha: 'abc1234',
    vercelEnv: 'production',
    checks,
    ...overrides,
  };
}

describe('decideDoctorCheckAlert', () => {
  it('returns shouldAlert=false when every check passes', () => {
    const report = makeReport([
      { name: 'env_vars', status: 'ok', detail: 'all set' },
      { name: 'cron_heartbeats', status: 'ok', detail: 'all fresh' },
    ]);
    const decision = decideDoctorCheckAlert(report);
    assert.equal(decision.shouldAlert, false);
    assert.equal(decision.failCount, 0);
    assert.equal(decision.warnCount, 0);
    assert.deepEqual(decision.failingChecks, []);
    assert.equal(decision.message, undefined);
  });

  it('returns shouldAlert=false when only warnings are present', () => {
    const report = makeReport([
      { name: 'env_vars', status: 'ok', detail: 'all set' },
      { name: 'cron_heartbeats', status: 'warn', detail: '1 stale heartbeat' },
    ]);
    const decision = decideDoctorCheckAlert(report);
    assert.equal(decision.shouldAlert, false);
    assert.equal(decision.failCount, 0);
    assert.equal(decision.warnCount, 1);
    assert.deepEqual(decision.failingChecks, []);
    assert.equal(decision.message, undefined);
  });

  it('alerts on a single failing check with singular message', () => {
    const report = makeReport([
      { name: 'env_vars', status: 'ok', detail: 'all set' },
      {
        name: 'cron_heartbeats',
        status: 'fail',
        detail: 'doctor-check stale by 3h',
        fix: 'check vercel cron logs',
      },
    ]);
    const decision = decideDoctorCheckAlert(report);
    assert.equal(decision.shouldAlert, true);
    assert.equal(decision.failCount, 1);
    assert.equal(decision.warnCount, 0);
    assert.equal(decision.message, 'doctor: 1 check failing');
    assert.deepEqual(decision.failingChecks, [
      {
        name: 'cron_heartbeats',
        detail: 'doctor-check stale by 3h',
        fix: 'check vercel cron logs',
      },
    ]);
  });

  it('alerts on multiple failing checks with plural message', () => {
    const report = makeReport([
      {
        name: 'env_vars',
        status: 'fail',
        detail: 'ANTHROPIC_API_KEY missing',
        fix: 'set in Vercel',
      },
      {
        name: 'rpc_health',
        status: 'fail',
        detail: 'reservation RPC errored',
      },
      { name: 'cron_heartbeats', status: 'warn', detail: 'minor staleness' },
      { name: 'manager_phone_shape', status: 'ok', detail: 'E.164 ok' },
    ]);
    const decision = decideDoctorCheckAlert(report);
    assert.equal(decision.shouldAlert, true);
    assert.equal(decision.failCount, 2);
    assert.equal(decision.warnCount, 1);
    assert.equal(decision.message, 'doctor: 2 checks failing');
    assert.deepEqual(
      decision.failingChecks.map(c => c.name),
      ['env_vars', 'rpc_health'],
    );
    // fix is optional — make sure undefined is preserved, not dropped.
    assert.equal(decision.failingChecks[1].fix, undefined);
  });

  it('skipped checks never count as failures', () => {
    const report = makeReport([
      { name: 'env_vars', status: 'ok', detail: 'all set' },
      { name: 'sentry_test', status: 'skipped', detail: 'no DSN in dev' },
    ]);
    const decision = decideDoctorCheckAlert(report);
    assert.equal(decision.shouldAlert, false);
    assert.equal(decision.failCount, 0);
    assert.equal(decision.warnCount, 0);
  });

  it('only fail-status checks land in failingChecks (warn does not leak)', () => {
    const report = makeReport([
      { name: 'a', status: 'warn', detail: 'just a warn' },
      { name: 'b', status: 'fail', detail: 'the real problem' },
      { name: 'c', status: 'warn', detail: 'another warn' },
    ]);
    const decision = decideDoctorCheckAlert(report);
    assert.equal(decision.failingChecks.length, 1);
    assert.equal(decision.failingChecks[0].name, 'b');
    assert.equal(decision.warnCount, 2);
  });
});
