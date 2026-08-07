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
import { propertyLocalToday, startOfLocalDay } from '@/lib/schedule/local-date';
import { unfinishedRecallSentence } from './copy';
import { listFindings } from '@/lib/findings/store';
import { toQueueFinding } from '@/lib/findings/queue-projection';
import {
  cardPhrasing, isCardRenderable, rankFindings, type QueueFinding,
} from '@/components/concourse/finding-cards';
import { repliesFor, wakeDestination, type CompanionReplyKind } from './replies';
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
  /** Whose companion this is. Scopes the unfinished-business recall to the
   *  person who was actually asked. */
  accountId: string;
  /** The hotel's own calendar day. Never the browser's. */
  today: string;
  timezone: string | null;
}): Promise<CompanionCandidate[]> {
  // ── Unfinished business, before the findings gate ──
  //
  // ABOVE `listShowsFindings` on purpose. Every other candidate in this file is
  // a manager surface, and the reason line roles get none is cost: their
  // equivalent is an eight-way fan-out. This one is not that. It is one indexed
  // read of THIS person's hotel over a three-day window, and the question it
  // answers ("you asked me something and I never got back to you") belongs to
  // whoever was asked, not to whoever can see findings.
  const unfinished = await unfinishedCandidate(
    input.propertyId, input.accountId, input.today, input.timezone,
  );

  const standing = listStandingFor(input.role, input.hotelMutationAllowed);
  if (!listShowsFindings(standing)) return unfinished ? [unfinished] : [];

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
  const noticed = await noticedCandidate(input.propertyId, input.today, input.timezone);

  // ── The findings, with their own replies ──────────────────────────────────
  //
  // Ranked and CUT FIRST, then the plans are read for the three that survived.
  // The order matters for cost: `loadActionsForFindings` over twenty-five ids
  // on every page load would be the fan-out this file's header refuses, and
  // over three it is one indexed read on a table that is empty at most hotels.
  const top = rankFindings(cards).slice(0, MAX_CANDIDATES);
  const actions = await actionsFor(input.propertyId, top.map((f) => f.id));

  return [
    // A question this person was asked and never answered leads over
    // everything, because it is the only candidate that is about a
    // conversation the companion left open. Everything below is the companion
    // volunteering; this is it finishing something.
    ...(unfinished ? [unfinished] : []),
    // Something that happened in the last few hours, prepared by the event
    // sweep minutes after it happened. It leads the things the companion is
    // VOLUNTEERING, because it is the only one of them that is about now: a
    // finding is a pattern over days and will still be true this evening,
    // while "a room failed inspection twenty minutes ago" is worth a manager's
    // attention while there is still something to do about it.
    //
    // It gets NO privileges for being fresh. It is an ordinary candidate: the
    // daily speech budget, the forty-five minute gap, the one-voice rule, "not
    // the same topic twice in a day" and "twice turned down is forever" all
    // apply to it exactly as they apply to a finding. Being recent buys it a
    // place in the queue, never a way around the manners.
    ...(noticed ? [noticed] : []),
    // Work that slipped leads over the rest. It is the only candidate here
    // that is about a promise the hotel already made to itself and did not
    // keep, and it is the one a person can act on without leaving the screen
    // they are on: the rows are right there, three buttons each.
    ...(slipped ? [slipped] : []),
    // Lopsided history leads when it exists. It is rarer than a finding and it
    // is about the AI's own ability to learn: a hotel that fixes it gets every
    // future stock answer improved, and a hotel that never hears about it
    // wonders why the numbers never got smarter.
    ...(lopsided ? [lopsided] : []),
    ...top.map((f) => {
      const action = actions.get(f.id) ?? null;
      const replyKind = findingReplyKind(f, action);
      return {
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
        replyKind,
        // THE ROW ID, not the dedupe key. The topic is what a No attaches to and
        // must survive re-detection; a verdict is written against the row that
        // exists right now, and writing it against yesterday's row would be a
        // manager's decision landing on a card nobody is looking at.
        replies: repliesFor({ kind: replyKind, findingId: f.id, actionId: action }),
      };
    }),
  ].filter((c) => c.text.trim().length > 0).slice(0, MAX_CANDIDATES);
}

/**
 * The live plan id for each of these findings, or an empty map.
 *
 * Fails soft, and the softness is the point: a card whose plan could not be
 * read still offers every way of FILING it, and only loses the one button that
 * would have done the work. Refusing to speak at all because a second table was
 * slow would trade a whole sentence for a single button.
 */
async function actionsFor(
  propertyId: string,
  findingIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (findingIds.length === 0) return out;
  try {
    const { loadActionsForFindings } = await import('@/lib/findings/actions/store');
    const live = await loadActionsForFindings(propertyId, findingIds);
    for (const [findingId, action] of live) {
      // ONLY a standing offer. An action already executed, undone or superseded
      // is not something to offer to run: the card renders an undo for those,
      // and an undo is a decision to make on the card with the receipt in front
      // of you, not in one line in the corner of another screen.
      if (action.state === 'proposed') out.set(findingId, action.id);
    }
  } catch {
    // See above.
  }
  return out;
}

/**
 * Which vocabulary a card speaks, read off the card itself.
 *
 * The two facts that decide it are the ones the screen uses: the DETECTOR (a
 * dated upkeep job has different honest answers from a pattern) and the
 * EFFECTIVE disposition (`toQueueFinding` has already applied the judge's
 * verdict and the clamp). Nothing here re-decides either.
 *
 * `preventive_due` is named because it is the one detector with its own closure
 * set in DETECTOR_CLOSURE_SETS, and this stays a two-line branch for the same
 * reason that table stays a one-entry table: a detector earns an entry when its
 * card is about a different KIND of thing, not when somebody wants nicer words.
 */
function findingReplyKind(
  f: Pick<QueueFinding, 'detectorId' | 'disposition'>,
  actionId: string | null,
): CompanionReplyKind {
  if (f.detectorId === PREVENTIVE_DETECTOR_ID) {
    if (f.disposition === 'propose') return 'finding_propose_preventive';
    if (f.disposition === 'recommend') return 'finding_recommend_preventive';
  }
  if (f.disposition === 'propose') {
    return actionId ? 'finding_propose_action' : 'finding_propose';
  }
  if (f.disposition === 'fyi') return 'finding_fyi';
  return 'finding_recommend';
}

/** The one detector whose card is about a dated job rather than a pattern. */
const PREVENTIVE_DETECTOR_ID = 'preventive_due';

// ─── Something that just happened ───────────────────────────────────────────
//
// How long a prepared note stays offerable. Four hours: past that it is not
// news, it is history, and the companion telling somebody at 6pm about a work
// order that opened before lunch is the thing the whole "wake on events" idea
// exists to avoid. A problem that is still real at 6pm will be a finding
// tonight, said by the machinery that is good at patterns.
const NOTICED_WINDOW_HOURS = 4;

/**
 * The freshest thing the event sweep prepared, if it is still fresh.
 *
 * ─── WHY THERE IS NO TABLE BEHIND THIS ─────────────────────────────────────
 *
 * The sweep's journal row IS the store. `agent_noticed` carries the sentence in
 * `metadata.say` and the topic in `metadata.topic`, so the record of "Staxis
 * noticed this" and the thing it might say about it are one row rather than two
 * that can disagree. This is the same shape `unfinishedCandidate` below already
 * uses against `agent_action_expired`.
 *
 * ─── WHAT KEEPS THIS FROM BECOMING A FIREHOSE ──────────────────────────────
 *
 * Nothing new, which is the point:
 *   1. ONE, EVER. Only the newest prepared note becomes a candidate, however
 *      many the sweep wrote this afternoon.
 *   2. FOUR HOURS. Older than that and it is not the news it was written as.
 *   3. THE ORDINARY LEDGER. The topic is the department, not the event, so a
 *      No attaches to the class of interruption rather than to one work order.
 *      It also spends the daily speech budget and honours the minimum gap.
 *   4. A ROW WITHOUT `say` IS NOT OFFERABLE. The sweep writes those when it
 *      decided something was worth remembering and not worth interrupting
 *      anybody about, and the absence of the field is what enforces it.
 *
 * HOTEL-WIDE, not person-scoped, and that is deliberate: unlike the unfinished
 * recall, this is not about a conversation with one person. It is a fact about
 * the building, and whoever opens the app first is the right person to hear it.
 *
 * Fails soft to null. A companion that cannot read its own record says nothing
 * about its own record.
 */
async function noticedCandidate(
  propertyId: string,
  today: string,
  timezone: string | null,
): Promise<CompanionCandidate | null> {
  try {
    const { readAgentJournal } = await import('@/lib/agent/journal');
    const since = new Date(Date.now() - NOTICED_WINDOW_HOURS * 3_600_000);
    // Never before the hotel's own day started. A note prepared at 11pm is not
    // offered to the person who opens the app at 1am: by the hotel's calendar
    // that is yesterday's news, and the daily budget it would spend is a new
    // day's.
    const dayStart = startOfLocalDay(today, timezone);
    const sinceIso = (since > dayStart ? since : dayStart).toISOString();

    const rows = await readAgentJournal(propertyId, {
      sinceIso,
      eventTypes: ['agent_noticed'],
      limit: 5,
    });
    // Newest first, and the newest OFFERABLE one, which is not the same thing.
    //
    // `agent_noticed` covers both halves of what the sweep decides: a note it
    // may bring up, and an observation it wrote down for itself. Only the first
    // carries `say`. Taking rows[0] blindly would mean an observation written at
    // 3pm silently swallowed a real note from 2pm, and the person would simply
    // never hear it. Rule 1 is still "one, ever" — it just means one of the ones
    // that can actually be said.
    const newest = rows.find((row) =>
      typeof row.metadata.say === 'string' && row.metadata.say.trim().length > 0);
    if (!newest) return null;

    const say = typeof newest.metadata.say === 'string' ? newest.metadata.say.trim() : '';
    const topic = typeof newest.metadata.topic === 'string' ? newest.metadata.topic : '';
    // Both come from the writer's own metadata. A row missing either is a row
    // from a shape this code does not know how to speak about, and guessing the
    // subject of a sentence is worse than not raising it.
    if (!say || !topic) return null;

    return {
      topic,
      text: say,
      // Operational by construction, and the construction is upstream: the
      // sweep only ever looks at event types about rooms, work and coverage
      // (INTERESTING_EVENT_TYPES), and role changes and account changes are
      // deliberately not among them. If that list ever grows a person-shaped
      // entry, this is the line that has to start reading the row rather than
      // asserting, and the charter test is what will catch it.
      sensitivity: 'operational',
      // Nothing on any screen is this sentence. The events are in the activity
      // log, which is not a screen anybody has open, so an empty `covers` is
      // the honest answer rather than an oversight.
      covers: [],
      // Where a person goes to do something about it, DERIVED FROM THE EVENT
      // rather than fixed at the one list. A manager told that a work order just
      // opened wants the maintenance board; sending them to the list of
      // everything and letting them find it is the routing hint standing in for
      // an answer, which is the whole bug the reply work is about.
      destination: wakeDestination(topic),
      severity: 'watch',
      replyKind: 'event_wake',
      replies: repliesFor({ kind: 'event_wake', topic }),
    };
  } catch {
    return null;
  }
}

// ─── Unfinished business ────────────────────────────────────────────────────
//
// How far back a forgotten question is still worth raising. Three days: past
// that, "you never got back to me on Thursday" is archaeology rather than a
// loose end, and the hotel has moved on from whatever the card was about.
const UNFINISHED_WINDOW_DAYS = 3;

/**
 * The one question the companion asked and never got an answer to.
 *
 * ─── WHAT KEEPS THIS FROM BECOMING NAGGING ─────────────────────────────────
 *
 * Four things, and none of them are new machinery:
 *   1. NOT TODAY. The read stops at the start of the hotel's own day, so a
 *      card that timed out this morning is not brought back this afternoon.
 *      "You did not answer me ten minutes ago" is not recall.
 *   2. ONE, EVER. Only the newest expired question becomes a candidate. A
 *      person who ignored four cards on Tuesday hears about one of them.
 *   3. THE ORDINARY LEDGER. The topic is keyed on the TOOL, so a No attaches
 *      to the subject rather than to one row: two Nos and the companion never
 *      raises that kind of question again, exactly like every other topic.
 *      It also spends the daily speech budget and honours the minimum gap.
 *   4. NO SECOND ASK. Saying yes hands the sentence back to the chat, which
 *      proposes the action and puts the SAME approval card up again. The
 *      companion still never acts without a yes.
 *
 * Fails soft to null. A companion that cannot read its own journal says
 * nothing about its journal.
 */
async function unfinishedCandidate(
  propertyId: string,
  accountId: string,
  today: string,
  timezone: string | null,
): Promise<CompanionCandidate | null> {
  try {
    const { readAgentJournal } = await import('@/lib/agent/journal');
    const { addDaysInTz, startOfLocalDay } = await import('@/lib/schedule/local-date');
    const dayStart = startOfLocalDay(today, timezone);
    const windowStart = startOfLocalDay(addDaysInTz(today, -UNFINISHED_WINDOW_DAYS), timezone);

    const rows = await readAgentJournal(propertyId, {
      sinceIso: windowStart.toISOString(),
      // The whole of rule 1 above, in one argument.
      untilIso: dayStart.toISOString(),
      eventTypes: ['agent_action_expired'],
      // THIS PERSON'S unanswered question, never the hotel's. "I asked you and
      // never heard back" said to somebody who was never asked is a false
      // sentence about a card they never saw, and the summary it would quote is
      // the copy off somebody else's approval card.
      actorAccountId: accountId,
      limit: 5,
    });
    // Newest first. Rule 2: take one.
    const newest = rows[0];
    if (!newest) return null;

    const topic = typeof newest.metadata.topic === 'string' ? newest.metadata.topic : '';
    const summary = typeof newest.metadata.summary === 'string' ? newest.metadata.summary : '';
    // Both come from the writer's own metadata. A row missing either is a row
    // from a shape this code does not know how to speak about, and guessing the
    // subject of a forgotten question is worse than not raising it.
    if (!topic || !summary) return null;

    const askedDay = propertyLocalToday(new Date(newest.occurredAt), timezone);
    const daysAgo = Math.max(1, Math.round(
      (startOfLocalDay(today, timezone).getTime() - startOfLocalDay(askedDay, timezone).getTime())
      / 86_400_000,
    ));

    return {
      topic,
      text: unfinishedRecallSentence({ summary, daysAgo }),
      // About a job, not about a person: the summary is the card's own copy for
      // a tool call, which is the same sentence the person was already shown.
      sensitivity: 'operational',
      // Nothing on any screen is this fact. The card it is about is long gone,
      // which is the entire reason this candidate exists, so an empty `covers`
      // is the honest answer rather than an oversight.
      covers: [],
      // No destination. A yes reopens the conversation instead of walking
      // somewhere, which is what `seed` is for.
      destination: null,
      seed: summary,
      severity: 'ok',
      replyKind: 'unfinished',
      replies: repliesFor({ kind: 'unfinished', seed: summary }),
    };
  } catch {
    return null;
  }
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
      // NO QUESTION, and that is the fix rather than an omission. "3 things
      // slipped past their day" asks nothing; the question that used to be
      // stapled under it was manufactured from the destination.
      replyKind: 'todo_slipped',
      replies: repliesFor({ kind: 'todo_slipped' }),
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
      replyKind: 'import_lopsided',
      replies: repliesFor({ kind: 'import_lopsided' }),
    };
  } catch {
    return null;
  }
}
