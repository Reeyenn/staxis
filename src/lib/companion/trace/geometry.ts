// ═══════════════════════════════════════════════════════════════════════════
// Where the lines go.
//
// THE BASELINE, AND THE WHOLE REASON THE TRACE NEEDS NO PAGE-SPECIFIC WORK.
// Every page has waste space in its own layout, and this module is the argument
// that a rectangle and a viewport are enough to find it. It takes the measured
// boxes of the rows a pattern is about, and returns the drops, the rail, the
// dots and the place the ink card hangs. It never reads the DOM, never touches
// React, and never knows what page it is on.
//
// The rules it encodes, in order:
//
//   1. NOTHING ON THE BOARD IS COVERED. The scrim is a single shape with a hole
//      punched over each row, so the rows the pattern is about are the only
//      thing at full brightness and none of them is painted over. Everything
//      the overlay draws lives BELOW the lowest row or ABOVE the highest one,
//      in the band the page already leaves there.
//
//   2. THE RAIL GOES WHERE THERE IS ROOM. Below the rows when the band under
//      them is deep enough, above them when it is not. A page scrolled so the
//      rows sit at the bottom of the window gets its trace drawn upward, which
//      is the same drawing rotated rather than a second design.
//
//   3. THE CARD IS ANCHORED TO THE RAIL AND CLAMPED TO THE WINDOW. It hangs off
//      the middle of the rail, so the eye follows the line into the sentence,
//      and it is pulled back inside the edges rather than allowed to run off
//      one. When it is pulled back, the dashed stem still lands on it, because
//      the stem is drawn to where the card ENDED UP.
// ═══════════════════════════════════════════════════════════════════════════

/** A measured box in viewport coordinates, exactly as getBoundingClientRect
 *  hands it over. */
export interface TraceRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface TraceViewport {
  readonly width: number;
  readonly height: number;
}

/** One anchored row, measured, with the words that go under its dot. */
export interface MeasuredAnchor {
  readonly domId: string;
  readonly label: string;
  readonly rect: TraceRect;
}

export interface TraceGeometry {
  /** Inflated boxes the scrim leaves unpainted. */
  readonly cutouts: readonly TraceRect[];
  /** The vertical hairline from each row to the rail. */
  readonly drops: ReadonlyArray<{ x: number; from: number; to: number }>;
  /** The horizontal line joining the drops. Null when there is only one. */
  readonly rail: { y: number; from: number; to: number } | null;
  readonly dots: ReadonlyArray<{ x: number; y: number; label: string }>;
  /** The dashed line from the rail to the card. */
  readonly stem: { x: number; from: number; to: number } | null;
  /** Where the ink card sits, in fixed-position coordinates. */
  readonly card: { left: number; width: number; top: number | null; bottom: number | null };
  /** True when the whole drawing was rotated upward for room. */
  readonly above: boolean;
  /** Where each label baseline sits. */
  readonly labelY: number;
}

/** How far the scrim's hole reaches past the row it is cut for. */
export const CUTOUT_PAD = 6;

/** The gap between the rows and the rail. */
export const RAIL_GAP = 44;

/** The gap between the rail and the top of the card. */
export const STEM_LENGTH = 40;

/** The widest the ink card is ever drawn. */
export const CARD_MAX_WIDTH = 660;

/** How close to the window edge the card may come. */
export const EDGE_MARGIN = 24;

/**
 * How much room the band under the rows needs before the trace is drawn
 * downward. The rail, its labels and the top of the card have to fit.
 */
export const ROOM_BELOW = RAIL_GAP + STEM_LENGTH + 120;

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(high, Math.max(low, value));
}

export function layoutTrace(
  anchors: readonly MeasuredAnchor[],
  viewport: TraceViewport,
): TraceGeometry | null {
  if (anchors.length === 0) return null;

  const cutouts = anchors.map((a) => ({
    left: a.rect.left - CUTOUT_PAD,
    top: a.rect.top - CUTOUT_PAD,
    width: a.rect.width + CUTOUT_PAD * 2,
    height: a.rect.height + CUTOUT_PAD * 2,
  }));

  const lowest = Math.max(...anchors.map((a) => a.rect.top + a.rect.height));
  const highest = Math.min(...anchors.map((a) => a.rect.top));
  const roomBelow = viewport.height - lowest;
  const roomAbove = highest;
  // Downward unless the band under the rows genuinely cannot hold the drawing
  // AND the band above it can. A tie goes down, because down is the direction
  // the design was drawn in and the one a reader expects.
  const above = roomBelow < ROOM_BELOW && roomAbove > roomBelow;

  const railY = above
    ? clamp(highest - RAIL_GAP, EDGE_MARGIN + 60, viewport.height - EDGE_MARGIN)
    : clamp(lowest + RAIL_GAP, EDGE_MARGIN, viewport.height - EDGE_MARGIN - 60);

  const drops = anchors.map((a) => ({
    x: Math.round(a.rect.left + a.rect.width / 2),
    from: above ? a.rect.top : a.rect.top + a.rect.height,
    to: railY,
  }));

  const xs = drops.map((d) => d.x);
  const railFrom = Math.min(...xs);
  const railTo = Math.max(...xs);
  const rail = railFrom === railTo ? null : { y: railY, from: railFrom, to: railTo };

  const dots = drops.map((d, i) => ({ x: d.x, y: railY, label: anchors[i].label }));
  const labelY = above ? railY - 12 : railY + 20;

  const width = Math.min(CARD_MAX_WIDTH, Math.max(280, viewport.width - EDGE_MARGIN * 2));
  const midX = Math.round((railFrom + railTo) / 2);
  const left = Math.round(clamp(midX - width / 2, EDGE_MARGIN, viewport.width - width - EDGE_MARGIN));

  const card = above
    ? { left, width, top: null, bottom: Math.round(viewport.height - (railY - STEM_LENGTH)) }
    : { left, width, top: Math.round(railY + STEM_LENGTH), bottom: null };

  // The stem is drawn to where the card ENDED UP, not to where the rail's
  // midpoint would have put it. A card clamped against an edge with a line
  // pointing into empty space beside it is the one thing that would make this
  // read as decoration rather than as an argument.
  const stemX = clamp(midX, left + 28, left + width - 28);
  const stem = {
    x: Math.round(stemX),
    from: railY,
    to: above ? railY - STEM_LENGTH : railY + STEM_LENGTH,
  };

  return { cutouts, drops, rail, dots, stem, card, above, labelY };
}

/**
 * The scrim, as one SVG path.
 *
 * An outer rectangle wound one way and a rounded rectangle per row wound the
 * other, so `fill-rule="evenodd"` leaves the rows unpainted. One path rather
 * than four overlapping panels, because four panels have three seams and a
 * seam over a card is a visible line across somebody's work.
 */
export function scrimPath(cutouts: readonly TraceRect[], viewport: TraceViewport, radius = 14): string {
  let d = `M0 0 H${viewport.width} V${viewport.height} H0 Z`;
  for (const c of cutouts) {
    const r = Math.min(radius, c.width / 2, c.height / 2);
    const x = c.left;
    const y = c.top;
    const w = c.width;
    const h = c.height;
    if (!(w > 0 && h > 0)) continue;
    d += ` M${x + r} ${y}`
      + ` H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r}`
      + ` V${y + h - r} A${r} ${r} 0 0 1 ${x + w - r} ${y + h}`
      + ` H${x + r} A${r} ${r} 0 0 1 ${x} ${y + h - r}`
      + ` V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`;
  }
  return d;
}

/** Is any part of this box inside the window right now? */
export function isOnScreen(rect: TraceRect, viewport: TraceViewport): boolean {
  return rect.top + rect.height > 0
    && rect.top < viewport.height
    && rect.left + rect.width > 0
    && rect.left < viewport.width;
}
