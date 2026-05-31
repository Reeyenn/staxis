/**
 * Tests for the invoice-line → inventory-item name matcher
 * (src/lib/inventory-match.ts). Pure logic, no network/DB.
 *
 * Mid-range scores are asserted relative to the exported thresholds rather
 * than as brittle floats, so a deliberate retune stays green while an
 * accidental regression (exact stops auto-selecting, generic-only starts
 * matching) fails loud.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName,
  tokenize,
  scoreNames,
  matchInvoiceLine,
  STRONG_THRESHOLD,
  WEAK_FLOOR,
  AMBIGUITY_DELTA,
  MAX_CANDIDATES,
} from '../inventory-match';

describe('normalizeName', () => {
  it('strips accents and lowercases', () => {
    assert.equal(normalizeName('Café Crème'), 'cafe creme');
  });
  it('turns punctuation into spaces and collapses whitespace', () => {
    assert.equal(normalizeName('Bath-Towel,  27"'), 'bath towel 27');
    assert.equal(normalizeName('  Hand   Soap '), 'hand soap');
  });
  it('handles empty input', () => {
    assert.equal(normalizeName(''), '');
  });
});

describe('tokenize', () => {
  it('singularizes long plural tokens only', () => {
    assert.deepEqual(tokenize('bath towels'), ['bath', 'towel']);
    // "gas" (short), "glass" (ss), "12pk" (numeric) are left intact
    assert.deepEqual(tokenize('gas glass 12pk'), ['gas', 'glass', '12pk']);
  });
  it('returns [] for empty', () => {
    assert.deepEqual(tokenize(''), []);
  });
});

describe('scoreNames', () => {
  it('scores identical normalized names at 1', () => {
    assert.equal(scoreNames('Paper Towels', 'paper towels'), 1);
  });
  it('scores a noisy vendor variant as a strong match', () => {
    assert.ok(scoreNames('Bath Towels', 'Bath Towel 27x54 White') >= STRONG_THRESHOLD);
    assert.ok(scoreNames('Bounty Paper Towels 12pk', 'Paper Towels') >= STRONG_THRESHOLD);
  });
  it('keeps generic-only overlap below the floor', () => {
    assert.ok(scoreNames('White Towel', 'White Cups') < WEAK_FLOOR);
  });
  it('scores zero when nothing overlaps', () => {
    assert.equal(scoreNames('Coffee Pods', 'Bath Towels'), 0);
  });
});

describe('matchInvoiceLine', () => {
  const items = [
    { id: '1', name: 'Paper Towels' },
    { id: '2', name: 'Hand Soap' },
    { id: '3', name: 'Coffee Pods' },
  ];

  it('auto-selects an exact match', () => {
    const r = matchInvoiceLine('Paper Towels', items);
    assert.equal(r.best?.id, '1');
    assert.equal(r.best?.tier, 'exact');
    assert.equal(r.autoSelect, true);
    assert.equal(r.ambiguous, false);
  });

  it('auto-selects a case/accent-only difference as normalized', () => {
    const r = matchInvoiceLine('PAPER TOWELS', items);
    assert.equal(r.best?.id, '1');
    assert.equal(r.best?.tier, 'normalized');
    assert.equal(r.autoSelect, true);
  });

  it('auto-selects a strong, non-risky vendor variant', () => {
    const r = matchInvoiceLine('Bounty Paper Towels 12pk', [{ id: '1', name: 'Paper Towels' }]);
    assert.equal(r.best?.id, '1');
    assert.equal(r.best?.tier, 'strong');
    assert.equal(r.autoSelect, true);
  });

  it('does NOT auto-select an ambiguous near-tie', () => {
    const r = matchInvoiceLine('Bath Towel', [
      { id: '1', name: 'Bath Towel Blue' },
      { id: '2', name: 'Bath Towel White' },
    ]);
    assert.equal(r.ambiguous, true);
    assert.equal(r.autoSelect, false);
    assert.ok(r.candidates[0].score - r.candidates[1].score < AMBIGUITY_DELTA);
  });

  it('does NOT auto-select a risky short single-token name', () => {
    const r = matchInvoiceLine('Soap', [{ id: '2', name: 'Hand Soap' }]);
    assert.equal(r.best?.id, '2'); // still a candidate to confirm
    assert.equal(r.autoSelect, false);
  });

  it('does NOT auto-select when units conflict (case vs each)', () => {
    const r = matchInvoiceLine('Paper Towel Case', [{ id: '1', name: 'Paper Towel Each' }]);
    assert.equal(r.best?.id, '1');
    assert.equal(r.autoSelect, false);
  });

  it('returns no candidates when nothing clears the floor', () => {
    const r = matchInvoiceLine('Zebra Print Umbrella', items);
    assert.equal(r.best, null);
    assert.deepEqual(r.candidates, []);
    assert.equal(r.autoSelect, false);
  });

  it('sorts candidates desc and caps at MAX_CANDIDATES', () => {
    const many = ['Bath', 'Hand', 'Pool', 'Beach', 'Gym', 'Spa', 'Face'].map((p, i) => ({
      id: String(i),
      name: `${p} Towel`,
    }));
    const r = matchInvoiceLine('Towel', many);
    assert.equal(r.candidates.length, MAX_CANDIDATES);
    for (let i = 1; i < r.candidates.length; i++) {
      assert.ok(r.candidates[i - 1].score >= r.candidates[i].score);
    }
  });

  it('handles empty inventory', () => {
    const r = matchInvoiceLine('Paper Towels', []);
    assert.equal(r.best, null);
    assert.equal(r.autoSelect, false);
  });

  it('pins the tuning thresholds', () => {
    assert.equal(STRONG_THRESHOLD, 0.62);
    assert.equal(WEAK_FLOOR, 0.34);
    assert.equal(AMBIGUITY_DELTA, 0.08);
    assert.equal(MAX_CANDIDATES, 5);
  });
});
