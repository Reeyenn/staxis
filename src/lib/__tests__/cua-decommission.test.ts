/**
 * Robot decommission (2026-07-25) — behavioural guards.
 *
 * The CUA robot (cua-service on Fly `staxis-cua`) is disabled, not deleted.
 * All the code is still in the tree and still compiles, so nothing about the
 * *shape* of the codebase tells you the robot is off — only behaviour does.
 * These tests pin that behaviour:
 *
 *   1. The switch itself is on. A deliberate tripwire, not a tautology: the
 *      only way to re-arm the robot is to edit this test too, which forces
 *      whoever does it to read the checklist in cua-service/README.md.
 *   2. The pull-enqueue cron route enqueues NOTHING — and, more strongly,
 *      never so much as reads the properties table. If it queried, the
 *      poisoned supabaseAdmin stub below would make it throw.
 *   3. The three cua_* doctor checks report a plain "decommissioned" ok
 *      rather than failing the deploy gate or claiming to be watching a live
 *      robot. Same poisoned stub proves they query nothing either.
 *
 * The cua-service side (index.ts / session-supervisor.ts / workflow-runtime.ts
 * all refusing to start) is NOT covered here — that package has its own test
 * runner and is not part of `npm run test`.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  CUA_DECOMMISSIONED,
  CUA_DECOMMISSION_REASON,
  decommissionedCheck,
} from '@/lib/pms/decommission';
import { GET as enqueuePropertyPulls } from '@/app/api/cron/enqueue-property-pulls/route';
import { runAllChecks } from '@/app/api/admin/doctor/route';

const CRON_SECRET = process.env.CRON_SECRET ?? 'placeholder-cron-secret-min-16';

// ─── Poisoned Supabase stub ──────────────────────────────────────────────
// Every database entry point throws. Any code path that tries to talk to
// Postgres therefore cannot quietly "succeed with zero rows" — it blows up
// and the assertion below catches it. This is what makes "queries nothing"
// a real assertion rather than a hopeful comment.

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
let dbTouches: string[] = [];

function poisonDb(): void {
  (supabaseAdmin as unknown as { from: unknown }).from = (table: string) => {
    dbTouches.push(`from(${table})`);
    throw new Error(`decommission test: unexpected DB read from(${table})`);
  };
  (supabaseAdmin as unknown as { rpc: unknown }).rpc = (fn: string) => {
    dbTouches.push(`rpc(${fn})`);
    throw new Error(`decommission test: unexpected DB read rpc(${fn})`);
  };
}

function restoreDb(): void {
  (supabaseAdmin as unknown as { from: unknown }).from = originalFrom;
  (supabaseAdmin as unknown as { rpc: unknown }).rpc = originalRpc;
}

describe('CUA decommission — the switch', () => {
  test('the robot is decommissioned', () => {
    // Tripwire. If you are here because this failed, you re-armed the PMS
    // robot. That is allowed — but do the whole checklist in
    // cua-service/README.md (web-app flag, fly.toml + deploy, the cron
    // workflow schedule) rather than only the one line that made this pass.
    assert.equal(
      CUA_DECOMMISSIONED,
      true,
      'CUA_DECOMMISSIONED flipped — see the re-arm checklist in cua-service/README.md',
    );
  });
});

describe('CUA decommission — health-check verdict', () => {
  test('reports ok, not fail/warn/skipped', () => {
    // ok is the honest answer: the robot being off is the intended state.
    // fail would 503 the deploy gate forever; warn would train everyone to
    // ignore doctor warnings; skipped reads as "could not check".
    const verdict = decommissionedCheck('24/7 PMS session heartbeats');
    assert.equal(verdict.status, 'ok');
  });

  test('names what is no longer watched, and why', () => {
    const verdict = decommissionedCheck('the $5/hotel/day Claude cost cap');
    assert.match(verdict.detail, /not monitored/i);
    assert.match(verdict.detail, /\$5\/hotel\/day Claude cost cap/);
    assert.ok(
      verdict.detail.includes(CUA_DECOMMISSION_REASON),
      'verdict should carry the shared reason string so every surface says the same thing',
    );
  });

  test('tells the operator how to turn it back on', () => {
    const verdict = decommissionedCheck('anything');
    assert.match(verdict.fix, /CUA_DECOMMISSIONED/);
    assert.match(verdict.fix, /README/);
  });
});

describe('/api/cron/enqueue-property-pulls — dormant while decommissioned', () => {
  before(() => {
    dbTouches = [];
    poisonDb();
  });
  after(restoreDb);

  test('enqueues nothing and never reads the database', async () => {
    const res = await enqueuePropertyPulls(
      new NextRequest('https://example.test/api/cron/enqueue-property-pulls', {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { decommissioned?: boolean; enqueued: number; totalProperties: number };
    };

    // ok:true on purpose — a manual workflow_dispatch greps for "ok":true,
    // and "did nothing, deliberately" is a success, not an incident.
    assert.equal(body.ok, true);
    assert.equal(body.data.decommissioned, true);
    assert.equal(body.data.enqueued, 0);
    assert.equal(body.data.totalProperties, 0);
    assert.deepEqual(
      dbTouches,
      [],
      `route touched the database while decommissioned: ${dbTouches.join(', ')}`,
    );
  });

  test('still refuses callers without the cron secret', async () => {
    // The decommission guard sits AFTER auth — turning the robot off must not
    // turn this into an open endpoint that reports fleet state to anyone.
    const res = await enqueuePropertyPulls(
      new NextRequest('https://example.test/api/cron/enqueue-property-pulls', {
        headers: { authorization: 'Bearer not-the-secret' },
      }),
    );
    assert.notEqual(res.status, 200);
  });
});

describe('/api/admin/doctor — cua_* checks are honest about the decommission', () => {
  before(() => {
    dbTouches = [];
    poisonDb();
  });
  after(restoreDb);

  test('all three report ok with a decommissioned detail, querying nothing', async () => {
    // useCache=false so we exercise the checks rather than a warm 60s cache.
    const report = await runAllChecks(false);

    for (const name of ['cua_sessions_alive', 'cua_cost_cap_paused', 'cua_mfa_pending']) {
      const check = report.checks.find((c) => c.name === name);
      assert.ok(check, `${name} should still be registered (dormant, not deleted)`);
      assert.equal(
        check.status,
        'ok',
        `${name} returned ${check.status} — a decommissioned robot must not fail the deploy gate`,
      );
      assert.match(
        check.detail,
        /decommission/i,
        `${name} must say it is decommissioned, not imply it is watching a live robot`,
      );
    }

    // If any of the three had actually queried property_sessions, the
    // poisoned stub would have recorded it here.
    assert.equal(
      dbTouches.filter((t) => t.includes('property_sessions')).length,
      0,
      'a decommissioned check must not query property_sessions',
    );
  });
});
