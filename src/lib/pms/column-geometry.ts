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

/** fix/cua-freeform-capture — a standalone (non-row) value element: a derived
 *  css selector + sample text + on-screen box (viewport CSS px). */
export interface GeomValue {
  selector: string;
  text: string;
  x: number; y: number; w: number; h: number;
}

export interface ColumnGeometry {
  /** The CSS px coordinate space the boxes live in (the captured viewport). */
  viewport: { w: number; h: number };
  columns: GeomColumn[];
  /** Standalone value elements (fix/cua-freeform-capture); absent on older captures. */
  values?: GeomValue[];
}

/** What a freeform drag resolved to: a per-row COLUMN, a one-off VALUE, or
 *  nothing recognizable (→ the UI asks the founder). */
export type FreeformResolution =
  | { kind: 'column'; column: GeomColumn }
  | { kind: 'value'; value: GeomValue }
  | { kind: 'unknown' };

/** Area of overlap between a drag box and a target box (px²). */
function overlapArea(d: { x: number; y: number; w: number; h: number }, t: { x: number; y: number; w: number; h: number }): number {
  const ox = Math.min(d.x + Math.max(0, d.w), t.x + t.w) - Math.max(d.x, t.x);
  const oy = Math.min(d.y + Math.max(0, d.h), t.y + t.h) - Math.max(d.y, t.y);
  return ox > 0 && oy > 0 ? ox * oy : 0;
}

/**
 * Resolve a freeform drag box (viewport CSS px) to a COLUMN (snap to the
 * column whose strip the box most overlaps AND whose vertical band the box sits
 * in), else a standalone VALUE (the value element the box most overlaps), else
 * UNKNOWN. A column only wins when the drag overlaps the table's vertical band;
 * a drag in the page header/footer falls through to the VALUE check. UNKNOWN
 * when nothing overlaps → the UI asks the founder.
 */
export function resolveDragRegion(
  geometry: ColumnGeometry,
  drag: { x: number; y: number; w: number; h: number },
): FreeformResolution {
  // Columns are vertical strips → horizontal overlap picks the candidate column.
  const col = pickColumnFromDrag(geometry, { x: drag.x, w: drag.w });
  // Y-GATE: only treat it as a column if the drag actually overlaps that
  // column's VERTICAL band (the table). Without this, a drag in the page
  // header/footer (e.g. the "Guest Count: 23" total sitting ABOVE the table)
  // that merely lines up left-to-right with a column below would be wrongly
  // captured as that column's per-row cell. A header/footer drag fails the gate
  // and falls through to the standalone-VALUE check, where it correctly snaps to
  // the page value (e.g. #guestCount). In-table drags (header row or body) sit
  // inside the band — column boxes span the full table height — so they are
  // unchanged. (column-geometry.test.ts pins both directions.)
  if (col) {
    const dragBottom = drag.y + Math.max(0, drag.h);
    if (drag.y < col.y + col.h && dragBottom > col.y) {
      return { kind: 'column', column: col };
    }
  }
  let bestValue: GeomValue | null = null;
  let bestArea = 0;
  for (const v of geometry.values ?? []) {
    const a = overlapArea(drag, v);
    if (a > bestArea) { bestArea = a; bestValue = v; }
  }
  if (bestValue) return { kind: 'value', value: bestValue };
  return { kind: 'unknown' };
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
