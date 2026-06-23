/**
 * feature/cua-column-editor — the worker data-path for founder-added columns
 * (no browser). Three pieces, each STRICTLY ADDITIVE (byte-identical when a feed
 * has no custom columns / no detected headers):
 *
 *   1. finalizeRecoveredSuccess persists `parse.hint.detectedColumns` (every
 *      page header + its cell index) from the captured header row — the source
 *      for the Coverage Editor's "add a column from the page" dropdown.
 *   2. actionRecipeToTableTemplate merges `parse.hint.customColumns` selectors
 *      into the primary source's read set AND tags them on `template.rawColumns`
 *      (never as typed fields — a custom column can't shadow a contract column).
 *   3. applyTemplateParsers gathers those custom values into each row's `raw`
 *      jsonb bucket instead of a typed field.
 */

import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeRecoveredSuccess, type PageAudit } from '../mapper.js';
import { actionRecipeToTableTemplate } from '../recipe-adapter.js';
import { applyTemplateParsers } from '../extractors/template-runner.js';
import type { CapturedTableHeaders } from '../extractors/dom-rows.js';
import type { ActionRecipe, TableTemplate } from '../types.js';

const headers = (): CapturedTableHeaders => ({
  cells: [
    { index: 1, text: 'conf', raw: 'Conf. #' },
    { index: 2, text: 'guest', raw: 'Guest Name' },
    { index: 9, text: 'rate', raw: 'Rate Plan' },
  ],
  roleKind: 'cell',
  hasSpan: false,
  headerChildCount: 3,
  bodyChildCount: 3,
});

const auditWith = (over: Partial<PageAudit>): PageAudit => ({
  verified: true,
  pageUrl: 'https://pms.example/arrivals',
  probeRows: [],
  totalMatched: 0,
  outstanding: new Map(),
  problems: [],
  ...over,
});

const successWith = (columns: Record<string, string>) => ({
  ok: true as const,
  action: { steps: [], parse: { mode: 'table' as const, hint: { rowSelector: 'tbody tr', columns } } },
});

const detectedOf = (action: ActionRecipe) =>
  action.parse.mode === 'table' ? action.parse.hint.detectedColumns : undefined;

describe('finalizeRecoveredSuccess — detectedColumns (page-column catalogue)', () => {
  test('persists every captured header with its index', () => {
    const out = finalizeRecoveredSuccess({
      success: successWith({ pms_reservation_id: 'td:nth-child(1)', guest_name: 'td:nth-child(2)' }),
      audit: auditWith({ headers: headers() }),
    });
    assert.deepEqual(detectedOf(out.action), [
      { index: 1, header: 'Conf. #' },
      { index: 2, header: 'Guest Name' },
      { index: 9, header: 'Rate Plan' },
    ]);
  });

  test('NO headers captured → NO detectedColumns key (byte-identical)', () => {
    const out = finalizeRecoveredSuccess({
      success: successWith({ pms_reservation_id: 'td:nth-child(1)' }),
      audit: auditWith({}),
    });
    assert.equal(detectedOf(out.action), undefined);
  });
});

describe('actionRecipeToTableTemplate — custom columns → rawColumns + read set', () => {
  const base = (customColumns?: Record<string, string>): ActionRecipe => ({
    steps: [{ kind: 'goto', url: 'https://pms.example/arrivals' }],
    parse: {
      mode: 'table',
      hint: {
        rowSelector: 'tbody tr',
        columns: { pms_reservation_id: 'td:nth-child(1)', guest_name: 'td:nth-child(2)' },
        ...(customColumns ? { customColumns } : {}),
      },
    },
  });

  test('a custom column is read from the page AND tagged rawColumns (not a field)', () => {
    const t = actionRecipeToTableTemplate('getArrivals', base({ rate_plan: 'td:nth-child(9)' }));
    assert.ok(t);
    assert.deepEqual(t!.rawColumns, ['rate_plan']);
    assert.equal(t!.sources[0]!.columns?.rate_plan, 'td:nth-child(9)');    // read from the DOM
    assert.equal(t!.fields.rate_plan, undefined);                          // but NOT a typed field
    // The contract fields are untouched.
    assert.ok(t!.fields.pms_reservation_id && t!.fields.guest_name);
  });

  test('a custom key that collides with a typed column is ignored (contract wins)', () => {
    const t = actionRecipeToTableTemplate('getArrivals', base({ guest_name: 'td:nth-child(7)' }));
    assert.ok(t);
    assert.equal(t!.rawColumns, undefined);                                // nothing added
    assert.equal(t!.sources[0]!.columns?.guest_name, 'td:nth-child(2)');   // original selector kept
  });

  test('no custom columns → rawColumns omitted (byte-identical)', () => {
    const t = actionRecipeToTableTemplate('getArrivals', base());
    assert.ok(t);
    assert.equal(t!.rawColumns, undefined);
  });
});

describe('applyTemplateParsers — custom values land in row.raw', () => {
  const template = {
    tableName: 'pms_reservations',
    keys: ['pms_reservation_id'],
    writeStrategy: 'upsert',
    snapshotScope: 'delta',
    sources: [{ name: 'primary', url: 'x', mode: 'dom_table', selectors: {}, columns: {} }],
    fields: { guest_name: { origin: 'list_row', source: 'primary', selectorOrColumn: 'guest_name' } },
    rawColumns: ['rate_plan', 'guarantee'],
  } as unknown as TableTemplate;

  test('non-blank custom cells gather into out.raw; typed field stays top-level', () => {
    const out = applyTemplateParsers({ guest_name: 'Smith', rate_plan: 'AAA', guarantee: 'Visa' }, template, 'list_row');
    assert.equal(out.guest_name, 'Smith');
    assert.deepEqual(out.raw, { rate_plan: 'AAA', guarantee: 'Visa' });
  });

  test('blank/absent custom cells are dropped; all-blank → no raw key', () => {
    const out = applyTemplateParsers({ guest_name: 'Smith', rate_plan: '   ' }, template, 'list_row');
    assert.equal(out.raw, undefined);
  });

  test('rawColumns only gather on the list_row pass (not detail_page)', () => {
    const out = applyTemplateParsers({ guest_name: 'Smith', rate_plan: 'AAA' }, template, 'detail_page');
    assert.equal(out.raw, undefined);
  });
});
