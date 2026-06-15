/**
 * CSV-export + single-value (inline_text) LEARNING strategies
 * (feature/cua-self-heal-reach, mapper.ts).
 *
 * Drives the two new self-contained strategy functions with INJECTED deps (no
 * Playwright / Anthropic). Proves:
 *   - csv emits ONLY when the downloaded CSV reconciles with the DOM oracle
 *     (reuses reconcileRows) and otherwise ABSTAINS (keeps the table recipe),
 *   - inline_text emits ONLY for a single-value numeric page and otherwise abstains,
 *   - and that BOTH emitted recipes round-trip THROUGH the real adapter +
 *     extractor to canonical rows — the end-to-end proof the runtime consumes them.
 */

import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { Page } from 'playwright';

import {
  attemptCsvDiscovery,
  attemptInlineTextDiscovery,
  proposeCsvColumnMap,
  parseCsvText,
  type CsvDiscoveryDeps,
  type InlineDiscoveryDeps,
} from '../mapper.js';
import { recipeToTableTemplates } from '../recipe-adapter.js';
import { extractCsvDownload } from '../extractors/csv-download.js';
import { extractDomInline } from '../extractors/dom-inline.js';
import { applyTemplateParsers } from '../extractors/template-runner.js';
import type { FeedSpec } from '../knowledge-file.js';
import type { Recipe, ActionRecipe } from '../types.js';

// Non-sequential keys (sequential row-number keys are rejected by reconcileRows).
const IDS = ['R1001', 'R1007', 'R1013', 'R1022', 'R1031', 'R1044'];
const GUESTS = ['Smith, John', 'Doe, Jane', 'Lee, Sam', 'Park, Ann', 'Cruz, Bo', 'Vo, Kim'];
const ARR = '2026-06-15';
const DEPS = ['2026-06-17', '2026-06-18', '2026-06-16', '2026-06-19', '2026-06-17', '2026-06-18'];

function domOracle(): Array<Record<string, string>> {
  return IDS.map((id, i) => ({ pms_reservation_id: id, guest_name: GUESTS[i]!, arrival_date: ARR, departure_date: DEPS[i]! }));
}
function csvRows(): Array<Record<string, string>> {
  return IDS.map((id, i) => ({ Conf: id, Guest: GUESTS[i]!, Arrival: ARR, Departure: DEPS[i]! }));
}
const CSV_HEADERS = ['Conf', 'Guest', 'Arrival', 'Departure'];

function tableSuccess() {
  const action: ActionRecipe = {
    steps: [{ kind: 'goto', url: 'https://pms.example/arrivals-report' }],
    parse: {
      mode: 'table',
      hint: { rowSelector: 'tr.res', columns: { pms_reservation_id: 'td:nth-child(1)', guest_name: 'td:nth-child(2)', arrival_date: 'td:nth-child(3)', departure_date: 'td:nth-child(4)' } },
    },
  };
  return { ok: true as const, action };
}

function csvDeps(over: Partial<CsvDiscoveryDeps> = {}): CsvDiscoveryDeps {
  return {
    extractOracleRows: async () => domOracle(),
    findCsvExport: async () => ({ ok: true, steps: [{ kind: 'click', selector: '#export-csv' }] }),
    downloadCsv: async () => ({ ok: true, headers: CSV_HEADERS, rows: csvRows() }),
    isOverBudget: async () => false,
    ...over,
  };
}

// ─── parseCsvText (self-contained learn-time parser) ─────────────────────────
describe('parseCsvText', () => {
  test('parses header + rows; honours quotes, embedded commas + doubled quotes', () => {
    const { headers, rows } = parseCsvText('Conf,Guest,Note\r\nR1,"Doe, Jane","say ""hi"""\nR2,Sam,plain\n');
    assert.deepEqual(headers, ['Conf', 'Guest', 'Note']);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.Guest, 'Doe, Jane');
    assert.equal(rows[0]!.Note, 'say "hi"');
    assert.equal(rows[1]!.Conf, 'R2');
  });
  test('empty text → no headers, no rows', () => {
    assert.deepEqual(parseCsvText(''), { headers: [], rows: [] });
  });
});

// ─── proposeCsvColumnMap (pure value-join) ───────────────────────────────────
describe('proposeCsvColumnMap', () => {
  test('learns canonical→header by value-joining on the key', () => {
    const out = proposeCsvColumnMap({
      keyColumn: 'pms_reservation_id',
      candidateColumns: ['pms_reservation_id', 'guest_name', 'arrival_date', 'departure_date'],
      domRows: domOracle(), csvRows: csvRows(), csvHeaders: CSV_HEADERS,
    });
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.keyHeader, 'Conf');
      assert.equal(out.map.pms_reservation_id, 'Conf');
      assert.equal(out.map.guest_name, 'Guest');
      assert.equal(out.map.arrival_date, 'Arrival');
      assert.equal(out.map.departure_date, 'Departure');
    }
  });
  test('no CSV header covers the DOM key → abstain (ok:false)', () => {
    const out = proposeCsvColumnMap({
      keyColumn: 'pms_reservation_id', candidateColumns: ['pms_reservation_id'],
      domRows: domOracle(), csvRows: csvRows().map((r) => ({ ...r, Conf: 'X' + r.Conf })), csvHeaders: CSV_HEADERS,
    });
    assert.equal(out.ok, false);
  });
});

// ─── attemptCsvDiscovery (abstain ladder + emit) ─────────────────────────────
describe('attemptCsvDiscovery', () => {
  const input = { actionName: 'getArrivals' as const, success: tableSuccess(), feedPageUrl: 'https://pms.example/arrivals-report', jobId: null };

  test('emits a csv recipe when the CSV reconciles with the DOM oracle', async () => {
    const out = await attemptCsvDiscovery(input, csvDeps());
    assert.ok(out);
    assert.equal(out!.action.parse.mode, 'csv');
    if (out!.action.parse.mode === 'csv') {
      assert.equal(out!.action.parse.hint.requiredColumn, 'Conf');
      assert.equal(out!.action.parse.hint.columns.pms_reservation_id, 'Conf');
    }
    assert.equal(out!.action.downloadsCsv, true);
    // steps = recorded nav + the export click → deriveCsvFlowFromSteps reads the trigger.
    assert.ok(out!.action.steps.some((s) => s.kind === 'click' && s.selector === '#export-csv'));
  });

  test('abstains (keeps table) when there is no export affordance', async () => {
    const out = await attemptCsvDiscovery(input, csvDeps({ findCsvExport: async () => ({ ok: false, reason: 'none' }) }));
    assert.equal(out, null);
  });

  test('abstains when the download fails', async () => {
    const out = await attemptCsvDiscovery(input, csvDeps({ downloadCsv: async () => ({ ok: false, reason: 'timeout' }) }));
    assert.equal(out, null);
  });

  test('abstains when the CSV does NOT reconcile with the DOM (wrong data)', async () => {
    const out = await attemptCsvDiscovery(input, csvDeps({
      downloadCsv: async () => ({ ok: true, headers: CSV_HEADERS, rows: csvRows().map((r, i) => ({ ...r, Conf: `ZZ${i}` })) }),
    }));
    assert.equal(out, null);
  });

  test('abstains on a non-core target (no reconcile oracle)', async () => {
    const out = await attemptCsvDiscovery({ ...input, actionName: 'getPaymentsDaily' as const }, csvDeps());
    assert.equal(out, null);
  });

  test('abstains when over budget (cost discipline)', async () => {
    const out = await attemptCsvDiscovery(input, csvDeps({ isOverBudget: async () => true }));
    assert.equal(out, null);
  });
});

// ─── csv end-to-end: emitted recipe → adapter → extractor → canonical rows ───
function fakeCsvPage(csvText: string) {
  const calls: string[] = [];
  const page = {
    calls,
    async click(sel: string) { calls.push(`click:${sel}`); },
    async selectOption() { /* noop */ },
    async fill() { /* noop */ },
    async waitForSelector() { /* noop */ },
    async waitForTimeout() { /* noop */ },
    async waitForEvent() { return { createReadStream: async () => Readable.from([Buffer.from(csvText, 'utf8')]) }; },
  };
  return page as unknown as Page & { calls: string[] };
}

describe('csv emit → runtime extract end-to-end', () => {
  test('the learned csv recipe round-trips through recipe-adapter + extractCsvDownload', async () => {
    const learned = await attemptCsvDiscovery(
      { actionName: 'getArrivals' as const, success: tableSuccess(), feedPageUrl: 'https://pms.example/arrivals-report', jobId: null },
      csvDeps(),
    );
    assert.ok(learned);
    const recipe: Recipe = {
      schema: 1,
      login: { startUrl: 'https://pms.example/login', steps: [], successSelectors: ['.d'] },
      actions: { getArrivals: learned!.action },
    };
    const { templates } = recipeToTableTemplates(recipe);
    const tmpl = templates.find((t) => t.tableName === 'pms_reservations');
    assert.ok(tmpl);
    assert.notEqual(tmpl!.incomplete, true);
    const src = tmpl!.sources[0]!;
    assert.equal(src.mode, 'csv_download');
    assert.equal(src.selectors?.downloadButton, '#export-csv');

    // Guest names contain commas → must be quoted in the raw CSV.
    const csvText = 'Conf,Guest,Arrival,Departure\n' + IDS.map((id, i) => `${id},"${GUESTS[i]}",${ARR},${DEPS[i]}`).join('\n') + '\n';
    const page = fakeCsvPage(csvText);
    const spec: FeedSpec = { mode: 'csv_download', url: '', selectors: src.selectors, columns: src.columns, extra: src.extra };
    const result = await extractCsvDownload({ page, feedSpec: spec, allowedHost: 'pms.example' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.rows.length, IDS.length);
    const canonical = result.rows.map((r) => applyTemplateParsers(r, tmpl!, 'list_row'));
    assert.equal(canonical[0]!.pms_reservation_id, 'R1001');
    assert.equal(canonical[0]!.guest_name, 'Smith, John');
    assert.equal(canonical[0]!.arrival_date, '2026-06-15');
  });
});

// ─── attemptInlineTextDiscovery (single-value pages) ─────────────────────────
function inlineSuccess() {
  const action: ActionRecipe = {
    steps: [{ kind: 'goto', url: 'https://pms.example/dashboard' }],
    parse: { mode: 'table', hint: { rowSelector: '#dash', columns: { occupied_count: '.occ', arrivals_count: '.arr' } } },
  };
  return { ok: true as const, action };
}
function inlineDeps(over: Partial<InlineDiscoveryDeps> = {}): InlineDiscoveryDeps {
  return {
    extractOracleRows: async () => [{ occupied_count: '42', arrivals_count: '7' }], // single record
    extractInline: async () => ({ occupied_count: '42', arrivals_count: '7' }),
    isOverBudget: async () => false,
    ...over,
  };
}

describe('attemptInlineTextDiscovery', () => {
  const input = { actionName: 'getDashboardCounts' as const, success: inlineSuccess(), feedPageUrl: 'https://pms.example/dashboard', jobId: null };

  test('emits inline_text for a single-value numeric page (document-rooted fields)', async () => {
    const out = await attemptInlineTextDiscovery(input, inlineDeps());
    assert.ok(out);
    assert.equal(out!.action.parse.mode, 'inline_text');
    if (out!.action.parse.mode === 'inline_text') {
      assert.equal(out!.action.parse.fields.occupied_count, '#dash .occ'); // composed absolute selector
      assert.equal(out!.action.parse.fields.arrivals_count, '#dash .arr');
    }
  });

  test('abstains on a MULTI-row table (not a single-value page)', async () => {
    const out = await attemptInlineTextDiscovery(input, inlineDeps({ extractOracleRows: async () => [{}, {}, {}] }));
    assert.equal(out, null);
  });

  test('abstains when a field reads blank', async () => {
    const out = await attemptInlineTextDiscovery(input, inlineDeps({ extractInline: async () => ({ occupied_count: '42', arrivals_count: '' }) }));
    assert.equal(out, null);
  });

  test('abstains when a field is non-numeric (only counters are value-provable)', async () => {
    const out = await attemptInlineTextDiscovery(input, inlineDeps({ extractInline: async () => ({ occupied_count: 'lots', arrivals_count: '7' }) }));
    assert.equal(out, null);
  });

  test('abstains when over budget', async () => {
    const out = await attemptInlineTextDiscovery(input, inlineDeps({ isOverBudget: async () => true }));
    assert.equal(out, null);
  });

  test('abstains when the page is only reachable via a post-goto interaction (inline has no preStep replay)', async () => {
    const action: ActionRecipe = {
      steps: [{ kind: 'goto', url: 'https://pms.example/dash' }, { kind: 'click', selector: '#counts-tab' }],
      parse: { mode: 'table', hint: { rowSelector: '#dash', columns: { occupied_count: '.occ' } } },
    };
    const out = await attemptInlineTextDiscovery({ actionName: 'getDashboardCounts' as const, success: { ok: true as const, action }, feedPageUrl: 'x', jobId: null }, inlineDeps());
    assert.equal(out, null);
  });
});

// ─── inline_text emit → runtime extract end-to-end ───────────────────────────
function fakeInlinePage(bySelector: Record<string, string>) {
  return {
    // Mirror extractDomInline's real evaluate: fields is field→selector; resolve
    // each by its SELECTOR (the page-side document.querySelector(sel)).
    async evaluate(_fn: unknown, fields: Record<string, string>) {
      const out: Record<string, string | null> = {};
      for (const [field, sel] of Object.entries(fields)) out[field] = bySelector[sel] ?? null;
      return out;
    },
    async waitForSelector() { /* noop */ },
  } as unknown as Page;
}

describe('inline_text emit → runtime extract end-to-end', () => {
  test('the learned inline recipe round-trips through recipe-adapter + extractDomInline', async () => {
    const learned = await attemptInlineTextDiscovery(
      { actionName: 'getDashboardCounts' as const, success: inlineSuccess(), feedPageUrl: 'https://pms.example/dashboard', jobId: null },
      inlineDeps(),
    );
    assert.ok(learned);
    const recipe: Recipe = {
      schema: 1,
      login: { startUrl: 'https://pms.example/login', steps: [], successSelectors: ['.d'] },
      actions: { getDashboardCounts: learned!.action },
    };
    const { templates } = recipeToTableTemplates(recipe);
    const tmpl = templates.find((t) => t.sourceActionKey === 'getDashboardCounts');
    assert.ok(tmpl);
    const src = tmpl!.sources[0]!;
    assert.equal(src.mode, 'dom_inline');
    // The adapter passes inline fields through as the source columns.
    const spec: FeedSpec = { mode: 'dom_inline', url: '', columns: src.columns };
    const page = fakeInlinePage({ '#dash .occ': '42', '#dash .arr': '7' });
    const result = await extractDomInline({ page, feedSpec: spec, allowedHost: 'pms.example' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.data.occupied_count, '42');
    assert.equal(result.data.arrivals_count, '7');
  });
});
