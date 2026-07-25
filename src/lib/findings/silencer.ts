// ─── The silencer ────────────────────────────────────────────────────────────
//
// The rules that decide whether a re-found problem opens a card, refreshes one,
// stays quiet, or breaks back out of a silence the manager armed. Pure — no
// clock, no database — because these are exactly the rules that must be
// provable, and because the runner needs to apply them identically whether the
// row came back from Postgres or from a test fixture.
//
// The guarantee itself lives in the database (the partial unique index in
// migration 0360). This file decides what to DO once the database has told us
// whether a row already exists.

import type {
  DetectorDeclaration,
  DetectorParams,
  EscalationPolicy,
  FindingDraft,
  FindingStatus,
} from './types';

/** The slice of an existing findings row the decision depends on. */
export interface ExistingFinding {
  status: FindingStatus;
  magnitude: number;
  summary: string;
  /** The magnitude the manager consented to when they silenced it. */
  silencedAtMagnitude: number | null;
}

export type SilencerAction =
  /** No active row for this problem — insert one. */
  | { kind: 'open' }
  /** A live row exists — refresh it. `status` is what it becomes. */
  | { kind: 'update'; status: Extract<FindingStatus, 'open' | 'updated'> }
  /** Silenced. Refresh the evidence quietly; surface nothing. */
  | { kind: 'suppress'; reason: 'muted' | 'known_problem' }
  /** Silenced, but the problem outgrew the silence. Back on the screen. */
  | { kind: 'escalate' };

/**
 * The problem's identity in the ledger. Detector-prefixed so two detectors can
 * never land on the same slot, and never contains the measurement — "4 work
 * orders" and "9 work orders" on room 214 are the same problem.
 */
export function dedupeKeyFor(detectorId: string, draftKey: string): string {
  const key = `${detectorId}:${draftKey}`;
  if (key.length > 200) {
    // The column is CHECK-capped at 200. Truncating would silently merge two
    // different problems into one card, which is worse than failing loudly.
    throw new Error(
      `Dedupe key "${key}" exceeds 200 characters. Shorten the detector's draft keys — ` +
      'truncating here would merge two different problems into one card.',
    );
  }
  return key;
}

/**
 * Has this problem outgrown the silence the manager armed?
 *
 * BOTH conditions must hold. The factor catches proportional growth (4 → 9);
 * the absolute delta stops a large-magnitude problem from re-firing on noise.
 * Together they express the actual rule: four known work orders is consent to
 * four, not to nine, but four creeping to five is still the same problem.
 *
 * A silence with no recorded consent point never escalates — the store always
 * records one when a manager silences a finding, so a null here means the row
 * was written by something that did not go through the store, and guessing
 * would mean re-nagging a manager who explicitly asked for quiet.
 */
export function shouldEscalate(
  policy: EscalationPolicy | null,
  silencedAtMagnitude: number | null,
  magnitude: number,
): boolean {
  if (!policy) return false;
  if (silencedAtMagnitude === null || !Number.isFinite(silencedAtMagnitude)) return false;
  if (!Number.isFinite(magnitude)) return false;
  return (
    magnitude >= silencedAtMagnitude * policy.factor &&
    magnitude - silencedAtMagnitude >= policy.minDelta
  );
}

/**
 * Did the evidence move enough that a manager looking at yesterday's card would
 * be seeing something out of date? That is what flips 'open' to 'updated'.
 */
export function evidenceMoved(existing: ExistingFinding, draft: FindingDraft): boolean {
  return existing.magnitude !== draft.magnitude || existing.summary !== draft.summary;
}

/**
 * The whole transition table, in one place.
 *
 *   nothing there        → open
 *   muted                → suppress, always. Mute means gone.
 *   known_problem        → suppress, UNLESS the problem outgrew the consent
 *   open / updated       → update; becomes 'updated' when the evidence moved,
 *                          and stays 'updated' once it has (the manager has
 *                          still not seen the newer number)
 */
export function decideAction(
  existing: ExistingFinding | null,
  draft: FindingDraft,
  declaration: DetectorDeclaration<DetectorParams>,
): SilencerAction {
  if (!existing) return { kind: 'open' };

  switch (existing.status) {
    case 'muted':
      return { kind: 'suppress', reason: 'muted' };

    case 'known_problem':
      return shouldEscalate(declaration.escalation, existing.silencedAtMagnitude, draft.magnitude)
        ? { kind: 'escalate' }
        : { kind: 'suppress', reason: 'known_problem' };

    case 'open':
    case 'updated':
      return {
        kind: 'update',
        status: evidenceMoved(existing, draft) || existing.status === 'updated' ? 'updated' : 'open',
      };

    // 'resolved' and 'expired' sit outside the active unique index, so the
    // store never hands one back as the current row for a problem. Reaching
    // here means the query changed; treat it as a fresh sighting.
    default:
      return { kind: 'open' };
  }
}

/**
 * Enforce the declared cap. Deterministic: worst first, then alphabetical, so
 * the same night's data always truncates to the same set — a cap that shuffled
 * would make findings appear and vanish for no reason a manager could see.
 */
export function capDrafts(drafts: readonly FindingDraft[], maxPerRun: number): FindingDraft[] {
  return [...drafts]
    .sort((a, b) => (b.magnitude - a.magnitude) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, maxPerRun);
}

/** Drop drafts whose key repeats — a detector bug, not a reason to double-write. */
export function dedupeDrafts(drafts: readonly FindingDraft[]): FindingDraft[] {
  const seen = new Set<string>();
  const out: FindingDraft[] = [];
  for (const draft of drafts) {
    if (seen.has(draft.key)) continue;
    seen.add(draft.key);
    out.push(draft);
  }
  return out;
}
