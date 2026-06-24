/**
 * Tests for src/lib/pms/column-geometry.ts — the pure "which column did I drag"
 * math behind feature/cua-click-to-map (drag a box on the source screenshot).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pickColumnFromDrag, slugifyHeader, type ColumnGeometry } from '@/lib/pms/column-geometry';

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

describe('slugifyHeader', () => {
  test('humanizes common headers', () => {
    assert.equal(slugifyHeader('Rate Plan'), 'rate_plan');
    assert.equal(slugifyHeader('Conf. #'), 'conf');
    assert.equal(slugifyHeader('# Nights'), 'nights');   // leading "# " stripped
    assert.equal(slugifyHeader('2nd Guest'), 'c_2nd_guest'); // leading digit → c_ prefix
    assert.equal(slugifyHeader('   '), 'field');
  });
});
