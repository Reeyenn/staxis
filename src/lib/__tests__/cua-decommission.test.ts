/**
 * Robot decommission (2026-07-25) — behavioural guards.
 *
 * The CUA robot (cua-service on Fly `staxis-cua`) is disabled, not deleted.
 * All the code is still in the tree and still compiles, so nothing about the
 * *shape* of the codebase tells you the robot is off — only behaviour does.
 * These tests pin that behaviour:
 *
 *   1. The switch itself is off. A deliberate tripwire, not a tautology: a
 *      future browser-automation product must make an explicit reviewed code
 *      change rather than drift back through deployment configuration.
 *   2. The three cua_* doctor checks report a plain "decommissioned" ok
 *      rather than failing the deploy gate or claiming to be watching a live
 *      robot. Same poisoned stub proves they query nothing either.
 *
 * The cua-service side (index.ts / session-supervisor.ts / workflow-runtime.ts
 * all refusing to start) is NOT covered here — that package has its own test
 * runner and is not part of `npm run test`.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  CUA_DECOMMISSIONED,
  CUA_DECOMMISSION_REASON,
  decommissionedCheck,
} from '@/lib/pms/decommission';
import { runAllChecks } from '@/app/api/admin/doctor/route';

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
    // Tripwire. If this fails, browser automation was reintroduced without
    // updating the retirement contract and its full product review.
    assert.equal(
      CUA_DECOMMISSIONED,
      true,
      'CUA_DECOMMISSIONED flipped — browser automation has no supported configuration-only re-enable path',
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

  test('states that configuration alone cannot turn it back on', () => {
    const verdict = decommissionedCheck('anything');
    assert.match(verdict.fix, /no supported configuration-only re-enable path/i);
    assert.match(verdict.fix, /product and architecture review/i);
    assert.doesNotMatch(verdict.fix, /fly deploy|schedule:|CUA_DECOMMISSIONED=false/i);
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
        /decommission|retir/i,
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
