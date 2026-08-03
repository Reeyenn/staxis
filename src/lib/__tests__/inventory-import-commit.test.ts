// The commit planner's rules, and the undo cascade's order.
//
// The undo test watches the REAL orchestration through a fake database, so
// deleting the prediction_log step or moving it after the counts fails here
// rather than in front of a manager holding a foreign-key error.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildImportCommitPlan,
  countedAtFor,
  ImportCommitError,
  type ConfirmedLine,
} from '@/lib/inventory-import/commit';
import {
  decideImportUndo,
  importUndoDeadline,
  runImportUndo,
  undoWindowSentence,
  IMPORT_UNDO_STEPS,
  INVENTORY_IMPORT_UNDO_WINDOW_DAYS,
  type UndoOps,
  type UndoRowRecord,
} from '@/lib/inventory-import/undo';

const TZ = 'America/Chicago';
const TODAY = '2026-08-03';

function line(partial: Partial<ConfirmedLine> = {}): ConfirmedLine {
  return {
    key: 'r1',
    rowIndex: 1,
    name: 'Bath Towel',
    unit: 'each',
    category: 'housekeeping',
    customCategoryId: null,
    unitCostCents: 450,
    vendorName: null,
    quantity: 12,
    parLevel: 40,
    asOfDate: null,
    decision: 'create',
    mergeItemId: null,
    ...partial,
  };
}

function plan(overrides: Partial<Parameters<typeof buildImportCommitPlan>[0]> = {}) {
  return buildImportCommitPlan({
    propertyTimezone: TZ,
    asOfDate: TODAY,
    todayLocal: TODAY,
    lines: [line()],
    existingItemIds: new Set(),
    ...overrides,
  });
}

// ─── The rule the whole feature hangs on ───────────────────────────────────

describe('an old sheet can never reach current stock', () => {
  test('a history-only plan contains no stock updates at all', () => {
    const p = plan({ asOfDate: '2026-05-12' });
    assert.equal(p.mode, 'history_only');
    assert.equal(p.stockUpdates.length, 0);
    // The history is still written; only the shelf is protected.
    assert.equal(p.counts.length, 1);
  });

  test('a recent plan does write stock, or the rule protects nothing', () => {
    const p = plan({ asOfDate: TODAY });
    assert.equal(p.mode, 'current');
    assert.equal(p.stockUpdates.length, 1);
    assert.equal(p.stockUpdates[0].currentStock, 12);
  });

  test('the mode is recomputed here, so a client claiming otherwise is ignored', () => {
    // The input type carries no mode field by design; the only way to get a
    // stock write is a genuinely recent as-of date.
    for (const date of ['2026-05-12', '2026-01-01', '2025-12-31']) {
      assert.equal(plan({ asOfDate: date }).stockUpdates.length, 0, date);
    }
  });

  test('a future as-of date is refused outright', () => {
    assert.throws(
      () => plan({ asOfDate: '2026-08-04' }),
      (e: unknown) => e instanceof ImportCommitError && e.code === 'as_of_date_future',
    );
  });

  test('a merge onto an item counted more recently leaves the shelf alone', () => {
    const countedAt = countedAtFor(TODAY, TZ);
    const later = new Date(new Date(countedAt).getTime() + 3_600_000).toISOString();
    const p = plan({
      lines: [line({ decision: 'merge', mergeItemId: 'item-1' })],
      existingItemIds: new Set(['item-1']),
      lastCountedAtByItem: new Map([['item-1', later]]),
    });
    assert.equal(p.mode, 'current');
    assert.equal(p.stockUpdates.length, 0);
    assert.equal(p.counts.length, 1, 'history is still recorded');
  });

  test('a merge onto an item counted earlier does update the shelf', () => {
    const p = plan({
      lines: [line({ decision: 'merge', mergeItemId: 'item-1' })],
      existingItemIds: new Set(['item-1']),
      lastCountedAtByItem: new Map([['item-1', '2026-01-01T12:00:00.000Z']]),
    });
    assert.equal(p.stockUpdates.length, 1);
  });
});

// ─── Money crosses into the legacy column exactly once ─────────────────────

describe('cents become dollars only at the database edge', () => {
  test('a created item carries dollars, converted from the cents it was read as', () => {
    const p = plan({ lines: [line({ unitCostCents: 2450 })] });
    assert.equal(p.creates[0].unitCostDollars, 24.5);
    assert.equal(p.counts[0].unitCostDollars, 24.5);
  });

  test('a sub-dollar price does not lose its cents', () => {
    const p = plan({ lines: [line({ unitCostCents: 7 })] });
    assert.equal(p.creates[0].unitCostDollars, 0.07);
  });

  test('no price stays no price, and never becomes zero dollars', () => {
    const p = plan({ lines: [line({ unitCostCents: null })] });
    assert.equal(p.creates[0].unitCostDollars, null);
  });

  test('a non-integer cents value is refused rather than rounded silently', () => {
    assert.throws(
      () => plan({ lines: [line({ unitCostCents: 4.5 })] }),
      (e: unknown) => e instanceof ImportCommitError && e.code === 'unit_cost_invalid',
    );
  });
});

// ─── Created items start at zero ───────────────────────────────────────────

describe('imported items are created empty and then counted', () => {
  test('a create carries no starting stock, only a count', () => {
    const p = plan();
    assert.equal(p.creates.length, 1);
    assert.equal('initialStock' in p.creates[0], false);
    assert.equal(p.counts[0].countedStock, 12);
    assert.equal(p.counts[0].createKey, 'r1');
    assert.equal(p.counts[0].itemId, null);
  });

  test('the count is stamped at hotel noon on the as-of date', () => {
    const p = plan({ asOfDate: '2026-05-12' });
    assert.equal(p.counts[0].asOfDate, '2026-05-12');
    // Chicago is UTC-5 in May, so local noon is 17:00Z.
    assert.equal(p.counts[0].countedAt, '2026-05-12T17:00:00.000Z');
  });
});

// ─── Multi-month history ───────────────────────────────────────────────────

describe('a monthly workbook becomes a run of dated counts', () => {
  const points = [
    { asOfDate: '2026-03-31', quantity: 120 },
    { asOfDate: '2026-04-30', quantity: 96 },
    { asOfDate: '2026-05-31', quantity: 140 },
  ];

  test('every month becomes its own count, because pairs are what teach', () => {
    const p = plan({
      asOfDate: '2026-05-31',
      lines: [line({ quantity: 140, historyPoints: points })],
    });
    assert.equal(p.counts.length, 3);
    assert.deepEqual(p.counts.map((c) => c.asOfDate), ['2026-03-31', '2026-04-30', '2026-05-31']);
    assert.deepEqual(p.counts.map((c) => c.countedStock), [120, 96, 140]);
  });

  test('only the newest month can ever touch the shelf', () => {
    const p = plan({
      asOfDate: TODAY,
      lines: [line({ quantity: 140, historyPoints: [...points, { asOfDate: TODAY, quantity: 33 }] })],
    });
    assert.equal(p.stockUpdates.length, 1);
    assert.equal(p.stockUpdates[0].currentStock, 33);
  });

  test('a point dated after the sheet was current is pulled back, never trusted forward', () => {
    const p = plan({
      asOfDate: '2026-05-31',
      lines: [line({ quantity: 10, historyPoints: [{ asOfDate: '2026-12-01', quantity: 999 }] })],
    });
    assert.equal(p.counts.length, 1);
    assert.equal(p.counts[0].asOfDate, '2026-05-31');
  });

  test('two points on the same date collapse to one count', () => {
    const p = plan({
      asOfDate: '2026-05-31',
      lines: [line({
        quantity: 10,
        historyPoints: [
          { asOfDate: '2026-05-31', quantity: 10 },
          { asOfDate: '2026-05-31', quantity: 12 },
        ],
      })],
    });
    assert.equal(p.counts.length, 1);
  });
});

// ─── Refusals ──────────────────────────────────────────────────────────────

describe('the planner refuses what it cannot write safely', () => {
  test('a merge target from another hotel is refused', () => {
    assert.throws(
      () => plan({
        lines: [line({ decision: 'merge', mergeItemId: '00000000-0000-4000-8000-000000000000' })],
        existingItemIds: new Set(['item-1']),
      }),
      (e: unknown) => e instanceof ImportCommitError && e.code === 'merge_target_unknown',
    );
  });

  test('a custom category from another hotel is refused', () => {
    assert.throws(
      () => plan({
        lines: [line({ customCategoryId: 'cat-elsewhere' })],
        customCategoryIds: new Set(['cat-ours']),
      }),
      (e: unknown) => e instanceof ImportCommitError && e.code === 'category_unknown',
    );
  });

  test('two lines merging into one item is refused rather than double-counted', () => {
    assert.throws(
      () => plan({
        lines: [
          line({ key: 'r1', decision: 'merge', mergeItemId: 'item-1' }),
          line({ key: 'r2', rowIndex: 2, name: 'Towel', decision: 'merge', mergeItemId: 'item-1' }),
        ],
        existingItemIds: new Set(['item-1']),
      }),
      (e: unknown) => e instanceof ImportCommitError && e.code === 'merge_target_repeated',
    );
  });

  test('the same new name twice is refused before Postgres has to', () => {
    assert.throws(
      () => plan({
        lines: [line({ key: 'r1' }), line({ key: 'r2', rowIndex: 2, name: 'bath towel' })],
      }),
      (e: unknown) => e instanceof ImportCommitError && e.code === 'duplicate_new_item',
    );
  });

  test('an empty list is refused rather than saved as an empty batch', () => {
    assert.throws(
      () => plan({ lines: [line({ decision: 'skip' })] }),
      (e: unknown) => e instanceof ImportCommitError && e.code === 'nothing_to_import',
    );
  });

  test('a skipped line is recorded, not forgotten', () => {
    const p = plan({
      lines: [line({ key: 'r1' }), line({ key: 'r2', rowIndex: 2, name: 'Soap', decision: 'skip' })],
      skipped: [{ rowIndex: 9, reason: 'total_row', text: 'Total 412' }],
    });
    assert.equal(p.skippedCount, 2);
    assert.ok(p.rows.some((r) => r.rowIndex === 9 && r.outcome === 'skipped'));
    assert.ok(p.rows.some((r) => r.rowIndex === 2 && r.skipReason === 'manager_removed'));
  });
});

// ─── Undo: the window ──────────────────────────────────────────────────────

describe('the undo window', () => {
  const importedAt = new Date('2026-08-01T12:00:00.000Z');

  test('is open inside the window and reports the days left', () => {
    const d = decideImportUndo({ importedAt, now: new Date('2026-08-03T12:00:00.000Z'), undoneAt: null });
    assert.equal(d.ok, true);
    assert.equal(d.daysLeft, INVENTORY_IMPORT_UNDO_WINDOW_DAYS - 2);
  });

  test('closes exactly at the deadline, not a moment later', () => {
    const deadline = importUndoDeadline(importedAt);
    assert.equal(decideImportUndo({ importedAt, now: new Date(deadline.getTime() - 1), undoneAt: null }).ok, true);
    const closed = decideImportUndo({ importedAt, now: deadline, undoneAt: null });
    assert.equal(closed.ok, false);
    assert.equal(closed.reason, 'window_expired');
  });

  test('an already-removed batch cannot be removed twice', () => {
    const d = decideImportUndo({ importedAt, undoneAt: '2026-08-02T00:00:00.000Z', now: new Date('2026-08-03') });
    assert.equal(d.ok, false);
    assert.equal(d.reason, 'already_undone');
  });

  test('the sentence never promises a window that has closed', () => {
    const deadline = importUndoDeadline(importedAt);
    assert.match(
      undoWindowSentence({ importedAt, undoneAt: null, now: new Date('2026-08-03T12:00:00.000Z') }),
      /another 28 days/,
    );
    assert.equal(undoWindowSentence({ importedAt, undoneAt: null, now: deadline }), 'Too long ago to remove in one step.');
    assert.equal(undoWindowSentence({ importedAt, undoneAt: '2026-08-02', now: new Date('2026-08-03') }), 'This import was removed.');
    for (const now of [new Date('2026-08-03'), deadline]) {
      assert.doesNotMatch(undoWindowSentence({ importedAt, undoneAt: null, now }), /—/);
    }
  });
});

// ─── Undo: the cascade ─────────────────────────────────────────────────────

interface FakeState {
  rows: UndoRowRecord[];
  days: Array<{ date: string; prior: Record<string, unknown> }>;
  activity: Record<string, { exists: boolean; currentStock: number; remainingCounts: number; remainingOrders: number }>;
}

function fakeOps(state: FakeState): { ops: UndoOps; calls: string[] } {
  const calls: string[] = [];
  const ops: UndoOps = {
    async loadRows() { calls.push('loadRows'); return state.rows; },
    async deletePredictions(ids) { calls.push(`deletePredictions:${ids.length}`); return ids.length; },
    async deleteCounts(ids) { calls.push(`deleteCounts:${ids.length}`); return ids.length; },
    async loadOccupancyDays() { calls.push('loadOccupancyDays'); return state.days; },
    async restoreDay(day) { calls.push(`restoreDay:${day.date}`); },
    async itemActivity(itemId) {
      calls.push(`itemActivity:${itemId}`);
      return state.activity[itemId] ?? { exists: true, currentStock: 0, remainingCounts: 0, remainingOrders: 0 };
    },
    async deleteItem(itemId) { calls.push(`deleteItem:${itemId}`); },
    async stampBatchUndone() { calls.push('stampBatchUndone'); },
  };
  return { ops, calls };
}

describe('removing an import removes what it taught, in the order Postgres allows', () => {
  test('the ML rows come out before the counts they point at', async () => {
    const { ops, calls } = fakeOps({
      rows: [
        { itemId: 'item-1', createdItem: true, countId: null },
        { itemId: 'item-1', createdItem: false, countId: 'count-1' },
        { itemId: 'item-1', createdItem: false, countId: 'count-2' },
      ],
      days: [],
      activity: {},
    });
    const result = await runImportUndo(ops);
    const predIdx = calls.findIndex((c) => c.startsWith('deletePredictions'));
    const countIdx = calls.findIndex((c) => c.startsWith('deleteCounts'));
    assert.ok(predIdx >= 0, 'the ML derivatives were never deleted');
    assert.ok(countIdx >= 0);
    assert.ok(
      predIdx < countIdx,
      'prediction_log must be deleted BEFORE inventory_counts: its FK is ON DELETE NO ACTION',
    );
    assert.equal(result.removedPredictions, 2);
    assert.equal(result.removedCounts, 2);
  });

  test('the documented step order matches the order that actually runs', () => {
    assert.deepEqual([...IMPORT_UNDO_STEPS], [
      'prediction_log',
      'inventory_counts',
      'daily_logs',
      'inventory',
      'inventory_import_batches',
    ]);
  });

  test('items, history and occupancy days all come out together', async () => {
    const { ops, calls } = fakeOps({
      rows: [
        { itemId: 'item-1', createdItem: true, countId: null },
        { itemId: 'item-1', createdItem: false, countId: 'count-1' },
      ],
      days: [{ date: '2026-03-04', prior: { occupied: null } }, { date: '2026-03-05', prior: { occupied: 41 } }],
      activity: {},
    });
    const result = await runImportUndo(ops);
    assert.equal(result.removedCounts, 1);
    assert.equal(result.restoredDays, 2);
    assert.equal(result.removedItems, 1);
    assert.ok(calls.includes('deleteItem:item-1'));
    assert.equal(calls[calls.length - 1], 'stampBatchUndone');
  });

  test('an item the hotel has started using is kept, not deleted', async () => {
    const { ops, calls } = fakeOps({
      rows: [{ itemId: 'item-1', createdItem: true, countId: null }],
      days: [],
      activity: { 'item-1': { exists: true, currentStock: 0, remainingCounts: 3, remainingOrders: 0 } },
    });
    const result = await runImportUndo(ops);
    assert.equal(result.keptItems, 1);
    assert.equal(result.removedItems, 0);
    assert.equal(calls.includes('deleteItem:item-1'), false);
  });

  test('an item with stock on the shelf is kept', async () => {
    const { ops } = fakeOps({
      rows: [{ itemId: 'item-1', createdItem: true, countId: null }],
      days: [],
      activity: { 'item-1': { exists: true, currentStock: 12, remainingCounts: 0, remainingOrders: 0 } },
    });
    assert.equal((await runImportUndo(ops)).keptItems, 1);
  });

  test('an item that already existed before this import is never touched', async () => {
    const { ops, calls } = fakeOps({
      rows: [{ itemId: 'item-9', createdItem: false, countId: 'count-1' }],
      days: [],
      activity: {},
    });
    const result = await runImportUndo(ops);
    assert.equal(result.removedItems, 0);
    assert.equal(calls.some((c) => c.startsWith('deleteItem')), false);
    assert.equal(calls.some((c) => c.startsWith('itemActivity')), false);
  });

  test('a batch with nothing in it still stamps, and touches nothing else', async () => {
    const { ops, calls } = fakeOps({ rows: [], days: [], activity: {} });
    const result = await runImportUndo(ops);
    assert.deepEqual(calls, ['loadRows', 'loadOccupancyDays', 'stampBatchUndone']);
    assert.equal(result.removedCounts, 0);
  });
});
