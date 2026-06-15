/**
 * ONE-FIX-GENERALIZES sample-verify + GOLDEN-FIXTURE gates, wired into
 * evaluatePromotionGate (feature/cua-self-heal-reach).
 *
 * Proves:
 *   - sample-verify aggregation counts only POSITIVE sibling failures (an
 *     offline/inconclusive sibling never downgrades — no fleet starvation),
 *   - the gate is DOWNGRADE-ONLY + DEFAULT-OFF: both new args are no-ops when
 *     absent/disabled (today's behaviour) and can only turn auto_promote →
 *     park_draft, never upgrade a parked decision,
 *   - golden-fixture catches a dropped-certified-column regression and is a
 *     no-op when no fixture is registered.
 */

import './ws-polyfill.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePromotionGate,
  aggregateSampleVerify,
  computeSampleVerifyGate,
  computeGoldenFixtureGate,
  recipeFreshShape,
  type SampleVerifyDeps,
  type SiblingVerifyResult,
  type SampleVerifyGateInput,
  type GoldenFixtureGateInput,
} from '../mapping-driver.js';
import { registerGoldenFixture, clearGoldenFixtures, type GoldenFixture } from '../golden-fixtures.js';
import type { Recipe, ActionRecipe } from '../types.js';

// ─── Recipe fixtures (mirrors mapping-driver-bestclass-verify.test.ts) ────────
function tableAction(columns: Record<string, string>): ActionRecipe {
  return { steps: [{ kind: 'goto', url: 'https://pms.example.com/x' }], parse: { mode: 'table', hint: { rowSelector: 'tr', columns } } };
}
function fullRecipe(overrides: Partial<Recipe['actions']> = {}): Recipe {
  return {
    schema: 1,
    login: { startUrl: 'https://pms.example.com/login', steps: [{ kind: 'click', selector: 'b' }], successSelectors: ['.d'] },
    actions: {
      getRoomStatus: tableAction({ room_number: 'a', status: 'b' }),
      getArrivals: tableAction({ pms_reservation_id: 'a', guest_name: 'b', arrival_date: 'c', departure_date: 'd' }),
      getDepartures: tableAction({ pms_reservation_id: 'a', guest_name: 'b', arrival_date: 'c', departure_date: 'd' }),
      getWorkOrders: tableAction({ pms_work_order_id: 'a', description: 'b', status: 'c', out_of_order: 'd' }),
      getGuests: tableAction({ pms_guest_id: 'a', name: 'b' }),
      getRevenueDaily: tableAction({ date: 'a' }),
      getRatesAndInventory: tableAction({ date: 'a' }),
      ...overrides,
    },
  };
}

const sv = (over: Partial<SampleVerifyGateInput> = {}): SampleVerifyGateInput =>
  ({ enabled: true, sampled: 2, failedSiblings: 0, ...over });
const gf = (over: Partial<GoldenFixtureGateInput> = {}): GoldenFixtureGateInput =>
  ({ enabled: true, regressedFeeds: [], ...over });

// ─── Baseline: defaults-off == today ─────────────────────────────────────────
describe('evaluatePromotionGate — new gates default-OFF == today', () => {
  test('no new args → auto_promote (unchanged)', () => {
    assert.equal(evaluatePromotionGate(fullRecipe()).decision, 'auto_promote');
  });
  test('sampleVerify disabled → auto_promote even with failures recorded', () => {
    const g = evaluatePromotionGate(fullRecipe(), undefined, undefined, sv({ enabled: false, failedSiblings: 3 }));
    assert.equal(g.decision, 'auto_promote');
  });
  test('goldenFixture disabled → auto_promote even with regressions recorded', () => {
    const g = evaluatePromotionGate(fullRecipe(), undefined, undefined, undefined, gf({ enabled: false, regressedFeeds: ['getArrivals'] }));
    assert.equal(g.decision, 'auto_promote');
  });
  test('both enabled but clean → auto_promote', () => {
    const g = evaluatePromotionGate(fullRecipe(), undefined, undefined, sv(), gf());
    assert.equal(g.decision, 'auto_promote');
  });
});

// ─── Downgrade-only: a positive failure HOLDS the change ─────────────────────
describe('evaluatePromotionGate — sample-verify downgrade-only', () => {
  test('a sibling positively failed → park_draft (held for founder review)', () => {
    const g = evaluatePromotionGate(fullRecipe(), undefined, undefined, sv({ failedSiblings: 1, sampled: 2 }));
    assert.equal(g.decision, 'park_draft');
    assert.match(g.reason, /sample-verify failed on 1\/2 sibling/);
  });
  test('zero failed siblings → auto_promote', () => {
    const g = evaluatePromotionGate(fullRecipe(), undefined, undefined, sv({ failedSiblings: 0, sampled: 2 }));
    assert.equal(g.decision, 'auto_promote');
  });
});

describe('evaluatePromotionGate — golden-fixture downgrade-only', () => {
  test('a regressed feed → park_draft', () => {
    const g = evaluatePromotionGate(fullRecipe(), undefined, undefined, undefined, gf({ regressedFeeds: ['getArrivals'] }));
    assert.equal(g.decision, 'park_draft');
    assert.match(g.reason, /golden-fixture regression/);
  });
});

describe('evaluatePromotionGate — gates only act in the auto_promote branch (never upgrade)', () => {
  test('a recipe that parks_partial stays parked even with a sample-verify failure', () => {
    // Drop a required feed → the gate decides park_partial/quarantine BEFORE the
    // auto_promote branch, so the new downgrade-only gates never run.
    const r = fullRecipe();
    delete r.actions.getWorkOrders;
    const base = evaluatePromotionGate(r);
    assert.notEqual(base.decision, 'auto_promote');
    const withGates = evaluatePromotionGate(r, undefined, undefined, sv({ failedSiblings: 2 }), gf({ regressedFeeds: ['getArrivals'] }));
    assert.equal(withGates.decision, base.decision); // unchanged — never upgraded, never re-categorized
  });
});

// ─── Sample-verify aggregation (pure) ────────────────────────────────────────
describe('aggregateSampleVerify', () => {
  const r = (propertyId: string, verdict: SiblingVerifyResult['verdict']): SiblingVerifyResult =>
    ({ propertyId, actionKey: 'getArrivals', verdict, reason: '' });
  test('counts pass/fail/inconclusive; failedSiblings is DISTINCT siblings', () => {
    const agg = aggregateSampleVerify([
      r('A', 'pass'), r('B', 'fail'), r('B', 'fail'), r('C', 'inconclusive'),
    ]);
    assert.equal(agg.sampled, 3);
    assert.equal(agg.failed, 2);
    assert.equal(agg.passed, 1);
    assert.equal(agg.inconclusive, 1);
    assert.equal(agg.failedSiblings, 1); // B counted once despite two failed feeds
  });
  test('all inconclusive → zero failedSiblings (offline siblings never block)', () => {
    const agg = aggregateSampleVerify([r('A', 'inconclusive'), r('B', 'inconclusive')]);
    assert.equal(agg.failedSiblings, 0);
  });
});

// ─── computeSampleVerifyGate with injected deps (no Playwright/Supabase) ──────
describe('computeSampleVerifyGate (injected deps)', () => {
  const mkDeps = (siblings: string[], verdictFor: (pid: string) => SiblingVerifyResult['verdict']): SampleVerifyDeps => ({
    selectSiblings: async () => siblings,
    replayFeedOnSibling: async (propertyId, _recipe, actionKey) => ({ propertyId, actionKey, verdict: verdictFor(propertyId), reason: '' }),
  });

  test('no changed targets → sampled 0, no failures', async () => {
    const out = await computeSampleVerifyGate({ pmsFamily: 'fam', recipe: fullRecipe(), changedTargets: [], excludePropertyId: 'self', deps: mkDeps(['A'], () => 'pass') });
    assert.equal(out.enabled, true);
    assert.equal(out.sampled, 0);
    assert.equal(out.failedSiblings, 0);
  });

  test('no eligible siblings → sampled 0', async () => {
    const out = await computeSampleVerifyGate({ pmsFamily: 'fam', recipe: fullRecipe(), changedTargets: ['getArrivals'], excludePropertyId: 'self', deps: mkDeps([], () => 'pass') });
    assert.equal(out.sampled, 0);
    assert.equal(out.failedSiblings, 0);
  });

  test('a failing sibling → failedSiblings 1 (this is what downgrades the gate)', async () => {
    const out = await computeSampleVerifyGate({ pmsFamily: 'fam', recipe: fullRecipe(), changedTargets: ['getArrivals'], excludePropertyId: 'self', deps: mkDeps(['A', 'B'], (pid) => (pid === 'B' ? 'fail' : 'pass')) });
    assert.equal(out.sampled, 2);
    assert.equal(out.failedSiblings, 1);
  });

  test('an inconclusive sibling never downgrades', async () => {
    const out = await computeSampleVerifyGate({ pmsFamily: 'fam', recipe: fullRecipe(), changedTargets: ['getArrivals'], excludePropertyId: 'self', deps: mkDeps(['A'], () => 'inconclusive') });
    assert.equal(out.failedSiblings, 0);
  });

  test('a replay that throws is caught as inconclusive (fail-safe, never a false fail)', async () => {
    const out = await computeSampleVerifyGate({
      pmsFamily: 'fam', recipe: fullRecipe(), changedTargets: ['getArrivals'], excludePropertyId: 'self',
      deps: { selectSiblings: async () => ['A'], replayFeedOnSibling: async () => { throw new Error('boom'); } },
    });
    assert.equal(out.failedSiblings, 0);
  });

  test('passes the bounded N to selectSiblings (cost discipline)', async () => {
    const prev = process.env.CUA_SAMPLE_VERIFY_N;
    process.env.CUA_SAMPLE_VERIFY_N = '3';
    let seenLimit = -1;
    await computeSampleVerifyGate({
      pmsFamily: 'fam', recipe: fullRecipe(), changedTargets: ['getArrivals'], excludePropertyId: 'self',
      deps: { selectSiblings: async (_f, _e, limit) => { seenLimit = limit; return []; }, replayFeedOnSibling: async () => ({ propertyId: '', actionKey: '', verdict: 'pass', reason: '' }) },
    });
    assert.equal(seenLimit, 3);
    if (prev === undefined) delete process.env.CUA_SAMPLE_VERIFY_N; else process.env.CUA_SAMPLE_VERIFY_N = prev;
  });
});

// ─── computeGoldenFixtureGate + recipeFreshShape (structural path) ────────────
describe('computeGoldenFixtureGate (mapping path)', () => {
  const fx = (): GoldenFixture => ({
    pmsFamily: 'fam', actionKey: 'getArrivals', capturedAt: '2026-06-14T00:00:00Z', parseMode: 'table',
    columns: ['arrival_date', 'departure_date', 'guest_name', 'pms_reservation_id'],
    columnVerdicts: { pms_reservation_id: 'certified', guest_name: 'certified', arrival_date: 'certified', departure_date: 'certified' },
    rowCount: 10,
  });

  test('no fixture registered → no regression (skip)', () => {
    clearGoldenFixtures();
    const out = computeGoldenFixtureGate({ pmsFamily: 'fam', recipe: fullRecipe(), targets: ['getArrivals'], freshShapeFor: (k) => recipeFreshShape(fullRecipe(), k) });
    assert.deepEqual(out.regressedFeeds, []);
    assert.equal(out.enabled, true);
  });

  test('a recipe that dropped a previously-certified column regresses', () => {
    clearGoldenFixtures();
    registerGoldenFixture(fx());
    // getArrivals missing arrival_date + departure_date in its shipping columns.
    const r = fullRecipe({ getArrivals: tableAction({ pms_reservation_id: 'a', guest_name: 'b' }) });
    const out = computeGoldenFixtureGate({ pmsFamily: 'fam', recipe: r, targets: ['getArrivals'], freshShapeFor: (k) => recipeFreshShape(r, k) });
    assert.deepEqual(out.regressedFeeds, ['getArrivals']);
    clearGoldenFixtures();
  });

  test('an unchanged recipe does NOT regress against its own fixture', () => {
    clearGoldenFixtures();
    registerGoldenFixture(fx());
    const r = fullRecipe();
    const out = computeGoldenFixtureGate({ pmsFamily: 'fam', recipe: r, targets: ['getArrivals'], freshShapeFor: (k) => recipeFreshShape(r, k) });
    assert.deepEqual(out.regressedFeeds, []);
    clearGoldenFixtures();
  });

  test('recipeFreshShape (structural path) reports hasValueEvidence:false — honest, no live data', () => {
    const s = recipeFreshShape(fullRecipe(), 'getArrivals');
    assert.ok(s);
    assert.equal(s!.hasValueEvidence, false);
    assert.ok(s!.columns.includes('arrival_date'));
  });
});

// ─── Review fix: a re-anchored (non-seeded) target carrying a STALE
//     unprovenRequiredColumns must block auto-promote — which is exactly why
//     tryReanchor refreshes that field from the heal's real re-extraction. ─────
describe('evaluatePromotionGate — unprovenRequiredColumns on a re-anchored target', () => {
  test('a non-seeded target still carrying unprovenRequiredColumns → park_partial (NOT auto_promote)', () => {
    const arr = tableAction({ pms_reservation_id: 'a', guest_name: 'b', arrival_date: 'c', departure_date: 'd' });
    (arr as { unprovenRequiredColumns?: string[] }).unprovenRequiredColumns = ['arrival_date'];
    const r = fullRecipe({ getArrivals: arr });
    const seed = { ...r.actions };
    delete seed.getArrivals; // the re-anchored target is NOT seeded
    assert.equal(evaluatePromotionGate(r, seed).decision, 'park_partial');
  });
  test('same recipe WITHOUT the stale field → auto_promote (the refresh enables the heal)', () => {
    const r = fullRecipe();
    const seed = { ...r.actions };
    delete seed.getArrivals;
    assert.equal(evaluatePromotionGate(r, seed).decision, 'auto_promote');
  });
});

// ─── Review fix: bounded sample-verify replay budget (cost discipline) ────────
describe('computeSampleVerifyGate — bounded replay budget', () => {
  test('caps total replays even with many siblings × many targets', async () => {
    let calls = 0;
    const manyTargets = Array.from({ length: 12 }, (_, i) => `getArrivals`); // count is what matters
    const out = await computeSampleVerifyGate({
      pmsFamily: 'fam', recipe: fullRecipe(), changedTargets: manyTargets, excludePropertyId: 'self',
      deps: {
        selectSiblings: async () => ['A', 'B', 'C', 'D', 'E'],
        replayFeedOnSibling: async (propertyId, _r, actionKey) => { calls++; return { propertyId, actionKey, verdict: 'pass', reason: '' }; },
      },
    });
    assert.ok(calls <= 16, `expected ≤16 replays, got ${calls}`);
    assert.equal(out.enabled, true);
  });
});
