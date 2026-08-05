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
import {
  findLopsidedHistory,
  lopsidedTopic,
  LOPSIDED_MIN_MONTHS,
} from '@/lib/inventory-import/lopsided';
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

  const lopsided = await lopsidedCandidate(input.propertyId);
  const slipped = await slippedCandidate(input.propertyId);

  return [
    // Work that slipped leads over everything. It is the only candidate here
    // that is about a promise the hotel already made to itself and did not
    // keep, and it is the one a person can act on without leaving the screen
    // they are on: the rows are right there, three buttons each.
    ...(slipped ? [slipped] : []),
    // Lopsided history leads when it exists. It is rarer than a finding and it
    // is about the AI's own ability to learn: a hotel that fixes it gets every
    // future stock answer improved, and a hotel that never hears about it
    // wonders why the numbers never got smarter.
    ...(lopsided ? [lopsided] : []),
    ...rankFindings(cards)
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
    })),
  ].filter((c) => c.text.trim().length > 0).slice(0, MAX_CANDIDATES);
}

/**
 * "3 things slipped from yesterday."
 *
 * ONE indexed count, which is what makes it affordable here. The reason this
 * file builds no candidates for line roles is that `gatherWorklist` is an
 * eight-way fan-out plus a derived inspection queue, far too expensive to run
 * speculatively on every page load. This is not that: it is a single count over
 * one table on (property, status, due_at), and it is only reached by the same
 * audience that already pays for the findings read above.
 *
 * IT NEVER SAYS A NUMBER IT HAS NOT COUNTED, and it never rounds. "A few things
 * slipped" is the sentence that makes a person stop believing the rest of them.
 *
 * Fails soft to silence. A companion that cannot count says nothing about
 * counting; it does not guess, and it does not apologise on the screen.
 */
async function slippedCandidate(propertyId: string): Promise<CompanionCandidate | null> {
  try {
    const { supabaseAdmin } = await import('@/lib/supabase-admin');
    const { count, error } = await supabaseAdmin
      .from('comms_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', propertyId)
      .eq('status', 'open')
      .lt('due_at', new Date().toISOString());
    if (error || typeof count !== 'number' || count < 1) return null;
    return {
      // Stable across days, so a No means "stop telling me about slippage"
      // rather than "stop telling me about today's three". Somebody who does
      // not want to hear it does not want to hear it tomorrow either.
      topic: 'todo:slipped',
      text: count === 1
        ? 'One thing on the list slipped past its day. It is still there, marked late.'
        : `${count} things on the list slipped past their day. They are still there, marked late.`,
      // Work that is late is operational by construction. It is about jobs, not
      // about how any one person is doing: the count spans everybody's rows and
      // names nobody, which is the line that keeps it out of `people`.
      sensitivity: 'operational',
      // The rows themselves are on the list already. An empty `covers` would
      // claim nothing on screen is this fact, and the one-voice rule would then
      // let the companion say out loud what the screen is already showing.
      covers: ['staxis:slipped'],
      destination: 'staxis',
      severity: 'watch',
    };
  } catch {
    return null;
  }
}

/**
 * "I have your inventory from March to June, but no occupancy for those
 * months." One extra read, and only for hotels that have imported something.
 *
 * The first query is a single indexed count against a table that is empty for
 * every hotel that has never used the importer, which is what keeps this off
 * the critical path for everybody else. Fails soft to silence: a companion that
 * cannot check its own history says nothing about it.
 */
async function lopsidedCandidate(propertyId: string): Promise<CompanionCandidate | null> {
  try {
    const { importedInventoryMonths, occupancyMonthsHeld } = await import('@/lib/db/inventory-imports');
    const inventoryMonths = await importedInventoryMonths(propertyId);
    if (inventoryMonths.length < LOPSIDED_MIN_MONTHS) return null;

    const occupancyMonths = await occupancyMonthsHeld(propertyId, inventoryMonths[0]);
    const lopsided = findLopsidedHistory({ inventoryMonths, occupancyMonths });
    if (!lopsided) return null;

    return {
      topic: lopsidedTopic(lopsided.side),
      text: lopsided.text,
      sensitivity: 'operational',
      // Nothing on any screen is this fact, so there is nothing to stay quiet
      // about. An empty `covers` is the honest answer, not an oversight.
      covers: [],
      destination: 'inventory',
      severity: 'ok',
    };
  } catch {
    return null;
  }
}
