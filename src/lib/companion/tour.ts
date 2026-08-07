// ═══════════════════════════════════════════════════════════════════════════
// The tour — the companion introducing the app so nobody has to demo it.
//
// ─── WHY THIS IS AUTHORED AND NOT GENERATED ────────────────────────────────
//
// The system this replaces ("Clicky") asked a model, once per step, to look at
// a list of everything clickable on the screen and pick the next thing to point
// at. It located controls by an accessible-name match against synthetic ids
// that were re-derived on every snapshot, and the documented escape hatch for a
// control with no readable name was never implemented, so an icon-only button
// was a coin flip. That is a reasonable design for "walk me through a task I
// just described in my own words". It is the wrong design for the one thing
// every new hire needs, which is the same three minutes every time.
//
// A tour is a SCRIPT. It does not vary by hotel, it does not vary by day, and
// nobody wants it to. So it is written down here, once, in sentences a person
// approved, and located through the anchor registry that the pointer and the
// chat already share. Three consequences, all of them the point:
//
//   • one vocabulary. A control the tour can reach is a control the chat
//     pointer can reach and the nightly robot can census. Adding a stop is
//     adding an anchor, not teaching a model a new name.
//   • no coin flip. `anchorSelector` is an exact attribute match. A stop whose
//     control is missing does not point at the nearest thing with a similar
//     label; PointerPopup refuses to draw and the tour moves on.
//   • no money, no latency, no model. The tour works when the AI layer is
//     asleep, because there is nothing in it for a model to do.
//
// ─── THE CHARTER CLAUSE THIS FILE EXISTS TO KEEP ───────────────────────────
//
// THE TOUR NEVER ACTS ON THE HOTEL. Not once, not "just to demonstrate". A
// `try` stop lights the real control and waits for the PERSON to use it, and
// the only thing that advances it is the app reporting that the real write
// really happened. There is deliberately no code path here that can create a
// to-do, and no stop shape that carries one.
//
// ─── ROLE AND SECTION AWARENESS IS STRUCTURAL ──────────────────────────────
//
// Every stop declares the page it belongs to; a stop survives only if
// `resolveDestination` would have offered that page to this person at this
// hotel, which is the same gate the "take me there" button uses. On top of
// that a stop with an anchor survives only if the anchor is reachable, which
// is the same gate the chat pointer uses. Nothing here re-implements either
// rule, so a hotel that switches Inventory off loses its Inventory stop
// without this file knowing that happened. Housekeeping never arrives at all:
// mount.ts refuses the hat before anything below runs.
// ═══════════════════════════════════════════════════════════════════════════

import type { AppRole } from '@/lib/roles';
import { canManageTeam } from '@/lib/roles';
import type { EnabledSections } from '@/lib/sections/registry';
import {
  anchorFor,
  anchorIsReachable,
  type CompanionAnchorKey,
  type CompanionAnchorStanding,
} from './anchors';
import { resolveDestination, type CompanionPage, type CompanionPageKey } from './pages';

/**
 * What a stop asks of the person.
 *
 *   watch  the companion says one sentence and lights the thing it is about.
 *          One tap to go on.
 *   try    the companion lights the control and STOPS. Nothing advances it but
 *          the real action landing.
 */
export type TourStopKind = 'watch' | 'try';

/**
 * The real acts a `try` stop can wait for.
 *
 * A CLOSED list, and each member is reported by the screen that owns the write
 * AFTER the server said yes. That ordering is the whole verification: a tour
 * that advanced on a click would advance on a click that failed, and would
 * then congratulate somebody for a to-do that does not exist.
 */
export type TourDeed = 'todo_created' | 'fact_taught';

export interface TourStop {
  /** Stable handle. Used for journaling and for the resume cursor. */
  key: string;
  /** The screen this stop happens on. Walked to through the pages allowlist. */
  page: CompanionPageKey;
  /**
   * The control the sentence is about, or null for a stop about a whole screen.
   *
   * Named beside the words for the same reason PointerLine names it beside
   * its paragraphs: the sentence and the thing it is about are one fact, and a
   * stop whose copy moved without its anchor moving is the companion drawing a
   * line at the wrong button.
   */
  anchor: CompanionAnchorKey | null;
  kind: TourStopKind;
  /** ONE plain sentence. See the copy rules at the top of copy.ts. */
  say: string;
  /** What has to actually happen. Present on `try` stops and nowhere else. */
  awaits?: TourDeed;
  /** An example worth typing, shown under a `try` stop's sentence. */
  example?: string;
  /** Manager, owner or admin only. Mirrors `CompanionPage.managerOnly`. */
  managerOnly?: boolean;
}

/**
 * The tour, in order.
 *
 * "Where the work is" first and "where the settings are" last, the same
 * ordering `tourFor` has always used: the tour is meant to end with somebody
 * able to do their job, not able to configure one.
 *
 * The two `try` stops are placed on purpose. The to-do comes second, while the
 * person is still on the screen they will spend their day on and before the
 * tour has asked anything of them. The taught fact comes late, once they have
 * seen enough of the hotel to have a fact worth telling. By the end the hotel
 * has one real to-do and one real thing the companion knows, both written by a
 * person.
 *
 * The last stop is the one that outlives the tour: everything above teaches a
 * screen, and the last one teaches how to find any screen without a tour.
 */
export const TOUR_STOPS: readonly TourStop[] = [
  {
    key: 'staxis-intro',
    page: 'staxis',
    anchor: 'nav-staxis',
    kind: 'watch',
    say: 'This is your one list. Anything that needs a decision turns up here, from every part of the app.',
  },
  {
    key: 'staxis-todo',
    page: 'staxis',
    anchor: 'todo-composer',
    kind: 'try',
    awaits: 'todo_created',
    say: 'Your turn. Type a to-do in the box, pick who does it, and send it. I will wait.',
    example: 'Fix the ice machine tomorrow',
  },
  {
    key: 'dashboard',
    page: 'dashboard',
    anchor: 'nav-dashboard',
    kind: 'watch',
    say: 'The dashboard is the hotel at a glance: who is in house, what is arriving, and what is not ready yet.',
  },
  {
    key: 'maintenance',
    page: 'maintenance',
    anchor: 'nav-maintenance',
    kind: 'watch',
    say: 'Maintenance holds your work orders and the jobs that come round again.',
  },
  {
    key: 'inventory',
    page: 'inventory',
    anchor: 'nav-inventory',
    kind: 'watch',
    say: 'Inventory is what you have on hand and what is running low.',
  },
  {
    key: 'messages',
    page: 'messages',
    anchor: 'nav-communications',
    kind: 'watch',
    say: 'Messages is where your team talks, and where the notices everybody should see get posted.',
  },
  {
    key: 'knows-teach',
    page: 'knows',
    anchor: 'knows-teach',
    kind: 'try',
    awaits: 'fact_taught',
    // Manager-only twice over: the stop says so, and the anchor needs `manage`.
    // Two gates that agree, rather than one relying on the other.
    managerOnly: true,
    say: 'Teach me one thing about your hotel. Type it here and I will use it from now on. I will wait.',
    example: 'Checkout is at 11',
  },
  {
    key: 'people',
    page: 'people',
    anchor: null,
    kind: 'watch',
    managerOnly: true,
    say: 'People is your roster: who works here, how to reach them, and what each person can see.',
  },
  {
    key: 'settings',
    page: 'settings',
    anchor: null,
    kind: 'watch',
    managerOnly: true,
    say: 'Settings is where the hotel itself is set up: shifts, checklists, and who has access.',
  },
  {
    // ─── The stop that outlives the tour ──────────────────────────────────
    // Founder pick. Everything above is a screen somebody will forget. This is
    // the one sentence that makes forgetting cheap, so it is last, on the
    // screen they started on, pointing at the thing that is on every screen.
    key: 'ask-me',
    page: 'staxis',
    anchor: 'staxis-mark',
    kind: 'watch',
    say: 'Last thing. If you are ever lost, ask me where something is and I will point at it.',
    example: 'Where do I add a work order?',
  },
];

// ─── Who gets which stops ───────────────────────────────────────────────────

export interface TourContext {
  role: AppRole | null | undefined;
  enabledSections: EnabledSections | undefined;
  /** What this person's own screen would have rendered. See anchors.ts. */
  standing: CompanionAnchorStanding;
}

/**
 * Would this stop be real for this person, at this hotel, today?
 *
 * Three independent refusals, and each one is a gate that already existed:
 *
 *   1. the PAGE. `resolveDestination` refuses a manager-only screen for a hat
 *      that does not manage, and a screen whose section this hotel switched
 *      off. A tour that walked somebody into a locked door would be worse than
 *      a shorter tour.
 *   2. the STOP's own manager flag, which says out loud what the page gate
 *      already implies for `people` and `settings` and is the ONLY gate on
 *      `knows-teach`, whose page (`knows`) is not manager-only.
 *   3. the ANCHOR. A stop whose control this person's access never renders is
 *      a stop that would point at nothing. Dropped rather than shown blind.
 */
export function tourStopApplies(stop: TourStop, ctx: TourContext): boolean {
  if (!ctx.role) return false;
  if (stop.managerOnly && !canManageTeam(ctx.role)) return false;
  if (!resolveDestination(stop.page, { role: ctx.role, enabledSections: ctx.enabledSections })) {
    return false;
  }
  if (stop.anchor) {
    const anchor = anchorFor(stop.anchor);
    if (!anchor) return false;
    if (!anchorIsReachable(anchor, ctx.standing)) return false;
  }
  return true;
}

/** This person's tour, in order. Empty means there is no tour to offer. */
export function tourStopsFor(ctx: TourContext): TourStop[] {
  return TOUR_STOPS.filter((stop) => tourStopApplies(stop, ctx));
}

/** Where a stop walks to, or null when the allowlist refuses it. */
export function tourDestination(stop: TourStop, ctx: TourContext): CompanionPage | null {
  return resolveDestination(stop.page, { role: ctx.role, enabledSections: ctx.enabledSections });
}

// ─── Running one ────────────────────────────────────────────────────────────
//
// PURE. The player in the browser owns pixels, the router and the clock; every
// decision about what happens next is here, so the suite can drive a whole
// tour without mounting anything.

export interface TourRun {
  /** The stops this run was built from. Fixed at start: a hotel that switched
   *  a section off mid-tour does not renumber somebody's walk under them. */
  stops: readonly TourStop[];
  /** Which one is showing. */
  index: number;
  /** True while a `try` stop is waiting for the real action. */
  waiting: boolean;
  /** Ended, and how. Null while it is still going. */
  ended: TourEnding | null;
}

/**
 * How a tour stopped.
 *
 *   finished  every stop was seen.
 *   skipped   they left early, by Escape or by the button. Journaled, and
 *             never offered again unprompted. See the manners note below.
 */
export type TourEnding = 'finished' | 'skipped';

export function startTourRun(stops: readonly TourStop[]): TourRun {
  return {
    stops,
    index: 0,
    waiting: stops.length > 0 && stops[0].kind === 'try',
    ended: stops.length === 0 ? 'finished' : null,
  };
}

/** The stop currently showing, or null once the run is over. */
export function currentStop(run: TourRun): TourStop | null {
  if (run.ended !== null) return null;
  return run.stops[run.index] ?? null;
}

/**
 * Move on.
 *
 * REFUSED WHILE WAITING. A `try` stop that could be skipped forward by the
 * same button that advances a `watch` stop is not a "you try" moment, it is a
 * slide with extra words. The only thing that clears `waiting` is
 * `tourDeedDone`, and the only way past it without doing the thing is to end
 * the tour, which is a different act with a different consequence.
 */
export function advanceTour(run: TourRun): TourRun {
  if (run.ended !== null || run.waiting) return run;
  const next = run.index + 1;
  if (next >= run.stops.length) return { ...run, ended: 'finished' };
  return { ...run, index: next, waiting: run.stops[next].kind === 'try' };
}

/**
 * The real thing happened.
 *
 * Only clears the wait when the deed is the one THIS stop asked for. Somebody
 * who teaches a fact during the to-do stop has done something useful and
 * something else, and moving the tour on would be the companion taking credit
 * for a step nobody took.
 */
export function tourDeedDone(run: TourRun, deed: TourDeed): TourRun {
  if (run.ended !== null || !run.waiting) return run;
  const stop = run.stops[run.index];
  if (!stop || stop.awaits !== deed) return run;
  return advanceTour({ ...run, waiting: false });
}

/** Escape, the skip button, or walking away. One consequence, said once. */
export function endTourRun(run: TourRun, ending: TourEnding): TourRun {
  if (run.ended !== null) return run;
  return { ...run, waiting: false, ended: ending };
}

/**
 * How far through, for the line under the sentence.
 *
 * One-based, because "1 of 9" is what a person counts and "0 of 9" is what a
 * computer counts.
 */
export function tourProgress(run: TourRun): { at: number; total: number } {
  return { at: Math.min(run.index + 1, run.stops.length), total: run.stops.length };
}
