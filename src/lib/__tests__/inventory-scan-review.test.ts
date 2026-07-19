import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRow,
  effectiveInvoiceUnitCost,
  invoiceReviewHasUnsavedWork,
  reviewRowHasCompleteCost,
  reviewRowHasCompleteNewItem,
  reviewRowIsReady,
  type RawInvoiceLine,
} from '../../app/inventory/_components/overlays/scan-review';
import type { DisplayItem } from '../../app/inventory/_components/types';

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

const display = (items: Array<{ id: string; name: string; estimated?: number }>) => items.map((item) => ({
  ...item,
  estimated: item.estimated ?? 0,
})) as unknown as DisplayItem[];

describe('invoice review match safety', () => {
  it('blocks a low-confidence suggested SKU until a manager confirms or rematches it', () => {
    const row = buildRow(
      line({ item_name: 'Bath linen', unit_cost: 2 }),
      0,
      display([{ id: 'towels', name: 'Bath towels', estimated: 4 }]),
    );
    assert.equal(row.decision, 'match');
    assert.equal(row.ambiguous, false);
    assert.equal(row.matchConfirmed, false);
    assert.equal(reviewRowIsReady(row), false);
    assert.equal(reviewRowIsReady({ ...row, matchConfirmed: true }), true);
  });

  it('blocks tied matches but allows conservative exact auto-matches', () => {
    const tied = buildRow(
      line({ item_name: 'Bath towel', unit_cost: 2 }),
      0,
      display([
        { id: 'white', name: 'Bath towel white' },
        { id: 'blue', name: 'Bath towel blue' },
      ]),
    );
    assert.equal(tied.ambiguous, true);
    assert.equal(tied.matchConfirmed, false);
    assert.equal(reviewRowIsReady(tied), false);

    const exact = buildRow(
      line({ item_name: 'Bath towels', unit_cost: 2 }),
      1,
      display([{ id: 'towels', name: 'Bath towels' }]),
    );
    assert.equal(exact.matchConfirmed, true);
    assert.equal(reviewRowIsReady(exact), true);
  });

  it('requires complete visible fields for an invoice-created item', () => {
    const row = buildRow(line({ item_name: 'New bath mat', unit_cost: 5 }), 0, []);
    assert.equal(row.decision, 'create');
    assert.equal(row.newPar, '');
    assert.equal(row.newSetAside, '0');
    assert.equal(row.newCustomCategoryId, null);
    assert.equal(reviewRowHasCompleteNewItem(row), false);
    assert.equal(reviewRowIsReady(row), false);
    assert.equal(reviewRowIsReady({ ...row, newPar: '12' }), true);
    assert.equal(reviewRowIsReady({ ...row, newName: '', newPar: '12' }), false);
    assert.equal(reviewRowIsReady({ ...row, newPar: '12', newSetAside: '13' }), false);
  });
});

describe('invoice review unsaved-work guard', () => {
  it('protects staged/scanned work but does not warn after a successful save', () => {
    assert.equal(invoiceReviewHasUnsavedWork({ phase: 'upload', hasStagedFile: true, rowCount: 0 }), true);
    assert.equal(invoiceReviewHasUnsavedWork({ phase: 'review', hasStagedFile: false, rowCount: 2 }), true);
    assert.equal(invoiceReviewHasUnsavedWork({ phase: 'done', hasStagedFile: false, rowCount: 2 }), false);
  });
});
