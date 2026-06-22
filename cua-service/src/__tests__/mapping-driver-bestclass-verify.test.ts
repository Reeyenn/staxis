/**
 * Best-class verification wiring tests (feature/cua-bestclass-verify) for the
 * mapping-driver side: the gate's optional verification arg (monotonic
 * downgrade-only), the cross-feed/fingerprint gatherers, and the signed-envelope
 * round-trip proving the new optional `verification` field doesn't break old
 * (field-less) signed rows.
 */

import './ws-polyfill.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePromotionGate,
  gatherCrossFeedObservation,
  computeRecipeFingerprint,
  type VerificationGateInput,
} from '../mapping-driver.js';
import { signRecipe, verifyRecipe } from '../recipe-signing.js';
import type { Recipe, ActionRecipe, BoardTargetState } from '../types.js';

// ─── Recipe fixtures (mirror mapper-field-contract.test.ts fullRecipe) ────────
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

const vg = (over: Partial<VerificationGateInput> = {}): VerificationGateInput => ({
  enforce: true, score: 1.0, threshold: 0.99, consistentPasses: 1, requiredPasses: 1, ...over,
});

// ─── Gate monotonicity: verification only ever DOWNGRADES auto_promote ────────
describe('evaluatePromotionGate — verification arg (monotonic)', () => {
  test('NO verification arg → identical to today (auto_promote)', () => {
    assert.equal(evaluatePromotionGate(fullRecipe()).decision, 'auto_promote');
  });

  test('verification present but enforce=false → advisory, still auto_promote', () => {
    const g = evaluatePromotionGate(fullRecipe(), undefined, vg({ enforce: false, score: 0.1 }));
    assert.equal(g.decision, 'auto_promote');
    assert.match(g.reason, /advisory/);
  });

  test('enforce + score below threshold → HELD for founder review (park_partial)', () => {
    const g = evaluatePromotionGate(fullRecipe(), undefined, vg({ score: 0.5 }));
    assert.equal(g.decision, 'park_partial');
    assert.match(g.reason, /best-class verification/);
    assert.match(g.reason, /score 0\.500 < threshold/);
  });

  test('enforce + score OK but pass^N not met → park_partial', () => {
    const g = evaluatePromotionGate(fullRecipe(), undefined, vg({ score: 1, consistentPasses: 1, requiredPasses: 2 }));
    assert.equal(g.decision, 'park_partial');
    assert.match(g.reason, /1\/2 consistent/);
  });

  test('enforce + score OK + pass^N met → auto_promote (with a quoted number)', () => {
    const g = evaluatePromotionGate(fullRecipe(), undefined, vg({ score: 1, consistentPasses: 2, requiredPasses: 2 }));
    assert.equal(g.decision, 'auto_promote');
    assert.match(g.reason, /verify score/);
  });

  test('verification NEVER upgrades: a missing-feed recipe stays park_partial even with a perfect score', () => {
    const r = fullRecipe();
    delete r.actions.getDepartures;
    const g = evaluatePromotionGate(r, undefined, vg({ score: 1, consistentPasses: 9, requiredPasses: 1 }));
    assert.equal(g.decision, 'park_partial'); // gap path reached before the auto_promote branch
    assert.ok(!/best-class verification/.test(g.reason), 'gap reason, not the verification reason');
  });

  test('verification NEVER upgrades a quarantine', () => {
    const r = fullRecipe();
    delete r.actions.getRoomStatus;
    delete r.actions.getArrivals; // below the partial bar
    const g = evaluatePromotionGate(r, undefined, vg({ score: 1, consistentPasses: 9 }));
    assert.equal(g.decision, 'quarantine');
  });
});

// ─── Cross-feed observation gathering from boardTargets ───────────────────────
describe('gatherCrossFeedObservation', () => {
  const boardTargets: Record<string, BoardTargetState> = {
    getArrivals: { status: 'found', preview: { rowCount: 30, sample: [{ pms_reservation_id: 'R1' }], sampleKind: 'rows' } },
    getRoomStatus: { status: 'found', preview: { rowCount: 80, sample: [{ room_number: '101', status: 'occupied' }], sampleKind: 'rows' } },
    getDashboardCounts: { status: 'found', preview: { rowCount: 1, sample: [{ total_occupied_rooms: '42', arrivals_remaining_today: '9' }], sampleKind: 'rows' } },
  };

  test('row feeds contribute rowCount; dashboard contributes parsed counters', () => {
    const { feeds, dashboardCounters } = gatherCrossFeedObservation(boardTargets);
    assert.equal(feeds.getArrivals?.rowCount, 30);
    assert.equal(feeds.getRoomStatus?.rowCount, 80);
    assert.equal(dashboardCounters.total_occupied_rooms, 42);
    assert.equal(dashboardCounters.arrivals_remaining_today, 9);
  });

  test('getDashboardCounts is the SOURCE, never itself listed as a row feed', () => {
    const { feeds } = gatherCrossFeedObservation(boardTargets);
    assert.equal(feeds.getDashboardCounts, undefined);
  });

  test('undefined boardTargets → empty observation (no crash)', () => {
    const { feeds, dashboardCounters } = gatherCrossFeedObservation(undefined);
    assert.deepEqual(feeds, {});
    assert.deepEqual(dashboardCounters, {});
  });

  test('a 3-row preview of a big feed is NOT marked complete (so exact counts don\'t undercount)', () => {
    const { feeds } = gatherCrossFeedObservation({
      getRoomStatus: { status: 'found', preview: { rowCount: 80, sample: [{ status: 'a' }, { status: 'b' }, { status: 'c' }] } },
    });
    assert.equal(feeds.getRoomStatus?.rowsComplete, false);
  });
});

describe('computeRecipeFingerprint — STRUCTURAL (stable across live-data drift)', () => {
  const bt = (rowCount: number): Record<string, BoardTargetState> => ({
    getArrivals: { status: 'found', preview: { rowCount, sample: [{ pms_reservation_id: 'A' }, { pms_reservation_id: 'B' }, { pms_reservation_id: 'C' }] } },
  });
  test('same recipe, WILDLY different live row counts → identical fingerprint (pass^N can converge)', () => {
    const a = computeRecipeFingerprint(fullRecipe(), bt(30));
    const b = computeRecipeFingerprint(fullRecipe(), bt(3)); // different bucket, occupancy churned
    assert.equal(a.fingerprint, b.fingerprint, 'structural fingerprint must ignore live-data drift');
    assert.equal(a.sane, true);
  });
  test('a DIFFERENT recipe shape (a column dropped) → different fingerprint (counter resets)', () => {
    const a = computeRecipeFingerprint(fullRecipe(), bt(30));
    const b = computeRecipeFingerprint(
      fullRecipe({ getArrivals: tableAction({ pms_reservation_id: 'a', guest_name: 'b', arrival_date: 'c' }) }), // no departure_date
      bt(30),
    );
    assert.notEqual(a.fingerprint, b.fingerprint);
  });
  test('a degenerate (constant) key in the preview flags not-sane', () => {
    const degenerate: Record<string, BoardTargetState> = {
      getArrivals: { status: 'found', preview: { rowCount: 3, sample: [{ pms_reservation_id: 'X' }, { pms_reservation_id: 'X' }, { pms_reservation_id: 'X' }] } },
    };
    assert.equal(computeRecipeFingerprint(fullRecipe(), degenerate).sane, false);
  });
});

// ─── Signed envelope: the new optional field is monotonicity-safe ─────────────
describe('signed envelope round-trip — verification field is additive', () => {
  const recipe = fullRecipe();
  const baseEnvelope = (): Record<string, unknown> => ({
    schema: 1, description: 'x', login: recipe.login, actions: recipe.actions, hints: {},
  });

  test('a LEGACY envelope (no verification) signs + verifies — old rows still load', () => {
    const env = JSON.parse(JSON.stringify(baseEnvelope()));
    const { signature, signedWithKeyId } = signRecipe(env as unknown as Recipe);
    assert.equal(verifyRecipe(env as unknown as Recipe, signature, signedWithKeyId).ok, true);
  });

  test('a NEW envelope WITH verification signs + verifies (signed === stored)', () => {
    const env = JSON.parse(JSON.stringify({
      ...baseEnvelope(),
      verification: { threshold: 0.99, score: 1, consistentPasses: 2, requiredPasses: 2, enforced: true, fingerprint: 'getArrivals:21-50:all:', computedAt: '2026-06-14T00:00:00.000Z', signals: { reconcile: 'pass', crossFeed: 'pass', fingerprint: 'pass', secondModel: 'abstain' } },
    }));
    const { signature, signedWithKeyId } = signRecipe(env as unknown as Recipe);
    assert.equal(verifyRecipe(env as unknown as Recipe, signature, signedWithKeyId).ok, true);
  });

  test('a signature taken WITHOUT the field still verifies the same field-less envelope (the optional field changes nothing for legacy rows)', () => {
    const legacy = JSON.parse(JSON.stringify(baseEnvelope()));
    const sig = signRecipe(legacy as unknown as Recipe);
    // Re-load the same field-less envelope (simulating an old DB row) → verifies.
    const reloaded = JSON.parse(JSON.stringify(baseEnvelope()));
    assert.equal(verifyRecipe(reloaded as unknown as Recipe, sig.signature, sig.signedWithKeyId).ok, true);
  });
});
