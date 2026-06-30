/**
 * visual-state-learn — orchestration coverage with a MOCK vision labeler (no API,
 * no cost) against a real Playwright CA-shaped page. Proves:
 *   - single-dimension clean/dirty learns `td:nth-child(6)@tablesort_sortvalue`,
 *   - an inverted CERTIFY pass parks (anti-inversion),
 *   - a FUSED status (occupied/vacant × clean/dirty) parks — no single signal,
 *   - a single-class screen parks,
 *   - too-few-rows parks.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder-for-tests';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { learnVisualStateColumn, type VisionLabeler } from '../visual-state-learn.js';

let browser: Browser | null = null;
let page: Page | null = null;
before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
});
after(async () => {
  if (browser) await browser.close();
});
const dataUrl = (html: string): string => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

// [room, clean|dirty, occupied?, evenRow]
type Row = [string, 'clean' | 'dirty', boolean, boolean];
const ROWS: Row[] = [
  ['101', 'clean', false, false],
  ['102', 'dirty', true, true],
  ['103', 'clean', false, false],
  ['104', 'dirty', true, true],
  ['105', 'clean', true, false],
  ['106', 'clean', false, true],
  ['201', 'dirty', true, true],
];

function caTable(rows: Row[]): string {
  const body = rows
    .map(([room, cond, occ, even]) => {
      const cls = even ? 'UBcontainer CHI_EvenCell CHI_EvenRowCell' : 'UBcontainer CHI_EvenCell';
      const sv = cond === 'clean' ? 'C' : 'D';
      const occText = occ ? 'Occupied' : 'Vacant';
      return `<tr><td>${room}</td><td></td><td>SNQQ</td><td>${occText}</td><td>Ready</td>` +
        `<td class="${cls}" tablesort_sortvalue="${sv}">Ready</td><td>None</td><td>M. C.</td></tr>`;
    })
    .join('');
  return `<table><tbody><tr id="t" style="display:none"><td>T</td><td></td><td></td><td></td><td></td>` +
    `<td tablesort_sortvalue="">Ready</td><td></td><td></td></tr>${body}</tbody></table>`;
}

// A mock labeler keyed by a per-room map; pass-specific override allows simulating
// an inverted certify pass.
function mockLabeler(byRoom: Map<string, string>, certifyByRoom?: Map<string, string>): VisionLabeler {
  return async (pass) => (pass === 'certify' && certifyByRoom ? certifyByRoom : byRoom);
}

const CONDITION_CSS = 'td:nth-child(6)';
const KEY_CSS = 'td:nth-child(1)';

describe('learnVisualStateColumn', () => {
  test('clean/dirty: learns td:nth-child(6)@tablesort_sortvalue, value map C->clean D->dirty', async () => {
    await page!.goto(dataUrl(caTable(ROWS)));
    const labels = new Map(ROWS.map(([room, cond]) => [room, cond] as const));
    const out = await learnVisualStateColumn({
      page: page!, rowSelector: 'tbody tr', keyCellCss: KEY_CSS, targetCellCss: CONDITION_CSS,
      label: mockLabeler(labels),
    });
    assert.equal(out.ok, true, out.reason);
    assert.equal(out.selector, 'td:nth-child(6)@tablesort_sortvalue');
    assert.deepEqual(out.valueMap, { C: 'clean', D: 'dirty' });
  });

  test('inverted certify pass parks (anti-inversion)', async () => {
    await page!.goto(dataUrl(caTable(ROWS)));
    const correct = new Map(ROWS.map(([room, cond]) => [room, cond] as const));
    const inverted = new Map(ROWS.map(([room, cond]) => [room, cond === 'clean' ? 'dirty' : 'clean'] as const));
    const out = await learnVisualStateColumn({
      page: page!, rowSelector: 'tbody tr', keyCellCss: KEY_CSS, targetCellCss: CONDITION_CSS,
      label: mockLabeler(correct, inverted),
    });
    assert.equal(out.ok, false);
    assert.match(out.reason, /certify failed/);
  });

  test('FUSED status (occupied/vacant x clean/dirty) parks — no single signal partitions', async () => {
    // 8 rows, ≥2 per fused label, so the per-class floor passes and we actually
    // reach findDiscriminator — which must return null because tablesort C/D maps
    // C to BOTH vacant_clean and occupied_clean (the occupancy half lives in a
    // different column the single attr can't see).
    const fusedRows: Row[] = [
      ['101', 'clean', false, false], ['102', 'clean', false, true],
      ['103', 'dirty', false, false], ['104', 'dirty', false, true],
      ['105', 'clean', true, false], ['106', 'clean', true, true],
      ['107', 'dirty', true, false], ['108', 'dirty', true, true],
    ];
    await page!.goto(dataUrl(caTable(fusedRows)));
    const fused = new Map(
      fusedRows.map(([room, cond, occ]) => [room, `${occ ? 'occupied' : 'vacant'}_${cond}`] as const),
    );
    const out = await learnVisualStateColumn({
      page: page!, rowSelector: 'tbody tr', keyCellCss: KEY_CSS, targetCellCss: CONDITION_CSS,
      label: mockLabeler(fused),
    });
    assert.equal(out.ok, false);
    assert.match(out.reason, /no single readable signal/);
  });

  test('single-class screen parks', async () => {
    const allClean = ROWS.map(([r, , occ, even]) => [r, 'clean', occ, even] as Row);
    await page!.goto(dataUrl(caTable(allClean)));
    const labels = new Map(allClean.map(([room]) => [room, 'clean'] as const));
    const out = await learnVisualStateColumn({
      page: page!, rowSelector: 'tbody tr', keyCellCss: KEY_CSS, targetCellCss: CONDITION_CSS,
      label: mockLabeler(labels),
    });
    assert.equal(out.ok, false);
    assert.match(out.reason, /<2 distinct/);
  });

  test('duplicate room numbers park (ambiguous binding)', async () => {
    // Two rows reading room "101" — the vision↔DOM join would be ambiguous.
    const dup: Row[] = [
      ['101', 'clean', false, false], ['101', 'dirty', true, true],
      ['103', 'clean', false, false], ['104', 'dirty', true, true],
      ['105', 'clean', false, false], ['106', 'clean', true, true],
    ];
    await page!.goto(dataUrl(caTable(dup)));
    const labels = new Map<string, string>([['101', 'clean'], ['103', 'clean'], ['104', 'dirty'], ['105', 'clean'], ['106', 'clean']]);
    const out = await learnVisualStateColumn({
      page: page!, rowSelector: 'tbody tr', keyCellCss: KEY_CSS, targetCellCss: CONDITION_CSS,
      label: mockLabeler(labels),
    });
    assert.equal(out.ok, false);
    assert.match(out.reason, /duplicate row keys/);
  });

  test('too-few-rows parks', async () => {
    const few = ROWS.slice(0, 3);
    await page!.goto(dataUrl(caTable(few)));
    const labels = new Map(few.map(([room, cond]) => [room, cond] as const));
    const out = await learnVisualStateColumn({
      page: page!, rowSelector: 'tbody tr', keyCellCss: KEY_CSS, targetCellCss: CONDITION_CSS,
      label: mockLabeler(labels),
    });
    assert.equal(out.ok, false);
    assert.match(out.reason, /too few/);
  });
});
