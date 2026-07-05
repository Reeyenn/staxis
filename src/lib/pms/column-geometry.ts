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
  | { kind: 'value'; value: GeomValue; labelText?: string }
  | { kind: 'unknown' };

/** A "label" is the static caption text beside a datum — it ends in a colon
 *  ("Guest Count:", "Room Count:"). The thing the founder actually wants is the
 *  datum next to it ("13"), not the caption. Handles the full-width colon used
 *  in some localized PMS UIs. */
function isLabelText(t: string): boolean {
  return /[:：]\s*$/.test(t.trim());
}

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
  // A header total renders as TWO boxes side by side: a wide LABEL ("Guest
  // Count:") and the narrow DATUM next to it ("13"). Raw max-overlap would pick
  // the wider label, so prefer a NON-label datum — but only one that's
  // MEANINGFULLY covered (≥half its own box, or ≥15% of the drag), so a stray
  // edge-clip of a neighbour can't win. The threshold is judged PER candidate:
  // track the best *qualifying* datum separately from the best by raw overlap,
  // so a big edge-clipped value can't shadow a small fully-covered one.
  const dragArea = Math.max(1, Math.max(0, drag.w) * Math.max(0, drag.h));
  let bestDatum: GeomValue | null = null, bestDatumArea = 0;       // qualifying non-label, max overlap
  let bestAnyDatum: GeomValue | null = null, bestAnyDatumArea = 0; // any non-label (clip-only fallback)
  let bestLabel: GeomValue | null = null, bestLabelArea = 0;
  for (const v of geometry.values ?? []) {
    const a = overlapArea(drag, v);
    if (a <= 0) continue;
    if (isLabelText(v.text)) {
      if (a > bestLabelArea) { bestLabelArea = a; bestLabel = v; }
      continue;
    }
    if (a > bestAnyDatumArea) { bestAnyDatumArea = a; bestAnyDatum = v; }
    const valArea = Math.max(1, v.w * v.h);
    if ((a >= 0.5 * valArea || a >= 0.15 * dragArea) && a > bestDatumArea) { bestDatumArea = a; bestDatum = v; }
  }
  // Order: a qualifying datum wins; else a label the founder dragged; else a
  // clip-only datum (better than nothing); else unknown. On a datum, carry the
  // adjacent caption as a NAMING hint so "13" auto-names "guest_count" not
  // "c_13" — even on a tight drag that didn't cover the label itself.
  if (bestDatum) {
    const lbl = nearestLeftLabel(bestDatum, geometry.values ?? []) ?? bestLabel?.text;
    return lbl ? { kind: 'value', value: bestDatum, labelText: lbl } : { kind: 'value', value: bestDatum };
  }
  if (bestLabel) {
    // A caption ("Guest Count:") is NEVER the thing the founder wants — they want
    // the value it describes. So when the drag landed only on a label, REDIRECT
    // to the datum beside it (the non-label value to its right on the same row).
    // This is what makes dragging the prominent words "Guest Count:" still
    // capture "13". Only a lone label with nothing beside it stays a label.
    const adj = nearestRightDatum(bestLabel, geometry.values ?? []);
    if (adj) return { kind: 'value', value: adj, labelText: bestLabel.text };
    return { kind: 'value', value: bestLabel };
  }
  if (bestAnyDatum) return { kind: 'value', value: bestAnyDatum };
  return { kind: 'unknown' };
}

/** Two boxes share a ROW when their vertical extents overlap by at least half the
 *  shorter box — a real overlap test, so a box stacked ABOVE/BELOW (no vertical
 *  overlap) is never treated as same-row. */
function sameRow(a: GeomValue, b: GeomValue): boolean {
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapY >= 0.5 * Math.min(a.h, b.h);
}

/** The DATUM a label describes: the nearest non-label value IMMEDIATELY to the
 *  label's right on the same row ("13" for "Guest Count:"). Lets a drag that
 *  landed only on the caption still capture the value beside it. Guards (Codex):
 *  must be on the same row (vertical overlap), within an adjacency gap (so a
 *  far-off cell isn't grabbed), and not past the NEXT caption to the right (so
 *  "Room Type: Guests: 4" doesn't name "4" as "Room Type"). Undefined → the
 *  caller keeps the label. */
function nearestRightDatum(label: GeomValue, values: GeomValue[]): GeomValue | undefined {
  const labelRight = label.x + label.w;
  const gapCap = Math.max(80, label.h, ...values.map((v) => v.h));
  // the next caption to the right bounds how far this label's value can sit.
  let boundaryX = Infinity;
  for (const v of values) {
    if (v === label || !isLabelText(v.text) || !sameRow(label, v)) continue;
    if (v.x > label.x && v.x < boundaryX) boundaryX = v.x;
  }
  let best: GeomValue | null = null;
  for (const v of values) {
    if (v === label || isLabelText(v.text) || !sameRow(label, v)) continue; // a real datum, same row
    if (v.x < label.x || v.x >= boundaryX) continue;     // to the right, before the next caption
    if (v.x - labelRight > gapCap) continue;             // adjacent, not a distant cell
    if (!best || v.x < best.x) best = v;                 // nearest from the left
  }
  return best ?? undefined;
}

/** The colon-label sitting just LEFT of a datum on the same row ("Guest Count:"
 *  for "13") — the caption to name the captured value after, even when the drag
 *  wrapped only the number. Nearest = greatest x at-or-left of the datum. */
function nearestLeftLabel(datum: GeomValue, values: GeomValue[]): string | undefined {
  let best: GeomValue | null = null;
  for (const v of values) {
    if (v === datum || !isLabelText(v.text) || !sameRow(datum, v)) continue;
    if (v.x > datum.x) continue;                  // to the left
    if (!best || v.x > best.x) best = v;          // closest from the left
  }
  return best?.text;
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
