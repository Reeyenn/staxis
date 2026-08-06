// ═══════════════════════════════════════════════════════════════════════════
// Discovery pointers — one thing per visit, and only ever one.
//
// This is the smallest possible layer on top of the companion's existing
// memory. It adds no new storage and no new reducer: a pointer is a TOPIC, and
// topics already know how to be shown once a day, declined, and dropped
// forever. Everything below is composition of exported pieces, which is what
// keeps it out of the way of anyone else working on the companion.
//
//   Not now           →  the topic was stamped when it was shown, so it is
//                        quiet for the rest of the hotel's day and returns on
//                        the next visit after that. Exactly the promise made
//                        on the button.
//   Do not show again →  the topic is dropped, permanently, first time asked.
//   Tapped the button →  the same as never. They found it. Going on pointing
//                        at a control somebody has just used is the app
//                        talking over a person who is already ahead of it.
//
// The second and third are the only places this file has an opinion. The
// companion's ordinary rule is that a topic drops after two declines, because
// most of what it says is worth one more try on another day. A pointer is not:
// somebody who says "do not show this again" about a button has read the
// sentence and made a decision, and asking twice would make the button a liar.
// ═══════════════════════════════════════════════════════════════════════════

import {
  rememberDeclined,
  type CompanionMemory,
} from './manners';
import {
  INVENTORY_POINTER_ORDER,
  STAXIS_POINTER_ORDER,
  pointerLine,
  type CompanionPointerKey,
  type PointerLine,
} from './copy';
import type { CompanionPageKey } from './pages';

/** Delay before a pointer appears, so it lands after the screen has settled
 *  and never competes with the thing the person came to look at. */
export const POINTER_DELAY_MS = 3_000;

/** Stable topic handle. Namespaced so it can never collide with a finding's. */
export function pointerTopic(key: CompanionPointerKey): string {
  return `pointer:${key}`;
}

export interface PointerCandidate extends PointerLine {
  topic: string;
}

/**
 * The screens that have pointers, and the order they are offered in.
 *
 * A page with no entry has no pointers, which is most of them. The order is
 * the product decision: on Inventory the importer comes first because a hotel
 * arriving with a spreadsheet meets "bring the file you have" before "photograph
 * a delivery", and a hotel with no items yet has no deliveries to photograph.
 */
const POINTERS_BY_PAGE: Partial<Record<CompanionPageKey, readonly CompanionPointerKey[]>> = {
  inventory: INVENTORY_POINTER_ORDER,
  staxis: STAXIS_POINTER_ORDER,
};

/** Every pointer that belongs on this screen, in the order they are offered. */
export function pointersForPage(page: CompanionPageKey): PointerCandidate[] {
  const keys = POINTERS_BY_PAGE[page] ?? [];
  return keys.map((key) => ({ ...pointerLine(key), topic: pointerTopic(key) }));
}

export interface PointerMemoryView {
  topics: Record<string, { dropped: boolean; lastOfferedDay: string | null }>;
}

/**
 * The one pointer to show right now, or null.
 *
 * Skips anything dropped forever, and anything already offered today. Returns
 * the FIRST survivor and stops looking, which is the one-thing-at-a-time rule
 * expressed as three lines of code rather than a paragraph of intent.
 */
export function pickPointer(
  pointers: readonly PointerCandidate[],
  memory: PointerMemoryView | null | undefined,
  today: string,
): PointerCandidate | null {
  const topics = memory?.topics ?? {};
  for (const p of pointers) {
    const seen = topics[p.topic];
    if (seen?.dropped) continue;
    if (seen && seen.lastOfferedDay === today) continue;
    return p;
  }
  return null;
}

/**
 * "Do not show this again", in one act.
 *
 * Composed from the existing decline reducer rather than reaching into the
 * memory shape: applying it twice reaches the drop threshold by the same path a
 * person's two Nos would, so there is exactly one definition of what dropped
 * means and this file does not own a copy of it.
 */
export function rememberDroppedTopic(
  memory: CompanionMemory,
  topic: string,
  today: string,
): CompanionMemory {
  let next = rememberDeclined(memory, topic, today);
  // Defensive rather than fixed at two: if the charter ever raises the decline
  // threshold, "do not show again" must still mean never, not "one closer".
  for (let i = 0; i < 8 && next.topics[topic]?.dropped !== true; i++) {
    next = rememberDeclined(next, topic, today);
  }
  return next;
}
