/**
 * WHERE THE LINES GO, AND WHAT THEY REFUSE TO COVER.
 *
 * The baseline claim this whole feature rests on is that a rectangle and a
 * viewport are enough to place a trace on any page without that page knowing
 * about it. This file is that claim, checked.
 *
 * The plausible bugs it is aimed at:
 *   - a scrim that paints over the rows it is supposed to be lighting
 *   - a rail drawn off the bottom of the window because the rows were near it
 *   - a card that runs off the edge of the screen, or a stem that points into
 *     empty space beside a card that was pulled back from one
 *   - a drawing that shifts shape when there is only one row to point at
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CARD_MAX_WIDTH,
  EDGE_MARGIN,
  isOnScreen,
  layoutTrace,
  scrimPath,
  type MeasuredAnchor,
  type TraceViewport,
} from '@/lib/companion/trace/geometry';

const VIEWPORT: TraceViewport = { width: 1440, height: 900 };

function anchor(domId: string, left: number, top: number): MeasuredAnchor {
  return { domId, label: domId.toUpperCase(), rect: { left, top, width: 300, height: 120 } };
}

const THREE = [anchor('a', 60, 200), anchor('b', 400, 220), anchor('c', 740, 180)];

describe('laying a trace out on a page that knows nothing about it', () => {
  test('nothing is drawn when there is nothing to point at', () => {
    assert.equal(layoutTrace([], VIEWPORT), null);
  });

  test('the drawing lives under the rows, in the band the page already leaves', () => {
    const g = layoutTrace(THREE, VIEWPORT);
    assert.ok(g);
    assert.equal(g.above, false);
    const lowest = Math.max(...THREE.map((a) => a.rect.top + a.rect.height));
    assert.ok(g.rail !== null);
    assert.ok(g.rail.y > lowest, 'the rail must clear every row');
    assert.ok(g.card.top !== null && g.card.top > g.rail.y);
    assert.equal(g.card.bottom, null);
  });

  test('a hole is punched over every row, and it is bigger than the row', () => {
    const g = layoutTrace(THREE, VIEWPORT)!;
    assert.equal(g.cutouts.length, 3);
    for (let i = 0; i < 3; i += 1) {
      const cut = g.cutouts[i];
      const row = THREE[i].rect;
      assert.ok(cut.left < row.left);
      assert.ok(cut.top < row.top);
      assert.ok(cut.left + cut.width > row.left + row.width);
      assert.ok(cut.top + cut.height > row.top + row.height);
    }
  });

  test('the scrim is one path with the rows subtracted, not four panels', () => {
    const g = layoutTrace(THREE, VIEWPORT)!;
    const d = scrimPath(g.cutouts, VIEWPORT);
    // One outer rectangle plus one closed sub-path per row.
    assert.equal((d.match(/Z/g) ?? []).length, 4);
    assert.ok(d.startsWith(`M0 0 H${VIEWPORT.width} V${VIEWPORT.height} H0 Z`));
  });

  test('rows near the bottom of the window get the same drawing, rotated up', () => {
    const low = THREE.map((a) => anchor(a.domId, a.rect.left, 760));
    const g = layoutTrace(low, VIEWPORT);
    assert.ok(g);
    assert.equal(g.above, true);
    assert.ok(g.rail !== null && g.rail.y < 760, 'the rail must be above the rows');
    assert.equal(g.card.top, null);
    assert.ok(g.card.bottom !== null && g.card.bottom > 0);
    // And the labels move to the other side of the rail with it.
    assert.ok(g.labelY < g.rail.y);
  });

  test('one row is a drop and a dot, with no rail to draw', () => {
    const g = layoutTrace([anchor('a', 500, 300)], VIEWPORT);
    assert.ok(g);
    assert.equal(g.drops.length, 1);
    assert.equal(g.rail, null);
    assert.equal(g.dots.length, 1);
    assert.ok(g.stem);
  });

  test('the card never runs off the edge, and the stem follows it when it is pulled back', () => {
    // One row hard against the right edge: the card cannot be centred on it.
    const g = layoutTrace([anchor('a', 1380, 300)], VIEWPORT)!;
    assert.ok(g.card.left >= EDGE_MARGIN);
    assert.ok(g.card.left + g.card.width <= VIEWPORT.width - EDGE_MARGIN);
    assert.ok(g.stem);
    assert.ok(g.stem.x >= g.card.left, 'the stem must land on the card');
    assert.ok(g.stem.x <= g.card.left + g.card.width);
  });

  test('the card is never wider than the design and never wider than the window', () => {
    assert.equal(layoutTrace(THREE, VIEWPORT)!.card.width, CARD_MAX_WIDTH);
    const narrow = layoutTrace(THREE, { width: 940, height: 900 })!;
    assert.ok(narrow.card.width <= 940 - EDGE_MARGIN * 2);
  });

  test('a dot and a label exist for every row, in the row\'s own words', () => {
    const g = layoutTrace(THREE, VIEWPORT)!;
    assert.deepEqual(g.dots.map((d) => d.label), ['A', 'B', 'C']);
    assert.deepEqual(g.dots.map((d) => d.y), [g.rail!.y, g.rail!.y, g.rail!.y]);
  });

  test('a row scrolled out of the window is not on the screen', () => {
    assert.equal(isOnScreen({ left: 10, top: -400, width: 300, height: 120 }, VIEWPORT), false);
    assert.equal(isOnScreen({ left: 10, top: 1200, width: 300, height: 120 }, VIEWPORT), false);
    assert.equal(isOnScreen({ left: 10, top: -40, width: 300, height: 120 }, VIEWPORT), true);
  });

  test('the same rows in the same window lay out the same way twice', () => {
    assert.deepEqual(layoutTrace(THREE, VIEWPORT), layoutTrace(THREE, VIEWPORT));
  });
});
