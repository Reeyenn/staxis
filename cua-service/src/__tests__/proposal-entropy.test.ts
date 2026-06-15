/**
 * Semantic-entropy abstain tests (feature/cua-bestclass-verify, Task 2).
 *
 * proposal-entropy.ts is a PURE module (no supabase/anthropic/playwright), so
 * these run with zero bootstrapping — no ws-polyfill / env shim needed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  proposalMeaningKey,
  clusterProposals,
  semanticEntropy,
  chooseConsensusProposal,
  type DiscoveryProposalShape,
} from '../proposal-entropy.js';

const A = (): DiscoveryProposalShape => ({
  candidateIndex: 0,
  jsonPath: 'data.arrivals',
  columns: { pms_reservation_id: 'resvId', arrival_date: 'arrivalDate', departure_date: 'departureDate' },
});
// Same MEANING as A but column order swapped + whitespace → must cluster with A.
const Aprime = (): DiscoveryProposalShape => ({
  candidateIndex: 0,
  jsonPath: ' data.arrivals ',
  columns: { departure_date: ' departureDate', arrival_date: 'arrivalDate ', pms_reservation_id: 'resvId' },
});
// DIFFERENT meaning: the dates are SWAPPED (the exact wrong-but-plausible case).
const B = (): DiscoveryProposalShape => ({
  candidateIndex: 0,
  jsonPath: 'data.arrivals',
  columns: { pms_reservation_id: 'resvId', arrival_date: 'departureDate', departure_date: 'arrivalDate' },
});
// DIFFERENT meaning: different captured array.
const C = (): DiscoveryProposalShape => ({
  candidateIndex: 1,
  jsonPath: 'data.arrivals',
  columns: { pms_reservation_id: 'resvId', arrival_date: 'arrivalDate', departure_date: 'departureDate' },
});

describe('proposalMeaningKey — order/whitespace invariant, swap-sensitive', () => {
  test('column order + whitespace do not change the meaning', () => {
    assert.equal(proposalMeaningKey(A()), proposalMeaningKey(Aprime()));
  });
  test('a date swap IS a different meaning', () => {
    assert.notEqual(proposalMeaningKey(A()), proposalMeaningKey(B()));
  });
  test('a different candidate array IS a different meaning', () => {
    assert.notEqual(proposalMeaningKey(A()), proposalMeaningKey(C()));
  });
  test('null (malformed / {none:true}) collapses to the "none" meaning', () => {
    assert.equal(proposalMeaningKey(null), 'none');
  });
  test('blank-path columns are dropped from the meaning', () => {
    const withBlank: DiscoveryProposalShape = { ...A(), columns: { ...A().columns, room_number: '   ' } };
    assert.equal(proposalMeaningKey(withBlank), proposalMeaningKey(A()));
  });
});

describe('clusterProposals + semanticEntropy', () => {
  test('all-identical → one cluster, entropy 0', () => {
    const clusters = clusterProposals([A(), Aprime(), A()]);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0]!.count, 3);
    assert.equal(semanticEntropy(clusters), 0);
  });
  test('single sample → entropy 0', () => {
    assert.equal(semanticEntropy(clusterProposals([A()])), 0);
  });
  test('maximal disagreement → entropy 1 (every sample distinct)', () => {
    const clusters = clusterProposals([A(), B(), C()]);
    assert.equal(clusters.length, 3);
    assert.equal(semanticEntropy(clusters), 1);
  });
  test('plurality cluster sorts first', () => {
    const clusters = clusterProposals([A(), A(), B()]);
    assert.equal(clusters[0]!.count, 2);
    assert.equal(proposalMeaningKey(clusters[0]!.representative), proposalMeaningKey(A()));
  });
});

describe('chooseConsensusProposal', () => {
  test('N=1 single sample → trivially trusted (today behaviour)', () => {
    const r = chooseConsensusProposal([A()]);
    assert.ok(r.ok);
    assert.equal(r.entropy, 0);
    assert.equal(r.agreement, 1);
    assert.equal(proposalMeaningKey(r.proposal), proposalMeaningKey(A()));
  });

  test('strong majority agree → trusted', () => {
    const r = chooseConsensusProposal([A(), Aprime(), A(), B()], { maxEntropy: 0.9, minDominance: 0.5 });
    assert.ok(r.ok);
    assert.equal(proposalMeaningKey(r.proposal), proposalMeaningKey(A()));
    assert.ok(r.agreement >= 0.75);
  });

  test('ABSTAIN: ambiguous samples (all distinct meanings) → high entropy, no dominant cluster', () => {
    const r = chooseConsensusProposal([A(), B(), C()], { maxEntropy: 0.5, minDominance: 0.5 });
    assert.equal(r.ok, false);
    if (!r.ok) {
      // 3 distinct meanings each count 1 → a tie (no plurality); had they not
      // tied, entropy 1.0 > 0.5 would also abstain. Either is a correct refusal.
      assert.match(r.reason, /tie_no_plurality|entropy_too_high|no_dominant_cluster/);
    }
  });

  test('ABSTAIN: a 50/50 split is a tie with no plurality (even with lax thresholds)', () => {
    // Deliberately lax maxEntropy + minDominance: the explicit tie guard must
    // still abstain rather than pick the arbitrary lexicographic tie-winner.
    const r = chooseConsensusProposal([A(), A(), B(), B()], { maxEntropy: 1, minDominance: 0.1 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'tie_no_plurality');
  });

  test('ABSTAIN: plurality meaning is "none" (model mostly gave up)', () => {
    const r = chooseConsensusProposal([null, null, A()], { maxEntropy: 1, minDominance: 0.3 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'plurality_is_none');
  });

  test('ABSTAIN: fewer samples than required', () => {
    const r = chooseConsensusProposal([A()], { minSamples: 3 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /too_few_samples/);
  });

  test('one swapped sample among agreeing ones is tolerated when below entropy cap', () => {
    // 4 agree, 1 swapped: agreement 0.8 → trust the majority (entropy ~0.72 for
    // an 80/20 two-way split, so the cap must be above that to accept it).
    const r = chooseConsensusProposal([A(), A(), A(), A(), B()], { maxEntropy: 0.8, minDominance: 0.6 });
    assert.ok(r.ok);
    assert.equal(proposalMeaningKey(r.proposal), proposalMeaningKey(A()));
  });
});
