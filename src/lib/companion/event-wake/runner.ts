// ═══════════════════════════════════════════════════════════════════════════
// One sweep: every hotel, one cheap look each, a model call only where
// something actually happened.
//
// ─── THE ORDER OF THE GATES IS THE WHOLE COST STORY ────────────────────────
//
// Each one is cheaper than the one below it, and each one can stop the sweep
// dead. A quiet hotel reaches exactly one database read and nothing else.
//
//   1. switched off?      one cached config read, shared across every hotel
//   2. demo hotel?        a column already in the discovery query
//   3. cursor?            one indexed read, one row
//   4. sections?          one cached read of this hotel's own switches
//   5. anything happen?   ONE indexed range read over activity_log
//   6. woken enough?      free, a column on the row already in hand
//   7. spend left?        one RPC under an advisory lock
//   8. THE MODEL          the only line that costs anything
//
// ─── THE ONE PROMISE THIS FILE MAKES ───────────────────────────────────────
//
// It never acts on the hotel and it never tells anybody anything. It PREPARES.
// A prepared note is a row in the companion's own record with a sentence in it;
// whether that sentence is ever said is decided somewhere else entirely, by
// manners.ts, against the same daily budget, the same forty-five minute gap,
// the same declines and the same one-voice rule as every other thing the
// companion might volunteer. There is no path from here to a screen that does
// not go through those rules.
//
// ─── AND WHAT IT WRITES WHEN IT HAS NOTHING ────────────────────────────────
//
// Nothing. A sweep that looked and found nothing worth saying leaves no row.
// The counters go to the log line and the heartbeat, which is where an operator
// looks; the hotel's own timeline is not an operator surface, and filling it
// with "Staxis looked and there was nothing" a hundred and forty-four times a
// day would make the fourteen rows that matter unfindable.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { runWithConcurrency } from '@/lib/parallel';
import { propertyLocalToday } from '@/lib/schedule/local-date';
import { resolveAiFeatureConfig } from '@/lib/ai/model-config-store';
import { getEnabledSectionsFresh } from '@/lib/sections/server';
import { isSectionEnabled } from '@/lib/sections/registry';
import {
  AGENT_JOURNAL_SOURCE,
  journalNoticedLine,
  journalObservedLine,
  readAgentJournal,
  recordAgentJournalEntry,
} from '@/lib/agent/journal';
import type { MessagesClient } from '@/lib/agent/llm';

import {
  INTERESTING_EVENT_TYPES,
  MAX_EVENTS_PER_WAKE,
  decideWake,
  disabledEventCategories,
  keepEnabledSections,
  wakeTopicFor,
  wakeWindow,
  type WakeEventRow,
  type WakeRefusal,
} from './events';
import { askWhatToPrepare, type WakeDecision } from './notice';
import { claimWakeWindow, readWakeState, recordWake } from './state';

/**
 * How many hotels are swept at once.
 *
 * The same ceiling the findings fleet pass uses, and for the same reason: one
 * hotel's slow read must not serialise the fleet, and the fleet must not open
 * fifty connections at once. Almost every hotel in a sweep does one read and
 * stops, so this is rarely the binding constraint.
 */
export const SWEEP_CONCURRENCY = 10;

/** How many open findings the model is shown as "already known". Enough to
 *  recognise a duplicate, few enough that the prompt stays small. */
const ALREADY_KNOWN_LIMIT = 6;

/** How many of today's journal lines the model is shown. */
const JOURNAL_LIMIT = 6;

export interface PropertySweepResult {
  propertyId: string;
  /** How many interesting rows the window held. */
  events: number;
  /** What happened, in one word an operator can count. */
  outcome: 'prepared' | 'observed' | 'nothing' | WakeRefusal;
  costUsd: number;
  /** True when the window had to be shortened because the sweep had not run in
   *  hours. A fact about the schedule, not about the hotel. */
  windowClamped: boolean;
}

export interface SweepOptions {
  now?: Date;
  /** Scripted model. Production never passes it; tests always do. */
  modelClient?: MessagesClient;
  /** Run only this hotel. An operator naming one hotel is intent, so this path
   *  skips the demo filter exactly as the management-patterns route does. */
  propertyId?: string;
  concurrency?: number;
}

// ─── One hotel ──────────────────────────────────────────────────────────────

interface PropertyRow {
  id: string;
  timezone: string | null;
}

/**
 * Look once at one hotel. Never throws.
 *
 * ─── TWO WAYS TO STOP, AND THE DIFFERENCE IS A CONTRACT ────────────────────
 *
 * Every early return here is one of exactly two things, and which one it is
 * decides whether the cursor moves:
 *
 *   I LOOKED, AND THERE IS NOTHING HERE      → the cursor ADVANCES.
 *     Nothing interesting landed; the hotel has woken enough today; the hotel
 *     switched off the surface a note would arrive on. In all three the window
 *     has been considered and found to hold nothing deliverable, which is the
 *     definition of `last_looked_at`.
 *
 *   I COULD NOT LOOK                         → the cursor STAYS PUT.
 *     The cursor itself was unreadable, the hotel's switches did not answer,
 *     the event read failed. Nothing was considered, so claiming the window
 *     would silently discard events nobody ever read.
 *
 * THIS DISTINCTION IS WHAT THE DOCTOR READS. `companion_event_wake_health`
 * warns when a cursor has not moved in thirty minutes, and that warning is only
 * meaningful if a stale cursor means "nobody is looking" rather than "this
 * hotel is skipped on purpose".
 *
 * IT WAS WRONG IN PRODUCTION AND THIS IS THE FIX. The Staxis-list gate below
 * used to return without claiming, so a hotel that had switched that list off
 * was skipped forever with a frozen cursor, and the doctor reported it stale
 * for the rest of time. One real hotel (Home2) sat at looks_total = 0 while its
 * six siblings advanced normally. A skipped hotel is not an unwatched hotel.
 *
 * Never throws: every failure inside becomes an `outcome` the caller can count.
 * A sweep of thirteen hotels must not end because one of them has a bad row.
 */
export async function sweepProperty(
  property: PropertyRow,
  opts: SweepOptions = {},
): Promise<PropertySweepResult> {
  const now = opts.now ?? new Date();
  const propertyId = property.id;
  const nothing = (outcome: PropertySweepResult['outcome'], events = 0, clamped = false)
    : PropertySweepResult => ({ propertyId, events, outcome, costUsd: 0, windowClamped: clamped });

  // ── 3. the cursor ──
  const stateRead = await readWakeState(propertyId, now);
  if (!stateRead.ok) return nothing('no_cursor');
  const state = stateRead.state;
  // A hotel seen for the first time has a cursor and no history. The window a
  // fresh cursor would define opens at the beginning of time, and "every work
  // order this hotel has ever had" is not something that just happened. Its
  // cursor was just set to now by the seed, so it is not stale and there is
  // nothing to advance.
  if (stateRead.seeded) return nothing('quiet');

  const window = wakeWindow(state.lastLookedAt, now);

  /**
   * Advance the cursor past the window we have now finished considering.
   *
   * ONE DEFINITION, EVERY CALLER. The arguments are the whole of the
   * compare-and-set, and two call sites that assembled them separately could
   * drift into claiming a window they did not read. Returns false when another
   * sweep got there first.
   */
  const claim = () => claimWakeWindow({
    propertyId,
    priorLastLookedAt: state.lastLookedAt,
    priorLooksTotal: state.looksTotal,
    untilIso: window.untilIso,
    now,
  });

  // ── 4. this hotel's own switches ──
  let sectionFlags;
  try {
    sectionFlags = await getEnabledSectionsFresh(propertyId);
  } catch (e) {
    // COULD NOT LOOK. Fails closed, the same direction `requireSectionEnabled`
    // fails: a switch we cannot read is a switch we must not act against, and a
    // window we never considered is a window we must not claim.
    log.warn('[companion/event-wake] section switches unreadable; this hotel sits this sweep out', {
      propertyId,
      err: e instanceof Error ? e.message : String(e),
    });
    return nothing('read_failed');
  }

  // The note's home is the Staxis list. A hotel that switched that off has said
  // it does not use the surface the note would arrive on, so there is nothing
  // deliverable in this window no matter what landed in it.
  //
  // LOOKED. The cursor advances, because "I considered this window and found
  // nothing I could deliver" is exactly what the cursor records. It is also
  // strictly CHEAPER than a quiet hotel, which reads the events as well: this
  // path is one state read, one switch read, one write, and no model call ever.
  if (!isSectionEnabled(sectionFlags, 'staxis')) {
    return (await claim())
      ? nothing('list_switched_off', 0, window.clamped)
      : nothing('window_already_claimed', 0, window.clamped);
  }

  // ── 5. did anything happen ──
  let rows: WakeEventRow[];
  try {
    rows = await readWindowEvents(
      propertyId,
      window.sinceIso,
      window.untilIso,
      // The hotel's switched-off departments, applied by the QUERY so the row
      // limit is not spent on rows the next line is going to drop anyway.
      disabledEventCategories(sectionFlags),
    );
  } catch (e) {
    // COULD NOT LOOK. The cursor deliberately stays where it is: claiming a
    // window whose events never came back would discard them silently, and a
    // persistently failing read SHOULD go stale so the doctor says so.
    log.warn('[companion/event-wake] event read failed; this hotel sits this sweep out', {
      propertyId,
      err: e instanceof Error ? e.message : String(e),
    });
    return nothing('read_failed');
  }

  // ── THE HOTEL'S OWN DAY, DERIVED ONCE ──────────────────────────────────
  //
  // Everything downstream that needs a calendar day uses THIS value: the wake
  // counter's reset check, the counter's own write, and the journal read. It
  // used to be computed twice from the same inputs, which was harmless right up
  // until somebody derived one of them differently.
  //
  // AND IT IS THE HOTEL'S, NEVER THE DATABASE'S. A day rendered by Postgres
  // comes out in the SESSION's timezone, which is a fact about the connection
  // rather than about the hotel. That is not a hypothetical: the test harness
  // runs PGlite at a fixed `Etc/GMT+6`, while a hotel on `America/Chicago` is at
  // UTC-5 for half the year, so the two disagree for one hour of every summer
  // day. `propertyLocalToday` is the only thing that knows which day it is for
  // the people who work here.
  const today = propertyLocalToday(now, property.timezone);

  const verdict = decideWake({
    rows: keepEnabledSections(rows, sectionFlags),
    // A stored day that is not today means the counter belongs to a day that
    // has ended, so it starts again at zero.
    wakesToday: state.wakesDay === today ? state.wakesToday : 0,
  });

  // ── LOOKED. CLAIM THE WINDOW, whatever the verdict was ──
  //
  // Always, and BEFORE anything expensive. A quiet hotel whose cursor never
  // moved would re-read a widening window every ten minutes until the clamp
  // caught it; a busy hotel whose cursor moved only after the model call could
  // pay twice for the same events if two sweeps overlapped.
  if (!(await claim())) return nothing('window_already_claimed', 0, window.clamped);

  if (!verdict.wake) return nothing(verdict.refusal, verdict.events, window.clamped);

  // ── 6/7/8. the only expensive part ──
  await recordWake({
    propertyId,
    wakesDayNow: today,
    priorWakesDay: state.wakesDay,
    priorWakesToday: state.wakesToday,
    priorWakesTotal: state.wakesTotal,
    now,
  });

  const [alreadyKnown, journalLines] = await Promise.all([
    readOpenFindingSummaries(propertyId),
    readTodaysJournalLines(propertyId, today, property.timezone),
  ]);

  const call = await askWhatToPrepare({
    propertyId,
    events: verdict.events,
    alreadyKnown,
    journalLines,
    now,
    modelClient: opts.modelClient,
  });

  if (!call.ok) {
    return {
      propertyId,
      events: verdict.events.length,
      outcome: call.reason,
      costUsd: call.costUsd,
      windowClamped: window.clamped,
    };
  }

  const outcome = await preserve({
    propertyId,
    decision: call.decision,
    events: verdict.events,
    now,
  });

  return {
    propertyId,
    events: verdict.events.length,
    outcome,
    costUsd: call.costUsd,
    windowClamped: window.clamped,
  };
}

/**
 * Write down what the call decided, if anything.
 *
 * THE JOURNAL ROW IS ALSO THE STORE. A `note` is one `agent_noticed` row whose
 * metadata carries the sentence and the topic, and `buildCompanionCandidates`
 * reads exactly that back. There is no second table, because the record of the
 * observation and the thing that might be said about it are one fact, and two
 * rows for one fact is how they end up disagreeing.
 */
async function preserve(input: {
  propertyId: string;
  decision: WakeDecision;
  events: readonly WakeEventRow[];
  now: Date;
}): Promise<'prepared' | 'observed' | 'nothing'> {
  if (input.decision.kind === 'nothing') return 'nothing';

  const prepared = input.decision.kind === 'note';
  await recordAgentJournalEntry({
    propertyId: input.propertyId,
    eventType: 'agent_noticed',
    description: prepared
      ? journalNoticedLine({ summary: input.decision.say })
      : journalObservedLine({ summary: input.decision.say }),
    // No actor. Nobody asked for this and nobody has been told yet, so filling
    // in a person would put a name on the by-actor filter for something that
    // person had no part in.
    actorAccountId: null,
    targetType: 'companion_note',
    targetLabel: null,
    // THE SWEEP'S OWN `now`, not a fresh clock, and that is a third independent
    // guard against self-excitation on top of the source filter and the event
    // type list. The cursor was just advanced to exactly this instant, and the
    // window read is `occurred_at > cursor`, so a row stamped here can never
    // fall inside the next window even if both other guards were removed.
    occurredAt: input.now,
    metadata: {
      // Present ONLY on a note. Its presence is what makes the row offerable,
      // so an observation cannot become an interruption by accident.
      ...(prepared ? { say: input.decision.say, topic: wakeTopicFor(input.events) } : {}),
      why: input.decision.why,
      eventCount: input.events.length,
      eventTypes: [...new Set(input.events.map((event) => event.eventType))],
    },
  });
  return prepared ? 'prepared' : 'observed';
}

// ─── The reads ──────────────────────────────────────────────────────────────

/**
 * The one query the whole feature turns on.
 *
 * `(property_id, occurred_at desc)` is `activity_log_property_time_idx` from
 * 0228, so the range is a ten-minute slice of one hotel and the event-type
 * filter runs over what that slice returns rather than over the table.
 *
 * The `source` filter is the SELF-EXCITATION guard, in the query. Without it
 * the companion's own journal rows land inside the next window, pass the gate,
 * and buy a model call about its own last model call. `keepInterestingEvents`
 * applies the same rule again in memory, because a loop that spends money is
 * not a place for one control.
 *
 * ─── WHY IT READS NEWEST FIRST AND HANDS BACK OLDEST FIRST ─────────────────
 *
 * The LIMIT has to fall on the rows that matter least, and for a feature whose
 * whole claim is "this just happened" that is the OLDEST ones. Read ascending,
 * a burst of more than MAX_EVENTS_PER_WAKE failures threw away the newest rows
 * and prepared a note about the beginning of the burst. So the read is
 * descending and the answer is reversed: the gate, the prompt and the topic all
 * still see one window in the order it happened.
 *
 * `excludeCategories` is the hotel's own switched-off departments. See
 * `disabledEventCategories`: applied here so the limit is not spent on rows
 * `keepEnabledSections` was always going to drop. Expressed as a chain of
 * `neq` rather than a `not.in` list because every filter in this file has to
 * mean the same thing to PostgREST and to the test harness's shim.
 */
async function readWindowEvents(
  propertyId: string,
  sinceIso: string,
  untilIso: string,
  excludeCategories: readonly string[] = [],
): Promise<WakeEventRow[]> {
  let query = supabaseAdmin
    .from('activity_log')
    .select('occurred_at, event_category, event_type, source, description, target_type, target_label, metadata')
    .eq('property_id', propertyId)
    .gt('occurred_at', sinceIso)
    .lte('occurred_at', untilIso)
    .neq('source', AGENT_JOURNAL_SOURCE)
    .in('event_type', [...INTERESTING_EVENT_TYPES]);
  for (const category of excludeCategories) query = query.neq('event_category', category);

  const { data, error } = await query
    .order('occurred_at', { ascending: false })
    .limit(MAX_EVENTS_PER_WAKE);
  if (error) throw new Error(`activity window read failed: ${error.message}`);

  return ((data ?? []) as Array<Record<string, unknown>>).reverse().map((row) => ({
    occurredAt: typeof row.occurred_at === 'string' ? row.occurred_at : '',
    eventCategory: typeof row.event_category === 'string' ? row.event_category : '',
    eventType: typeof row.event_type === 'string' ? row.event_type : '',
    source: typeof row.source === 'string' ? row.source : '',
    description: typeof row.description === 'string' ? row.description : '',
    targetType: typeof row.target_type === 'string' ? row.target_type : null,
    targetLabel: typeof row.target_label === 'string' ? row.target_label : null,
    metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {},
  })).filter((row) => row.occurredAt !== '' && row.eventType !== '');
}

/** What the companion can already say. Degrades to nothing: a model that is
 *  not shown the open list writes a duplicate at worst, and a sweep that
 *  refused to run because a list read hiccuped is worse than a duplicate. */
async function readOpenFindingSummaries(propertyId: string): Promise<string[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('findings')
      .select('summary')
      .eq('property_id', propertyId)
      .in('status', ['open', 'updated'])
      // Biggest first. `severity` is a text column whose alphabetical order
      // ('attention' before 'critical') is not its severity order, so sorting
      // on it would put the wrong six in front of the model.
      .order('magnitude', { ascending: false })
      .limit(ALREADY_KNOWN_LIMIT);
    if (error) return [];
    return ((data ?? []) as Array<{ summary?: unknown }>)
      .map((row) => (typeof row.summary === 'string' ? row.summary : ''))
      .filter((summary) => summary.length > 0);
  } catch {
    return [];
  }
}

/** What the companion has already done and said today. Same degradation. */
async function readTodaysJournalLines(
  propertyId: string,
  today: string,
  timezone: string | null,
): Promise<string[]> {
  try {
    const { startOfLocalDay } = await import('@/lib/schedule/local-date');
    const rows = await readAgentJournal(propertyId, {
      sinceIso: startOfLocalDay(today, timezone).toISOString(),
      limit: JOURNAL_LIMIT,
    });
    return rows.map((row) => row.description);
  } catch {
    return [];
  }
}

// ─── The fleet ──────────────────────────────────────────────────────────────

export interface SweepSummary {
  propertiesConsidered: number;
  propertiesSwept: number;
  results: PropertySweepResult[];
  /** Set when the whole sweep was vetoed before any hotel was read. */
  switchedOff: boolean;
}

/**
 * Every hotel, once.
 *
 * DEMO HOTELS SIT OUT THE SCHEDULED PASS. `properties.is_test` is the tag the
 * rest of the product already treats as "not a customer" (see
 * src/lib/company/demo-portfolio.ts, which reaches the same verdict about a
 * company by asking about its hotels). A seeded demo hotel waking a model
 * fourteen times a day is real money spent on an audience of nobody, and rows
 * that later read like a customer's history.
 *
 * An explicitly named `propertyId` is an operator's deliberate act and runs
 * whatever it is told, demo or not. Three ways in, two answers, exactly like
 * the management-patterns route.
 */
export async function sweepAllProperties(opts: SweepOptions = {}): Promise<SweepSummary> {
  // ── 1. the switch, once for the whole fleet ──
  //
  // The AI Control Center's own per-feature enable, which is the switch a
  // founder actually has for this. There is no AI EMPLOYEE switch to consult
  // because no employee on the roster owns this feature yet
  // (src/lib/ai/employee-registry.ts); the day one does, its
  // `isEmployeeSwitchedOff` check belongs on this line beside the config read,
  // not instead of it.
  //
  // Checked HERE rather than left to `runAgent` to discover: the runtime does
  // throw `AiFeatureDisabledError` when the plan resolves, but by then a spend
  // hold has been taken and released and an error has been captured, once per
  // hotel per ten minutes, forever.
  if (await featureIsSwitchedOff()) {
    return { propertiesConsidered: 0, propertiesSwept: 0, results: [], switchedOff: true };
  }

  const properties = await discoverProperties(opts.propertyId);
  const outcomes = await runWithConcurrency(
    properties,
    (property) => sweepProperty(property, opts),
    Math.max(1, Math.min(opts.concurrency ?? SWEEP_CONCURRENCY, SWEEP_CONCURRENCY)),
  );

  const results = outcomes.map((outcome) =>
    outcome.ok
      ? outcome.value
      : ({
        propertyId: outcome.input.id,
        events: 0,
        // A hotel whose whole sweep threw is not "quiet". `sweepProperty`
        // catches everything it knows about, so reaching here means something
        // unanticipated, and it is filed as the failure it is.
        outcome: 'read_failed' as const,
        costUsd: 0,
        windowClamped: false,
      } satisfies PropertySweepResult),
  );

  return {
    propertiesConsidered: properties.length,
    propertiesSwept: results.length,
    results,
    switchedOff: false,
  };
}

/**
 * Is this feature switched off in the AI Control Center?
 *
 * FAILS OPEN, on purpose and in the same direction the employee-switch reader
 * does: an unreadable config is not a decision, and a watcher that stopped
 * itself on a transient read error would be a kill switch that can fire itself.
 * The failure is self-limiting, because a database that cannot answer this also
 * cannot answer the cursor read one gate later.
 */
async function featureIsSwitchedOff(): Promise<boolean> {
  try {
    const config = await resolveAiFeatureConfig('companion.event_wake');
    return config.enabled !== true;
  } catch (e) {
    log.warn('[companion/event-wake] could not read the feature switch; carrying on', {
      err: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

async function discoverProperties(only?: string): Promise<PropertyRow[]> {
  let query = supabaseAdmin
    .from('properties')
    .select('id, timezone, is_test')
    .order('id', { ascending: true })
    .limit(5000);
  if (only) query = query.eq('id', only);
  const { data, error } = await query;
  if (error) throw new Error(`event-wake property scan failed: ${error.message}`);

  const rows = (data ?? []) as Array<{ id: string; timezone: string | null; is_test: boolean | null }>;
  return rows
    .filter((row) => (only ? true : row.is_test !== true))
    .map((row) => ({ id: row.id, timezone: row.timezone }));
}
