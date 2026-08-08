// ═══════════════════════════════════════════════════════════════════════════
// Somebody is looking for something and not finding it.
//
// ─── THE ONLY SENTENCE THIS FILE IS ALLOWED TO PRODUCE ─────────────────────
//
// "Looking for something? Ask me and I will point." Once. Ever. Per person.
//
// It exists because the last stop of the tour teaches a real ability and the
// people who most need that ability are the ones who never took the tour. A
// person clicking through four screens in half a minute without touching
// anything has told us, in the only language a screen has, that they cannot
// find the thing they came for.
//
// ─── WHY THE THRESHOLDS ARE DELIBERATELY TOO HIGH ──────────────────────────
//
// A false positive here is the worst thing the companion can do. It is the app
// telling a competent person, in the middle of their own work, that it thinks
// they are lost. There is no recovering from that: they will read every future
// sentence in the same voice. A miss costs nothing at all, because the ability
// is still there and the tour still teaches it.
//
// So every dial is set past the founder's floor rather than at it:
//
//   4 navigations, not 3     three is a person going Staxis, Maintenance,
//                            back. That is not lost, that is a round trip.
//   3 distinct screens       four visits that bounce between two screens is
//                            somebody comparing two things, which is work.
//   30 seconds               a whole window, and it slides: anything older
//                            falls out rather than accumulating over a shift.
//   zero actions             a single meaningful act anywhere in the window
//                            clears the whole thing. Somebody who did
//                            something knows where they are.
//   welcomed already         never on somebody's first minutes. A brand new
//                            person clicking around is exploring, and the
//                            welcome has already offered them the tour.
//
// ─── AND IT ADDS NO NEW WAY TO INTERRUPT ───────────────────────────────────
//
// This module decides nothing about speech. It produces a CANDIDATE, which the
// existing manners engine then accepts or refuses like any other: it spends the
// daily budget, it honours the minimum gap, it cannot appear over somebody who
// is typing, it cannot appear while the tour is pending, and a No drops the
// topic. There is no code path from here to a person's screen that does not go
// through `decideCompanionSpeech`.
// ═══════════════════════════════════════════════════════════════════════════

import type { CompanionCandidate, CompanionMemory } from './manners';
import { repliesFor } from './replies';
import { wanderingLine } from './copy';

/** The sliding window. Anything older than this is not part of the same hunt. */
export const WANDER_WINDOW_MS = 30_000;

/** Navigations inside the window. The founder's floor is three; this is four. */
export const WANDER_MIN_MOVES = 4;

/** Distinct screens among them. Two screens is a comparison, not a hunt. */
export const WANDER_MIN_DISTINCT_PAGES = 3;

/**
 * The topic a No attaches to.
 *
 * One topic, not one per screen: somebody who said no to being offered help
 * finding things said no to the idea, not to the idea on Maintenance.
 */
export const WANDER_TOPIC = 'wander:lost';

/** One arrival on one screen. */
export interface WanderVisit {
  /** The companion's own page key, or any stable per-screen string. */
  page: string;
  /** When they landed, in epoch milliseconds. */
  at: number;
}

export interface WanderInput {
  /** Arrivals, newest last. The caller keeps this bounded. */
  visits: readonly WanderVisit[];
  /**
   * When this person last did something that counted, or null.
   *
   * "Counted" means a real act on the hotel: a to-do written, a row marked
   * done, a message sent, a count saved. Scrolling is not an action and
   * neither is opening a menu, because both are things a lost person does.
   */
  lastActionAt: number | null;
  /** Now, in epoch milliseconds. Passed in so the whole thing is testable. */
  now: number;
  memory: CompanionMemory;
}

export type WanderRefusal =
  | 'never_welcomed'
  | 'already_offered'
  | 'too_few_moves'
  | 'too_few_screens'
  | 'acted_recently';

export type WanderDecision =
  | { wandering: false; refusal: WanderRefusal }
  | { wandering: true; candidate: CompanionCandidate };

/**
 * Are they lost?
 *
 * Returns a candidate, never a decision to speak. The refusal is kept rather
 * than collapsed to a boolean because the thresholds are the product, and a
 * test that can only see false cannot tell "three moves" from "they did
 * something" from "we already asked".
 */
export function decideWandering(input: WanderInput): WanderDecision {
  // Day one belongs to the welcome, which has already offered a tour. Offering
  // help finding things to somebody who has not yet been told who is talking
  // is the app introducing itself twice in two different voices.
  if (!input.memory.welcomedAt) return { wandering: false, refusal: 'never_welcomed' };

  // Once, ever. `dropped` is set the moment it is shown as well as on a No, so
  // this one check covers both "they said no" and "they already heard it".
  if (input.memory.topics[WANDER_TOPIC]?.dropped) {
    return { wandering: false, refusal: 'already_offered' };
  }

  const floor = input.now - WANDER_WINDOW_MS;
  const recent = input.visits.filter((v) => v.at > floor && v.at <= input.now);
  if (recent.length < WANDER_MIN_MOVES) return { wandering: false, refusal: 'too_few_moves' };

  const distinct = new Set(recent.map((v) => v.page));
  if (distinct.size < WANDER_MIN_DISTINCT_PAGES) {
    return { wandering: false, refusal: 'too_few_screens' };
  }

  // One real act anywhere in the window and this is not a hunt. Deliberately
  // the WHOLE window rather than "since the first visit": somebody who saved
  // something and then went looking for the next thing is working.
  if (input.lastActionAt !== null && input.lastActionAt > floor) {
    return { wandering: false, refusal: 'acted_recently' };
  }

  return {
    wandering: true,
    candidate: {
      topic: WANDER_TOPIC,
      text: wanderingLine(),
      // Operational, so it may be said unprompted. It is about the app, not
      // about a person: there is nothing here anybody would mind a colleague
      // reading over their shoulder.
      sensitivity: 'operational',
      // It is about nothing on the screen, so the one-voice rule has nothing
      // to compare it against and it can never be suppressed by a card.
      covers: [],
      // No destination. The answer to "yes" is a conversation, not a screen:
      // walking a lost person to a ninth screen is the problem, not the fix.
      destination: null,
      severity: 'ok',
      // A yes hands the person straight into the chat with the question already
      // half asked, which is the whole ability being taught. It carries no new
      // capability: the seeded sentence goes through the same turn they could
      // have typed, and `staxis_point_at` still refuses everything it always
      // refused.
      seed: WANDER_SEED,
      // Built HERE, beside the sentence, by the code that decided to say it.
      // That is the whole rule replies.ts exists for: the alternative is a
      // question invented at render time to fit a routing hint, which is the
      // bug that shipped a fire-panel statement under "Want me to take you to
      // Staxis?".
      replyKind: 'wandering',
      replies: repliesFor({ kind: 'wandering', seed: WANDER_SEED }),
    },
  };
}

/**
 * What a yes puts in the composer.
 *
 * A QUESTION, not an instruction. The point of the offer is that they finish
 * this sentence themselves and learn that finishing it works.
 */
export const WANDER_SEED = 'Where do I find';

// ─── Keeping the trail ──────────────────────────────────────────────────────

/** How many arrivals are worth remembering. Twice the window's worth. */
export const WANDER_TRAIL_CAP = 12;

/**
 * Add one arrival and drop what no longer matters.
 *
 * Pure, and bounded twice: by the window and by the cap. A tab left open all
 * shift walks a hundred screens and this list never grows past twelve.
 */
export function recordVisit(
  trail: readonly WanderVisit[],
  visit: WanderVisit,
): WanderVisit[] {
  const floor = visit.at - WANDER_WINDOW_MS;
  // A repeat of the screen they are already on is not a move. Next.js
  // re-renders a route on a query change, and counting those would let one
  // screen with a tab strip look like a hunt across four.
  const last = trail[trail.length - 1];
  if (last && last.page === visit.page) return trail.filter((v) => v.at > floor);
  return [...trail.filter((v) => v.at > floor), visit].slice(-WANDER_TRAIL_CAP);
}
