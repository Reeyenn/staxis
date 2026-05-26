/**
 * Unit tests for the pure forecast helpers.
 *
 * These lock in the rules that the ForecastView relies on:
 *   - Gap classification at the green/yellow/red boundaries — off-by-one
 *     here flips a "fully staffed" day to red overnight.
 *   - Honesty label resolution at the 30-day boundary — drift here
 *     would let the UI claim "AI prediction" with only a week of data.
 *   - Cleaning-minute math agreement with ScheduleTab.tsx's formula.
 *   - Range expansion + date arithmetic stability across DST.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HISTORY_THRESHOLD_DAYS,
  DEFAULT_HOURLY_WAGE_CENTS,
  DEFAULT_SHIFT_MINUTES,
  addDays,
  canViewForecast,
  classifyGap,
  expandRange,
  projectLaborCents,
  recommendedHeadcount,
  resolveAccuracyLabel,
  summarizeRange,
  totalCleaningMinutes,
  type DaySummary,
} from '@/lib/forecast';

// ─────────────────────────────────────────────────────────────────────
// Range expansion
// ─────────────────────────────────────────────────────────────────────

describe('expandRange', () => {
  it('today → exactly one day, the anchor', () => {
    assert.deepEqual(expandRange('2026-05-26', 'today'), ['2026-05-26']);
  });

  it('week → 7 days starting at anchor (NOT Monday-aligned)', () => {
    const got = expandRange('2026-05-26', 'week');
    assert.equal(got.length, 7);
    assert.equal(got[0], '2026-05-26');
    assert.equal(got[6], '2026-06-01');
  });

  it('14day → 14 days starting at anchor', () => {
    const got = expandRange('2026-05-26', '14day');
    assert.equal(got.length, 14);
    assert.equal(got[0], '2026-05-26');
    assert.equal(got[13], '2026-06-08');
  });

  it('crosses month boundaries correctly', () => {
    // 2026-01-30 + 13 = 2026-02-12
    const got = expandRange('2026-01-30', '14day');
    assert.equal(got[13], '2026-02-12');
  });

  it('crosses a leap-year February correctly', () => {
    // 2028 is a leap year — Feb 28 + 1 = Feb 29.
    const got = expandRange('2028-02-28', 'week');
    assert.equal(got[1], '2028-02-29');
    assert.equal(got[2], '2028-03-01');
  });

  it('crosses a non-leap-year February correctly', () => {
    // 2026 is NOT a leap year — Feb 28 + 1 must be Mar 1, not Feb 29.
    const got = expandRange('2026-02-28', 'week');
    assert.equal(got[1], '2026-03-01');
  });

  it('addDays stable across spring-forward DST', () => {
    // 2026-03-08 is when DST kicks in for America/Chicago. Computing
    // dates in UTC sidesteps the +23h DST surprise that would cross a
    // different calendar day in local time.
    assert.equal(addDays('2026-03-07', 1), '2026-03-08');
    assert.equal(addDays('2026-03-08', 1), '2026-03-09');
  });

  it('addDays rejects garbage input loudly', () => {
    assert.throws(() => addDays('not-a-date', 1), /invalid date string/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Gap classification — the most-load-bearing rule in the file
// ─────────────────────────────────────────────────────────────────────

describe('classifyGap — exact spec boundaries', () => {
  it('green when scheduled equals recommended', () => {
    assert.equal(classifyGap({ housekeepersScheduled: 5, housekeepersRecommended: 5 }), 'green');
  });

  it('green when scheduled exceeds recommended (no over-cap-as-warning)', () => {
    assert.equal(classifyGap({ housekeepersScheduled: 7, housekeepersRecommended: 5 }), 'green');
  });

  it('yellow when exactly one short', () => {
    assert.equal(classifyGap({ housekeepersScheduled: 4, housekeepersRecommended: 5 }), 'yellow');
  });

  it('red when two short (the off-by-one boundary)', () => {
    assert.equal(classifyGap({ housekeepersScheduled: 3, housekeepersRecommended: 5 }), 'red');
  });

  it('red when zero scheduled', () => {
    assert.equal(classifyGap({ housekeepersScheduled: 0, housekeepersRecommended: 4 }), 'red');
  });

  it('green when both are zero (idle day)', () => {
    assert.equal(classifyGap({ housekeepersScheduled: 0, housekeepersRecommended: 0 }), 'green');
  });

  it('treats NaN scheduled as zero, classifies vs recommended', () => {
    // Defense against a NULL row coming through the JSON path as NaN
    // — we'd rather render "fully staffed" for missing data than crash
    // the day card. recommended=2, scheduled=0 → off by 2 → red.
    assert.equal(classifyGap({ housekeepersScheduled: NaN, housekeepersRecommended: 2 }), 'red');
  });

  it('treats negative scheduled as zero', () => {
    assert.equal(classifyGap({ housekeepersScheduled: -3, housekeepersRecommended: 2 }), 'red');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Honesty label
// ─────────────────────────────────────────────────────────────────────

describe('resolveAccuracyLabel — 30-day boundary', () => {
  it('exactly 30 days history with fitted model → ai_prediction', () => {
    const got = resolveAccuracyLabel({
      historyDays: HISTORY_THRESHOLD_DAYS,
      predictionAvailable: true,
      modelKind: 'fitted',
    });
    assert.equal(got, 'ai_prediction');
  });

  it('29 days history with fitted model → industry_estimate_learning', () => {
    // The whole point of the threshold — model can be "fitted" the
    // moment quantile regression returns valid params, but with only
    // 29 days we still call it "learning" so the GM doesn't oversell.
    const got = resolveAccuracyLabel({
      historyDays: HISTORY_THRESHOLD_DAYS - 1,
      predictionAvailable: true,
      modelKind: 'fitted',
    });
    assert.equal(got, 'industry_estimate_learning');
  });

  it('warming-up model never gets promoted, even with 90 days', () => {
    const got = resolveAccuracyLabel({
      historyDays: 90,
      predictionAvailable: true,
      modelKind: 'warming-up',
    });
    assert.equal(got, 'industry_estimate_learning');
  });

  it('capacity-unavailable model → capacity_unavailable label', () => {
    const got = resolveAccuracyLabel({
      historyDays: 90,
      predictionAvailable: true,
      modelKind: 'capacity-unavailable',
    });
    assert.equal(got, 'capacity_unavailable');
  });

  it('prediction absent → capacity_unavailable regardless of history', () => {
    // Graceful-degrade path: if ml-service hasn't written a row for
    // this date yet (or returned an error), we surface
    // capacity_unavailable rather than fabricating a number.
    const got = resolveAccuracyLabel({
      historyDays: 365,
      predictionAvailable: false,
      modelKind: 'fitted',
    });
    assert.equal(got, 'capacity_unavailable');
  });

  it('null history → industry_estimate_learning (treat unknown as learning)', () => {
    const got = resolveAccuracyLabel({
      historyDays: null,
      predictionAvailable: true,
      modelKind: 'fitted',
    });
    assert.equal(got, 'industry_estimate_learning');
  });

  it('missing modelKind defaults to safe path (still gates on history)', () => {
    // No modelKind hint but with full history → ai_prediction is OK;
    // the prediction-availability gate above is the safety net for the
    // genuinely-unknown case.
    const got = resolveAccuracyLabel({
      historyDays: 60,
      predictionAvailable: true,
    });
    assert.equal(got, 'ai_prediction');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Cleaning-minute math
// ─────────────────────────────────────────────────────────────────────

describe('totalCleaningMinutes — agrees with ScheduleTab formula', () => {
  it('happy path with property overrides', () => {
    const m = totalCleaningMinutes({
      departures: 10,
      stayoversLight: 5,
      stayoversFull: 3,
      deepCleans: 0,
      checkoutMinutes: 28,
      stayoverDay1Minutes: 14,
      stayoverDay2Minutes: 22,
    });
    // 10*28 + 5*14 + 3*22 = 280 + 70 + 66 = 416
    assert.equal(m, 416);
  });

  it('falls back to defaults when overrides are missing', () => {
    const m = totalCleaningMinutes({
      departures: 10,
      stayoversLight: 5,
      stayoversFull: 3,
      deepCleans: 0,
    });
    // 10*30 + 5*15 + 3*20 = 300 + 75 + 60 = 435
    assert.equal(m, 435);
  });

  it('treats zero or negative overrides as missing (fallback)', () => {
    // A misconfigured property row (shift_minutes=0 from a fat-fingered
    // settings save) must not silently produce zero-time everywhere.
    const m = totalCleaningMinutes({
      departures: 4,
      stayoversLight: 0,
      stayoversFull: 0,
      deepCleans: 0,
      checkoutMinutes: 0,
    });
    // 4 * 30 (default) = 120
    assert.equal(m, 120);
  });

  it('clamps negative room counts to zero rather than going negative', () => {
    const m = totalCleaningMinutes({
      departures: -5,
      stayoversLight: 2,
      stayoversFull: 0,
      deepCleans: 0,
    });
    // 0*30 + 2*15 + 0 = 30
    assert.equal(m, 30);
  });

  it('includes deep cleans when set', () => {
    const m = totalCleaningMinutes({
      departures: 0,
      stayoversLight: 0,
      stayoversFull: 0,
      deepCleans: 2,
      deepCleanMinutes: 60,
    });
    assert.equal(m, 120);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Recommended headcount
// ─────────────────────────────────────────────────────────────────────

describe('recommendedHeadcount', () => {
  it('uses optimizer recommendation when present', () => {
    const r = recommendedHeadcount({
      totalCleaningMinutes: 1000,
      shiftMinutes: 420,
      optimizerRecommendation: 6,
    });
    assert.equal(r, 6);
  });

  it('falls back to deterministic ceiling + 1 laundry when optimizer is silent', () => {
    // 1000 / 420 = 2.38 → ceil 3 → +1 laundry = 4
    const r = recommendedHeadcount({
      totalCleaningMinutes: 1000,
      shiftMinutes: 420,
      optimizerRecommendation: null,
    });
    assert.equal(r, 4);
  });

  it('uses default shift cap when shiftMinutes is null', () => {
    const r = recommendedHeadcount({
      totalCleaningMinutes: 1000,
      shiftMinutes: null,
      optimizerRecommendation: null,
    });
    // Same as above because default is 420
    assert.equal(r, 4);
  });

  it('clamps to 1+1=2 minimum on an empty day', () => {
    const r = recommendedHeadcount({
      totalCleaningMinutes: 0,
      shiftMinutes: 420,
      optimizerRecommendation: null,
    });
    assert.equal(r, 2);
  });

  it('treats NaN optimizer recommendation as missing', () => {
    const r = recommendedHeadcount({
      totalCleaningMinutes: 1000,
      shiftMinutes: 420,
      optimizerRecommendation: NaN,
    });
    assert.equal(r, 4); // falls through to deterministic
  });

  it('treats sub-1 optimizer recommendation as missing (sanity floor)', () => {
    const r = recommendedHeadcount({
      totalCleaningMinutes: 1000,
      shiftMinutes: 420,
      optimizerRecommendation: 0.4,
    });
    assert.equal(r, 4); // falls through to deterministic
  });
});

// ─────────────────────────────────────────────────────────────────────
// Labor cost projection
// ─────────────────────────────────────────────────────────────────────

describe('projectLaborCents', () => {
  it('uses per-staff wages when all set', () => {
    // 4 HKs all at $15.50/hr * 7h each = 4 * $108.50 = $434 = 43400 cents
    const r = projectLaborCents({
      scheduledWagesCents: [1550, 1550, 1550, 1550],
      shiftMinutes: 420,
    });
    assert.equal(r.cents, 43400);
    assert.equal(r.wagePending, false);
  });

  it('falls back to default wage + wagePending=true when all wages missing', () => {
    // 4 HKs * 7h * $14/hr = $392.00 = 39200 cents
    const r = projectLaborCents({
      scheduledWagesCents: [null, null, null, null],
      shiftMinutes: 420,
    });
    assert.equal(r.cents, 39200);
    assert.equal(r.wagePending, true);
  });

  it('mixed wages — wagePending=true even when some are set (the Codex audit fix)', () => {
    // 3 staff at $15, 2 staff with no wage. The prior implementation
    // averaged the 3 set wages and reused that average without
    // raising wagePending — silently understated cost when scheduled
    // staff actually lacked wages. New behavior: any missing wage
    // flips wagePending; the missing staff are projected at the
    // benchmark default so the total is at worst a slight underestimate.
    const r = projectLaborCents({
      scheduledWagesCents: [1500, 1500, 1500, null, null],
      shiftMinutes: 420,
    });
    // 3 * 7h * $15 = $315 + 2 * 7h * $14 = $196 → $511 = 51100 cents
    assert.equal(r.cents, 51100);
    assert.equal(r.wagePending, true);
  });

  it('empty scheduled list → zero cents, wagePending=false (nobody to flag)', () => {
    const r = projectLaborCents({
      scheduledWagesCents: [],
      shiftMinutes: 420,
    });
    assert.equal(r.cents, 0);
    assert.equal(r.wagePending, false);
  });

  it('default wage matches the documented constant', () => {
    // Guards against silent drift between the constant and the test
    // expectation if someone bumps DEFAULT_HOURLY_WAGE_CENTS later.
    assert.equal(DEFAULT_HOURLY_WAGE_CENTS, 1400);
  });

  it('default shift matches the documented constant', () => {
    assert.equal(DEFAULT_SHIFT_MINUTES, 420);
  });

  it('treats zero or negative wage as missing', () => {
    const r = projectLaborCents({
      scheduledWagesCents: [0, -100],
      shiftMinutes: 420,
    });
    // Both invalid → both treated as missing, projected at default.
    // 2 * 7h * $14 = $196 = 19600 cents
    assert.equal(r.cents, 19600);
    assert.equal(r.wagePending, true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Range summary
// ─────────────────────────────────────────────────────────────────────

describe('summarizeRange', () => {
  const day = (over: Partial<DaySummary> = {}): DaySummary => ({
    totalMinutesNeeded: 0,
    housekeepersScheduled: 0,
    housekeepersRecommended: 0,
    shiftMinutes: 420,
    gapStatus: 'green',
    ...over,
  });

  it('counts red days as understaffed; yellow and green do not count', () => {
    const r = summarizeRange([
      day({ gapStatus: 'green' }),
      day({ gapStatus: 'yellow' }),
      day({ gapStatus: 'red' }),
      day({ gapStatus: 'red' }),
    ]);
    assert.equal(r.understaffedDayCount, 2);
  });

  it('rolls hours scheduled from actual headcount × shift cap', () => {
    // 2 days × 3 HKs × 7h = 42h
    const r = summarizeRange([
      day({ housekeepersScheduled: 3 }),
      day({ housekeepersScheduled: 3 }),
    ]);
    assert.equal(r.totalHoursScheduled, 42);
  });

  it('computes gap hours as max(0, needed − scheduled)', () => {
    // 400 minutes needed, 0 scheduled → 6.7h gap
    const r = summarizeRange([
      day({ totalMinutesNeeded: 400, housekeepersScheduled: 0 }),
    ]);
    assert.equal(r.gapHours, 6.7);
  });

  it('never reports a negative gap when over-staffed', () => {
    // Plenty of capacity, tiny workload — banner should say "0 gap"
    // rather than "−42 hours" which would read as a UI bug.
    const r = summarizeRange([
      day({ totalMinutesNeeded: 60, housekeepersScheduled: 5 }),
    ]);
    assert.equal(r.gapHours, 0);
  });

  it('uses per-day shift cap, not a global one', () => {
    // Day 1: shift 480 (8h), HKs=2 → 16h. Day 2: shift 360 (6h), HKs=3 → 18h.
    // Total = 34h.
    const r = summarizeRange([
      day({ housekeepersScheduled: 2, shiftMinutes: 480 }),
      day({ housekeepersScheduled: 3, shiftMinutes: 360 }),
    ]);
    assert.equal(r.totalHoursScheduled, 34);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Role gate — locks in the exact set of roles permitted to read the
// forecast. Mirrors src/lib/__tests__/activity-log-role-gate.test.ts
// (admin/owner/GM allowed; everyone else denied).
// ─────────────────────────────────────────────────────────────────────

describe('canViewForecast — exact role contract', () => {
  const cases: Array<[string, boolean]> = [
    ['admin', true],
    ['owner', true],
    ['general_manager', true],
    ['front_desk', false],
    ['housekeeping', false],
    ['maintenance', false],
    ['staff', false],
  ];

  for (const [role, allowed] of cases) {
    it(`${role} ${allowed ? 'can' : 'cannot'} view the forecast`, () => {
      assert.equal(canViewForecast(role), allowed);
    });
  }

  it('null role → denied (no account row case)', () => {
    assert.equal(canViewForecast(null), false);
  });

  it('undefined role → denied', () => {
    assert.equal(canViewForecast(undefined), false);
  });

  it('empty-string role → denied', () => {
    assert.equal(canViewForecast(''), false);
  });

  it('unknown role string → denied (fail-closed)', () => {
    assert.equal(canViewForecast('chief_robot'), false);
  });
});
