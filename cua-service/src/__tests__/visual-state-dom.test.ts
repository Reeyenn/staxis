/**
 * visual-state-dom — Playwright coverage for gatherCellSignals against a
 * Choice-Advantage-shaped housekeeping table:
 *   - a HIDDEN template row first (display:none) — must be dropped (same bug class
 *     as the dom-rows visible-row fix), so it can't inject a junk/blank key,
 *   - room number in column 1 (the stable key), constant "Ready" textContent in
 *     the condition column, the real clean/dirty in tablesort_sortvalue="C"|"D",
 *     and the CHI_EvenRowCell zebra class on even rows.
 * Proves the gatherer keys by room number, reads attrs + classes, and that its
 * output feeds findDiscriminator to the RIGHT signal end-to-end (DOM → learn).
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder-for-tests';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { gatherCellSignals } from '../visual-state-dom.js';
import { findDiscriminator, type RowSignals } from '../visual-state.js';

let browser: Browser | null = null;
let page: Page | null = null;

before(async () => {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
});
after(async () => {
  if (browser) await browser.close();
});

const dataUrl = (html: string): string => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

// room, clean|dirty, evenRow
const ROWS: Array<[string, 'clean' | 'dirty', boolean]> = [
  ['101', 'clean', false],
  ['102', 'dirty', true],
  ['103', 'clean', false],
  ['104', 'dirty', true],
  ['105', 'clean', false],
  ['106', 'clean', true],
  ['201', 'dirty', true],
];

function caTable(): string {
  const body = ROWS.map(([room, label, even]) => {
    const cls = even ? 'UBcontainer CHI_EvenCell CHI_EvenRowCell' : 'UBcontainer CHI_EvenCell';
    const sv = label === 'clean' ? 'C' : 'D';
    return `<tr><td>${room}</td><td></td><td>SNQQ</td><td>Vacant</td><td>Ready</td>` +
      `<td class="${cls}" tablesort_sortvalue="${sv}">Ready</td><td>None</td><td>M. C.</td></tr>`;
  }).join('');
  // A hidden TEMPLATE row first (CA's <tr id="roomConditionRow" style="display:none">)
  return `<table><tbody>` +
    `<tr id="tmpl" style="display:none"><td>TMPL</td><td></td><td></td><td></td><td></td>` +
    `<td class="UBcontainer" tablesort_sortvalue="">Ready</td><td></td><td></td></tr>` +
    body + `</tbody></table>`;
}

describe('gatherCellSignals — CA-shaped table', () => {
  test('keys by room number, drops the hidden template row, reads attrs + classes', async () => {
    await page!.goto(dataUrl(caTable()));
    const sigs = await gatherCellSignals(page!, 'tbody tr', 'td:nth-child(1)', 'td:nth-child(6)');

    // Hidden template row (key "TMPL") is gone; all 7 real rooms present.
    assert.equal(sigs.length, 7);
    assert.deepEqual(sigs.map((s) => s.rowKey), ['101', '102', '103', '104', '105', '106', '201']);

    const r101 = sigs.find((s) => s.rowKey === '101')!;
    assert.equal(r101.text, 'Ready'); // textContent is the uninformative constant
    assert.equal(r101.attrs.tablesort_sortvalue, 'C');
    assert.ok(!r101.classes.includes('CHI_EvenRowCell')); // odd row → no parity class

    const r102 = sigs.find((s) => s.rowKey === '102')!;
    assert.equal(r102.attrs.tablesort_sortvalue, 'D');
    assert.ok(r102.classes.includes('CHI_EvenRowCell')); // even row → parity class present
  });

  test('end-to-end: gathered signals → findDiscriminator picks tablesort_sortvalue', async () => {
    await page!.goto(dataUrl(caTable()));
    const sigs = await gatherCellSignals(page!, 'tbody tr', 'td:nth-child(1)', 'td:nth-child(6)');
    // Join with vision labels (by room number) — here from the fixture truth.
    const labelByRoom = new Map(ROWS.map(([room, label]) => [room, label] as const));
    const rows: RowSignals[] = sigs
      .filter((s) => labelByRoom.has(s.rowKey))
      .map((s) => ({ ...s, visionLabel: labelByRoom.get(s.rowKey)! }));

    const res = findDiscriminator(rows);
    assert.ok(res, 'should learn from real DOM signals');
    assert.equal(res!.rule.kind, 'attr');
    if (res!.rule.kind === 'attr') {
      assert.equal(res!.rule.attr, 'tablesort_sortvalue');
      assert.deepEqual(res!.rule.valueMap, { C: 'clean', D: 'dirty' });
    }
  });

  test('xpath row selector returns [] (caller abstains)', async () => {
    await page!.goto(dataUrl(caTable()));
    const sigs = await gatherCellSignals(page!, '//tbody/tr', 'td:nth-child(1)', 'td:nth-child(6)');
    assert.equal(sigs.length, 0);
  });
});
