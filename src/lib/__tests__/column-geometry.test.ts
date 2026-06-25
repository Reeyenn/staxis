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
