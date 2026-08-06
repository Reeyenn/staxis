// ═══════════════════════════════════════════════════════════════════════════
// What a refresh of the companion bootstrap is allowed to change.
//
// THIS MODULE IS PURE. It exists because the rule it encodes is the difference
// between "notices arrive without a reload" and "somebody gets greeted twice",
// and the hook it serves cannot be mounted in this repo's test runner (the
// suite runs under --conditions=react-server). So the rule lives here, where a
// test can call it, and the hook is left holding wiring.
//
// ─── THE RULE ──────────────────────────────────────────────────────────────
//
// A refresh replaces the DELIVERABLE half of the bootstrap: work that landed
// on this person, and things worth raising. It replaces nothing else.
//
// The half it must not touch is the memory, and the reason is a specific bug
// rather than a principle. The browser holds an OPTIMISTIC copy of the
// companion's memory between the moment it speaks and the moment the server
// agrees: `welcomedAt` is set locally the instant the welcome renders, and the
// POST that makes it durable is still in flight. A refresh landing inside that
// window carries the server's older memory, `welcomedAt` goes back to null, and
// the manners engine welcomes the same person a second time in the same page
// load. That is the one thing the whole manners layer exists to prevent, and it
// would have arrived through the back door of a refresh.
//
// The person, the hotel and the availability are left alone for a duller
// reason: they do not change under somebody who is standing still, and
// replacing them would be three more chances to get the same class of bug.
// ═══════════════════════════════════════════════════════════════════════════

import type { CompanionCandidate } from './manners';
import type { AssignmentNotice } from './notices';

/** The half of a bootstrap that changes while a screen is open. */
export interface CompanionDeliverable {
  notices: readonly AssignmentNotice[];
  candidates: readonly CompanionCandidate[];
}

/**
 * Anything shaped enough to merge. Deliberately structural rather than the
 * hook's own `Bootstrap` type: this module must not depend on a client file,
 * and the two fields below are the whole of what it reads.
 */
export interface CompanionDeliverableSource {
  notices?: readonly AssignmentNotice[];
  candidates?: readonly CompanionCandidate[];
}

/** The deliverable half, normalized. A missing list reads as empty. */
export function deliverableOf(
  source: CompanionDeliverableSource | null | undefined,
): CompanionDeliverable {
  return {
    notices: source?.notices ?? [],
    candidates: source?.candidates ?? [],
  };
}

/**
 * Fold a fresh snapshot into the one on screen.
 *
 * Generic in the bootstrap's own shape so the hook keeps its exact type. The
 * spread order is the whole of the rule: `current` last for everything, with
 * only the two deliverable fields taken from `incoming`.
 */
export function mergeDeliverable<T extends CompanionDeliverableSource>(
  current: T,
  incoming: CompanionDeliverableSource,
): T {
  const fresh = deliverableOf(incoming);
  return { ...current, notices: fresh.notices, candidates: fresh.candidates };
}

/**
 * A stable string for "does this snapshot say the same thing as the last one".
 *
 * Used as the polling transport's `isEqual`, so an idle screen publishes
 * nothing and re-renders zero times an hour. It covers ONLY the deliverable
 * half, because that is the only half a refresh can change: including the
 * memory would make every unrelated server-side stamp look like news.
 */
export function deliverableFingerprint(
  source: CompanionDeliverableSource | null | undefined,
): string {
  return JSON.stringify(deliverableOf(source));
}
