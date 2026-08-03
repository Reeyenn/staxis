// Behaviour tests for the import draft: the as-of rule, money, merges, unit
// conflicts and the skipped-rows sentence. Every case here is one a plausible
// bug would break — the bar from CLAUDE.md — not a restatement of the source.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildImportDraft,
  buildSkippedSentence,
  decideAsOfMode,
  daysBetweenIso,
  modeSentenceFor,
  RECENT_AS_OF_MAX_AGE_DAYS,
  type ExistingItem,
  type RawImportRow,
} from '@/lib/inventory-import/draft';
import {
  dollarsToCents,
  centsToDollars,
  formatCents,
  isPlausibleUnitCostCents,
  parseMoneyToCents,
} from '@/lib/inventory-import/money';
import { canonicalUnit, displayUnit, findUnitConflicts } from '@/lib/inventory-import/units';

const TODAY = '2026-08-03';

function row(partial: Partial<RawImportRow> & { rowIndex: number }): RawImportRow {
  return { name: 'Bath Towel', ...partial };
}

function existing(name: string, id: string, unit: string | null = 'each'): ExistingItem {
  return { id, name, unit, category: 'housekeeping', customCategoryId: null };
}

// ─── Money is cents, in one direction, forever ─────────────────────────────

describe('import money conversion', () => {
  test('reads the shapes a person types into a spreadsheet', () => {
    assert.equal(parseMoneyToCents('$24.50'), 2450);
    assert.equal(parseMoneyToCents('24.5'), 2450);
    assert.equal(parseMoneyToCents('1,234.56'), 123456);
    assert.equal(parseMoneyToCents('$1,234'), 123400);
    assert.equal(parseMoneyToCents(4.5), 450);
    assert.equal(parseMoneyToCents('$4.50/ea'), 450);
    assert.equal(parseMoneyToCents('4.50 each'), 450);
    assert.equal(parseMoneyToCents('12.99 USD'), 1299);
  });

  test('refuses what it cannot read rather than guessing a number', () => {
    assert.equal(parseMoneyToCents(''), null);
    assert.equal(parseMoneyToCents('n/a'), null);
    assert.equal(parseMoneyToCents('see invoice'), null);
    assert.equal(parseMoneyToCents(null), null);
    assert.equal(parseMoneyToCents(Number.NaN), null);
  });

  test('a negative price is never accepted as a unit cost', () => {
    assert.equal(parseMoneyToCents('(4.50)'), -450);
    assert.equal(parseMoneyToCents('-4.50'), -450);
    assert.equal(isPlausibleUnitCostCents(parseMoneyToCents('(4.50)')), false);
    assert.equal(isPlausibleUnitCostCents(parseMoneyToCents('-4.50')), false);
  });

  test('float artifacts never shave a cent off', () => {
    // 1.005 * 100 is 100.49999999999999 in IEEE-754; a naive round gives 100.
    assert.equal(dollarsToCents(1.005), 101);
    assert.equal(dollarsToCents(8.115), 812);
    assert.equal(dollarsToCents(0.07), 7);
    assert.equal(dollarsToCents(1.1 + 2.2), 330);
  });

  test('the round trip through the legacy dollars column is lossless', () => {
    for (const cents of [1, 7, 99, 100, 2450, 123456, 9_999_999]) {
      assert.equal(dollarsToCents(centsToDollars(cents)), cents, `cents ${cents} did not survive`);
    }
  });

  test('a price above the sanity ceiling is not carried into the draft', () => {
    assert.equal(isPlausibleUnitCostCents(parseMoneyToCents('$250,000.00')), false);
    assert.equal(isPlausibleUnitCostCents(parseMoneyToCents('$99,000.00')), true);
    assert.equal(isPlausibleUnitCostCents(0), false);
  });

  test('display never renders a cents value as if it were dollars', () => {
    assert.equal(formatCents(2450), '$24.50');
    assert.equal(formatCents(7), '$0.07');
    assert.equal(formatCents(123456), '$1,234.56');
  });

  test('a draft line carries cents, not the dollars the sheet printed', () => {
    const draft = buildImportDraft({
      rows: [row({ rowIndex: 1, name: 'Bath Towel', unit: 'each', unitCost: '$4.50', quantity: '12' })],
      existingItems: [],
      customCategories: [],
      asOfDate: TODAY,
      todayLocal: TODAY,
    });
    assert.equal(draft.lines.length, 1);
    assert.equal(draft.lines[0].unitCostCents, 450);
  });
});

// ─── The as-of rule ────────────────────────────────────────────────────────

describe('the as-of date decides where quantities land', () => {
  test('a sheet inside the recent window may set current counts', () => {
    assert.equal(decideAsOfMode(TODAY, TODAY), 'current');
    assert.equal(decideAsOfMode('2026-07-31', TODAY), 'current');
    assert.equal(daysBetweenIso('2026-07-27', TODAY), RECENT_AS_OF_MAX_AGE_DAYS);
    assert.equal(decideAsOfMode('2026-07-27', TODAY), 'current');
  });

  test('a sheet one day past the window is history, not stock', () => {
    assert.equal(decideAsOfMode('2026-07-26', TODAY), 'history_only');
    assert.equal(decideAsOfMode('2026-05-12', TODAY), 'history_only');
  });

  test('a future date is treated as history, never as permission', () => {
    // A typo'd year must not become a licence to overwrite the shelf.
    assert.equal(decideAsOfMode('2027-01-01', TODAY), 'history_only');
  });

  test('old quantities cannot be aimed at current stock', () => {
    const draft = buildImportDraft({
      rows: [row({ rowIndex: 1, name: 'Bath Towel', unit: 'each', quantity: '40' })],
      existingItems: [],
      customCategories: [],
      asOfDate: '2026-05-12',
      todayLocal: TODAY,
    });
    assert.equal(draft.mode, 'history_only');
    assert.equal(draft.lines[0].quantityTarget, 'history_only');
    assert.notEqual(draft.lines[0].quantityTarget, 'current_stock');
  });

  test('a recent sheet does aim at current stock, or the mode means nothing', () => {
    const draft = buildImportDraft({
      rows: [row({ rowIndex: 1, name: 'Bath Towel', unit: 'each', quantity: '40' })],
      existingItems: [],
      customCategories: [],
      asOfDate: TODAY,
      todayLocal: TODAY,
    });
    assert.equal(draft.mode, 'current');
    assert.equal(draft.lines[0].quantityTarget, 'current_stock');
  });

  test('the sentence names the date and says plainly which mode it is', () => {
    const old = modeSentenceFor('history_only', '2026-05-12', TODAY);
    assert.match(old, /May 12, 2026/);
    assert.match(old, /history/i);
    assert.match(old, /fresh count/i);

    const now = modeSentenceFor('current', TODAY, TODAY);
    assert.match(now, /on-hand counts/i);
    assert.doesNotMatch(now, /history/i);
  });

  test('no user-facing sentence carries an em dash', () => {
    for (const date of ['2026-05-12', '2026-07-31', TODAY]) {
      const mode = decideAsOfMode(date, TODAY);
      assert.doesNotMatch(modeSentenceFor(mode, date, TODAY), /—/);
    }
  });
});

// ─── Merge proposals ───────────────────────────────────────────────────────

describe('merge proposals', () => {
  test('an exact name match proposes a merge and is confident', () => {
    const draft = buildImportDraft({
      rows: [row({ rowIndex: 1, name: 'Bath Towel', unit: 'each', quantity: '12' })],
      existingItems: [existing('Bath Towel', 'item-1')],
      customCategories: [],
      asOfDate: TODAY,
      todayLocal: TODAY,
    });
    assert.equal(draft.lines[0].action, 'merge');
    assert.equal(draft.lines[0].merge?.itemId, 'item-1');
    assert.equal(draft.lines[0].merge?.confident, true);
  });

  test('the same item under a different name is proposed but not auto-confident', () => {
    const draft = buildImportDraft({
      rows: [row({ rowIndex: 1, name: 'Bounty Paper Towels 12pk', unit: 'case', quantity: '3' })],
      existingItems: [existing('Paper Towels', 'item-2', 'case')],
      customCategories: [],
      asOfDate: TODAY,
      todayLocal: TODAY,
    });
    assert.equal(draft.lines[0].action, 'merge');
    assert.equal(draft.lines[0].merge?.itemId, 'item-2');
    assert.equal(draft.lines[0].merge?.confident, false);
  });

  test('a genuinely new item proposes create, not a bad merge', () => {
    const draft = buildImportDraft({
      rows: [row({ rowIndex: 1, name: 'Pool Chlorine Tablets', unit: 'bucket', quantity: '2' })],
      existingItems: [existing('Bath Towel', 'item-1'), existing('Coffee Pods', 'item-3')],
      customCategories: [],
      asOfDate: TODAY,
      todayLocal: TODAY,
    });
    assert.equal(draft.lines[0].action, 'create');
    assert.equal(draft.lines[0].merge, null);
  });

  test('a unit disagreement with the existing item blocks confidence', () => {
    const draft = buildImportDraft({
      rows: [row({ rowIndex: 1, name: 'Bath Towel', unit: 'case', quantity: '4' })],
      existingItems: [existing('Bath Towel', 'item-1', 'each')],
      customCategories: [],
      asOfDate: TODAY,
      todayLocal: TODAY,
    });
    assert.equal(draft.lines[0].merge?.confident, false);
    assert.deepEqual(draft.lines[0].merge?.unitDisagreement, { ours: 'each', theirs: 'case' });
  });

  test('a merged line keeps the shelf the hotel already put the item on', () => {
    const draft = buildImportDraft({
      rows: [row({ rowIndex: 1, name: 'Coffee Pods', category: 'housekeeping', unit: 'box', quantity: '5' })],
      existingItems: [{
        id: 'item-9', name: 'Coffee Pods', unit: 'box',
        category: 'breakfast', customCategoryId: null,
      }],
      customCategories: [],
      asOfDate: TODAY,
      todayLocal: TODAY,
    });
    assert.equal(draft.lines[0].category, 'breakfast');
  });

  test('the same item twice in one file folds into one line', () => {
    const draft = buildImportDraft({
      rows: [
        row({ rowIndex: 1, name: 'Bath Towel', unit: 'each', quantity: '10' }),
        row({ rowIndex: 2, name: 'bath  towel', unit: 'each', quantity: '5' }),
      ],
      existingItems: [],
      customCategories: [],
      asOfDate: TODAY,
      todayLocal: TODAY,
    });
    assert.equal(draft.lines.length, 1);
    assert.equal(draft.lines[0].quantity, 15);
    assert.equal(draft.skipped.filter((s) => s.reason === 'duplicate_in_file').length, 1);
  });
});

// ─── Unit conflicts across months ──────────────────────────────────────────

describe('unit conflicts across months', () => {
  test('canonicalizes the spellings sheets actually use', () => {
    assert.equal(canonicalUnit('CS'), 'case');
    assert.equal(canonicalUnit('cases'), 'case');
    assert.equal(canonicalUnit('EA.'), 'each');
    assert.equal(canonicalUnit('12 pk'), 'pack');
    assert.equal(canonicalUnit(''), null);
    assert.equal(canonicalUnit('gross'), null);
    // An unrecognized unit is kept, never coerced into "each".
    assert.equal(displayUnit('gross'), 'gross');
    assert.equal(displayUnit(''), 'each');
  });

  test('March saying cases and June saying each is flagged, with the newer unit proposed', () => {
    const conflicts = findUnitConflicts([
      { itemKey: 'bath towel', itemName: 'Bath Towel', rawUnit: 'cases', asOfDate: '2026-03-31' },
      { itemKey: 'bath towel', itemName: 'Bath Towel', rawUnit: 'each', asOfDate: '2026-06-30' },
    ]);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].proposedUnit, 'each');
    assert.equal(conflicts[0].changesQuantity, true);
    assert.match(conflicts[0].message, /March 2026 says case/);
    assert.match(conflicts[0].message, /June 2026 says each/);
    assert.doesNotMatch(conflicts[0].message, /—/);
  });

  test('two spellings of the same unit are not a conflict', () => {
    const conflicts = findUnitConflicts([
      { itemKey: 'bath towel', itemName: 'Bath Towel', rawUnit: 'CS', asOfDate: '2026-03-31' },
      { itemKey: 'bath towel', itemName: 'Bath Towel', rawUnit: 'cases', asOfDate: '2026-06-30' },
    ]);
    assert.equal(conflicts.length, 0);
  });

  test('two containers disagreeing is flagged but does not claim to change counts', () => {
    const conflicts = findUnitConflicts([
      { itemKey: 'towel', itemName: 'Towel', rawUnit: 'case', asOfDate: '2026-03-31' },
      { itemKey: 'towel', itemName: 'Towel', rawUnit: 'box', asOfDate: '2026-06-30' },
    ]);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].changesQuantity, false);
  });

  test('different items never bleed into each other', () => {
    const conflicts = findUnitConflicts([
      { itemKey: 'towel', itemName: 'Towel', rawUnit: 'case', asOfDate: '2026-03-31' },
      { itemKey: 'soap', itemName: 'Soap', rawUnit: 'each', asOfDate: '2026-06-30' },
    ]);
    assert.equal(conflicts.length, 0);
  });

  test('a draft over a multi-month workbook surfaces the conflict', () => {
    const draft = buildImportDraft({
      rows: [
        row({ rowIndex: 1, name: 'Bath Towel', unit: 'cases', quantity: '4', asOfDate: '2026-03-31' }),
        row({ rowIndex: 2, name: 'Bath Towel', unit: 'each', quantity: '96', asOfDate: '2026-06-30' }),
      ],
      existingItems: [],
      customCategories: [],
      asOfDate: '2026-06-30',
      todayLocal: TODAY,
    });
    assert.equal(draft.unitConflicts.length, 1);
    assert.equal(draft.unitConflicts[0].proposedUnit, 'each');
  });
});

// ─── Honesty about what was left out ───────────────────────────────────────

describe('skipped rows are named, never silently dropped', () => {
  test('totals, headings and notes are recognized and counted', () => {
    const draft = buildImportDraft({
      rows: [
        row({ rowIndex: 1, name: 'Item', unit: 'Unit', quantity: 'Qty', unitCost: 'Price' }),
        row({ rowIndex: 2, name: 'Bath Towel', unit: 'each', quantity: '12' }),
        row({ rowIndex: 3, name: 'Total', quantity: '412' }),
        row({ rowIndex: 4, name: 'Subtotal', quantity: '212' }),
        row({ rowIndex: 5, name: 'Notes: reorder before the holiday' }),
        row({ rowIndex: 6, name: '' }),
        row({ rowIndex: 7, name: 'HOUSEKEEPING' }),
      ],
      existingItems: [],
      customCategories: [],
      asOfDate: TODAY,
      todayLocal: TODAY,
    });
    assert.equal(draft.lines.length, 1);
    assert.equal(draft.counts.skipped, 6);
    assert.equal(draft.skipped.filter((s) => s.reason === 'total_row').length, 2);
    assert.equal(draft.skipped.filter((s) => s.reason === 'header_row').length, 1);
    assert.equal(draft.skipped.filter((s) => s.reason === 'note_row').length, 2);
    assert.equal(draft.skipped.filter((s) => s.reason === 'no_name').length, 1);
  });

  test('the sentence states the real number and names the kinds', () => {
    const sentence = buildSkippedSentence([
      { rowIndex: 3, reason: 'total_row', text: 'Total' },
      { rowIndex: 4, reason: 'total_row', text: 'Subtotal' },
      { rowIndex: 5, reason: 'note_row', text: 'Notes' },
    ]);
    assert.equal(sentence, 'Skipped 3 rows: totals and notes.');
  });

  test('a single skipped row reads as a row, not rows', () => {
    assert.equal(
      buildSkippedSentence([{ rowIndex: 3, reason: 'total_row', text: 'Total' }]),
      'Skipped 1 row: totals.',
    );
  });

  test('nothing skipped says nothing at all', () => {
    assert.equal(buildSkippedSentence([]), '');
  });

  test('the count in the sentence always matches the rows behind it', () => {
    const draft = buildImportDraft({
      rows: [
        row({ rowIndex: 1, name: 'Total' }),
        row({ rowIndex: 2, name: 'Bath Towel', unit: 'each', quantity: '2' }),
        row({ rowIndex: 3, name: 'Notes' }),
      ],
      existingItems: [],
      customCategories: [],
      asOfDate: TODAY,
      todayLocal: TODAY,
    });
    const stated = Number(/Skipped (\d+)/.exec(draft.skippedSentence)?.[1]);
    assert.equal(stated, draft.skipped.length);
    assert.equal(stated, draft.counts.skipped);
  });

  test('a row the reader itself refused is carried through, not lost', () => {
    const draft = buildImportDraft({
      rows: [row({ rowIndex: 2, name: 'Bath Towel', unit: 'each', quantity: '2' })],
      existingItems: [],
      customCategories: [],
      asOfDate: TODAY,
      todayLocal: TODAY,
      readerSkipped: [{ rowIndex: 9, reason: 'total_row', text: 'Grand total 918' }],
    });
    assert.equal(draft.skipped.length, 1);
    assert.equal(draft.skipped[0].rowIndex, 9);
    assert.match(draft.skippedSentence, /^Skipped 1 row: totals\.$/);
  });

  test('vendor names are collected once each for the suggestion pool', () => {
    const draft = buildImportDraft({
      rows: [
        row({ rowIndex: 1, name: 'Bath Towel', unit: 'each', quantity: '2', vendorName: 'Acme Supply' }),
        row({ rowIndex: 2, name: 'Hand Soap', unit: 'each', quantity: '9', vendorName: 'Acme Supply' }),
        row({ rowIndex: 3, name: 'Coffee Pods', unit: 'box', quantity: '4', vendorName: 'Bean Co' }),
      ],
      existingItems: [],
      customCategories: [],
      asOfDate: TODAY,
      todayLocal: TODAY,
    });
    assert.deepEqual(draft.vendorNames, ['Acme Supply', 'Bean Co']);
  });
});
