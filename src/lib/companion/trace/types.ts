// ═══════════════════════════════════════════════════════════════════════════
// The Trace — what the companion has to show, in one shape.
//
// THE TRACE IS THE COMPANION REACHING INTO THE PAGE. It is not a second system
// and it has no branding of its own: a trace is offered through the same
// `CompanionCandidate` seam every other thing the companion says goes through
// (see ../candidates.ts), decided by the same manners engine, remembered in the
// same `companion_memory` blob, and drawn by the same ink surfaces the panel
// already uses.
//
// ─── WHY THIS IS NOT THE FINDINGS LEDGER ───────────────────────────────────
// src/lib/findings is the nightly, persisted, cron-driven, judge-phrased system
// whose output is a card in a queue. It is reused here for the parts that are
// genuinely the same question: the honest price band (findings/pricing.ts) and
// the "three in a window is a pattern" threshold. It is NOT the source of a
// trace, for two reasons that are both fatal on their own:
//
//   1. A trace has to name the EXACT ROWS ON THE SCREEN so a line can be drawn
//      to them. A findings row carries a target (a room number, an item id) and
//      a dedupe key whose interior is the detector's private business. Neither
//      one can answer "which three cards on this board".
//   2. The findings runner is a cron, and the crons are switched off at the
//      founder's own master switch. A trace built on stored findings would
//      never appear at all.
//
// So detection here is page-time, reads only what the page itself could read,
// writes nothing, and costs ZERO MODEL CALLS. Every detector in ./detectors is
// a pure function of rows handed to it.
// ═══════════════════════════════════════════════════════════════════════════

import type { CompanionSensitivity, CompanionSeverity } from '../manners';
import type { CompanionPageKey } from '../pages';

/**
 * The screens a trace can be drawn on.
 *
 * A subset of CompanionPageKey on purpose. `staxis` is here because the one
 * list is where a pattern found somewhere else turns up as a line, not because
 * anything is ever drawn on it.
 */
export type TracePage = Extract<CompanionPageKey, 'maintenance' | 'inventory' | 'staxis'>;

/**
 * One thing on the page the trace runs to.
 *
 * `domId` is the value of a `data-trace-anchor` attribute, or of one of the
 * attributes the page already had before the trace existed (the maintenance
 * board has carried `data-wo-id` since its FLIP animation shipped). The overlay
 * looks the node up at draw time and re-measures on scroll and resize, so an
 * anchor that is off screen is scrolled to rather than guessed at.
 *
 * `present: false` is the honest answer for a thing the pattern is about that
 * the page is NOT currently showing: a closed work order that lives behind the
 * History button, or a room that has no ticket yet. Nothing is ever drawn to
 * one. It is named in the card's own words instead, which is the whole reason
 * the field exists rather than the anchor being dropped.
 */
export interface TraceAnchor {
  /** Attribute value to find the row by. Empty when `present` is false. */
  readonly domId: string;
  /** The short mono label under the dot. "JUN 14 · RATTLE". */
  readonly label: string;
  /** Is this thing on the screen right now? */
  readonly present: boolean;
  /** For absent anchors: the sentence that stands in for the line. */
  readonly note?: string;
}

/** One key/value line inside the ink card. Both sides are plain English. */
export interface TraceFact {
  readonly k: string;
  readonly v: string;
}

/**
 * What a button on the ink card actually does.
 *
 * `tool` names a REAL, EXISTING server action. There is no such thing as a
 * trace-only write path: if the product has no way to do the thing, the button
 * does not exist. A dead button on a card that just claimed to understand the
 * hotel is worse than no button.
 */
export interface TraceActionPlan {
  readonly tool: TraceToolId;
  readonly label: string;
  /** Frozen at detection time from the same evidence the card renders. */
  readonly args: Readonly<Record<string, string>>;
}

/**
 * The catalog. One entry per existing server action a trace may offer.
 *
 * `create_work_order` is `createWorkOrderForComms` in src/lib/comms/core.ts,
 * the same function POST /api/comms/action already calls to put a ticket on the
 * maintenance board.
 *
 * There is deliberately NO `merge_work_orders`. Nothing in this product can
 * merge two work orders into one: there is no parent column, no supersedes
 * column and no join table, so "merge into one job" would be a button that
 * lies. What IS real is putting one combined job on the board that covers the
 * whole run, which is what the button says instead.
 */
export type TraceToolId = 'create_work_order';

/**
 * The money line, or the honest absence of one.
 *
 * `figure` is null unless THIS hotel's own recorded numbers support a range
 * (findings/pricing.ts owns that arithmetic and refuses to invent a width).
 * `line` is true either way, which is why it is not optional: "a small repair
 * now, or a replacement later" is a real thing to say about a failing run and
 * says it without a number nobody can check.
 */
export interface TraceCost {
  /** "$300–$600", or null. Never a point estimate, never borrowed. */
  readonly figure: string | null;
  /** What the figure is for, or the words that stand in for it. */
  readonly line: string;
  /** Where it came from, or why there is none. Always set. */
  readonly basis: string;
}

/**
 * One pattern, ready to be asked about and drawn.
 *
 * Everything here was computed by pure code from rows the page could load. No
 * sentence in it was written by a model.
 */
export interface TracePattern {
  /**
   * The identity of the PROBLEM, content-derived and stable across
   * recomputation. Doubles as the manners topic, so a No recorded against it
   * survives the pattern being found again tomorrow with a fourth ticket in it.
   * See ./identity.ts for the scheme and why the measurement is excluded.
   */
  readonly key: string;
  readonly detectorId: string;
  /**
   * The screen this is drawn on, or null for a pattern that is only ever
   * spoken.
   *
   * Null is a real answer, not a missing one. A pattern about one person's
   * attendance has nothing on any screen to join a line between, and the
   * screen it would be about is not one the companion can walk anybody to.
   * It gets said, with its facts, inside the panel the person opened, and
   * nothing is ever drawn for it.
   */
  readonly page: TracePage | null;
  /** The ask, in the companion's own voice. One sentence, ends in a question. */
  readonly ask: string;
  /** The mono eyebrow over the ink card. "Three rooms, one line · 2nd floor". */
  readonly kicker: string;
  /** The plain-English explanation. Two sentences at most. */
  readonly body: string;
  readonly facts: readonly TraceFact[];
  readonly cost: TraceCost | null;
  /** The receipt line: what a human would re-read to check this. */
  readonly basis: string;
  readonly anchors: readonly TraceAnchor[];
  readonly actions: readonly TraceActionPlan[];
  /** `people` never speaks first. See CompanionSensitivity. */
  readonly sensitivity: CompanionSensitivity;
  readonly severity: CompanionSeverity;
  /** Ids in the one-list's namespace, for the one-voice rule. */
  readonly covers: readonly string[];
  /** Bigger is worse. Ranking only; never printed. */
  readonly magnitude: number;
}

/**
 * How many anchors must actually be findable in the DOM before the overlay
 * will draw anything.
 *
 * One, not two. The rule this enforces is "never draw a line to something that
 * is not there", and a single lit row with the ink card hanging under it is the
 * baseline treatment working exactly as designed. A detector that means
 * something stronger by "these are one thing" enforces its own higher floor —
 * `maintenance-run.ts` refuses to speak with fewer than two tickets still on
 * the board, because "these three are one problem" is a claim about a plural.
 */
export const MIN_VISIBLE_ANCHORS = 1;

/**
 * The narrowest width the trace will engage at.
 *
 * Below it nothing is offered and nothing is drawn. The overlay is a geometric
 * argument about a page's own empty space, and a phone has none: the companion
 * itself is already hidden under 760px (see ASX_CSS), so a trace there would be
 * an overlay with no companion attached to it. Mobile is out of scope by
 * decision, not by accident, and this constant is where that decision lives.
 */
export const TRACE_MIN_VIEWPORT_WIDTH = 900;
