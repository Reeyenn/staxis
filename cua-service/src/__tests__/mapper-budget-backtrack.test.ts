/**
 * Plan v10 mapper tuning — two scoped fixes (no Playwright, no Anthropic, no DB).
 *
 * FIX 1 (room-status loop): the nav-guidance prompt makes the agent return to
 * the dashboard and try a sibling link when a click lands on the wrong page —
 * the guidance that first found departures. But re-screenshotting the dashboard
 * each leg re-accumulates identical (screenshot, dashboard) tuples and trips the
 * action-loop detector, turning a healthy retry into a hard feed failure. The
 * fix resets the loop detector on each DELIBERATE return and caps the number of
 * returns. Pinned here via the pure pieces: isDashboardUrl (transition signal)
 * and DashboardReturnTracker (reset/cap state machine).
 *
 * FIX 2 (optional over-spend): optional feeds now get HALF the per-classification
 * cost + step budget; required feeds keep the full budget so a promotion-gating
 * feed can never be starved. Pinned via targetBudget.
 */

// MUST be first: WebSocket shim + env placeholders before mapper.ts's import
// graph (supabase/env/anthropic all construct at module load).
import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { targetBudget, scaleCostCapForModel, modelCostFactor, deriveFailureClass, isDashboardUrl, DashboardReturnTracker } from '../mapper.js';

const DASH = 'https://pms.example.com/dashboard';

// ── fix/cua-discovery-budget — model-aware DEFAULT cap scaling ───────────────
describe('scaleCostCapForModel — DEFAULT caps follow the run model', () => {
  test('an undefined model resolves to the DEFAULT (Opus 4.8 → ×2), NOT Sonnet ×1', () => {
    // The critical case: regenerate + auto-enqueue pass model=undefined. If this
    // resolved to factor 1.0 the job cap would stay at the Sonnet base and re-
    // introduce the mid-navigation kill.
    assert.equal(modelCostFactor(undefined), 2.0);
    assert.equal(scaleCostCapForModel(30_000_000, undefined), 60_000_000);
  });
  test('explicit models scale by their factor', () => {
    assert.equal(scaleCostCapForModel(30_000_000, 'claude-sonnet-4-6'), 30_000_000);
    assert.equal(scaleCostCapForModel(30_000_000, 'claude-opus-4-8'), 60_000_000);
    assert.equal(scaleCostCapForModel(30_000_000, 'claude-fable-5'), 90_000_000);
  });
  test('the recovery-drill base ($0.60) scales to $1.20 on Opus', () => {
    assert.equal(scaleCostCapForModel(600_000, 'claude-opus-4-8'), 1_200_000);
  });
  test('an infinite base is never scaled (no NaN)', () => {
    assert.equal(scaleCostCapForModel(Number.POSITIVE_INFINITY, 'claude-opus-4-8'), Number.POSITIVE_INFINITY);
  });
});

// ── fix/cua-discovery-budget — failure classification (budget vs findability) ─
describe('deriveFailureClass — budget vs findability vs …', () => {
  test('unavailable comes from STATUS only, never reason text', () => {
    assert.equal(deriveFailureClass('unavailable', 'loop detector tripped'), 'unavailable');
  });
  test('budget catches cost-cap AND token/wallclock budget reasons', () => {
    assert.equal(deriveFailureClass('failed', 'per-target cost cap exceeded for list_page ($1.20)'), 'budget');
    assert.equal(deriveFailureClass('failed', 'token budget exceeded'), 'budget');
    assert.equal(deriveFailureClass('failed', 'wallclock budget exceeded'), 'budget');
  });
  test('findability catches loop / dashboard / step / no-JSON / exhausted', () => {
    assert.equal(deriveFailureClass('failed', 'loop detector tripped'), 'findability');
    assert.equal(deriveFailureClass('failed', 'exhausted 5 dashboard returns without locating arrivals'), 'findability');
    assert.equal(deriveFailureClass('failed', 'mapper exhausted step budget'), 'findability');
    assert.equal(deriveFailureClass('failed', 'no usable JSON after recovery re-ask'), 'findability');
  });
  test('table-found-then-gave-up → partial; unmatched → other', () => {
    assert.equal(deriveFailureClass('failed', 'agent claimed unavailable after a table was already found (recovery fatigue)'), 'partial');
    assert.equal(deriveFailureClass('failed', 'something unexpected'), 'other');
  });
});

// ── FIX 2 — targetBudget ────────────────────────────────────────────────────
describe('targetBudget (FIX 2) — optional feeds get a tighter budget', () => {
  const CLASSES = ['list_page', 'report_menu', 'drilldown_sample'] as const;

  test('required feeds keep the FULL by-classification budget (Sonnet baseline)', () => {
    // Documented base caps, at the Sonnet 1.0 cost factor.
    assert.deepEqual(targetBudget('list_page', false, 'claude-sonnet-4-6'), { stepCap: 80, costCapMicros: 600_000 });
    assert.deepEqual(targetBudget('report_menu', false, 'claude-sonnet-4-6'), { stepCap: 100, costCapMicros: 1_200_000 });
    assert.deepEqual(targetBudget('drilldown_sample', false, 'claude-sonnet-4-6'), { stepCap: 60, costCapMicros: 1_440_000 });
  });

  // fix/cua-discovery-budget — Opus 4.8 costs ~2x/turn, so its COST cap scales 2x
  // (the STEP cap does not — turns ≠ dollars). This is what lets buried feeds
  // finish navigating instead of cost-capping mid-search.
  test('Opus scales the COST cap 2x (step cap unchanged)', () => {
    assert.deepEqual(targetBudget('list_page', false, 'claude-opus-4-8'), { stepCap: 80, costCapMicros: 1_200_000 });
    assert.deepEqual(targetBudget('report_menu', false, 'claude-opus-4-8'), { stepCap: 100, costCapMicros: 2_400_000 });
    assert.deepEqual(targetBudget('drilldown_sample', false, 'claude-opus-4-8'), { stepCap: 60, costCapMicros: 2_880_000 });
  });

  test('optional feeds get exactly half the cost cap (Sonnet baseline)', () => {
    assert.equal(targetBudget('list_page', true, 'claude-sonnet-4-6').costCapMicros, 300_000);
    assert.equal(targetBudget('report_menu', true, 'claude-sonnet-4-6').costCapMicros, 600_000);
    assert.equal(targetBudget('drilldown_sample', true, 'claude-sonnet-4-6').costCapMicros, 720_000);
  });

  test('optional feeds get half the step cap (floored)', () => {
    assert.equal(targetBudget('list_page', true).stepCap, 40);
    assert.equal(targetBudget('report_menu', true).stepCap, 50);
    assert.equal(targetBudget('drilldown_sample', true).stepCap, 30); // ×3 samples = 90 total
  });

  test('optional is ALWAYS strictly cheaper than required, never zero', () => {
    for (const c of CLASSES) {
      const req = targetBudget(c, false);
      const opt = targetBudget(c, true);
      assert.ok(opt.costCapMicros < req.costCapMicros, `${c}: optional cost < required`);
      assert.ok(opt.stepCap < req.stepCap, `${c}: optional steps < required`);
      assert.ok(opt.costCapMicros > 0, `${c}: optional cost > 0`);
      assert.ok(opt.stepCap > 0, `${c}: optional steps > 0`);
    }
  });

  test('unknown classification falls back to full caps and never produces NaN', () => {
    // Back-compat fallback path (full step cap, infinite cost cap). An infinite
    // cost cap must never be scaled to NaN — the soft-abort sites gate on
    // === Number.POSITIVE_INFINITY.
    const unknown = 'mystery_page' as unknown as 'list_page';
    const req = targetBudget(unknown, false);
    const opt = targetBudget(unknown, true);
    assert.equal(req.costCapMicros, Number.POSITIVE_INFINITY);
    assert.equal(opt.costCapMicros, Number.POSITIVE_INFINITY);
    assert.ok(!Number.isNaN(opt.costCapMicros));
    assert.ok(!Number.isNaN(opt.stepCap));
    assert.equal(req.stepCap, 80); // MAX_AGENT_STEPS_PER_ACTION fallback
  });
});

// ── FIX 1 — isDashboardUrl ──────────────────────────────────────────────────
describe('isDashboardUrl (FIX 1) — dashboard-return detection', () => {
  test('exact match is the dashboard', () => {
    assert.equal(isDashboardUrl(DASH, DASH), true);
  });

  test('trailing slash, query, and hash are ignored', () => {
    assert.equal(isDashboardUrl(DASH + '/', DASH), true);
    assert.equal(isDashboardUrl(DASH + '?t=12345', DASH), true); // cache-buster
    assert.equal(isDashboardUrl(DASH + '#top', DASH), true);
    assert.equal(isDashboardUrl(DASH + '/?x=1#y', DASH), true);
  });

  test('a different path is NOT the dashboard (the feed/wrong page)', () => {
    assert.equal(isDashboardUrl('https://pms.example.com/reports/departures', DASH), false);
    assert.equal(isDashboardUrl('https://pms.example.com/dashboard/sub', DASH), false);
  });

  test('a different origin is NOT the dashboard', () => {
    assert.equal(isDashboardUrl('https://evil.example.com/dashboard', DASH), false);
    assert.equal(isDashboardUrl('http://pms.example.com/dashboard', DASH), false); // scheme differs
  });

  test('malformed / empty URL → false (safe degrade, never throws)', () => {
    assert.equal(isDashboardUrl('', DASH), false);
    assert.equal(isDashboardUrl('not a url', DASH), false);
    assert.equal(isDashboardUrl(DASH, 'also not a url'), false);
  });
});

// ── FIX 1 — DashboardReturnTracker state machine ────────────────────────────
describe('DashboardReturnTracker (FIX 1) — reset on return, cap the bounce', () => {
  const FEED = 'https://pms.example.com/reports/departures';

  test('sitting on the dashboard in-place is NOT a return (no reset — loop detector still trips)', () => {
    const t = new DashboardReturnTracker(DASH);
    // Starts on the dashboard; never leaves. No transition INTO the dashboard.
    assert.equal(t.onTurn(DASH), 'none');
    assert.equal(t.onTurn(DASH), 'none');
    assert.equal(t.onTurn(DASH), 'none');
    assert.equal(t.count, 0);
  });

  test('each leave-then-return is a single reset', () => {
    const t = new DashboardReturnTracker(DASH);
    assert.equal(t.onTurn(DASH), 'none');   // start on dashboard
    assert.equal(t.onTurn(FEED), 'none');   // clicked a link → left
    assert.equal(t.onTurn(DASH), 'reset');  // clicked Home → return #1
    assert.equal(t.count, 1);
    assert.equal(t.onTurn(DASH), 'none');   // still on dashboard, not a new return
    assert.equal(t.onTurn(FEED), 'none');   // left again
    assert.equal(t.onTurn(DASH), 'reset');  // return #2
    assert.equal(t.count, 2);
  });

  test('caps after MAX_DASHBOARD_RETURNS (default 5); 6th return → cap', () => {
    const t = new DashboardReturnTracker(DASH);
    // 5 deliberate returns all reset; the 6th caps.
    for (let i = 1; i <= 5; i++) {
      assert.equal(t.onTurn(FEED), 'none', `leave before return ${i}`);
      assert.equal(t.onTurn(DASH), 'reset', `return ${i} resets`);
    }
    assert.equal(t.count, 5);
    assert.equal(t.onTurn(FEED), 'none');
    assert.equal(t.onTurn(DASH), 'cap'); // return #6 — give up gracefully
    assert.equal(t.count, 6);
  });

  test('a tighter explicit cap is honored', () => {
    const t = new DashboardReturnTracker(DASH, 2);
    assert.equal(t.onTurn(FEED), 'none');
    assert.equal(t.onTurn(DASH), 'reset'); // #1
    assert.equal(t.onTurn(FEED), 'none');
    assert.equal(t.onTurn(DASH), 'reset'); // #2
    assert.equal(t.onTurn(FEED), 'none');
    assert.equal(t.onTurn(DASH), 'cap');   // #3 > 2
  });

  test('a closed-page empty URL is treated as off-dashboard (safe degrade)', () => {
    const t = new DashboardReturnTracker(DASH);
    assert.equal(t.onTurn(''), 'none');     // off-dashboard
    assert.equal(t.onTurn(DASH), 'reset');  // recovered → counts as a return
    assert.equal(t.count, 1);
  });
});
