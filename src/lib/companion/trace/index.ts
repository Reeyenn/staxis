// ═══════════════════════════════════════════════════════════════════════════
// One pattern, offered the way the companion offers everything else.
//
// This module is the join between the detectors and the manners engine, and it
// is deliberately thin: a trace becomes a `CompanionCandidate`, and from there
// the frequency cap, the one-voice rule, the decline memory, the peek pill and
// the severity dot all apply to it for free, because they apply to candidates.
//
// Nothing in here decides whether to speak. That is manners.ts's job and it
// stays there.
// ═══════════════════════════════════════════════════════════════════════════

import type { CompanionCandidate } from '../manners';
import type { TracePage, TracePattern } from './types';

export { tracePatternKey, isTraceTopic, TRACE_TOPIC_PREFIX } from './identity';
export { MIN_VISIBLE_ANCHORS, TRACE_MIN_VIEWPORT_WIDTH } from './types';
export type {
  TraceAnchor,
  TraceActionPlan,
  TraceCost,
  TraceFact,
  TracePage,
  TracePattern,
  TraceToolId,
} from './types';

/**
 * How many patterns travel to the browser.
 *
 * More than one even though at most one is ever shown, for the same reason
 * `buildCompanionCandidates` ships three: the first may be suppressed by a No
 * from last week or by the one-voice rule, and a list of one would turn either
 * of those into silence. Small, because each one carries its facts with it.
 */
export const MAX_TRACES = 3;

/** A pattern, in the shape the manners engine already understands. */
export function traceCandidate(pattern: TracePattern): CompanionCandidate {
  return {
    // The pattern key IS the topic. It is content-derived and survives
    // recomputation, so a No given today still holds tomorrow when the same
    // run has a fourth ticket on it. See identity.ts.
    topic: pattern.key,
    text: pattern.ask,
    sensitivity: pattern.sensitivity,
    covers: pattern.covers,
    destination: pattern.page,
    severity: pattern.severity,
  };
}

/**
 * The patterns worth carrying, worst first.
 *
 * Ranked across detectors by severity and then by each detector's own
 * magnitude. Magnitudes are NOT comparable between detectors (three work
 * orders and a 38% usage jump are not on one scale), which is why severity
 * leads: it is the one field every detector sets against the same three-level
 * definition the findings ledger already uses.
 */
export function rankTraces(patterns: readonly TracePattern[]): TracePattern[] {
  const rank = { urgent: 0, watch: 1, ok: 2 } as const;
  return [...patterns].sort((a, b) => {
    const bySeverity = rank[a.severity] - rank[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return b.magnitude - a.magnitude;
  });
}

/**
 * The patterns that belong to the screen somebody is standing on.
 *
 * A pattern with no page belongs to no screen and is never returned here. It
 * reaches a person only through the panel ask.
 */
export function tracesForPage(patterns: readonly TracePattern[], page: TracePage | null): TracePattern[] {
  if (!page) return [];
  return patterns.filter((p) => p.page === page);
}

/**
 * Is this pattern still true enough to draw?
 *
 * Called after a walk from another screen. The manager said yes on the Staxis
 * list, the router moved, and by the time the maintenance board finished
 * loading somebody may have closed two of the three tickets. Comparing the
 * pattern's anchors against the ids the freshly-loaded page actually produced
 * is the only honest way to find that out, and an honest sentence about it
 * beats a trace drawn to nothing.
 */
export function traceStillStands(
  pattern: TracePattern,
  freshKeys: ReadonlySet<string>,
): boolean {
  const wanted = pattern.anchors.filter((a) => a.present);
  if (wanted.length === 0) return true;
  return wanted.every((a) => freshKeys.has(a.domId));
}
