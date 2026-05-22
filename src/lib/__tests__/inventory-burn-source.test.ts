/**
 * Tests for `selectBurnRate` (Phase 4 honesty audit).
 *
 * Pins the four-way classification of every item's burn rate:
 *   ml             → ML model wrote a positive prediction
 *   rule-occupancy → operator-configured usagePerCheckout/usagePerStayover
 *   fallback-60d   → par level / 60 (no rule, no model, but item has par)
 *   no-data        → nothing — burn=1/day so daysLeft math doesn't NaN, but
 *                    the UI renders em-dash rather than the number.
 *
 * Boundary cases: rate=0 doesn't count as ML, par=0 falls through to no-data,
 * occ multiplier is applied for rule-occupancy.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectBurnRate } from '../inventory-predictions';

const ITEM_BASE = {
  id: 'item-1',
  usagePerCheckout: null as number | null,
  usagePerStayover: null as number | null,
  parLevel: null as number | null,
};

describe('selectBurnRate — ml branch', () => {
  it('picks ML rate when positive and present', () => {
    const result = selectBurnRate(ITEM_BASE, 2.5, 30);
    assert.equal(result.burnSource, 'ml');
    assert.equal(result.burnPerDay, 2.5);
    assert.equal(result.burn, 2.5);
    assert.equal(result.burnUnit, '/day');
  });

  it('treats mlRate=0 as "no ML signal" and falls through (NOT ml)', () => {
    // ml=0 isn't a "predicted zero" — it's "no data". Behaviorally indistinct
    // from undefined; both should fall through to rule/par/no-data.
    const item = { ...ITEM_BASE, usagePerCheckout: 0.1 };
    const result = selectBurnRate(item, 0, 30);
    assert.equal(result.burnSource, 'rule-occupancy');
  });

  it('treats mlRate=undefined as "no ML signal"', () => {
    const item = { ...ITEM_BASE, parLevel: 60 };
    const result = selectBurnRate(item, undefined, 1);
    assert.equal(result.burnSource, 'fallback-60d');
  });

  it('treats mlRate=NaN as "no ML signal" (gracefully)', () => {
    const item = { ...ITEM_BASE, parLevel: 120 };
    const result = selectBurnRate(item, NaN, 1);
    assert.equal(result.burnSource, 'fallback-60d');
  });
});

describe('selectBurnRate — rule-occupancy branch', () => {
  it('uses max(perCheckout, perStayover) and multiplies by occRoomsPerDay', () => {
    const item = { ...ITEM_BASE, usagePerCheckout: 0.5, usagePerStayover: 0.1 };
    const result = selectBurnRate(item, undefined, 20);
    assert.equal(result.burnSource, 'rule-occupancy');
    assert.equal(result.burn, 0.5);                 // per-occ-room rate
    assert.equal(result.burnPerDay, 0.5 * 20);      // multiplied by occ
    assert.equal(result.burnUnit, '/occ-room');
  });

  it('fires even when only usagePerStayover is configured', () => {
    const item = { ...ITEM_BASE, usagePerStayover: 0.3 };
    const result = selectBurnRate(item, undefined, 10);
    assert.equal(result.burnSource, 'rule-occupancy');
    assert.equal(result.burn, 0.3);
  });

  it('respects ml > 0 over a configured rule', () => {
    // ml wins over rule when both exist.
    const item = { ...ITEM_BASE, usagePerCheckout: 0.5 };
    const result = selectBurnRate(item, 1.7, 20);
    assert.equal(result.burnSource, 'ml');
    assert.equal(result.burnPerDay, 1.7);
  });

  it('treats per-checkout/per-stayover of 0 as "no rule"', () => {
    const item = { ...ITEM_BASE, usagePerCheckout: 0, usagePerStayover: 0, parLevel: 60 };
    const result = selectBurnRate(item, undefined, 10);
    assert.equal(result.burnSource, 'fallback-60d');
  });

  it('clamps occRoomsPerDay to >= 1 (no zero-occupancy divide-by-zero)', () => {
    const item = { ...ITEM_BASE, usagePerCheckout: 0.5 };
    const result = selectBurnRate(item, undefined, 0);
    assert.equal(result.burnSource, 'rule-occupancy');
    assert.equal(result.burnPerDay, 0.5);            // 0.5 × max(0, 1)
  });
});

describe('selectBurnRate — fallback-60d branch', () => {
  it('uses par/60 when no rule and no ML', () => {
    const item = { ...ITEM_BASE, parLevel: 120 };
    const result = selectBurnRate(item, undefined, 30);
    assert.equal(result.burnSource, 'fallback-60d');
    assert.equal(result.burn, 2.0);                  // 120/60
    assert.equal(result.burnPerDay, 2.0);
    assert.equal(result.burnUnit, '/day');
  });

  it('treats par=0 as no-data, not fallback-60d (no signal at all)', () => {
    const item = { ...ITEM_BASE, parLevel: 0 };
    const result = selectBurnRate(item, undefined, 30);
    assert.equal(result.burnSource, 'no-data');
  });
});

describe('selectBurnRate — no-data branch', () => {
  it('returns burn=1, no-data when nothing is configured', () => {
    const result = selectBurnRate(ITEM_BASE, undefined, 30);
    assert.equal(result.burnSource, 'no-data');
    assert.equal(result.burn, 1);
    assert.equal(result.burnPerDay, 1);
    assert.equal(result.burnUnit, '/day');
  });

  it('returns burn=1, no-data for null parLevel + null rules', () => {
    const result = selectBurnRate(
      { id: 'x', usagePerCheckout: null, usagePerStayover: null, parLevel: null },
      undefined,
      30,
    );
    assert.equal(result.burnSource, 'no-data');
  });
});

describe('selectBurnRate — priority order', () => {
  it('ml > rule > fallback-60d > no-data when all signals present', () => {
    const item = {
      id: 'item',
      usagePerCheckout: 0.5,
      usagePerStayover: 0.3,
      parLevel: 60,
    };
    // ml wins
    assert.equal(selectBurnRate(item, 2.0, 10).burnSource, 'ml');
    // no ml → rule wins over fallback
    assert.equal(selectBurnRate(item, undefined, 10).burnSource, 'rule-occupancy');
    // strip rules → fallback wins over no-data
    assert.equal(
      selectBurnRate(
        { ...item, usagePerCheckout: 0, usagePerStayover: 0 },
        undefined,
        10,
      ).burnSource,
      'fallback-60d',
    );
    // strip par → no-data
    assert.equal(
      selectBurnRate(
        { ...item, usagePerCheckout: 0, usagePerStayover: 0, parLevel: 0 },
        undefined,
        10,
      ).burnSource,
      'no-data',
    );
  });
});
