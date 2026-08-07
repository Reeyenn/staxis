// ═══════════════════════════════════════════════════════════════════════════
// "Want to see what's new?"
//
// ─── WHAT THIS IS NOT ──────────────────────────────────────────────────────
//
// It is not a changelog, not a release-notes panel, not a red dot, and above
// all not a periodic hint in the daily hello. The founder rejected capability
// hints in the hello outright, and this file is the reason that rejection can
// hold: the honest need behind "remind people what the app can do" is not a
// reminder at all, it is that something CHANGED and the people who already
// learned the old shape have no way to find out.
//
// So the trigger is a fact, not a timer. An entry exists because a specific
// thing shipped on a specific day. When a person has not seen it, the
// companion may offer, once, to show them. When there is nothing newer than
// what they have seen, there is nothing to offer and nothing is said. An empty
// registry produces total silence, which is the correct behaviour on every day
// nothing shipped, and that is most days.
//
// ─── IT IS A TOUR, NOT A NOTICE ────────────────────────────────────────────
//
// A yes runs the same player over the same anchors as the first-run tour, with
// one to three stops. That is deliberate: a sentence about a change somebody
// cannot find is worse than saying nothing, and the machinery that can put an
// arrow on the real control already exists. An entry whose stops all fail the
// role and section gates is not offered at all, so nobody is ever shown a
// change that is not on their screen.
//
// ─── TWO SEPARATE MEMORIES, AND WHY ────────────────────────────────────────
//
//   whatsNewThrough   the CATCH-UP CURSOR. Stamped for a person the first time
//                     the companion has anything to do with them, so somebody
//                     hired in November is never walked through what shipped in
//                     June. Without it, every new hire's second day would be a
//                     backlog.
//   topics            the PER-ENTRY answer, through the ordinary ledger. Shown
//                     or declined, either way that entry is done with them.
//
// One would not do. The cursor alone would re-offer an entry to somebody who
// declined it while a newer one was pending; the topics alone would offer the
// whole history to a new hire.
// ═══════════════════════════════════════════════════════════════════════════

import type { CompanionMemory } from './manners';
import { tourStopApplies, type TourContext, type TourStop } from './tour';

export interface WhatsNewEntry {
  /** Stable. The handle a No attaches to; never reuse one. */
  id: string;
  /**
   * The day it shipped, YYYY-MM-DD.
   *
   * Compared as a STRING, which is why the format is fixed: `>` on
   * `2026-08-07` is a date comparison for free, with no parsing and no
   * timezone to get wrong. A second thing shipping the same day gets a later
   * `id` and the tie is broken by declaration order below.
   */
  shippedOn: string;
  /** One sentence: what changed, in the words of the job. */
  headline: string;
  /** One to three stops, run on the tour's own player over the same anchors. */
  stops: readonly TourStop[];
}

/**
 * Everything worth showing somebody who was already here.
 *
 * ORDERED OLDEST FIRST. Deliberately EMPTY at the moment this shipped: the
 * first entry belongs to the first change that lands after it, written by
 * whoever ships that change. An entry added here with no stops that survive
 * the gates is silently never offered, which is the safe failure.
 *
 * The bar for adding one: could somebody who used this app last week miss
 * this, and would they be annoyed to find out late? If not, it is not an
 * entry. A registry that grows a row per release becomes the changelog nobody
 * wanted, and the companion will have spent its one credible interruption on a
 * button that moved four pixels.
 */
export const WHATS_NEW: readonly WhatsNewEntry[] = [];

export type WhatsNewRefusal =
  | 'never_welcomed'
  | 'nothing_shipped'
  | 'all_caught_up'
  | 'nothing_for_this_person';

export type WhatsNewDecision =
  | { show: false; refusal: WhatsNewRefusal }
  | { show: true; entry: WhatsNewEntry; stops: readonly TourStop[]; topic: string };

/** The topic handle for one entry. Namespaced so it cannot collide. */
export function whatsNewTopic(id: string): string {
  return `whatsnew:${id}`;
}

/**
 * The one change worth offering right now, or nothing.
 *
 * OLDEST FIRST among the ones still owed, so a person who has been away for
 * two changes meets them in the order they happened rather than backwards.
 */
export function decideWhatsNew(
  ctx: TourContext,
  memory: CompanionMemory,
  registry: readonly WhatsNewEntry[] = WHATS_NEW,
): WhatsNewDecision {
  if (!memory.welcomedAt) return { show: false, refusal: 'never_welcomed' };
  if (registry.length === 0) return { show: false, refusal: 'nothing_shipped' };

  const through = memory.whatsNewThrough;
  const owed = registry.filter((e) => (through === null ? true : e.shippedOn > through));
  if (owed.length === 0) return { show: false, refusal: 'all_caught_up' };

  for (const entry of owed) {
    const topic = whatsNewTopic(entry.id);
    if (memory.topics[topic]?.dropped) continue;
    // The same three gates the first-run tour applies, applied per stop. An
    // entry about the importer is not offered to a hat that has no importer,
    // and an entry about a section this hotel switched off is not offered at
    // all. This is the adversarial case the role tests pin.
    const stops = entry.stops.filter((stop) => tourStopApplies(stop, ctx));
    if (stops.length === 0) continue;
    return { show: true, entry, stops, topic };
  }
  return { show: false, refusal: 'nothing_for_this_person' };
}

/**
 * The cursor to stamp so somebody is caught up.
 *
 * The newest thing in the registry, not the entry they were just shown: a
 * person who declines the only pending change is caught up on it, and
 * advancing only as far as what they saw would re-offer the next one
 * immediately. Null when there is nothing to be caught up on.
 */
export function whatsNewHighWater(
  registry: readonly WhatsNewEntry[] = WHATS_NEW,
): string | null {
  let newest: string | null = null;
  for (const entry of registry) {
    if (newest === null || entry.shippedOn > newest) newest = entry.shippedOn;
  }
  return newest;
}
