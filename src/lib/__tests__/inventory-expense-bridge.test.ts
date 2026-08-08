// Unit tests for the inventory → Financials expense bridge: invoice-total
// cents math (round once, no per-line drift), the dollars-weighted department
// suggestion, the deterministic per-invoice operation id (the no-double-book
// key), and notes-tag reference recovery for the retry path. Pure functions
// only — no DB, no clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dollarsToCents } from '@/lib/format';
import {
  expenseAmountCentsFromLines,
  expenseOperationIdForInvoice,
  inventoryExpenseNotes,
  invoiceReferenceFromNotesTag,
  suggestExpenseDepartment,
  type BridgeLine,
} from '@/lib/inventory-expense-bridge';

const line = (
  category: BridgeLine['category'],
  quantity: number,
  unitCost: number | null,
): BridgeLine => ({ category, quantity, unitCost });

test('expenseAmountCentsFromLines — sums line dollars and rounds once', () => {
  // 3 × $3.333… (a $10.00 line total split by qty) must come back as $10.00,
  // not 3 × $3.33 = $9.99. Rounding happens once, at the end.
  assert.equal(expenseAmountCentsFromLines([line('housekeeping', 3, 10 / 3)]), 1000);
  // Two thirds-lines that individually round down still sum correctly.
  assert.equal(
    expenseAmountCentsFromLines([
      line('housekeeping', 3, 10 / 3),
      line('breakfast', 3, 20 / 3),
    ]),
    3000,
  );
  assert.equal(expenseAmountCentsFromLines([line('maintenance', 4, 12.5)]), 5000);
});

test('expenseAmountCentsFromLines — rounds a half cent the way the ledger does', () => {
  // A hand-typed three-decimal unit cost lands exactly on a half cent. Postgres
  // stores round(quantity * unit_cost, 2) in exact numeric, so the delivery
  // records $8.58; `Math.round(8.575 * 100)` is 857 because the float is
  // 857.4999999999999, which booked the Checkbook expense a cent light for the
  // same invoice. The canonical converter shifts the decimal in string space.
  assert.equal(expenseAmountCentsFromLines([line('housekeeping', 1, 8.575)]), 858);
  assert.equal(expenseAmountCentsFromLines([line('breakfast', 1, 1.005)]), 101);

  // Stated as the invariant rather than three magic numbers: the booked total
  // is always the canonical conversion of the summed line dollars.
  for (const unitCost of [8.575, 1.005, 2.675, 0.115, 12.345]) {
    assert.equal(
      expenseAmountCentsFromLines([line('housekeeping', 1, unitCost)]),
      dollarsToCents(unitCost),
      `unit cost ${unitCost} diverges from the canonical converter`,
    );
  }
});

test('expenseAmountCentsFromLines — ignores unusable lines instead of guessing', () => {
  assert.equal(expenseAmountCentsFromLines([]), 0);
  assert.equal(expenseAmountCentsFromLines([line('housekeeping', 2, null)]), 0);
  assert.equal(expenseAmountCentsFromLines([line('housekeeping', 0, 5)]), 0);
  assert.equal(expenseAmountCentsFromLines([line('housekeeping', -1, 5)]), 0);
  assert.equal(expenseAmountCentsFromLines([line('housekeeping', 2, -5)]), 0);
  // A bad line never poisons the good ones.
  assert.equal(
    expenseAmountCentsFromLines([line('housekeeping', 2, null), line('breakfast', 1, 4)]),
    400,
  );
});

test('suggestExpenseDepartment — dollars-weighted majority, not line count', () => {
  // Two cheap breakfast lines lose to one expensive maintenance line.
  assert.equal(
    suggestExpenseDepartment([
      line('breakfast', 1, 5),
      line('breakfast', 1, 5),
      line('maintenance', 1, 200),
    ]),
    'maintenance',
  );
  assert.equal(suggestExpenseDepartment([line('breakfast', 10, 3)]), 'breakfast');
  // Custom-tab items map to 'other' rather than a guessed department.
  assert.equal(suggestExpenseDepartment([line('other', 1, 50)]), 'other');
});

test('suggestExpenseDepartment — deterministic default and tie-break', () => {
  // No usable dollars at all → housekeeping (the most common supply invoice).
  assert.equal(suggestExpenseDepartment([]), 'housekeeping');
  assert.equal(suggestExpenseDepartment([line('breakfast', 1, null)]), 'housekeeping');
  // Exact tie resolves in fixed category order, so the suggestion never
  // flip-flops between renders.
  assert.equal(
    suggestExpenseDepartment([line('maintenance', 1, 50), line('breakfast', 1, 50)]),
    'maintenance',
  );
});

test('expenseOperationIdForInvoice — stable, well-formed, and scope-sensitive', async () => {
  const a1 = await expenseOperationIdForInvoice('prop-1', 'Scanned invoice · inv#A1@sysco');
  const a2 = await expenseOperationIdForInvoice('prop-1', 'Scanned invoice · inv#A1@sysco');
  const b = await expenseOperationIdForInvoice('prop-2', 'Scanned invoice · inv#A1@sysco');
  const c = await expenseOperationIdForInvoice('prop-1', 'Scanned invoice · inv#A2@sysco');
  // Same invoice at the same hotel → the same id forever (the dedupe key).
  assert.equal(a1, a2);
  // A different hotel or a different invoice must never collide.
  assert.notEqual(a1, b);
  assert.notEqual(a1, c);
  // Strict UUID shape (version + variant nibbles), accepted by validateUuid.
  const uuidRx = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;
  for (const id of [a1, b, c]) assert.match(id, uuidRx);
});

test('invoiceReferenceFromNotesTag — recovers the reference, refuses legacy tags', () => {
  assert.equal(
    invoiceReferenceFromNotesTag('Scanned invoice · inv#INV-2041@guest supply co'),
    'INV-2041',
  );
  // Legacy unnumbered tag → null (the bridge skips booking rather than
  // booking something it cannot dedupe).
  assert.equal(invoiceReferenceFromNotesTag('Scanned invoice'), null);
  assert.equal(invoiceReferenceFromNotesTag(null), null);
  assert.equal(invoiceReferenceFromNotesTag(undefined), null);
});

test('inventoryExpenseNotes — carries provenance and the tag, no em dashes', () => {
  const notes = inventoryExpenseNotes('Scanned invoice · inv#77@sysco');
  assert.ok(notes.includes('inv#77@sysco'));
  assert.ok(notes.toLowerCase().includes('inventory invoice scan'));
  assert.ok(!notes.includes('—'));
});
