// ─── Stored finding → the shape a card renders ───────────────────────────────
//
// ONE projection, used by /api/findings, by the morning brief, and by the
// company queue. Three copies of it existed before this file, and the failure
// mode of three copies is not a crash — it is a brief line and the card it
// points at quietly disagreeing about what the finding says, because one of the
// three learned about a new field and the others did not.
//
// The judge's verdict is resolved HERE (effectiveDisposition), so every surface
// in the product renders the decision that was made with the hotel's numbers in
// front of it rather than the detector's pre-hotel default.

import {
  effectiveDisposition,
  type CardAction,
  type CardSignOff,
  type QueueFinding,
} from '@/components/concourse/finding-cards';
import { getAction } from './actions/registry';
import type { FindingAction } from './actions/types';
import type { Finding } from './types';

export interface ProjectionExtras {
  /** The judge's wording, when it has any. */
  phrased?: { en: string | null; es: string | null } | null;
  /**
   * A Spanish rendering of the two BASIS lines, when the producer can write one.
   *
   * Only the portfolio checks supply this today, and for a structural reason:
   * `company_findings` has no judged_* columns, so nothing downstream ever
   * translates a company card, and its basis lines were English on a screen a
   * Spanish-reading VP opens. See `portfolioSpanish` in company/portfolio-checks.
   */
  basisEs?: { price: string | null; evidence: string | null } | null;
  /** The attached fix, when the runner froze one. */
  action?: FindingAction | null;
  /** The company signature standing on that fix, when a rule reaches it. */
  signOff?: CardSignOff | null;
  /** Which hotel this is, on a screen showing more than one. */
  hotel?: { propertyId: string; name: string } | null;
}

/**
 * The attached fix, in the shape the card renders.
 *
 * EVERY SENTENCE IS DERIVED HERE, ON THE SERVER, FROM THE FROZEN PARAMS through
 * the catalog entry that also defines what the button does. The client never
 * composes its own description of the plan, so the offer a manager reads and
 * the plan the database executes cannot drift apart.
 *
 * Returns null — the card renders as a plain finding — when the catalog has no
 * entry for the kind, or when the frozen params no longer satisfy the entry's
 * own validation. Both mean the code that would execute this has changed since
 * the plan was frozen, and a button whose effect we cannot vouch for is worse
 * than no button.
 */
export function toCardAction(action: FindingAction): CardAction | null {
  const definition = getAction(action.kind);
  if (!definition) return null;
  if (definition.validate(action.params)) return null;

  const offer = definition.offer(action.params);
  const label = definition.label(action.params);
  const receipt = action.receipt ? definition.receiptLine(action.receipt, action.params) : null;

  return {
    id: action.id,
    kind: action.kind,
    state: action.state,
    offerEn: offer.en,
    offerEs: offer.es,
    labelEn: label.en,
    labelEs: label.es,
    receiptEn: receipt?.en ?? null,
    receiptEs: receipt?.es ?? null,
    changed: action.changedFacts
      ? {
          field: action.changedFacts.field,
          was: action.changedFacts.was,
          now: action.changedFacts.now,
          subject: action.changedFacts.subject ?? null,
        }
      : null,
    failureReason: action.failureReason,
  };
}

/** Stored row → wire shape. Everything the card renders, nothing it does not. */
export function toQueueFinding(
  f: Finding | (Omit<Finding, 'propertyId'> & { propertyId: string | null }),
  extras: ProjectionExtras = {},
): QueueFinding {
  const card: QueueFinding = {
    id: f.id,
    detectorId: f.detectorId,
    dedupeKey: f.dedupeKey,
    summary: f.summary,
    phrasedEn: extras.phrased?.en ?? null,
    phrasedEs: extras.phrased?.es ?? null,
    // Straight off the row, unlike the phrasing above: there is no per-caller
    // decision to make about a question, and a caller that had to remember to
    // pass it through is a caller that will forget.
    judgedQuestion: 'judgedQuestion' in f ? (f.judgedQuestion ?? null) : null,
    severity: f.severity,
    // The judge's verdict when it has one, the detector's default otherwise.
    // Which buttons a card offers — and whether it is a card at all — follows
    // the decision made WITH this hotel's numbers in front of it.
    disposition: effectiveDisposition(f),
    status: f.status,
    magnitude: f.magnitude,
    price: f.price
      ? { ...f.price, basisEs: extras.basisEs?.price ?? null }
      : null,
    evidence: {
      queryId: f.evidence?.queryId ?? '',
      params: (f.evidence?.params ?? {}) as Record<string, unknown>,
      values: (f.evidence?.values ?? {}) as Record<string, unknown>,
      basis: f.evidence?.basis ?? '',
      basisEs: extras.basisEs?.evidence ?? null,
    },
    asOf: f.asOf,
    weakestInputAgeDays: f.weakestInputAgeDays,
    firstSeenAt: f.firstSeenAt,
    lastSeenAt: f.lastSeenAt,
    occurrenceCount: f.occurrenceCount,
    action: extras.action ? toCardAction(extras.action) : null,
  };
  if (extras.signOff !== undefined) card.signOff = extras.signOff;
  if (extras.hotel !== undefined) card.hotel = extras.hotel;
  return card;
}
