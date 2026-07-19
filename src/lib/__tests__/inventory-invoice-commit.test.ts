/**
 * Tests for the invoice commit planner (src/lib/inventory-invoice-commit.ts).
 * Pure logic — no DB. Pins the correctness-critical behaviors from the
 * adversarial review: coalescing by itemId, validation, re-baseline math,
 * the override, and the soft dedupe tag.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommitPlan,
  buildNotesTag,
  invoiceDateFromReceivedAt,
  invoiceAlreadyRecorded,
} from '../inventory-invoice-commit';

const NOW = new Date('2026-05-29T12:00:00');

type Line = Parameters<typeof buildCommitPlan>[0]['lines'][number];
function draft(lines: Line[], extra: Record<string, unknown> = {}) {
  return {
    propertyTimezone: 'America/Chicago',
    vendorName: 'Acme Supply',
    invoiceDate: '2026-05-01',
    invoiceNumber: '5567',
    lines,
    ...extra,
  };
}

describe('buildCommitPlan — validation', () => {
  it('excludes skipped lines', () => {
    const p = buildCommitPlan(draft([{ key: 'a', itemName: 'Towels', decision: 'skip', matchedItemId: '1', qty: '5' }]), NOW);
    assert.equal(p.orders.length, 0);
    assert.equal(p.stockUpdates.length, 0);
    assert.equal(p.creates.length, 0);
  });

  it('drops lines with non-positive / non-numeric qty', () => {
    const p = buildCommitPlan(draft([
      { key: 'a', itemName: 'X', decision: 'match', matchedItemId: '1', qty: '0' },
      { key: 'b', itemName: 'Y', decision: 'match', matchedItemId: '2', qty: 'abc' },
      { key: 'c', itemName: 'Z', decision: 'match', matchedItemId: '3', qty: '-4' },
    ]), NOW);
    assert.equal(p.orders.length, 0);
  });

  it('coerces blank unit cost to undefined and parses a real one', () => {
    const p = buildCommitPlan(draft([
      { key: 'a', itemName: 'X', decision: 'match', matchedItemId: '1', qty: '5', unitCost: '', onHandEstimate: 0 },
      { key: 'b', itemName: 'Y', decision: 'match', matchedItemId: '2', qty: '2', unitCost: '3.50', onHandEstimate: 0 },
    ]), NOW);
    assert.equal(p.orders[0].unitCost, undefined);
    assert.equal(p.orders[1].unitCost, 3.5);
  });

  it('uses the invoice line total as the authoritative purchase amount', () => {
    const p = buildCommitPlan(draft([
      {
        key: 'a', itemName: 'Towels', decision: 'match', matchedItemId: '1',
        qty: '12', unitCost: '2.00', totalCost: '21.60', onHandEstimate: 0,
      },
    ]), NOW);
    assert.equal(p.orders[0].unitCost, 1.8);
    assert.equal(p.orders[0].quantity * (p.orders[0].unitCost ?? 0), 21.6);
  });
});

describe('buildCommitPlan — dates & tag', () => {
  it('converts the hotel-local invoice date using that property timezone', () => {
    const valid = buildCommitPlan(draft([{ key: 'a', itemName: 'X', decision: 'match', matchedItemId: '1', qty: '1', onHandEstimate: 0 }]), NOW);
    assert.equal(valid.receivedAt.toISOString(), '2026-05-01T17:00:00.000Z');

    const winter = buildCommitPlan(draft(
      [{ key: 'a', itemName: 'X', decision: 'match', matchedItemId: '1', qty: '1', onHandEstimate: 0 }],
      { invoiceDate: '2026-01-15' },
    ), NOW);
    assert.equal(winter.receivedAt.toISOString(), '2026-01-15T18:00:00.000Z');
  });

  it('preserves dates east of UTC and restores them in hotel time', () => {
    const plan = buildCommitPlan(draft(
      [{ key: 'a', itemName: 'X', decision: 'match', matchedItemId: '1', qty: '1', onHandEstimate: 0 }],
      { propertyTimezone: 'Pacific/Kiritimati', invoiceDate: '2026-05-01' },
    ), NOW);
    assert.equal(plan.receivedAt.toISOString(), '2026-04-30T22:00:00.000Z');
    assert.equal(invoiceDateFromReceivedAt(plan.receivedAt, 'Pacific/Kiritimati'), '2026-05-01');
    assert.equal(invoiceDateFromReceivedAt('not-an-instant', 'Pacific/Kiritimati'), null);
  });

  it('uses the correct DST offset on transition dates', () => {
    const line: Line = { key: 'a', itemName: 'X', decision: 'match', matchedItemId: '1', qty: '1', onHandEstimate: 0 };
    const spring = buildCommitPlan(draft([line], { invoiceDate: '2026-03-08' }), NOW);
    const fall = buildCommitPlan(draft([line], { invoiceDate: '2026-11-01' }), NOW);
    assert.equal(spring.receivedAt.toISOString(), '2026-03-08T17:00:00.000Z');
    assert.equal(fall.receivedAt.toISOString(), '2026-11-01T18:00:00.000Z');
  });

  it('falls back to now for a blank or invalid calendar date', () => {

    const blank = buildCommitPlan(draft([{ key: 'a', itemName: 'X', decision: 'match', matchedItemId: '1', qty: '1', onHandEstimate: 0 }], { invoiceDate: null }), NOW);
    assert.equal(blank.receivedAt.getTime(), NOW.getTime());

    const garbage = buildCommitPlan(draft([{ key: 'a', itemName: 'X', decision: 'match', matchedItemId: '1', qty: '1', onHandEstimate: 0 }], { invoiceDate: 'not-a-date' }), NOW);
    assert.equal(garbage.receivedAt.getTime(), NOW.getTime());

    const impossible = buildCommitPlan(draft([{ key: 'a', itemName: 'X', decision: 'match', matchedItemId: '1', qty: '1', onHandEstimate: 0 }], { invoiceDate: '2026-02-31' }), NOW);
    assert.equal(impossible.receivedAt.getTime(), NOW.getTime());
  });

  it('builds the dedupe tag with and without an invoice number', () => {
    assert.equal(buildNotesTag('5567', 'Acme Supply'), 'Invoice scan · inv#5567@acme supply');
    assert.equal(buildNotesTag(null, 'Acme'), 'Invoice scan');
    assert.equal(buildNotesTag('', 'Acme'), 'Invoice scan');
  });
});

describe('buildCommitPlan — shapes', () => {
  it('produces a create entry + a linked order for a create line', () => {
    const p = buildCommitPlan(draft([
      { key: 'c1', itemName: 'New Mop', decision: 'create', matchedItemId: null, qty: '12', unitCost: '4', newItem: { category: 'housekeeping', unit: 'each', parLevel: '20' } },
    ]), NOW);
    assert.equal(p.creates.length, 1);
    assert.deepEqual(
      { ...p.creates[0] },
      { createKey: 'c1', name: 'New Mop', category: 'housekeeping', unit: 'each', parLevel: 20, unitCost: 4, initialStock: 12 },
    );
    assert.equal(p.orders.length, 1);
    assert.equal(p.orders[0].itemId, null);
    assert.equal(p.orders[0].createKey, 'c1');
    assert.equal(p.orders[0].quantity, 12);
    assert.equal(p.stockUpdates.length, 0);
  });

  it('drops a create line with an invalid qty', () => {
    const p = buildCommitPlan(draft([
      { key: 'c1', itemName: 'New Mop', decision: 'create', matchedItemId: null, qty: '0', newItem: { category: 'housekeeping', unit: 'each', parLevel: '0' } },
    ]), NOW);
    assert.equal(p.creates.length, 0);
    assert.equal(p.orders.length, 0);
  });

  it('preserves quantity_cases', () => {
    const p = buildCommitPlan(draft([
      { key: 'a', itemName: 'Towels', decision: 'match', matchedItemId: '1', qty: '36', quantityCases: 3, onHandEstimate: 0 },
      { key: 'b', itemName: 'Soap', decision: 'match', matchedItemId: '2', qty: '4', onHandEstimate: 0 },
    ]), NOW);
    assert.equal(p.orders[0].quantityCases, 3);
    assert.equal(p.orders[1].quantityCases, null);
  });
});

describe('buildCommitPlan — stock re-baseline', () => {
  it('coalesces two lines on the same item into ONE stock update', () => {
    const p = buildCommitPlan(draft([
      { key: 'a', itemName: 'Bath Towel', decision: 'match', matchedItemId: 'item1', qty: '5', onHandEstimate: 8 },
      { key: 'b', itemName: 'Bath Towel', decision: 'match', matchedItemId: 'item1', qty: '7', onHandEstimate: 8 },
    ]), NOW);
    assert.equal(p.orders.length, 2); // ledger keeps both lines
    assert.equal(p.stockUpdates.length, 1); // but one stock write
    assert.equal(p.stockUpdates[0].itemId, 'item1');
    assert.equal(p.stockUpdates[0].finalStock, 20); // max(0,round(8)) + (5+7)
  });

  it('rounds the on-hand estimate before adding received qty', () => {
    const p = buildCommitPlan(draft([
      { key: 'a', itemName: 'X', decision: 'match', matchedItemId: '1', qty: '10', onHandEstimate: 7.6 },
    ]), NOW);
    assert.equal(p.stockUpdates[0].finalStock, 18); // round(7.6)=8 + 10
  });

  it('uses an explicit after-override instead of the additive math', () => {
    const p = buildCommitPlan(draft([
      { key: 'a', itemName: 'X', decision: 'match', matchedItemId: '1', qty: '5', onHandEstimate: 8, afterOverride: '50' },
    ]), NOW);
    assert.equal(p.stockUpdates[0].finalStock, 50);
  });
});

describe('invoiceAlreadyRecorded', () => {
  const tag = 'Invoice scan · inv#5567@acme supply';
  it('flags a matching numbered tag in existing notes', () => {
    assert.equal(invoiceAlreadyRecorded(['Reorder list', tag, null], tag), true);
  });
  it('never flags an unnumbered tag (cannot dedupe)', () => {
    assert.equal(invoiceAlreadyRecorded(['Invoice scan'], 'Invoice scan'), false);
  });
  it('returns false when no note matches', () => {
    assert.equal(invoiceAlreadyRecorded(['something else'], tag), false);
  });
});
