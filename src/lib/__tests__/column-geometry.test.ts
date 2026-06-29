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

// A header total renders as a wide LABEL ("Guest Count:") + the narrow DATUM next
// to it ("13") as two separate boxes. The real-page proof: dragging the whole
// "Guest Count: 13" must capture the NUMBER, not the wider label. (The other
// fixtures collapse label+number into one box and can't exercise this.)
describe('resolveDragRegion — label vs. datum (the "Guest Count: 13" bug)', () => {
  const PAIR: ColumnGeometry = {
    viewport: { w: 1280, h: 800 },
    columns: [{ index: 3, header: 'Guest Name', x: 100, y: 280, w: 180, h: 400 }], // table below the header
    values: [
      { selector: 'div:nth-of-type(1) > label', text: 'Guest Count:', x: 52,  y: 166, w: 74, h: 30 },
      { selector: '#guestCount',                 text: '13',           x: 126, y: 166, w: 25, h: 30 },
      { selector: 'div:nth-of-type(3) > label', text: 'Room Count:',  x: 158, y: 166, w: 74, h: 30 },
      { selector: '#roomCount',                  text: '8',            x: 232, y: 166, w: 19, h: 30 },
    ],
  };

  test('dragging the WHOLE "Guest Count: 13" captures the NUMBER, not the label', () => {
    const r = resolveDragRegion(PAIR, { x: 50, y: 162, w: 103, h: 36 }); // covers label(52-126) + number(126-151)
    assert.equal(r.kind, 'value');
    if (r.kind === 'value') {
      assert.equal(r.value.selector, '#guestCount');
      assert.equal(r.value.text, '13');
      assert.equal(r.labelText, 'Guest Count:'); // naming hint → "guest_count", not "c_13"
    }
  });

  test('a tight drag on just the number also captures it', () => {
    const r = resolveDragRegion(PAIR, { x: 125, y: 165, w: 27, h: 32 });
    assert.equal(r.kind === 'value' && r.value.selector, '#guestCount');
  });

  test('a drag on only the label (no datum under it) falls back to the label', () => {
    const r = resolveDragRegion(PAIR, { x: 52, y: 165, w: 70, h: 30 }); // 52-122, ends before the number at 126
    assert.equal(r.kind, 'value');
    if (r.kind === 'value') assert.equal(r.value.text, 'Guest Count:');
  });

  test('a drag that only edge-clips a neighbouring number does not steal it (threshold)', () => {
    const r = resolveDragRegion(PAIR, { x: 52, y: 165, w: 77, h: 30 }); // 52-129: clips only ~3px of the number
    assert.equal(r.kind, 'value');
    if (r.kind === 'value') assert.equal(r.value.text, 'Guest Count:');
  });

  test('a lone colon-label with no datum nearby still resolves to it (not unknown)', () => {
    const geo: ColumnGeometry = { viewport: { w: 1280, h: 800 }, columns: PAIR.columns,
      values: [{ selector: 'div > label', text: 'Helpful Information:', x: 1093, y: 200, w: 107, h: 20 }] };
    const r = resolveDragRegion(geo, { x: 1095, y: 202, w: 100, h: 16 });
    assert.equal(r.kind, 'value');
    if (r.kind === 'value') assert.equal(r.value.text, 'Helpful Information:');
  });

  test('a single combined "Guest Count: 39" box (no trailing colon) resolves unchanged', () => {
    const geo: ColumnGeometry = { viewport: { w: 1280, h: 800 }, columns: PAIR.columns,
      values: [{ selector: '#guestCount', text: 'Guest Count: 39', x: 100, y: 166, w: 140, h: 20 }] };
    const r = resolveDragRegion(geo, { x: 100, y: 165, w: 140, h: 22 });
    assert.equal(r.kind, 'value');
    if (r.kind === 'value') assert.equal(r.value.selector, '#guestCount');
  });

  test('a fully-covered small datum beats a big edge-clipped value with MORE raw overlap', () => {
    const geo: ColumnGeometry = { viewport: { w: 1280, h: 800 }, columns: PAIR.columns, values: [
      { selector: 'div > span', text: 'Some Wide Header', x: 50, y: 166, w: 180, h: 30 }, // big non-label, box 5400
      { selector: '#guestCount', text: '13',              x: 500, y: 166, w: 25, h: 30 }, // small, box 750
    ] };
    // drag 200..800: clips the wide one (200-230 = 900px², fails threshold) but fully covers "13" (qualifies).
    const r = resolveDragRegion(geo, { x: 200, y: 160, w: 600, h: 30 });
    assert.equal(r.kind, 'value');
    if (r.kind === 'value') assert.equal(r.value.selector, '#guestCount'); // the qualifying datum, not the bigger clip
  });

  test('a tight drag on just the number still auto-names from the adjacent label', () => {
    const r = resolveDragRegion(PAIR, { x: 125, y: 165, w: 27, h: 32 }); // wraps only "13", not the caption
    assert.equal(r.kind, 'value');
    if (r.kind === 'value') {
      assert.equal(r.value.selector, '#guestCount');
      assert.equal(r.labelText, 'Guest Count:'); // found the caption to its left → "guest_count"
    }
  });

  test('Room Count "8" names from the NEAREST left caption (Room Count:), not Guest Count:', () => {
    const r = resolveDragRegion(PAIR, { x: 156, y: 162, w: 97, h: 36 }); // "Room Count: 8"
    assert.equal(r.kind, 'value');
    if (r.kind === 'value') { assert.equal(r.value.selector, '#roomCount'); assert.equal(r.labelText, 'Room Count:'); }
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
