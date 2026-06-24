/**
 * column-geometry — feature/cua-click-to-map.
 *
 * Pure geometry helpers for "drag a box on the source screenshot to capture a
 * column." The worker (cua-service/src/feed-capture.ts) saves each DATA column's
 * on-screen box in VIEWPORT CSS px (the fullPage:false provenance screenshot's
 * coordinate space). The Coverage Editor renders that screenshot scaled to fit,
 * lets the admin drag a rectangle, converts the dragged rectangle back to
 * viewport px, and asks which column it covers. Kept pure (no DOM) so the
 * which-column-did-I-drag math is unit-tested without a browser.
 */

export interface GeomColumn {
  /** 1-based body nth-child — the selector is `<tag>:nth-child(index)`. */
  index: number;
  /** Aligned header label (may be '' on a headerless/unaligned table). */
  header: string;
  x: number; y: number; w: number; h: number;
}

export interface ColumnGeometry {
  /** The CSS px coordinate space the boxes live in (the captured viewport). */
  viewport: { w: number; h: number };
  columns: GeomColumn[];
}

/**
 * Which column did the dragged rectangle land on? Columns are vertical strips,
 * so the decision is HORIZONTAL overlap: pick the column whose x-extent overlaps
 * the dragged x-extent the most. Returns null when the drag covers no column
 * (e.g. dragged in empty margin) so the caller can ignore a stray drag.
 *
 * `drag` is in the SAME viewport-CSS space as the geometry (the caller scales
 * the on-image pixels by geometry.viewport.w / renderedImageWidth first).
 */
export function pickColumnFromDrag(
  geometry: ColumnGeometry,
  drag: { x: number; w: number },
): GeomColumn | null {
  const dragLeft = drag.x;
  const dragRight = drag.x + Math.max(0, drag.w);
  let best: GeomColumn | null = null;
  let bestOverlap = 0;
  for (const c of geometry.columns) {
    const overlap = Math.min(dragRight, c.x + c.w) - Math.max(dragLeft, c.x);
    if (overlap > bestOverlap) { bestOverlap = overlap; best = c; }
  }
  return bestOverlap > 0 ? best : null;
}

/** "Rate Plan" → "rate_plan" default custom name (mirrors the cockpit slug). */
export function slugifyHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^([0-9])/, 'c_$1').slice(0, 49) || 'field';
}
