// ═══════════════════════════════════════════════════════════════════════════
// Where the one object sits, how it opens and closes, and where its panel and
// peek can fit around it.
//
// PURE. No React, no window, no storage of its own. Everything arrives as an
// argument, including the viewport and the storage object, which is what makes
// "the panel never renders off screen" a thing a test can assert rather than a
// thing somebody eyeballs on one monitor.
//
// The same reason is why the HOVER-INTENT timing, the PANEL EXIT duration and
// the WHEEL CONTAINMENT arithmetic live here too rather than inline in the
// component. None of them is geometry, but all three are decisions with a
// consequence, and the suite runs under --conditions=react-server and cannot
// mount a component to check one.
//
// The mark defaults to the bottom-right corner at a 26px inset, and a person
// may drag it anywhere. That is device ergonomics, not a profile setting: the
// same person on a laptop and on a wall-mounted desk screen wants it in two
// different places, so the position is stored per device in localStorage and
// never travels to the server.
//
// TWO RULES THE WHOLE FILE EXISTS FOR
//   1. The mark is always fully inside the viewport, including after a resize.
//   2. The panel and the peek re-anchor to wherever the mark ended up, flipping
//      above/below and left/right as space requires, and are clamped so neither
//      can leave the screen. A control the person can no longer reach is worse
//      than one they cannot move.
// ═══════════════════════════════════════════════════════════════════════════

/** Diameter of the Obsidian mark. Fixed by the design; never responsive. */
export const MARK_SIZE = 86;

/** Corner inset at rest, right and bottom. */
export const DOCK_INSET = 26;

/** Gap between the mark and the panel, and between the mark and the peek. */
export const DOCK_GAP = 12;

/** Fixed panel width. */
export const PANEL_WIDTH = 392;

/** Panel ceiling before the viewport gets a say. */
export const PANEL_MAX_HEIGHT = 560;

/** Fraction of the viewport height the panel may occupy. */
export const PANEL_VIEWPORT_FRACTION = 0.62;

/** Peek pill ceiling. Shrinks when the mark is dragged near an edge. */
export const PEEK_MAX_WIDTH = 400;

/**
 * Breathing room between any floating piece and the viewport edge.
 *
 * Deliberately smaller than DOCK_INSET: a mark dragged hard into a corner must
 * still be able to open its panel, and the panel is allowed closer to the edge
 * than the resting mark ever is.
 */
export const EDGE_MARGIN = 12;

/**
 * How far a pointer may travel before the gesture stops being a click.
 *
 * Small enough that a deliberate drag is recognised immediately, large enough
 * that a trackpad click with a shaky hand still opens the panel. There is no
 * long press: holding still and clicking must always open.
 */
export const DRAG_THRESHOLD = 6;

/** localStorage key. Per device, per browser. Never sent anywhere. */
export const DOCK_STORAGE_KEY = 'staxis.companion.dock';

export interface Vec { x: number; y: number }
export interface Viewport { width: number; height: number }

/** The mark's top-left when nobody has moved it. */
export function defaultDockPosition(viewport: Viewport): Vec {
  return clampDockPosition(
    {
      x: viewport.width - DOCK_INSET - MARK_SIZE,
      y: viewport.height - DOCK_INSET - MARK_SIZE,
    },
    viewport,
  );
}

/**
 * Pull a position fully inside the viewport.
 *
 * Runs on every drag frame, on every window resize, and on the value read back
 * from storage, because a position saved on a 27 inch monitor is off screen on
 * the laptop the same person opens next.
 */
export function clampDockPosition(pos: Vec, viewport: Viewport): Vec {
  const maxX = Math.max(EDGE_MARGIN, viewport.width - MARK_SIZE - EDGE_MARGIN);
  const maxY = Math.max(EDGE_MARGIN, viewport.height - MARK_SIZE - EDGE_MARGIN);
  return {
    x: clamp(round(pos.x), Math.min(EDGE_MARGIN, maxX), maxX),
    y: clamp(round(pos.y), Math.min(EDGE_MARGIN, maxY), maxY),
  };
}

/** Has this pointer moved far enough that it is a drag and not a click? */
export function isDragGesture(dx: number, dy: number, threshold: number = DRAG_THRESHOLD): boolean {
  return Math.hypot(dx, dy) > threshold;
}

// ─── Persistence ────────────────────────────────────────────────────────────

/** Anything shaped like localStorage. Passed in so this file stays pure. */
export interface DockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Read the stored position, or null for "still in the corner".
 *
 * Nothing in localStorage is trusted: another tab, an extension or a stale
 * build could have written anything there. A value that is not two finite
 * numbers degrades to the default corner rather than to NaN coordinates, which
 * would place the mark nowhere at all.
 */
export function readStoredDock(storage: DockStorage | null | undefined): Vec | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(DOCK_STORAGE_KEY);
  } catch {
    return null;
  }
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 120) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const { x, y } = parsed as { x?: unknown; y?: unknown };
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  } catch {
    return null;
  }
}

/** Write, or clear when the mark is sent back to its corner. */
export function writeStoredDock(storage: DockStorage | null | undefined, pos: Vec | null): void {
  if (!storage) return;
  try {
    if (pos === null) storage.removeItem(DOCK_STORAGE_KEY);
    else storage.setItem(DOCK_STORAGE_KEY, JSON.stringify({ x: round(pos.x), y: round(pos.y) }));
  } catch {
    // A full or blocked storage costs the person a remembered position on the
    // next page load. It must never cost them the companion.
  }
}

// ─── Panel placement ────────────────────────────────────────────────────────

export interface PanelPlacement {
  left: number;
  /** Set when the panel hangs below the mark. */
  top: number | null;
  /** Set when the panel rises above the mark, which is the resting case. */
  bottom: number | null;
  maxHeight: number;
  placement: 'above' | 'below';
}

/**
 * Anchor the panel to the mark's current position.
 *
 * Anchored by EDGE rather than by measured height on purpose: the panel's real
 * height depends on how much conversation is in it, and pinning `bottom` to the
 * mark means the slab grows upward from a fixed seam instead of drifting every
 * time a message lands. Height is capped by whichever space it took.
 *
 * Prefers above, which is what the design shows at the default corner. Flips
 * below only when there is genuinely more room there.
 */
export function placePanel(mark: Vec, viewport: Viewport): PanelPlacement {
  const spaceAbove = mark.y - DOCK_GAP - EDGE_MARGIN;
  const spaceBelow = viewport.height - (mark.y + MARK_SIZE) - DOCK_GAP - EDGE_MARGIN;
  const ceiling = Math.min(PANEL_MAX_HEIGHT, viewport.height * PANEL_VIEWPORT_FRACTION);

  const above = spaceAbove >= ceiling || spaceAbove >= spaceBelow;
  const room = Math.max(120, above ? spaceAbove : spaceBelow);

  // Right edge of the panel lines up with the right edge of the mark, so the
  // subsurface glow at the panel's bottom reads as continuing into the stone.
  const width = Math.min(PANEL_WIDTH, Math.max(240, viewport.width - EDGE_MARGIN * 2));
  const preferredLeft = mark.x + MARK_SIZE - width;
  const maxLeft = Math.max(EDGE_MARGIN, viewport.width - width - EDGE_MARGIN);

  return {
    left: clamp(round(preferredLeft), Math.min(EDGE_MARGIN, maxLeft), maxLeft),
    top: above ? null : round(mark.y + MARK_SIZE + DOCK_GAP),
    bottom: above ? round(viewport.height - mark.y + DOCK_GAP) : null,
    maxHeight: round(Math.min(ceiling, room)),
    placement: above ? 'above' : 'below',
  };
}

/** The panel's own width for the current viewport. Matches placePanel's. */
export function panelWidthFor(viewport: Viewport): number {
  return Math.min(PANEL_WIDTH, Math.max(240, viewport.width - EDGE_MARGIN * 2));
}

// ─── Peek placement ─────────────────────────────────────────────────────────

export interface PeekPlacement {
  /** Set when the pill sits to the left of the mark, which is the design. */
  right: number | null;
  /** Set when the mark is near the left edge and the pill flips over. */
  left: number | null;
  /** Vertical centre of the pill. The pill is translated up by half itself. */
  centerY: number;
  maxWidth: number;
  side: 'left' | 'right';
}

/**
 * Slide the peek in beside the mark, on whichever side has room.
 *
 * `maxWidth` is the space actually available rather than a constant, so a mark
 * dragged to the left edge gets a narrower pill instead of one that runs off
 * the screen. The sentence is one clause and ellipsises; a peek that has to be
 * scrolled is not a peek.
 */
export function placePeek(mark: Vec, viewport: Viewport): PeekPlacement {
  const roomLeft = mark.x - DOCK_GAP - EDGE_MARGIN;
  const roomRight = viewport.width - (mark.x + MARK_SIZE) - DOCK_GAP - EDGE_MARGIN;
  const onLeft = roomLeft >= Math.min(PEEK_MAX_WIDTH, 180) || roomLeft >= roomRight;
  const room = Math.max(0, onLeft ? roomLeft : roomRight);

  const half = 24;
  const centerY = clamp(
    round(mark.y + MARK_SIZE / 2),
    EDGE_MARGIN + half,
    Math.max(EDGE_MARGIN + half, viewport.height - EDGE_MARGIN - half),
  );

  return {
    right: onLeft ? round(viewport.width - mark.x + DOCK_GAP) : null,
    left: onLeft ? null : round(mark.x + MARK_SIZE + DOCK_GAP),
    centerY,
    maxWidth: round(Math.min(PEEK_MAX_WIDTH, room)),
    side: onLeft ? 'left' : 'right',
  };
}

/**
 * Is there enough room beside the mark to show a peek at all?
 *
 * A 60px sliver of a sentence is not information, it is decoration that covers
 * the page. Below this the hover simply does nothing.
 */
export function peekFits(placement: PeekPlacement): boolean {
  return placement.maxWidth >= 140;
}

// ─── Hover intent ───────────────────────────────────────────────────────────

/**
 * How long the pointer must rest on the mark before the panel opens itself.
 *
 * Short enough to feel like the object answering, long enough that a cursor
 * crossing the corner on its way somewhere else never flickers the panel open.
 */
export const HOVER_OPEN_MS = 80;

/**
 * Grace after the pointer leaves the mark AND the panel before it closes again.
 *
 * Longer than the open delay on purpose: the gap between the mark and the panel
 * is 12px of bare page, and a pointer travelling from one to the other passes
 * over it. Closing on that would make the panel impossible to reach.
 */
export const HOVER_CLOSE_MS = 400;

/**
 * Does hover own the panel on this device?
 *
 * Only true for a real pointer. On touch the tap is the whole interaction and a
 * hover-open would fire on the same tap that toggles, opening and closing in
 * one gesture. `(hover: hover) and (pointer: fine)` is the question, asked by
 * the caller and answered here so the rule is one place.
 */
export function hoverOwnsPanel(input: { finePointer: boolean }): boolean {
  return input.finePointer === true;
}

/** Should entering the mark arm the open timer? */
export function hoverCanOpen(input: {
  finePointer: boolean;
  dragging: boolean;
  open: boolean;
}): boolean {
  return hoverOwnsPanel(input) && !input.dragging && !input.open;
}

/**
 * Should leaving the mark-plus-panel region arm the close timer?
 *
 * `busy` is the whole reason this is a function rather than a boolean at the
 * call site. A panel the person is TYPING into, dictating into, or waiting on an
 * answer from must not vanish because their hand drifted off the trackpad. The
 * pointer leaving is a hint, not an instruction; only Escape, the close button
 * and a click outside are instructions.
 */
export function hoverCanClose(input: {
  finePointer: boolean;
  open: boolean;
  busy: boolean;
}): boolean {
  return hoverOwnsPanel(input) && input.open && !input.busy;
}

// ─── Auto peek ──────────────────────────────────────────────────────────────

/**
 * How long the peek stays out when it came on its own rather than on hover.
 *
 * Long enough to read one clause without hurrying, short enough that it is
 * gone before it becomes furniture. It retreats by itself; there is nothing to
 * dismiss, because a thing that demands dismissal is not a peek.
 */
export const AUTO_PEEK_MS = 6000;

/**
 * Should this sentence show itself, unasked?
 *
 * ONCE PER CANDIDATE PER SESSION. `shown` is the set of sentence keys already
 * volunteered on this page load; a candidate that has had its moment waits to
 * be hovered like everything else.
 *
 * The manners are NOT re-litigated here. A sentence only reaches this function
 * because decideCompanionSpeech already let it through the daily cap, the
 * minimum gap, the declined-twice drop, the one-thing-at-a-time rule and the
 * never-while-typing floor. What is left to check is whether the corner is
 * free: nothing volunteers itself over an open panel, a drag, or a person who
 * is mid-sentence at the keyboard.
 */
export function shouldAutoPeek(input: {
  key: string | null;
  shown: ReadonlySet<string>;
  open: boolean;
  dragging: boolean;
  busy: boolean;
}): boolean {
  if (!input.key) return false;
  if (input.shown.has(input.key)) return false;
  return !input.open && !input.dragging && !input.busy;
}

/**
 * Does this peek stay out until somebody deals with it?
 *
 * THE ANSWER DEPENDS ENTIRELY ON WHETHER IT ASKED A QUESTION.
 *
 * A hello and the "this got handled already" note are statements. They have
 * nothing to answer, so they say their piece and retreat on AUTO_PEEK_MS, which
 * is what the pill was designed for and what it should keep doing.
 *
 * An OFFER is a question with buttons on it, and retreating after six seconds
 * made the buttons a trap: the pill asked "mind if I show you?", the person
 * looked away, and the question was gone with no record that it was ever asked.
 * The offer now lives in the thread either way, so nothing is lost when the
 * pill goes — but a question that withdraws itself while you are reading it is
 * the app deciding your answer is No. So it stays, and the only things that
 * take it away are an answer, a dismissal, or leaving the page.
 *
 * The manners are untouched by this. `shouldAutoPeek` still decides whether the
 * pill may appear at all, and every never-while-typing / one-at-a-time / a-No-is
 * -a-No rule ran before that. This only governs how long it lingers once shown.
 */
export function peekPersists(input: { hasActions: boolean }): boolean {
  return input.hasActions === true;
}

// ─── Open and close motion ──────────────────────────────────────────────────

/** A1 · Rise. The panel coming up out of the mark. */
export const PANEL_ENTER_MS = 280;

/** B1 · Sink. Always faster than the rise; closing should not be savoured. */
export const PANEL_EXIT_MS = 200;

/** What both become when the person has asked for less motion. */
export const REDUCED_MOTION_MS = 120;

/**
 * How long the panel must stay mounted after it is logically closed.
 *
 * The exit only exists if something renders it, and an unmount on the same tick
 * as the state change renders nothing at all — which is exactly what was
 * happening: B1 was specified, written into the CSS, and never once seen.
 */
export function panelExitMs(reducedMotion: boolean): number {
  return reducedMotion ? REDUCED_MOTION_MS : PANEL_EXIT_MS;
}

/**
 * Is the panel in the tree, and what is it wearing?
 *
 * The contract the exit animation depends on, in one place a test can hold: a
 * panel that is logically CLOSED but still `closing` is STILL MOUNTED. Before
 * this, `{open && <panel/>}` unmounted on the same commit that closed it, so
 * B1 · Sink was specified, written into the CSS, and never rendered a frame.
 */
export function panelRenderState(input: { open: boolean; closing: boolean }): {
  mounted: boolean;
  className: string;
} {
  const mounted = input.open || input.closing;
  return {
    mounted,
    className: input.closing ? 'asx-panel asx-closing' : 'asx-panel',
  };
}

// ─── Wheel containment ──────────────────────────────────────────────────────

/**
 * A wheel notch in `deltaMode: DOM_DELTA_LINE`, in pixels.
 *
 * Firefox reports lines rather than pixels. 16 is one line at the panel's own
 * 13-14px type; the exact value matters far less than not treating "3" as three
 * pixels, which is what ignoring deltaMode does.
 */
export const WHEEL_LINE_PX = 16;

/** Anything shaped like a scrolling element. */
export interface ScrollBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Normalise a wheel delta to pixels, whatever units the browser used. */
export function wheelDeltaPx(deltaY: number, deltaMode: number, pageHeight: number): number {
  if (!Number.isFinite(deltaY)) return 0;
  if (deltaMode === 1) return deltaY * WHEEL_LINE_PX;
  if (deltaMode === 2) return deltaY * Math.max(1, pageHeight);
  return deltaY;
}

/**
 * Where a scroller lands after a wheel delta, clamped to its own ends.
 *
 * THE POINT IS THE CLAMP, NOT THE ARITHMETIC. The panel's thread is
 * `overflow-y: auto` inside a fixed-position slab, and the browser's default is
 * to hand the wheel to the page in two separate cases:
 *
 *   1. the thread has no overflow yet, so it is not a scroll target at all —
 *      which is every freshly-opened panel, whose thread holds one placeholder
 *      line. The first gesture therefore scrolls the PAGE, and only once a
 *      conversation has made the thread taller does the panel start scrolling.
 *      That is the "it only does it once" the founder saw.
 *   2. the thread is at an end, and the wheel chains outward.
 *
 * `overscroll-behavior: contain` fixes (2) and cannot fix (1): an element with
 * no overflow never receives the gesture to contain. So the panel takes the
 * wheel itself and routes it here.
 */
export function containScroll(box: ScrollBox, deltaPx: number): number {
  const max = Math.max(0, box.scrollHeight - box.clientHeight);
  return clamp(box.scrollTop + deltaPx, 0, max);
}

/**
 * Can this box take any of that delta, or is it already against that end?
 *
 * Not used to decide whether to swallow the wheel — the panel swallows it
 * either way, which is the rule — but it is the honest answer to "did anything
 * move", and the test asserts on it.
 */
export function scrollAbsorbs(box: ScrollBox, deltaPx: number): boolean {
  return containScroll(box, deltaPx) !== box.scrollTop;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}
