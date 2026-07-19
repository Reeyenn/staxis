import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRow,
  effectiveInvoiceUnitCost,
  reviewRowHasCompleteCost,
  type RawInvoiceLine,
} from '../../app/inventory/_components/overlays/scan-review';

const line = (patch: Partial<RawInvoiceLine> = {}): RawInvoiceLine => ({
  item_name: 'Bath towels',
  quantity: 12,
  quantity_cases: null,
  pack_size: null,
  unit_cost: null,
  total_cost: null,
  ...patch,
});

describe('invoice review cost confirmation', () => {
  it('shows the authoritative scanned line total as a visible per-unit cost', () => {
    const row = buildRow(line({ total_cost: 21.6, unit_cost: 2 }), 0, []);
    assert.equal(Number(row.unitCostInput), 1.8);
    assert.equal(row.unitCostDirty, false);
    assert.equal(reviewRowHasCompleteCost(row), true);
  });

  it('requires a usable cost for every received line', () => {
    const row = buildRow(line(), 0, []);
    assert.equal(row.unitCostInput, '');
    assert.equal(reviewRowHasCompleteCost(row), false);
    assert.equal(reviewRowHasCompleteCost({ ...row, decision: 'skip' }), true);
    assert.equal(reviewRowHasCompleteCost({ ...row, unitCostInput: '0' }), true);
  });

  it('recomputes untouched OCR totals when the reviewed quantity changes', () => {
    assert.equal(Number(effectiveInvoiceUnitCost(line({ total_cost: 10 }), 4)), 2.5);
  });
});
