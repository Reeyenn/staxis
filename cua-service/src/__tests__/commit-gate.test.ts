/**
 * Multi-signal commit gate tests (feature/cua-bestclass-verify, Tasks 3-5).
 *
 * PURE module — no bootstrapping needed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeCommitScore,
  decideCommit,
  valueFingerprint,
  recipeFingerprintString,
  fingerprintsMatch,
  DEFAULT_COMMIT_THRESHOLD,
  DEFAULT_REQUIRED_PASSES,
  type CommitSignals,
} from '../commit-gate.js';

const sig = (over: Partial<CommitSignals> = {}): CommitSignals => ({
  reconcile: 'abstain', crossFeed: 'abstain', fingerprint: 'abstain', secondModel: 'abstain', ...over,
});

describe('computeCommitScore — monotonicity (no failure ⟹ 1.0)', () => {
  test('all abstain → score 1.0 (a legacy-shaped recipe is never newly penalised)', () => {
    const s = computeCommitScore(sig());
    assert.equal(s.score, 1);
    assert.deepEqual(s.failedSignals, []);
  });

  test('all pass → score 1.0', () => {
    const s = computeCommitScore(sig({ reconcile: 'pass', crossFeed: 'pass', fingerprint: 'pass', secondModel: 'pass' }));
    assert.equal(s.score, 1);
  });

  test('ANY single fail drops below the default threshold', () => {
    for (const key of ['reconcile', 'crossFeed', 'fingerprint', 'secondModel'] as const) {
      const s = computeCommitScore(sig({ [key]: 'fail' }));
      assert.ok(s.score < DEFAULT_COMMIT_THRESHOLD, `${key} fail must drop below threshold (got ${s.score})`);
      assert.deepEqual(s.failedSignals, [key]);
    }
  });

  test('multiple fails stack and floor at 0', () => {
    const s = computeCommitScore(sig({ reconcile: 'fail', crossFeed: 'fail', fingerprint: 'fail', secondModel: 'fail' }));
    assert.equal(s.score, 0);
  });
});

describe('decideCommit — calibrated threshold (Task 4)', () => {
  test('score ≥ threshold AND passes met → commit', () => {
    const d = decideCommit({ score: 1.0, consistentPasses: 1, requiredPasses: 1 });
    assert.equal(d.commit, true);
    assert.equal(d.meetsThreshold, true);
    assert.equal(d.meetsPasses, true);
  });

  test('score below threshold → hold, with a quotable number in the reason', () => {
    const d = decideCommit({ score: 0.7, consistentPasses: 5, requiredPasses: 1 });
    assert.equal(d.commit, false);
    assert.equal(d.meetsThreshold, false);
    assert.match(d.reason, /0\.700 < threshold 0\.99/);
  });

  test('a custom (calibrated) per-family threshold is honoured', () => {
    // A laxer family threshold of 0.6 lets a 0.7 score through.
    assert.equal(decideCommit({ score: 0.7, threshold: 0.6, consistentPasses: 1 }).commit, true);
    // A stricter 0.999 rejects a 0.99 score.
    assert.equal(decideCommit({ score: 0.99, threshold: 0.999, consistentPasses: 1 }).commit, false);
  });
});

describe('decideCommit — pass^N (Task 5)', () => {
  test('default requiredPasses = 1 ⟹ one pass commits (today behaviour)', () => {
    assert.equal(DEFAULT_REQUIRED_PASSES, 1);
    assert.equal(decideCommit({ score: 1, consistentPasses: 1 }).commit, true);
  });

  test('N=2 requires two consistent passes before commit', () => {
    const first = decideCommit({ score: 1, consistentPasses: 1, requiredPasses: 2 });
    assert.equal(first.commit, false);
    assert.equal(first.meetsThreshold, true);
    assert.equal(first.meetsPasses, false);
    assert.match(first.reason, /1\/2 consistent/);

    const second = decideCommit({ score: 1, consistentPasses: 2, requiredPasses: 2 });
    assert.equal(second.commit, true);
  });

  test('a perfect score still cannot commit until pass^N is satisfied', () => {
    assert.equal(decideCommit({ score: 1, consistentPasses: 2, requiredPasses: 3 }).commit, false);
  });
});

describe('valueFingerprint + cross-pass consistency (the pass^N anchor)', () => {
  const rooms = (statuses: string[]) =>
    statuses.map((s, i) => ({ room_number: String(100 + i), status: s }));

  test('two passes of the same recipe → matching fingerprint (counter increments)', () => {
    const fpA = valueFingerprint({ feed: 'getRoomStatus', rows: rooms(['occupied', 'vacant_clean', 'occupied']), keyField: 'room_number', statusField: 'status', rowCount: 42 });
    // Same shape, one extra guest checked in (43 vs 42 — within the same bucket).
    const fpB = valueFingerprint({ feed: 'getRoomStatus', rows: rooms(['occupied', 'vacant_clean', 'occupied']), keyField: 'room_number', statusField: 'status', rowCount: 43 });
    assert.ok(fingerprintsMatch(recipeFingerprintString([fpA]), recipeFingerprintString([fpB])));
  });

  test('a different recipe shape → fingerprint diverges (counter resets)', () => {
    const fpA = valueFingerprint({ feed: 'getRoomStatus', rows: rooms(['occupied', 'vacant_clean']), keyField: 'room_number', statusField: 'status', rowCount: 42 });
    // A wrong re-learn: 5 rooms only (different rowCount bucket) + different vocab.
    const fpB = valueFingerprint({ feed: 'getRoomStatus', rows: rooms(['dirty', 'clean']), keyField: 'room_number', statusField: 'status', rowCount: 5 });
    assert.equal(fingerprintsMatch(recipeFingerprintString([fpA]), recipeFingerprintString([fpB])), false);
  });

  test('a constant key column across ≥3 rows is flagged not-sane (wrong-key smell)', () => {
    const fp = valueFingerprint({
      feed: 'getArrivals',
      rows: [{ pms_reservation_id: 'X' }, { pms_reservation_id: 'X' }, { pms_reservation_id: 'X' }],
      keyField: 'pms_reservation_id',
      rowCount: 3,
    });
    assert.equal(fp.sane, false);
    assert.equal(fp.keyDistinctBucket, 'low');
  });

  test('all-distinct keys are sane with bucket "all"', () => {
    const fp = valueFingerprint({
      feed: 'getArrivals',
      rows: [{ pms_reservation_id: 'A' }, { pms_reservation_id: 'B' }, { pms_reservation_id: 'C' }],
      keyField: 'pms_reservation_id',
      rowCount: 3,
    });
    assert.equal(fp.sane, true);
    assert.equal(fp.keyDistinctBucket, 'all');
  });

  test('fingerprintsMatch is false when either side is missing (no false consistency)', () => {
    assert.equal(fingerprintsMatch(undefined, 'x'), false);
    assert.equal(fingerprintsMatch('x', undefined), false);
    assert.equal(fingerprintsMatch(undefined, undefined), false);
  });
});
