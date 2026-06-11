/**
 * csv_download wiring (Chat 1 plumbing) — offline, no Playwright.
 *
 * The bug: recipe-adapter dropped a learned csv flow's click-sequence and
 * download trigger, so every learned csv feed died at runtime with
 * "feedSpec missing selectors.downloadButton". These tests pin the fix:
 *
 *   1. The adapter derives selectors.downloadButton (last click) +
 *      extra.preSteps (ordered interaction steps) from the recipe's steps,
 *      and no longer flags csv templates `incomplete`.
 *   2. extractCsvDownload runs END-TO-END from an adapter-built source on a
 *      fake page: pre-steps replayed in order, trigger clicked, download
 *      parsed, rows → canonical columns via applyTemplateParsers.
 *   3. Credential fills never survive into preSteps; dom_table recipes with
 *      interaction steps STILL flag incomplete (regression).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { Page } from 'playwright';

import {
  recipeToTableTemplates,
  actionRecipeToTableTemplate,
  deriveCsvFlowFromSteps,
} from '../recipe-adapter.js';
import { extractCsvDownload } from '../extractors/csv-download.js';
import { applyTemplateParsers } from '../extractors/template-runner.js';
import { parsePreSteps, replayPreSteps, type PreStep } from '../extractors/pre-steps.js';
import type { FeedSpec } from '../knowledge-file.js';
import type { Recipe, RecipeStep } from '../types.js';

// ─── The canonical learned csv flow ────────────────────────────────────────

const CSV_STEPS: RecipeStep[] = [
  { kind: 'goto', url: 'https://pms.example/reports' },
  { kind: 'click', selector: 'a#hk-report' },
  { kind: 'select', selector: '#format', value: 'csv' },
  { kind: 'fill', selector: '#room-range', value: '100-200' },
  { kind: 'fill', selector: '#user', value: '$username' },     // must be dropped
  { kind: 'wait_for', selector: '#generate', timeoutMs: 5000 },
  { kind: 'click', selector: '#generate' },                     // the trigger
  { kind: 'wait_ms', ms: 2000 },                                // trailing — dropped
];

function csvRecipe(): Recipe {
  return {
    schema: 1,
    login: { startUrl: 'https://pms.example/login', steps: [], successSelectors: ['.dash'] },
    dateFormat: { order: 'MDY', separator: '/', confidence: 'high' },
    actions: {
      getArrivals: {
        steps: CSV_STEPS,
        downloadsCsv: true,
        parse: {
          mode: 'csv',
          hint: {
            columns: {
              pms_reservation_id: 'Conf',
              guest_name: 'Guest',
              arrival_date: 'Arrival',
              departure_date: 'Departure',
            },
            requiredColumn: 'Conf',
          },
        },
      },
    },
  };
}

// ─── Fake page that records every interaction + serves a download ─────────

function fakeCsvPage(csvText: string) {
  const calls: string[] = [];
  const page = {
    calls,
    async click(sel: string) { calls.push(`click:${sel}`); },
    async check(sel: string) { calls.push(`check:${sel}`); },
    async selectOption(sel: string, value: string) { calls.push(`select:${sel}=${value}`); },
    async fill(sel: string, value: string) { calls.push(`fill:${sel}=${value}`); },
    async waitForSelector(sel: string) { calls.push(`wait_for:${sel}`); },
    async waitForTimeout(ms: number) { calls.push(`wait_ms:${ms}`); },
    keyboard: {
      async type(t: string) { calls.push(`type:${t}`); },
      async press(k: string) { calls.push(`press:${k}`); },
    },
    mouse: {
      async click(x: number, y: number) { calls.push(`mouse_click:${x},${y}`); },
    },
    async waitForEvent(event: string) {
      calls.push(`waitForEvent:${event}`);
      return {
        createReadStream: async () => Readable.from([Buffer.from(csvText, 'utf8')]),
      };
    },
  };
  return page as unknown as Page & { calls: string[] };
}

// ─── Adapter derivation ────────────────────────────────────────────────────

describe('deriveCsvFlowFromSteps', () => {
  test('last click becomes the download trigger; earlier steps become preSteps in order', () => {
    const flow = deriveCsvFlowFromSteps(CSV_STEPS);
    assert.equal(flow.downloadButton, '#generate');
    assert.equal(flow.downloadClickAt, undefined);
    assert.deepEqual(flow.preSteps, [
      { kind: 'click', selector: 'a#hk-report' },
      { kind: 'select', selector: '#format', value: 'csv' },
      { kind: 'fill', selector: '#room-range', value: '100-200' },
      // credential fill dropped; trailing wait_ms after the trigger dropped
      { kind: 'wait_for', selector: '#generate', timeoutMs: 5000 },
    ]);
  });

  test('only steps AFTER the last goto are considered', () => {
    const flow = deriveCsvFlowFromSteps([
      { kind: 'click', selector: '#stale-pre-goto' },
      { kind: 'goto', url: 'https://pms.example/a' },
      { kind: 'goto', url: 'https://pms.example/b' },
      { kind: 'click', selector: '#dl' },
    ]);
    assert.equal(flow.downloadButton, '#dl');
    assert.deepEqual(flow.preSteps, []);
  });

  test('coordinate-recorded final click becomes downloadClickAt', () => {
    const flow = deriveCsvFlowFromSteps([
      { kind: 'goto', url: 'https://pms.example/r' },
      { kind: 'click', selector: '#open' },
      { kind: 'click_at', x: 510, y: 320 },
    ]);
    assert.equal(flow.downloadButton, undefined);
    assert.deepEqual(flow.downloadClickAt, { x: 510, y: 320 });
    assert.deepEqual(flow.preSteps, [{ kind: 'click', selector: '#open' }]);
  });

  test('no click at all → no trigger (extractor will fail loudly)', () => {
    const flow = deriveCsvFlowFromSteps([{ kind: 'goto', url: 'https://x.example' }]);
    assert.equal(flow.downloadButton, undefined);
    assert.equal(flow.downloadClickAt, undefined);
  });
});

describe('adapter csv wiring', () => {
  test('csv source carries downloadButton + preSteps and is NOT incomplete', () => {
    const { templates } = recipeToTableTemplates(csvRecipe());
    const tmpl = templates.find((t) => t.tableName === 'pms_reservations');
    assert.ok(tmpl);
    assert.equal(tmpl!.incomplete, undefined, 'csv recipes must not be flagged incomplete');
    const src = tmpl!.sources[0]!;
    assert.equal(src.mode, 'csv_download');
    assert.equal(src.url, 'https://pms.example/reports');
    assert.equal(src.selectors?.downloadButton, '#generate');
    assert.equal(src.selectors?.requiredColumn, 'Conf');
    const preSteps = src.extra?.preSteps as PreStep[];
    assert.equal(preSteps.length, 4);
    assert.equal(
      preSteps.some((s) => (s.kind === 'fill' || s.kind === 'type_text') && /\$(username|password)/.test(String((s as { value?: string }).value))),
      false,
      'credential steps must never reach the runtime source',
    );
    // The learned headers double as the extractor's schema-drift check.
    assert.deepEqual(src.extra?.expectedHeaderColumns, ['Conf', 'Guest', 'Arrival', 'Departure']);
    // The learned PMS date format rides every mode (Codex P1) — a csv report
    // URL with {today} must render in the PMS's format, not ISO.
    assert.deepEqual(src.extra?.dateRender, { order: 'MDY', separator: '/', confidence: 'high' });
  });

  test('TRIGGERLESS csv flow IS flagged incomplete (Codex P1 — it can never download)', () => {
    const recipe = csvRecipe();
    recipe.actions.getArrivals!.steps = [{ kind: 'goto', url: 'https://pms.example/reports' }];
    const { templates } = recipeToTableTemplates(recipe);
    const tmpl = templates.find((t) => t.tableName === 'pms_reservations')!;
    assert.equal(tmpl.incomplete, true);
  });

  test('fills into credential-looking fields are dropped at derivation (Codex P1)', () => {
    const flow = deriveCsvFlowFromSteps([
      { kind: 'goto', url: 'https://pms.example/r' },
      { kind: 'fill', selector: '#report-password', value: 'literal-secret' },
      { kind: 'fill', selector: '#csrf-token', value: 'abc123' },
      { kind: 'fill', selector: '#room-range', value: '100-200' },
      // Benign compound containing "token" must NOT be dropped (false-positive fence).
      { kind: 'fill', selector: '#tokenizedSearch', value: 'suite' },
      { kind: 'click', selector: '#dl' },
    ]);
    assert.deepEqual(flow.preSteps, [
      { kind: 'fill', selector: '#room-range', value: '100-200' },
      { kind: 'fill', selector: '#tokenizedSearch', value: 'suite' },
    ]);
  });

  test('learned dateRender rides dom_table sources too; no learned format → no stray extra', () => {
    const withLearned = actionRecipeToTableTemplate('getArrivals', {
      steps: [{ kind: 'goto', url: 'https://pms.example/arrivals?d={today}' }],
      parse: { mode: 'table', hint: { rowSelector: 'tr.res', columns: { guest_name: 'td.name' } } },
    }, { dateFormat: { order: 'MDY', separator: '/', confidence: 'high' } });
    assert.deepEqual(
      withLearned!.sources[0]!.extra?.dateRender,
      { order: 'MDY', separator: '/', confidence: 'high' },
    );

    const withoutLearned = actionRecipeToTableTemplate('getArrivals', {
      steps: [{ kind: 'goto', url: 'https://pms.example/arrivals' }],
      parse: { mode: 'table', hint: { rowSelector: 'tr.res', columns: { guest_name: 'td.name' } } },
    });
    assert.equal(withoutLearned!.sources[0]!.extra, undefined);
  });

  test('REGRESSION: dom_table with interaction steps still flags incomplete', () => {
    const t = actionRecipeToTableTemplate('getArrivals', {
      steps: [
        { kind: 'goto', url: 'https://pms.example/arrivals' },
        { kind: 'click', selector: '#expand' },
      ],
      parse: { mode: 'table', hint: { rowSelector: 'tr.res', columns: { guest_name: 'td.name' } } },
    });
    assert.equal(t!.incomplete, true);
  });
});

// ─── preSteps validation + replay ─────────────────────────────────────────

describe('parsePreSteps / replayPreSteps', () => {
  test('malformed lists are rejected as a whole', () => {
    assert.equal(parsePreSteps([{ kind: 'click' }]).ok, false);          // no selector
    assert.equal(parsePreSteps([{ kind: 'teleport' }]).ok, false);       // unknown kind
    assert.equal(parsePreSteps('nope').ok, false);                        // not an array
    assert.equal(parsePreSteps(undefined).ok && (parsePreSteps(undefined) as { steps: PreStep[] }).steps.length === 0, true);
  });

  test('replay preserves order and reports the failing step', async () => {
    const page = fakeCsvPage('');
    const r = await replayPreSteps(page, [
      { kind: 'click', selector: '#a' },
      { kind: 'select', selector: '#b', value: 'csv' },
      { kind: 'press_key', key: 'Enter' },
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(page.calls, ['click:#a', 'select:#b=csv', 'press:Enter']);

    const failing = {
      ...page,
      async click() { throw new Error('selector gone'); },
    } as unknown as Page;
    const bad = await replayPreSteps(failing, [{ kind: 'click', selector: '#a' }]);
    assert.equal(bad.ok, false);
    assert.equal(bad.failedStepIndex, 0);
    assert.match(bad.reason!, /pre-step 0 \(click\) failed/);
  });

  test('credential fills are skipped at replay too (defense-in-depth)', async () => {
    const page = fakeCsvPage('');
    const r = await replayPreSteps(page, [
      { kind: 'fill', selector: '#u', value: '$username' },
      { kind: 'fill', selector: 'input[name=pwd]', value: 'literal-secret' },
      { kind: 'click', selector: '#go' },
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(page.calls, ['click:#go']);
  });
});

// ─── End-to-end: adapter-built source → extractor → canonical rows ────────

describe('csv end-to-end from an adapter-built source', () => {
  const CSV_TEXT = 'Conf,Guest,Arrival,Departure\nCONF-1,Jane Doe,06/10/2026,06/12/2026\nCONF-2,Sam Lee,06/11/2026,06/13/2026\n';

  test('preSteps replay → trigger click → download parsed → canonical columns', async () => {
    const { templates } = recipeToTableTemplates(csvRecipe());
    const tmpl = templates.find((t) => t.tableName === 'pms_reservations')!;
    const src = tmpl.sources[0]!;

    const page = fakeCsvPage(CSV_TEXT);
    // url:'' — navigation itself is safeGoto's job (covered by navigate.test.ts);
    // it does live DNS preflight, so the offline test skips the goto.
    const spec: FeedSpec = {
      mode: 'csv_download',
      url: '',
      selectors: src.selectors,
      columns: src.columns,
      extra: src.extra,
    };
    const result = await extractCsvDownload({
      page, feedSpec: spec, allowedHost: 'pms.example',
    });

    assert.equal(result.ok, true, result.reason);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0]!.Conf, 'CONF-1');

    // The recorded interaction order: every pre-step, THEN the download race.
    assert.deepEqual(page.calls, [
      'click:a#hk-report',
      'select:#format=csv',
      'fill:#room-range=100-200',
      'wait_for:#generate',
      'waitForEvent:download',
      'click:#generate',
    ]);

    // Close the loop: csv rows → canonical descriptor columns + parsed dates.
    const canonical = result.rows.map((r) => applyTemplateParsers(r, tmpl, 'list_row'));
    assert.equal(canonical[0]!.pms_reservation_id, 'CONF-1');
    assert.equal(canonical[0]!.guest_name, 'Jane Doe');
    assert.equal(canonical[0]!.arrival_date, '2026-06-10');   // learned MDY → ISO
    assert.equal(canonical[1]!.departure_date, '2026-06-13');
  });

  test('a RENAMED PMS column fails the feed with a schema-drift reason', async () => {
    const { templates } = recipeToTableTemplates(csvRecipe());
    const tmpl = templates.find((t) => t.tableName === 'pms_reservations')!;
    const src = tmpl.sources[0]!;
    // PMS renamed "Conf" → "Confirmation" — the learned column map no longer
    // lines up with the export.
    const page = fakeCsvPage('Confirmation,Guest,Arrival,Departure\nCONF-1,Jane,06/10/2026,06/12/2026\n');
    const result = await extractCsvDownload({
      page,
      feedSpec: { mode: 'csv_download', url: '', selectors: src.selectors, columns: src.columns, extra: src.extra },
      allowedHost: 'pms.example',
    });
    assert.equal(result.ok, false);
    assert.match(result.reason!, /schema drift: missing columns \[Conf\]/);
  });

  test('a flow with NO trigger fails loudly (not a silent empty success)', async () => {
    const page = fakeCsvPage(CSV_TEXT);
    const result = await extractCsvDownload({
      page,
      feedSpec: { mode: 'csv_download', url: '', columns: {} },
      allowedHost: 'pms.example',
    });
    assert.equal(result.ok, false);
    assert.match(result.reason!, /missing selectors\.downloadButton/);
  });

  test('coordinate trigger works when no selector was recorded', async () => {
    const page = fakeCsvPage(CSV_TEXT);
    const result = await extractCsvDownload({
      page,
      feedSpec: {
        mode: 'csv_download',
        url: '',
        extra: { downloadClickAt: { x: 510, y: 320 } },
      },
      allowedHost: 'pms.example',
    });
    assert.equal(result.ok, true, result.reason);
    assert.ok(page.calls.includes('mouse_click:510,320'));
  });

  test('invalid preSteps payload fails the feed before any interaction', async () => {
    const page = fakeCsvPage(CSV_TEXT);
    const result = await extractCsvDownload({
      page,
      feedSpec: {
        mode: 'csv_download',
        url: '',
        selectors: { downloadButton: '#go' },
        extra: { preSteps: [{ kind: 'click' }] },   // missing selector
      },
      allowedHost: 'pms.example',
    });
    assert.equal(result.ok, false);
    assert.match(result.reason!, /invalid preSteps/);
    assert.deepEqual(page.calls, []);
  });
});
