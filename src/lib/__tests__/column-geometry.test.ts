/**
 * Tests for src/lib/pms/column-geometry.ts — the pure "which column did I drag"
 * math behind feature/cua-click-to-map (drag a box on the source screenshot).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pickColumnFromDrag, resolveDragRegion, slugifyHeader, type ColumnGeometry } from '@/lib/pms/column-geometry';

// A CA-Arrivals-ish strip layout in viewport CSS px (3 columns shown).
const GEO: ColumnGeometry = {
  viewport: { w: 1000, h: 800 },
  columns: [
    { index: 3, header: 'Guest Name', x: 100, y: 50, w: 180, h: 600 },
    { index: 8, header: 'Room #',     x: 300, y: 50, w: 80,  h: 600 },
    { index: 14, header: 'Conf #',    x: 700, y: 50, w: 120, h: 600 },
  ],
};

describe('pickColumnFromDrag', () => {
  test('a box squarely over a column picks it', () => {
    const c = pickColumnFromDrag(GEO, { x: 120, w: 100 });
    assert.equal(c?.header, 'Guest Name');
    assert.equal(c?.index, 3);
  });

  test('picks the column with the GREATER overlap when a drag straddles two', () => {
    // 260..360 overlaps Guest(100..280)=20 and Room(300..380)=60 → Room wins.
    const c = pickColumnFromDrag(GEO, { x: 260, w: 100 });
    assert.equal(c?.header, 'Room #');
  });

  test('a drag in an empty margin (no overlap) returns null', () => {
    assert.equal(pickColumnFromDrag(GEO, { x: 450, w: 80 }), null); // 450..530 hits nothing
  });

  test('a far-right column resolves correctly', () => {
    assert.equal(pickColumnFromDrag(GEO, { x: 720, w: 40 })?.index, 14);
  });

  test('zero/negative width drag never throws and returns null', () => {
    assert.equal(pickColumnFromDrag(GEO, { x: 120, w: 0 }), null);
    assert.equal(pickColumnFromDrag(GEO, { x: 120, w: -5 }), null);
  });
});

describe('resolveDragRegion', () => {
  const GEOV: ColumnGeometry = {
    ...GEO,
    values: [
      { selector: '#guestCount', text: 'Guest Count: 39', x: 100, y: 700, w: 140, h: 20 },
      { selector: '#date', text: 'June 23, 2026', x: 400, y: 700, w: 120, h: 20 },
    ],
  };

  test('a box over a column resolves to that column (columns win)', () => {
    const r = resolveDragRegion(GEOV, { x: 120, y: 60, w: 100, h: 400 });
    assert.equal(r.kind, 'column');
    if (r.kind === 'column') assert.equal(r.column.header, 'Guest Name');
  });

  test('a box over a standalone value (no column overlap) resolves to that value', () => {
    // x 400..520 overlaps no column (columns end at 820 but none span 400..520),
    // and the date value sits at 400..520, y 700 → value wins.
    const r = resolveDragRegion(GEOV, { x: 400, y: 695, w: 110, h: 30 });
    assert.equal(r.kind, 'value');
    if (r.kind === 'value') assert.equal(r.value.selector, '#date');
  });

  test('a box over empty space resolves to unknown (→ UI asks the founder)', () => {
    const r = resolveDragRegion(GEOV, { x: 900, y: 695, w: 40, h: 20 });
    assert.equal(r.kind, 'unknown');
  });

  test('no values present → still resolves columns, else unknown', () => {
    assert.equal(resolveDragRegion(GEO, { x: 120, y: 60, w: 100, h: 400 }).kind, 'column');
    assert.equal(resolveDragRegion(GEO, { x: 450, y: 695, w: 80, h: 20 }).kind, 'unknown');
  });

  // Regression: the "Guest Count: 23" bug. A page total in the header sits ABOVE
  // the table but lines up left-to-right with a column below it. The X-only pick
  // used to mis-resolve it to that column's per-row cell (→ "Check In"). The
  // Y-gate must make it fall through to the header VALUE (#guestCount) instead.
  const GEO_HEADER: ColumnGeometry = {
    ...GEO, // columns span y 50..650
    values: [
      { selector: '#guestCount', text: 'Guest Count: 23', x: 110, y: 10, w: 90, h: 25 }, // ABOVE the table
      { selector: '#roomCount',  text: 'Room Count: 10',  x: 310, y: 10, w: 70, h: 25 }, // ABOVE, over Room #
    ],
  };

  test('a header total ABOVE the table, x-aligned over a column, resolves to the VALUE not the column', () => {
    // y 8..36 is entirely above the column band (50..650); x 110..200 lines up with Guest Name (100..280).
    const r = resolveDragRegion(GEO_HEADER, { x: 110, y: 8, w: 90, h: 28 });
    assert.equal(r.kind, 'value');
    if (r.kind === 'value') assert.equal(r.value.selector, '#guestCount');
  });

  test('a second header total above a different column also resolves to its value', () => {
    const r = resolveDragRegion(GEO_HEADER, { x: 312, y: 8, w: 66, h: 28 });
    assert.equal(r.kind, 'value');
    if (r.kind === 'value') assert.equal(r.value.selector, '#roomCount');
  });

  test('an in-table drag (header row or body) still resolves to the column — Y-gate does not regress it', () => {
    // y 60 sits inside the band → column wins even though a header value is x-aligned above.
    const r = resolveDragRegion(GEO_HEADER, { x: 120, y: 60, w: 100, h: 200 });
    assert.equal(r.kind, 'column');
    if (r.kind === 'column') assert.equal(r.column.header, 'Guest Name');
  });

  test('a drag below the table that x-overlaps a column resolves to a below-table value, not the column', () => {
    const geo: ColumnGeometry = {
      ...GEO,
      values: [{ selector: '#footerTotal', text: 'Total: 23', x: 110, y: 700, w: 90, h: 20 }], // y 700 > band 650
    };
    const r = resolveDragRegion(geo, { x: 110, y: 698, w: 90, h: 24 });
    assert.equal(r.kind, 'value');
    if (r.kind === 'value') assert.equal(r.value.selector, '#footerTotal');
  });
});

describe('slugifyHeader', () => {
  test('humanizes common headers', () => {
    assert.equal(slugifyHeader('Rate Plan'), 'rate_plan');
    assert.equal(slugifyHeader('Conf. #'), 'conf');
    assert.equal(slugifyHeader('# Nights'), 'nights');   // leading "# " stripped
    assert.equal(slugifyHeader('2nd Guest'), 'c_2nd_guest'); // leading digit → c_ prefix
    assert.equal(slugifyHeader('   '), 'field');
  });
});
