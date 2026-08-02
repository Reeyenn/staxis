// ═══════════════════════════════════════════════════════════════════════════
// The one thing the companion might say, sourced from work already done.
//
// ONE DATABASE QUERY. Everything after it is pure. That is not a performance
// nicety, it is the design: this runs on every authenticated page load, and a
// companion that fanned out ten reads to work out whether to say hello would be
// a tax on every screen in the app.
//
// AND NO MODEL CALL. The sentence a candidate carries was written by the
// nightly judge (or by the detector that found the thing), stored in a column,
// and is read back verbatim by `cardPhrasing`. Nothing is phrased now.
//
// ─── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
//
// It does not call GET /api/findings. That route WRITES: it records shown_count
// for the cards it returns, which feeds detector self-demotion. A companion
// polling it would demote detectors for cards nobody laid eyes on, and the
// symptom would be the hotel's own findings quietly getting worse. The route
// next door, /api/findings/badge, exists for exactly this reason.
//
// It does not build candidates for line roles. The cheap read below is the
// findings list, and findings are a manager surface (listShowsFindings). The
// line-role equivalent is `gatherWorklist`, which is an eight-way fan-out plus a
// derived inspection queue: too expensive to run speculatively on every page
// load for a maybe. So a front desk or maintenance hat gets a companion that
// greets, tours, explains screens and answers anything, and does not volunteer.
// That is a smaller promise honestly kept rather than a bigger one paid for on
// every navigation. When the Staxis list's own payload becomes shareable, this
// is where the line-role branch goes.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';
import type { AppRole } from '@/lib/roles';
import { listFindings } from '@/lib/findings/store';
import { toQueueFinding } from '@/lib/findings/queue-projection';
import { cardPhrasing, isCardRenderable, rankFindings } from '@/components/concourse/finding-cards';
import { listShowsFindings, listStandingFor } from '@/lib/feed/list-access';
import type { CompanionCandidate, CompanionSeverity } from './manners';

/**
 * The three levels findings already carry, in the companion's own words.
 *
 * Straight mapping, no re-judging: the severity a finding was stored with is
 * the severity the peek's dot shows. Inventing a second opinion here would mean
 * the same fact reading as urgent in the corner and as routine on the list.
 */
const SEVERITY_FROM_FINDING: Record<string, CompanionSeverity> = {
  critical: 'urgent',
  attention: 'watch',
  info: 'ok',
};

/** How deep to look. The ranker only ever hands back a first place. */
const SCAN_LIMIT = 25;

/**
 * How many candidates to return.
 *
 * More than one, even though the companion says at most one thing: the FIRST
 * candidate may be suppressed by the one-voice rule (it is already on the
 * screen) or by a No this person gave it last week, and a list of one would
 * turn either of those into silence. Three is enough to survive both without
 * shipping the whole queue to the browser.
 */
const MAX_CANDIDATES = 3;

export async function buildCompanionCandidates(input: {
  propertyId: string;
  role: AppRole;
  hotelMutationAllowed: boolean;
}): Promise<CompanionCandidate[]> {
  const standing = listStandingFor(input.role, input.hotelMutationAllowed);
  if (!listShowsFindings(standing)) return [];

  let rows;
  try {
    rows = await listFindings(input.propertyId, {
      statuses: ['open', 'updated'],
      limit: SCAN_LIMIT,
    });
  } catch {
    // Never throws upward. A companion with nothing to say is the correct
    // degraded state; a page that fails to load because the greeter could not
    // think of a topic is not.
    return [];
  }

  const cards = rows
    .map((f) => toQueueFinding(f))
    .filter((f) => isCardRenderable(f));

  return rankFindings(cards)
    .slice(0, MAX_CANDIDATES)
    .map((f) => ({
      // The DEDUPE KEY, not the row id. The same problem re-detected tomorrow
      // gets a new row, and a No that expired overnight is not a No. The dedupe
      // key is stable across re-detections of the same thing, which is exactly
      // the grain "do not bring this up again" is about.
      topic: `finding:${f.dedupeKey}`,
      text: cardPhrasing(f, 'en'),
      // Findings are operational by construction: they are about rooms, stock,
      // equipment and money owed. Nothing in the detector registry produces a
      // finding about how one person is performing. If that ever changes, this
      // is the line that has to start reading the detector rather than
      // asserting, and the charter test is what will catch it.
      sensitivity: 'operational' as const,
      covers: [`finding:${f.id}`],
      destination: 'staxis' as const,
      severity: SEVERITY_FROM_FINDING[f.severity] ?? ('watch' as const),
    }))
    .filter((c) => c.text.trim().length > 0);
}
