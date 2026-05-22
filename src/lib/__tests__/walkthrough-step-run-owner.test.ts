/**
 * Tests checkRunOwnership — the run-owner gate added in the 2026-05-22
 * audit (Codex [HIGH] finding).
 *
 * Background: staxis_walkthrough_step verifies (run_id, property_id) but
 * NOT (user_id). Without a route-layer ownership check, any authenticated
 * user on the same property who learns another user's runId could
 * advance that run, consume its 12-step cap, and pull the narration to
 * their own screen.
 *
 * The route now:
 *   1. SELECTs walkthrough_runs by id, gets {user_id}
 *   2. Calls checkRunOwnership(runRow, sessionAccountId) — this helper
 *   3. Bails out on non-ok before the step RPC ever runs
 *
 * This test pins the helper. A regression that allows mismatched owners
 * to pass through surfaces here at PR time.
 *
 * Run via: npx tsx --test src/lib/__tests__/walkthrough-step-run-owner.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkRunOwnership } from '../../app/api/walkthrough/step/route';

const ACCOUNT_SELF = '00000000-0000-0000-0000-000000000010';
const ACCOUNT_OTHER = '00000000-0000-0000-0000-000000000020';

describe('checkRunOwnership — happy path', () => {
  test('returns ok when run.user_id matches the session account', () => {
    const out = checkRunOwnership({ user_id: ACCOUNT_SELF }, ACCOUNT_SELF);
    assert.deepEqual(out, { ok: true });
  });
});

describe('checkRunOwnership — rejection paths', () => {
  test('returns 404 not_found when the run row is missing', () => {
    const out = checkRunOwnership(null, ACCOUNT_SELF);
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.status, 404);
      assert.equal(out.code, 'not_found');
    }
  });

  test('returns 404 not_found when the run row is undefined', () => {
    const out = checkRunOwnership(undefined, ACCOUNT_SELF);
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.status, 404);
    }
  });

  test('returns 403 forbidden when user_id mismatches the session account', () => {
    // This is the actual same-tenant hijack that the audit closed.
    // Without this 403 branch, the route would proceed to the step RPC
    // and the foreign user would consume someone else's walkthrough.
    const out = checkRunOwnership({ user_id: ACCOUNT_OTHER }, ACCOUNT_SELF);
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.status, 403);
      assert.equal(out.code, 'forbidden');
    }
  });

  test('does NOT special-case any "magic" sessionAccountId — strict equality only', () => {
    // Guard against a refactor that adds an admin/superuser bypass and
    // accidentally loosens the gate. Strict triple-equals is the only
    // way ownership can match — no near-misses.
    assert.equal(checkRunOwnership({ user_id: '' }, ACCOUNT_SELF).ok, false);
    assert.equal(checkRunOwnership({ user_id: ACCOUNT_SELF + ' ' }, ACCOUNT_SELF).ok, false);
    // Hex letter case sensitivity matters because PostgreSQL stores
    // UUIDs canonically lower-case but a client could send upper.
    const withHex = 'aabbccdd-1111-2222-3333-444455556666';
    assert.equal(checkRunOwnership({ user_id: withHex.toUpperCase() }, withHex).ok, false);
  });
});
