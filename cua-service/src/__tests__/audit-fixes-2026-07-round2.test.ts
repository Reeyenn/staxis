/**
 * Pins the 2026-07 round-2 audit fixes (mapper.ts + url-template.ts) so they
 * can't regress. All pure-logic pins — no browser, no model.
 *
 *   A. mapDrillDownAction anchors the feed's landing URL: recording a trailing
 *      goto(listUrl) makes the list URL the recipe's source and empties the
 *      blind-replayed exploration preSteps (deriveDomPreStepsFromSteps).
 *   B. Drill-down {var_N} placeholders are rewritten to column names, so the
 *      detailUrlTemplate is replayable (every placeholder resolves from a list
 *      column / a row keyed by column name).
 *   F. A csv download recipe's steps are snapshotted at the trigger click, so
 *      deriveCsvFlowFromSteps derives the REAL export click as the trigger — a
 *      later post-export exploration click can't become the trigger.
 *   H. inferUrlTemplate re-encodes invariant query-param values, so a value
 *      containing an encoded &/=/# can't split the template's query string.
 */

import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  inferUrlTemplate,
  mapPlaceholdersToColumns,
  templatePlaceholders,
  substituteTemplate,
} from '../url-template.js';
import { deriveDomPreStepsFromSteps, deriveCsvFlowFromSteps } from '../recipe-adapter.js';
import { recordLandingGoto } from '../mapper.js';
import type { RecipeStep } from '../types.js';

// ─── ITEM H — inferUrlTemplate re-encodes invariant query-param values ──────

describe('inferUrlTemplate — invariant query-param re-encoding (ITEM H)', () => {
  test('an invariant param value with encoded &/=/# is re-encoded, not spliced', () => {
    // The `ret` param is invariant across samples and its ORIGINAL value contained
    // encoded &, =, # — searchParams.get() decodes them; emitting them raw would
    // split the query into different params than the samples had.
    const samples = [
      '/Reservation/view?id=A1&ret=%2Fhk%3Ftab%3D2%26all%3D1',
      '/Reservation/view?id=B2&ret=%2Fhk%3Ftab%3D2%26all%3D1',
      '/Reservation/view?id=C3&ret=%2Fhk%3Ftab%3D2%26all%3D1',
    ];
    const r = inferUrlTemplate(samples);
    assert.equal(r.ok, true);
    // The `ret` value must survive as a SINGLE encoded param, not spill into a
    // spurious top-level `all=1` param or truncate the `ret` value.
    const parsed = new URL(r.template, 'https://_dummy.invalid');
    assert.equal(parsed.searchParams.get('ret'), '/hk?tab=2&all=1');
    assert.equal(parsed.searchParams.get('all'), null); // NOT a separate param
    // Exactly two params: the varying `id` (now a placeholder) and the invariant `ret`.
    assert.deepEqual([...parsed.searchParams.keys()].sort(), ['id', 'ret']);
    assert.equal(parsed.searchParams.get('id'), '{var_0}'); // id varies → placeholder
  });

  test('a plus-sign in an invariant value is re-encoded (round-trips as literal +)', () => {
    const samples = [
      '/detail?id=1&note=a%2Bb',
      '/detail?id=2&note=a%2Bb',
      '/detail?id=3&note=a%2Bb',
    ];
    const r = inferUrlTemplate(samples);
    assert.equal(r.ok, true);
    const parsed = new URL(r.template, 'https://_dummy.invalid');
    assert.equal(parsed.searchParams.get('note'), 'a+b');
  });

  test('a plain invariant value is unchanged (byte-identical for the common case)', () => {
    const samples = ['/v?id=1&tab=list', '/v?id=2&tab=list', '/v?id=3&tab=list'];
    const r = inferUrlTemplate(samples);
    assert.equal(r.ok, true);
    assert.match(r.template, /tab=list/);
  });
});

// ─── ITEM B — {var_N} rewritten to column names → replayable template ───────

describe('drill-down template placeholder rewrite (ITEM B)', () => {
  // Mirror EXACTLY what mapDrillDownAction now does: infer → map placeholders to
  // columns → rewrite {var_N} to {columnName}.
  function buildDrillTemplate(sampleUrls: string[], rowData: Array<Record<string, string>>) {
    const inference = inferUrlTemplate(sampleUrls);
    const placeholderToColumn = inference.ok
      ? mapPlaceholdersToColumns(inference.placeholders, rowData)
      : {};
    let detailUrlTemplate = inference.ok ? inference.template : sampleUrls[0]!;
    const detailUrlParams: Record<string, string> = {};
    for (const [placeholder, columnName] of Object.entries(placeholderToColumn)) {
      detailUrlTemplate = detailUrlTemplate.replaceAll(`{${placeholder}}`, `{${columnName}}`);
      detailUrlParams[columnName] = columnName;
    }
    const templateFullyBound =
      inference.ok && [...detailUrlTemplate.matchAll(/\{([^}]+)\}/g)].every(
        (m) => detailUrlParams[m[1]!] !== undefined,
      );
    return { detailUrlTemplate, detailUrlParams, templateFullyBound };
  }

  test('the template placeholder is the COLUMN name (not {var_0}) and resolves from a row', () => {
    const sampleUrls = [
      '/Reservation/view?id=ABC123',
      '/Reservation/view?id=DEF456',
      '/Reservation/view?id=GHI789',
    ];
    const rowData = [
      { reservation_id: 'ABC123', guest_name: 'Ann' },
      { reservation_id: 'DEF456', guest_name: 'Bob' },
      { reservation_id: 'GHI789', guest_name: 'Cy' },
    ];
    const { detailUrlTemplate, detailUrlParams, templateFullyBound } = buildDrillTemplate(sampleUrls, rowData);

    // No {var_N} survives — the placeholder is the list column name.
    assert.doesNotMatch(detailUrlTemplate, /\{var_\d+\}/);
    assert.deepEqual(templatePlaceholders(detailUrlTemplate), ['reservation_id']);
    // urlParams is keyed by the same column name (the template-runner + gate contract).
    assert.deepEqual(detailUrlParams, { reservation_id: 'reservation_id' });
    assert.equal(templateFullyBound, true);

    // The template is replayable: a runtime row (keyed by column name) substitutes.
    const url = substituteTemplate(detailUrlTemplate, { reservation_id: 'ABC123' });
    assert.equal(url, '/Reservation/view?id=ABC123');
  });

  test('an unbindable var (matches no column) is NOT stamped templateVerified', () => {
    const sampleUrls = [
      '/view?id=A1&seq=10',
      '/view?id=B2&seq=20',
      '/view?id=C3&seq=30',
    ];
    // rowData only has a column matching `id` — `seq` values match NO column, so
    // its {var_N} can't be rewritten and the template is unreplayable.
    const rowData = [
      { reservation_id: 'A1' },
      { reservation_id: 'B2' },
      { reservation_id: 'C3' },
    ];
    const { detailUrlTemplate, templateFullyBound } = buildDrillTemplate(sampleUrls, rowData);
    // A raw {var_N} remains (the seq column was never bound).
    assert.match(detailUrlTemplate, /\{var_\d+\}/);
    // …so we must NOT advertise it as verified (the eligibility gate would fail closed forever).
    assert.equal(templateFullyBound, false);
  });
});

// ─── ITEM A — drill-down landing-goto anchoring ────────────────────────────

describe('drill-down landing goto anchoring (ITEM A)', () => {
  test('recording goto(listUrl) makes listUrl the source and empties the blind preSteps', () => {
    // Reproduce mapDrillDownAction's recorded steps BEFORE the fix: a lone
    // goto(dashboard) plus the whole exploration + drill click path.
    const steps: RecipeStep[] = [
      { kind: 'goto', url: 'https://pms.example/dashboard' },
      { kind: 'click_at', x: 100, y: 40 },   // open the reservations menu
      { kind: 'click_at', x: 120, y: 80 },   // click "list"
      { kind: 'click_at', x: 300, y: 200 },  // drill into a sample row
      { kind: 'click_at', x: 20, y: 20 },    // back
    ];

    // Without the fix: the last goto is the dashboard, so recipe-adapter would
    // derive sourceUrl = dashboard AND carry every click as blind preSteps.
    const before = deriveDomPreStepsFromSteps(steps);
    assert.ok(before.length > 0, 'pre-fix: exploration clicks would be blind-replayed');

    // The fix — anchor the model's list URL as a trailing goto.
    recordLandingGoto(steps, 'https://pms.example/reservations/list');

    // The last goto is now the LIST page → recipe-adapter derives it as source.
    const gotos = steps.filter((s) => s.kind === 'goto');
    assert.equal((gotos[gotos.length - 1] as { url: string }).url, 'https://pms.example/reservations/list');
    // …and every exploration/drill click now falls BEFORE that goto, so it is
    // dropped instead of being blind-replayed on the live PMS each poll.
    assert.deepEqual(deriveDomPreStepsFromSteps(steps), []);
  });

  test('a listUrl equal to the dashboard is a no-op (no spurious goto)', () => {
    const steps: RecipeStep[] = [
      { kind: 'goto', url: 'https://pms.example/dashboard' },
      { kind: 'click_at', x: 1, y: 1 },
    ];
    const gotosBefore = steps.filter((s) => s.kind === 'goto').length;
    recordLandingGoto(steps, 'https://pms.example/dashboard');
    // Same URL → no appended goto (recordLandingGoto is idempotent on unchanged URL).
    assert.equal(steps.filter((s) => s.kind === 'goto').length, gotosBefore);
  });
});

// ─── ITEM F — csv download trigger is the export click, not a later click ───

describe('csv download flow trigger derivation (ITEM F)', () => {
  test('steps snapshotted AT the trigger click derive the correct download trigger', () => {
    // The full recorded path: navigate to the report page, click Export (fires the
    // download), THEN two more exploration clicks after the export.
    const full: RecipeStep[] = [
      { kind: 'goto', url: 'https://pms.example/report' },
      { kind: 'click', selector: '#export-btn' },   // ← the real download trigger
      { kind: 'click', selector: '#other-menu' },   // post-export exploration
      { kind: 'click', selector: '#another' },       // post-export exploration
    ];
    // The snapshot taken AT download-fire time ends at the export click.
    const atTrigger: RecipeStep[] = full.slice(0, 2);

    const wrong = deriveCsvFlowFromSteps(full);
    const right = deriveCsvFlowFromSteps(atTrigger);

    // Pre-fix (full list): the LAST click after the last goto is a wrong exploration click.
    assert.equal(wrong.downloadButton, '#another');
    // Post-fix (snapshot): the trigger is the real export click.
    assert.equal(right.downloadButton, '#export-btn');
  });
});
