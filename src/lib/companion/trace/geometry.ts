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

// ═══════════════════════════════════════════════════════════════════════════
// The pointer — the same argument, made about ONE control.
//
// WHY IT LIVES IN THIS FILE AND NOT A SECOND GEOMETRY MODULE.
// A trace and a pointer are the same act at two sizes: the companion putting a
// sentence on the page and drawing a line from it to something real. They
// share the rectangle, the viewport, the inflation pad, the edge margin, the
// clamp and the "is this even on screen" test. Two modules would be two
// definitions of how close to the window edge the companion may come, and the
// day they disagreed the bug would be invisible in both files.
//
// What is genuinely different is the shape of the drawing, and only that is
// new below:
//
//   A TRACE points at SEVERAL rows, so it needs a rail to gather them and a
//   band of empty page to hang a wide card in.
//
//   A POINTER points at ONE control, so there is nothing to gather. It sits
//   beside the thing, on whichever side has room, with a single hairline and
//   an arrowhead landing on the control's own edge. It never covers the page
//   and it never displaces it: the founder's whole objection to the first
//   build was that an inline card pushed the screen down under somebody who
//   had come to read it.
//
// THE ARROW NEVER POINTS AT NOTHING. This function refuses a zero-sized box,
// which is what a control inside a `display: none` branch measures as, so the
// caller has one thing to check rather than a policy to remember. A pointer
// with nowhere to point is not drawn at all, and is not spent either.
// ═══════════════════════════════════════════════════════════════════════════

/** Which side of the control the popup ended up on. */
export type PointerSide = 'below' | 'above' | 'right' | 'left';

export interface PointerCardSize {
  readonly width: number;
  readonly height: number;
}

export interface PointerGeometry {
  /** The control's own box, inflated. What lights up. */
  readonly glow: TraceRect;
  /** Where the popup sits, in fixed-position coordinates. */
  readonly card: { left: number; top: number; width: number; height: number };
  readonly side: PointerSide;
  /** The hairline, from the popup's edge to the control's edge. */
  readonly line: { x1: number; y1: number; x2: number; y2: number };
  /** The arrowhead, landing ON the control, angled along the line. */
  readonly head: { x: number; y: number; angle: number };
}

/** The gap between the popup and the control it points at. */
export const POINTER_GAP = 22;

/** How far in from a popup corner the hairline may start. Keeps the line off
 *  the rounded corners, where it would read as a stray mark. */
const POINTER_INSET = 26;

/**
 * Where the popup goes and where the line runs.
 *
 * Pure: it is handed a measured control, the window, and how big the popup
 * turned out to be. It reads no DOM and knows no page.
 */
export function layoutPointer(
  target: TraceRect,
  viewport: TraceViewport,
  card: PointerCardSize,
): PointerGeometry | null {
  // A control that measures as nothing is a control that is not really there.
  if (!(target.width > 0 && target.height > 0)) return null;
  if (!(card.width > 0 && card.height > 0)) return null;
  if (!(viewport.width > 0 && viewport.height > 0)) return null;
  // NaN survives every comparison above by being false, but a NaN LEFT would
  // not: it would flow into the arithmetic and produce a card positioned at
  // `NaNpx`, which renders at the origin with no error anywhere.
  if (!Number.isFinite(target.left) || !Number.isFinite(target.top)) return null;

  const glow: TraceRect = {
    left: target.left - CUTOUT_PAD,
    top: target.top - CUTOUT_PAD,
    width: target.width + CUTOUT_PAD * 2,
    height: target.height + CUTOUT_PAD * 2,
  };

  // Never wider than the window can hold, whatever the popup asked for. No
  // minimum floor: a floor bigger than the window is how a "minimum readable
  // width" becomes a card hanging off the edge of a narrow one.
  const width = Math.max(1, Math.min(card.width, viewport.width - EDGE_MARGIN * 2, viewport.width));
  const height = Math.max(1, Math.min(card.height, viewport.height - EDGE_MARGIN * 2, viewport.height));

  const glowRight = glow.left + glow.width;
  const glowBottom = glow.top + glow.height;
  const room: Record<PointerSide, number> = {
    below: viewport.height - glowBottom,
    above: glow.top,
    right: viewport.width - glowRight,
    left: glow.left,
  };
  const needed: Record<PointerSide, number> = {
    below: height + POINTER_GAP + EDGE_MARGIN,
    above: height + POINTER_GAP + EDGE_MARGIN,
    right: width + POINTER_GAP + EDGE_MARGIN,
    left: width + POINTER_GAP + EDGE_MARGIN,
  };
  // Down, then up, then sideways. Same first choice and same fallback as the
  // trace, for the same reason: down is the direction the design was drawn in
  // and the one a reader expects. Sideways is what is left for a control in a
  // narrow window with a rail above it and a board below it, which is exactly
  // the stockroom's left rail on a laptop.
  const order: readonly PointerSide[] = ['below', 'above', 'right', 'left'];
  const side: PointerSide = order.find((s) => room[s] >= needed[s])
    // Nothing fits. Take the roomiest side rather than the first: a popup
    // clamped into the biggest gap is still readable, and it is still beside
    // the control rather than on top of it.
    ?? order.reduce((best, s) => (room[s] > room[best] ? s : best), order[0]);

  const centerX = glow.left + glow.width / 2;
  const centerY = glow.top + glow.height / 2;

  let left: number;
  let top: number;
  if (side === 'below' || side === 'above') {
    left = clamp(centerX - width / 2, EDGE_MARGIN, Math.max(EDGE_MARGIN, viewport.width - width - EDGE_MARGIN));
    const wanted = side === 'below' ? glowBottom + POINTER_GAP : glow.top - POINTER_GAP - height;
    top = clamp(wanted, EDGE_MARGIN, Math.max(EDGE_MARGIN, viewport.height - height - EDGE_MARGIN));
  } else {
    top = clamp(centerY - height / 2, EDGE_MARGIN, Math.max(EDGE_MARGIN, viewport.height - height - EDGE_MARGIN));
    const wanted = side === 'right' ? glowRight + POINTER_GAP : glow.left - POINTER_GAP - width;
    left = clamp(wanted, EDGE_MARGIN, Math.max(EDGE_MARGIN, viewport.width - width - EDGE_MARGIN));
  }

  left = Math.round(left);
  top = Math.round(top);

  // The line runs from the popup's facing edge to the control's facing edge.
  // Both ends are clamped INSIDE the box they belong to, so a popup pushed
  // against a window edge still has its line start on itself and land on the
  // control rather than in the space beside either.
  let tip: { x: number; y: number };
  let root: { x: number; y: number };
  const insetX = (v: number) => clamp(v, left + Math.min(POINTER_INSET, width / 2), left + width - Math.min(POINTER_INSET, width / 2));
  const insetY = (v: number) => clamp(v, top + Math.min(POINTER_INSET, height / 2), top + height - Math.min(POINTER_INSET, height / 2));

  if (side === 'below') {
    tip = { x: clamp(centerX, glow.left, glowRight), y: glowBottom };
    root = { x: insetX(tip.x), y: top };
  } else if (side === 'above') {
    tip = { x: clamp(centerX, glow.left, glowRight), y: glow.top };
    root = { x: insetX(tip.x), y: top + height };
  } else if (side === 'right') {
    tip = { x: glowRight, y: clamp(centerY, glow.top, glowBottom) };
    root = { x: left, y: insetY(tip.y) };
  } else {
    tip = { x: glow.left, y: clamp(centerY, glow.top, glowBottom) };
    root = { x: left + width, y: insetY(tip.y) };
  }

  // The tip is clamped to the CONTROL above, which is right when the control is
  // on screen and wrong when it is not: a control wider than the window, or the
  // nothing-fits fallback, can put the control's own edge outside the viewport,
  // and an arrowhead there is drawn outside the viewport-sized SVG and simply
  // never appears. Clamping to the window keeps the head visible and still on
  // the control wherever the two overlap, which is the only place a reader
  // would look for it.
  tip = {
    x: clamp(tip.x, 0, viewport.width),
    y: clamp(tip.y, 0, viewport.height),
  };

  const angle = Math.atan2(tip.y - root.y, tip.x - root.x) * (180 / Math.PI);

  return {
    glow,
    card: { left, top, width, height },
    side,
    line: { x1: Math.round(root.x), y1: Math.round(root.y), x2: Math.round(tip.x), y2: Math.round(tip.y) },
    head: { x: Math.round(tip.x), y: Math.round(tip.y), angle },
  };
}
