/**
 * feature/cua-semantic-columns — runtime reader self-heal tests.
 *
 * Exercises extractDomRows (extractors/dom-rows.ts) against real Playwright
 * pages. Proves the header-anchored ("semantic") column resolution:
 *   - tiered resolves a column by header text, with css fallback
 *   - a column REORDER self-heals (reads the right cell after columns move)
 *   - legacy flat (no tiered) replays byte-identically AND is brittle to reorder
 *     (which is exactly the gap tiering closes)
 *   - no header row → positional css fallback (never blocks a feed)
 *   - duplicate headers ("Date", "Date") disambiguate by INDEX (no strict-mode
 *     throw the way getByRole-by-name would)
 *   - the `@attr` + within-cell refinement survive the index rebase
 *   - the rowSelector xpath tier fires when css matches nothing
 *   - the column xpath tier fills a column whose css is blank in every row
 *
 * Plus unit coverage of the pure helpers (parseFirstNthIndex / rebaseNthIndex /
 * normalizeHeaderText / readTableHeaders / headerGateOk).
 */

// Env shims (lib code transitively touches supabase-admin at import).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder-for-tests';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import {
  extractDomRows,
  readTableHeaders,
  headerGateOk,
  parseFirstNthIndex,
  rebaseNthIndex,
  normalizeHeaderText,
} from '../extractors/dom-rows.js';
import type { TieredSelector } from '../types.js';

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

const dataUrl = (html: string): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

/**
 * Mirror of mapper.ts buildColumnHeaderAnchors — author the durable per-column
 * header anchors from the LIVE header row, exactly as finalize does (read header
 * text at each column's nth-child index → roleName{role,name}). Kept in lock-step
 * with the real authoring, which is unit-tested separately via
 * finalizeRecoveredSuccess in semantic-columns-finalize.test.ts.
 */
async function authorAnchors(
  p: Page,
  rowSelector: string,
  columns: Record<string, string>,
): Promise<Record<string, TieredSelector>> {
  const headers = await readTableHeaders(p, rowSelector);
  assert.ok(headers, 'readTableHeaders should resolve on a real table');
  assert.ok(headerGateOk(headers), 'header gate should pass on a clean table');
  const textByIndex = new Map<number, string>();
  for (const c of headers!.cells) if (c.index >= 1 && c.raw.trim() !== '') textByIndex.set(c.index, c.raw);
  const tiered: Record<string, TieredSelector> = {};
  for (const [field, css] of Object.entries(columns)) {
    const idx = parseFirstNthIndex(css);
    const text = idx != null ? textByIndex.get(idx) : undefined;
    if (idx != null && text) tiered[field] = { roleName: { role: headers!.roleKind, name: text }, css };
  }
  return tiered;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

// V1: Room | Guest | Status   (the order the mapper learned on)
const TABLE_V1 = `<!DOCTYPE html><html><body><table><thead><tr>
<th>Room</th><th>Guest</th><th>Status</th>
</tr></thead><tbody>
<tr><td>101</td><td>Alice</td><td>Clean</td></tr>
<tr><td>102</td><td>Bob</td><td>Dirty</td></tr>
</tbody></table></body></html>`;

// V2: Guest | Status | Room   (PMS reordered: Room moved 1 → 3, same header TEXT)
const TABLE_V2_REORDER = `<!DOCTYPE html><html><body><table><thead><tr>
<th>Guest</th><th>Status</th><th>Room</th>
</tr></thead><tbody>
<tr><td>Alice</td><td>Clean</td><td>101</td></tr>
<tr><td>Bob</td><td>Dirty</td><td>102</td></tr>
</tbody></table></body></html>`;

const LEARNED_COLUMNS = {
  room: 'td:nth-child(1)',
  guest: 'td:nth-child(2)',
  status: 'td:nth-child(3)',
};

describe('feature/cua-semantic-columns — runtime reader self-heal', () => {
  test('legacy flat (no tiered) replays exactly as today on the learned layout', async () => {
    await page!.goto(dataUrl(TABLE_V1));
    const r = await extractDomRows(page!, 'tbody tr', LEARNED_COLUMNS, { cap: 50 });
    assert.deepEqual(r.rows, [
      { room: '101', guest: 'Alice', status: 'Clean' },
      { room: '102', guest: 'Bob', status: 'Dirty' },
    ]);
    assert.equal(r.resolution, undefined, 'fast path emits no resolution telemetry');
  });

  test('tiered on the SAME layout reads IDENTICALLY to flat (no drift, no behavior change)', async () => {
    await page!.goto(dataUrl(TABLE_V1));
    const flat = await extractDomRows(page!, 'tbody tr', LEARNED_COLUMNS, { cap: 50 });
    const tiered = await authorAnchors(page!, 'tbody tr', LEARNED_COLUMNS);
    const withTiered = await extractDomRows(page!, 'tbody tr', LEARNED_COLUMNS, { cap: 50, columnsTiered: tiered });
    assert.deepEqual(withTiered.rows, flat.rows, 'tiered must not change reads when nothing moved');
    assert.ok(withTiered.resolution);
    assert.ok(withTiered.resolution!.every((r) => r.tier === 'roleName' && r.drift === false));
  });

  test('a column REORDER self-heals via the header anchor', async () => {
    // Author anchors on V1, then point the SAME recipe at the reordered V2.
    await page!.goto(dataUrl(TABLE_V1));
    const tiered = await authorAnchors(page!, 'tbody tr', LEARNED_COLUMNS);

    await page!.goto(dataUrl(TABLE_V2_REORDER));
    const healed = await extractDomRows(page!, 'tbody tr', LEARNED_COLUMNS, { cap: 50, columnsTiered: tiered });
    assert.deepEqual(healed.rows, [
      { room: '101', guest: 'Alice', status: 'Clean' },
      { room: '102', guest: 'Bob', status: 'Dirty' },
    ], 'header anchor re-finds each column after the reorder');

    const byField = new Map(healed.resolution!.map((r) => [r.field, r]));
    assert.equal(byField.get('room')!.tier, 'roleName');
    assert.equal(byField.get('room')!.drift, true);
    assert.equal(byField.get('room')!.fromIndex, 1);
    assert.equal(byField.get('room')!.toIndex, 3);
    assert.equal(byField.get('guest')!.drift, true);   // 2 -> 1
    assert.equal(byField.get('status')!.drift, true);  // 3 -> 2
  });

  test('WITHOUT tiering, the same reorder grabs the WRONG cells (the gap tiering closes)', async () => {
    await page!.goto(dataUrl(TABLE_V2_REORDER));
    const brittle = await extractDomRows(page!, 'tbody tr', LEARNED_COLUMNS, { cap: 50 });
    // Positional: room=nth-child(1)=Guest value, etc. — silently wrong.
    assert.equal(brittle.rows[0]!.room, 'Alice');
    assert.equal(brittle.rows[0]!.status, '101');
    assert.notEqual(brittle.rows[0]!.room, '101');
  });

  test('non-positional css column uses the css tier (no rebaseable index)', async () => {
    const html = `<!DOCTYPE html><html><body><table><thead><tr>
      <th>Room</th><th>Note</th></tr></thead><tbody>
      <tr><td>201</td><td><span class="note-cell">VIP</span></td></tr>
      </tbody></table></body></html>`;
    await page!.goto(dataUrl(html));
    const columns = { room: 'td:nth-child(1)', note: '.note-cell' };
    const tiered: Record<string, TieredSelector> = {
      room: { roleName: { role: 'cell', name: 'Room' }, css: 'td:nth-child(1)' },
      note: { roleName: { role: 'cell', name: 'Note' }, css: '.note-cell' }, // non-positional
    };
    const r = await extractDomRows(page!, 'tbody tr', columns, { cap: 50, columnsTiered: tiered });
    assert.equal(r.rows[0]!.room, '201');
    assert.equal(r.rows[0]!.note, 'VIP');
    const byField = new Map(r.resolution!.map((x) => [x.field, x.tier]));
    assert.equal(byField.get('room'), 'roleName');
    assert.equal(byField.get('note'), 'css', 'class selector has no nth index → css tier');
  });

  test('no header row → positional css fallback (feed never blocked)', async () => {
    // A header-less table (all <td>, no <th>/thead). Even WITH tiered authored,
    // the resolver finds no header and reads positionally — exactly as today.
    const html = `<!DOCTYPE html><html><body><table><tbody>
      <tr><td>301</td><td>Carol</td><td>Inspected</td></tr>
      </tbody></table></body></html>`;
    await page!.goto(dataUrl(html));
    const headers = await readTableHeaders(page!, 'tbody tr');
    assert.equal(headerGateOk(headers), false, 'no <th> → gate fails');
    const tiered: Record<string, TieredSelector> = {
      room: { roleName: { role: 'cell', name: 'Room' }, css: 'td:nth-child(1)' },
    };
    const r = await extractDomRows(page!, 'tbody tr', { room: 'td:nth-child(1)' }, { cap: 50, columnsTiered: tiered });
    assert.equal(r.rows[0]!.room, '301');
    assert.equal(r.resolution!.find((x) => x.field === 'room')!.tier, 'css');
  });

  test('duplicate headers ("Date", "Date") disambiguate by INDEX, never strict-throw', async () => {
    const html = `<!DOCTYPE html><html><body><table><thead><tr>
      <th>Date</th><th>Guest</th><th>Date</th></tr></thead><tbody>
      <tr><td>2026-06-14</td><td>Dave</td><td>2026-06-16</td></tr>
      </tbody></table></body></html>`;
    await page!.goto(dataUrl(html));
    const columns = { arrival: 'td:nth-child(1)', guest: 'td:nth-child(2)', departure: 'td:nth-child(3)' };
    const tiered: Record<string, TieredSelector> = {
      arrival: { roleName: { role: 'cell', name: 'Date' }, css: 'td:nth-child(1)' },
      guest: { roleName: { role: 'cell', name: 'Guest' }, css: 'td:nth-child(2)' },
      departure: { roleName: { role: 'cell', name: 'Date' }, css: 'td:nth-child(3)' },
    };
    const r = await extractDomRows(page!, 'tbody tr', columns, { cap: 50, columnsTiered: tiered });
    assert.equal(r.rows[0]!.arrival, '2026-06-14');
    assert.equal(r.rows[0]!.departure, '2026-06-16');
    assert.equal(r.rows[0]!.guest, 'Dave');
    // Both Date columns resolved (by index), no fallthrough, no throw.
    assert.ok(r.resolution!.filter((x) => x.field === 'arrival' || x.field === 'departure').every((x) => x.tier === 'roleName' && !x.drift));
  });

  test('@attr + within-cell refinement survive the rebase on a reorder', async () => {
    const v1 = `<!DOCTYPE html><html><body><table><thead><tr>
      <th>Room</th><th>Link</th></tr></thead><tbody>
      <tr><td>401</td><td><a href="/res/401">open</a></td></tr>
      </tbody></table></body></html>`;
    const v2 = `<!DOCTYPE html><html><body><table><thead><tr>
      <th>Link</th><th>Room</th></tr></thead><tbody>
      <tr><td><a href="/res/401">open</a></td><td>401</td></tr>
      </tbody></table></body></html>`;
    const columns = { room: 'td:nth-child(1)', link: 'td:nth-child(2) a@href' };
    await page!.goto(dataUrl(v1));
    const tiered = await authorAnchors(page!, 'tbody tr', columns);
    await page!.goto(dataUrl(v2));
    const r = await extractDomRows(page!, 'tbody tr', columns, { cap: 50, columnsTiered: tiered });
    assert.equal(r.rows[0]!.room, '401');
    assert.equal(r.rows[0]!.link, '/res/401', 'href read from the rebased column index');
  });

  test('rowSelector xpath tier fires when css matches nothing', async () => {
    await page!.goto(dataUrl(TABLE_V1));
    const r = await extractDomRows(
      page!,
      'tr.does-not-exist',
      LEARNED_COLUMNS,
      { cap: 50, rowSelectorTiered: { css: 'tr.does-not-exist', xpath: '//tbody/tr' } },
    );
    assert.equal(r.rowSelectorTier, 'xpath');
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[0]!.room, '101');
  });

  test('column xpath tier fills a column whose css is blank in every row', async () => {
    const html = `<!DOCTYPE html><html><body><table><thead><tr>
      <th>Room</th><th>Owner</th></tr></thead><tbody>
      <tr><td>501</td><td data-owner="Eve"></td></tr>
      </tbody></table></body></html>`;
    await page!.goto(dataUrl(html));
    // owner css points at a class that doesn't exist → blank; xpath reads the attr.
    const columns = { room: 'td:nth-child(1)', owner: '.owner-name' };
    const tiered: Record<string, TieredSelector> = {
      owner: { css: '.owner-name', xpath: './td[2]/@data-owner' },
    };
    const r = await extractDomRows(page!, 'tbody tr', columns, { cap: 50, columnsTiered: tiered });
    assert.equal(r.rows[0]!.room, '501');
    assert.equal(r.rows[0]!.owner, 'Eve');
    assert.equal(r.resolution!.find((x) => x.field === 'owner')!.tier, 'xpath');
  });
});

describe('feature/cua-semantic-columns — pure helpers', () => {
  test('parseFirstNthIndex reads the first bare nth integer, else null', () => {
    assert.equal(parseFirstNthIndex('td:nth-child(3)'), 3);
    assert.equal(parseFirstNthIndex('td:nth-of-type(5) a@href'), 5);
    assert.equal(parseFirstNthIndex(':nth-child( 7 )'), 7);
    assert.equal(parseFirstNthIndex('.status-cell'), null);
    assert.equal(parseFirstNthIndex('@data-room'), null);
    assert.equal(parseFirstNthIndex('td:nth-child(2n+1)'), null, 'formula args are not rebaseable');
  });

  test('rebaseNthIndex swaps ONLY the first index, preserving @attr and refinement', () => {
    assert.equal(rebaseNthIndex('td:nth-child(3)', 5), 'td:nth-child(5)');
    assert.equal(rebaseNthIndex('td:nth-child(3) a@href', 5), 'td:nth-child(5) a@href');
    assert.equal(rebaseNthIndex('td:nth-of-type(2) .badge', 4), 'td:nth-of-type(4) .badge');
    assert.equal(rebaseNthIndex('.no-index', 9), '.no-index', 'no nth → unchanged');
  });

  test('normalizeHeaderText collapses whitespace, trims, lowercases', () => {
    assert.equal(normalizeHeaderText('  Room   Number\n'), 'room number');
    assert.equal(normalizeHeaderText('STATUS'), 'status');
  });

  test('readTableHeaders + headerGateOk: clean table passes, colspan header fails', async () => {
    await page!.goto(dataUrl(TABLE_V1));
    const h = await readTableHeaders(page!, 'tbody tr');
    assert.ok(h);
    assert.equal(h!.roleKind, 'cell');
    assert.deepEqual(h!.cells.map((c) => [c.index, c.text]), [[1, 'room'], [2, 'guest'], [3, 'status']]);
    assert.equal(headerGateOk(h), true);

    const spanned = `<!DOCTYPE html><html><body><table><thead><tr>
      <th colspan="2">Guest</th><th>Status</th></tr></thead><tbody>
      <tr><td>101</td><td>Alice</td><td>Clean</td></tr></tbody></table></body></html>`;
    await page!.goto(dataUrl(spanned));
    const hs = await readTableHeaders(page!, 'tbody tr');
    assert.ok(hs);
    assert.equal(hs!.hasSpan, true);
    assert.equal(headerGateOk(hs), false, 'spanning header → positions untrustworthy');
  });

  test('readTableHeaders resolves ARIA grids as gridcell', async () => {
    const html = `<!DOCTYPE html><html><body>
      <div role="grid"><div role="row"><div role="columnheader">Room</div><div role="columnheader">Guest</div></div>
      <div role="row" class="r"><div role="gridcell">601</div><div role="gridcell">Frank</div></div></div>
      </body></html>`;
    await page!.goto(dataUrl(html));
    const h = await readTableHeaders(page!, 'div.r');
    assert.ok(h);
    assert.equal(h!.roleKind, 'gridcell');
    assert.equal(headerGateOk(h), true);
  });
});
