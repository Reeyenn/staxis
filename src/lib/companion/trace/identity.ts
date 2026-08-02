// ═══════════════════════════════════════════════════════════════════════════
// The identity of a pattern.
//
// A trace key is the handle a No attaches to. It is stored in
// `staxis_user_prefs.companion_memory` under `topics`, it survives page loads,
// hotel switches and re-detections, and once somebody has turned the same
// pattern down twice the companion never raises it again. So the key has to
// mean "this problem", not "this computation of this problem".
//
// ─── THE ONE RULE ──────────────────────────────────────────────────────────
// The key is derived from the SUBJECT and never from the MEASUREMENT. Same rule
// the findings ledger states for its dedupe keys, and for the same reason: if a
// fourth work order appearing on the run changed the key, tomorrow's trace
// would be a brand new topic with a clean decline count, and the No a manager
// gave today would quietly stop working.
//
//   'maintenance_run' + ['2-even', 'hvac']        → right
//   'maintenance_run' + ['2-even', 'hvac', '3']   → wrong, the count is in it
//
// ─── WHY IT IS HASHED ──────────────────────────────────────────────────────
// Three reasons, all of them practical:
//
//   • The memory column is capped at 8KB by a CHECK constraint and topic keys
//     are dropped on the way back out if they exceed 200 characters, which
//     would be a silent way for a No to stop working. A hash is 8 characters
//     whatever went into it.
//   • A subject part can be a person. `callout_weekday` is about one named
//     member of staff, and a preferences blob is not a place to write down who
//     a manager has been shown a pattern about. The hash carries the identity
//     without carrying the name.
//   • It makes the key opaque to the browser, which is where the decline is
//     posted from. Nothing about the pattern can be reconstructed from it.
//
// The trade is that changing how a subject is normalized resets everybody's
// declines for that detector. That is accepted, deliberately, and is the reason
// `normalizePart` below is boring on purpose.
// ═══════════════════════════════════════════════════════════════════════════

/** The prefix every trace topic carries, so callers can tell one at a glance. */
export const TRACE_TOPIC_PREFIX = 'trace:';

/**
 * FNV-1a, 32 bit, base36.
 *
 * Not a security primitive and not trying to be: this is a bucket label for a
 * preferences blob, and the only property it needs is that the same subject
 * lands on the same label every time in every runtime. Chosen over anything in
 * `node:crypto` because this module is imported by browser code as well, and a
 * shared identity scheme with two implementations is a bug waiting for a
 * quiet afternoon.
 */
export function traceHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // The FNV prime, 16777619, by shift-and-add so the whole thing stays in
    // 32-bit integer arithmetic rather than drifting into float territory.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

/**
 * One subject part, flattened to something a hash can be taken over.
 *
 * Lower-cased and stripped of everything but letters, digits and a separator,
 * so "Room 214", "room  214" and "ROOM-214" are one subject rather than three.
 */
export function normalizePart(part: string): string {
  return part
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * `trace:<detectorId>:<hash>` — the stable identity of one pattern.
 *
 * @param detectorId  Stays in the clear so a support question ("why does it
 *                    keep asking about maintenance") can be answered from the
 *                    stored blob without a lookup table.
 * @param subject     The parts that make this problem THIS problem. Order
 *                    matters and is the caller's business: a detector that
 *                    passes its parts in a different order next release has
 *                    changed the identity, which is the same as renaming it.
 */
export function tracePatternKey(detectorId: string, subject: readonly string[]): string {
  const flattened = subject.map(normalizePart).join('|');
  return `${TRACE_TOPIC_PREFIX}${detectorId}:${traceHash(`${detectorId}|${flattened}`)}`;
}

/** True for a companion topic that a trace produced. */
export function isTraceTopic(topic: string | null | undefined): boolean {
  return typeof topic === 'string' && topic.startsWith(TRACE_TOPIC_PREFIX);
}
