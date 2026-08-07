// ═══════════════════════════════════════════════════════════════════════════
// THE GATE. What counts as something happening, and whether it is worth waking
// for.
//
// PURE. No clock of its own, no database, no fetch, and above all NO MODEL
// CALL. That is the entire economic argument for this feature: a companion that
// asked a model whether anything had happened would cost money on every quiet
// hotel every ten minutes, forever. The question "did anything happen" is a
// filtered count, so it is answered by a filtered count, and the model is only
// ever consulted about events that already passed a test written in code.
//
// ─── WHY activity_log AND NOTHING ELSE ─────────────────────────────────────
//
// Eleven source tables already mirror themselves into `activity_log` through
// triggers that fire atomically with the insert they describe (migration 0228).
// Housekeeping, maintenance, room status, inspections, callouts, breaks, staff
// and accounts all land in one place, with a pre-rendered English sentence and
// a jsonb payload, on one index: (property_id, occurred_at). A watcher that
// polled eleven tables would be eleven times the cost for strictly less
// information, and it would miss the twelfth source the day somebody adds one.
//
// ─── THE INTERESTING SET, AND WHY IT IS SHORT ──────────────────────────────
//
// Every value below is a string one of those triggers ACTUALLY WRITES. They
// were read out of the migrations rather than guessed, because an event type
// that no trigger produces is a watcher that never fires and looks like a
// watcher that works.
//
// The test applied to each candidate was one question: WOULD A MANAGER WANT TO
// BE TOLD THIS HAPPENED? Not "is this data" — all of it is data. A hotel writes
// hundreds of activity rows a day and almost all of them are the building
// working correctly: rooms cleaned, tasks assigned, breaks taken, work orders
// closed. Waking on those is how a companion becomes something people turn off.
//
// So the set is the things that went WRONG or that newly need somebody:
// something broke, something failed inspection, a clean was thrown out,
// somebody called out.
//
// EVERY ONE OF THEM IS PROVED against a real trigger-written row in
// companion-event-wake.integration.test.ts, which drives the source tables and
// reads back what Postgres actually composed. That test is not decoration: it
// is what caught `cleaning_paused_room` below.
//
// ─── WHAT IS DELIBERATELY EXCLUDED, WITH REASONS ───────────────────────────
//
//   room_status_changed        The hottest event type in the table. 0202's own
//                              volume note puts it at up to 5M rows a month per
//                              hotel at maximum churn, and every single one of
//                              them is the PMS saying a room changed state,
//                              which is the building working. The anomaly
//                              inside it that would be worth hearing about, a
//                              room going out of order, already arrives here on
//                              a cheaper indexed path: it opens a work order,
//                              and `work_order_created` carries `out_of_order`
//                              in its metadata.
//   cleaning_task_*  (normal)  created / in_progress / completed / ready_now /
//                              inspection_pending are the housekeeping day
//                              happening. Only the two failure states are in.
//   inspection_pass,           Good news is not news. A companion that
//   cleaning_completed,        announced every passed inspection would spend
//   work_order_resolved,       its whole speech budget on congratulations.
//   work_order_closed
//   break_started/ended,       Staff mechanics. Nobody wants an interruption
//   assignment_created,        because a housekeeper took their break.
//   assignment_deactivated
//   role_changed, user_created Access changes are audited, not narrated. They
//                              are also somebody's HR business, and the
//                              companion's shoulder-safe rule keeps it out of
//                              exactly this class of thing.
//   callout_reverted           Somebody un-called-out. That is a problem
//                              GOING AWAY.
//   cleaning_paused_room       A DEAD EVENT TYPE, and the reason this list was
//                              read out of the migrations rather than written
//                              from memory. 0228 still defines the trigger, but
//                              0272 dropped `room_pause_events`, so nothing has
//                              produced one of these since. It was in an early
//                              draft of this set: a watcher keyed on it would
//                              have looked exactly like a watcher that works
//                              and would have fired forever on nothing.
//
// COMPLAINTS AND MESSAGES ARE NOT HERE, and not by choice: neither
// `complaints` (0235) nor the comms tables write to activity_log at all. There
// is no trigger to read. When one is added, its event type joins the list below
// and nothing else about this feature changes, which is the point of keying the
// gate on event types rather than on tables.
//
// ─── THE SELF-EXCITATION RULE ──────────────────────────────────────────────
//
// `activity_log` now has a writer that is the companion itself (migration 0456,
// source = 'staxis_agent'). Its rows are in the same table, on the same index,
// inside the same window. A gate that counted them would be a loop: the
// companion notices something, journals that it noticed it, the journal row
// lands inside the next window, the gate passes, the model is called, it has
// nothing to say but journals the wake, and the hotel pays for a conversation
// the companion is having with itself.
//
// It is excluded TWICE, on purpose, and the two exclusions are independent:
//   1. by SOURCE — `isSelfWritten` below, applied in the query and again here
//   2. by EVENT TYPE — none of the journal's event types (agent_acted,
//      agent_noticed, agent_said, …) appear in INTERESTING_EVENT_TYPES
// Either one alone would be sufficient. Both are here because a loop that
// spends money is the failure mode where "sufficient" is not the bar, and
// because a future edit that adds an agent event type to the interesting set by
// mistake still cannot start the loop.
// ═══════════════════════════════════════════════════════════════════════════

import { AGENT_JOURNAL_SOURCE } from '@/lib/agent/journal';
import { isSectionEnabled, type AppSection, type EnabledSections } from '@/lib/sections/registry';

/**
 * Every `activity_log.event_type` the sweep will wake for.
 *
 * Read out of the trigger bodies in migrations 0228, 0415 and 0435. Grouped by
 * the department a manager would file them under, which is also the
 * `event_category` the trigger writes.
 */
export const INTERESTING_EVENT_TYPES: readonly string[] = Object.freeze([
  // ── maintenance ──
  /** A new work order exists. Something is broken that was not broken before. */
  'work_order_created',
  /** A work order that had been closed or resolved is open again. The fix did
   *  not hold, which is a different and worse fact than the original break. */
  'work_order_open',
  /** Somebody pushed a work order out rather than doing it. */
  'work_order_deferred',

  // ── housekeeping ──
  /** A room failed inspection (the `inspections` table's own path). */
  'inspection_fail',
  /** A room failed inspection (the canonical housekeeping path, 0435). Both
   *  are listed because both are written, by different code, for the same
   *  fact, and a gate that knew about only one would miss half of them. */
  'cleaning_task_inspected_fail',
  /** A room went back to the housekeeper for corrections. */
  'cleaning_task_correction_pending',
  /** A clean was flagged as suspiciously long. */
  'cleaning_flagged',
  /** A clean was thrown out as too short to have happened. */
  'cleaning_discarded',
  /** A manager reviewed a flagged clean and threw it out. */
  'cleaning_review_rejected',

  // ── staff ──
  /** Somebody is not coming in. The one staffing fact that is always news. */
  'callout_reported',
]);

/** Set form, for the per-row check. Built once. */
const INTERESTING = new Set(INTERESTING_EVENT_TYPES);

/**
 * How many interesting rows one sweep will read for one hotel.
 *
 * A ceiling rather than a page: this is a ten-minute window, and a hotel that
 * produced more than this many failures in ten minutes has a data problem, not
 * a note the companion should be writing. The count reported to the model is
 * the number of rows READ, and it says so, so a truncated batch can never
 * become a sentence claiming a total it did not see.
 */
export const MAX_EVENTS_PER_WAKE = 40;

/**
 * The furthest back a single sweep will ever look.
 *
 * The cursor is normally minutes old. It is not after a deploy pause, a
 * disabled schedule, or a hotel that was switched off for a week: then it is
 * days old, and the window it defines would hand the model a week of failures
 * and ask for one sentence about them. That sentence would be a summary of
 * history, which is what the nightly findings run is for, and this feature is
 * for things that just happened.
 *
 * Two hours is generously longer than the sweep's own cadence and short enough
 * that everything inside it is still true.
 */
export const MAX_LOOKBACK_MINUTES = 120;

/**
 * At most this many wakes per hotel per HOTEL-LOCAL day.
 *
 * The cheap ceiling, and the one that bites first. The companion may say at
 * most COMPANION_MAX_SPEECH_PER_DAY (five) unprompted things in a day, and
 * every one of them competes with findings, slipped work and a forgotten
 * question. Preparing more notes than there are mouths to say them with is
 * money spent on things nobody will ever be told.
 *
 * Six rather than five: one spare, because a prepared note can be declined, and
 * a note that was turned down should not have cost the hotel its last wake.
 */
export const MAX_WAKES_PER_DAY = 6;

// ─── One row, as the gate sees it ───────────────────────────────────────────

export interface WakeEventRow {
  occurredAt: string;
  eventCategory: string;
  eventType: string;
  source: string;
  description: string;
  targetType: string | null;
  targetLabel: string | null;
  metadata: Record<string, unknown>;
}

/** Written by the companion itself. See the self-excitation rule above. */
export function isSelfWritten(row: { source: string }): boolean {
  return row.source === AGENT_JOURNAL_SOURCE;
}

/**
 * Is this one row worth waking for?
 *
 * BOTH conditions, and the order does not matter because neither is allowed to
 * carry the other. A row written by the companion is out no matter what its
 * event type says; a row whose event type is not on the list is out no matter
 * who wrote it.
 */
export function isInterestingEvent(row: { source: string; eventType: string }): boolean {
  if (isSelfWritten(row)) return false;
  return INTERESTING.has(row.eventType);
}

/** Belt to the query's braces: the read already filters, this filters again. */
export function keepInterestingEvents(
  rows: readonly WakeEventRow[],
): WakeEventRow[] {
  return rows.filter((row) => isInterestingEvent(row));
}

// ─── The hotel's own switches ───────────────────────────────────────────────

/**
 * Which part of the app an event belongs to, in the section registry's own
 * vocabulary.
 *
 * `activity_log.event_category` and `APP_SECTIONS` already agree on three
 * names, which is why this is a three-line map rather than a design: the
 * trigger writes 'housekeeping' and the section is called 'housekeeping'.
 *
 * A category with no section here is NOT gated. That is the safe direction and
 * it matches the registry's own default-on rule (`isSectionEnabled` treats an
 * unknown or absent flag as on): a new event category must not be silently
 * dropped because nobody has mapped it yet.
 */
const SECTION_FOR_CATEGORY: Readonly<Record<string, AppSection>> = Object.freeze({
  housekeeping: 'housekeeping',
  maintenance: 'maintenance',
  staff: 'staff',
});

/**
 * Drop the events this hotel has switched off.
 *
 * A hotel that turned Housekeeping off has said it does not run housekeeping
 * through Staxis. Being interrupted about a failed inspection would then be the
 * companion talking about a part of the app the hotel has told us it does not
 * use, which is worse than saying nothing: it is a reason to distrust the
 * switch.
 *
 * DEFAULT ON, via `isSectionEnabled`, which is the house rule for this flag
 * (never `flags[x] === true`). A hotel that has never touched a toggle has
 * every section on.
 */
export function keepEnabledSections(
  rows: readonly WakeEventRow[],
  flags: EnabledSections,
): WakeEventRow[] {
  return rows.filter((row) => {
    const section = SECTION_FOR_CATEGORY[row.eventCategory];
    return section === undefined || isSectionEnabled(flags, section);
  });
}

// ─── The verdict ────────────────────────────────────────────────────────────

export type WakeRefusal =
  /** No cursor could be read or written. Without one the sweep cannot claim a
   *  window, and a sweep that cannot claim a window would re-read the same
   *  events every ten minutes and pay for each of them. */
  | 'no_cursor'
  /**
   * Something the sweep needed to read did not answer.
   *
   * Kept apart from `no_cursor` because the two send an operator to different
   * places: one means migration 0459 is not applied or the cursor row is
   * unreadable, the other means the hotel's own switches or its event stream
   * did not come back. A single counter would put the wrong fix in front of
   * whoever is looking.
   */
  | 'read_failed'
  /** Another sweep claimed this window first. */
  | 'window_already_claimed'
  /** Nothing interesting landed. The common case, and it costs one read. */
  | 'quiet'
  /**
   * This hotel switched off the Staxis list, which is where a prepared note
   * would arrive. Nothing in its window is deliverable, whatever landed there.
   *
   * COUNTED APART FROM `quiet`, because they are different facts and only one
   * of them is about the hotel's data. A hotel that will structurally never
   * receive a note for as long as that switch is off is something an operator
   * should be able to see on the heartbeat, not something that hides inside a
   * number labelled "quiet".
   */
  | 'list_switched_off'
  /** This hotel has already woken as often today as it is allowed to. */
  | 'daily_wake_cap'
  /** The hotel's AI spend ceiling for this feature is used up. */
  | 'spend_cap'
  /** The spend ceiling itself could not be consulted. Different from the line
   *  above and recorded differently: one is the system working, the other is
   *  the system broken, and filing an outage as a budget line is how an outage
   *  goes uninvestigated. */
  | 'spend_unavailable'
  /** The model call failed, or its reply broke the contract. Silence, never a
   *  crash: unlike the findings judge there is no true sentence this feature is
   *  obliged to produce, so a refused reply is a wake that prepared nothing. */
  | 'model_unavailable';

// A SWITCHED-OFF FEATURE AND A DEMO HOTEL ARE DELIBERATELY NOT IN THIS UNION.
// Neither is a verdict about one hotel's events: the switch is read once for
// the whole fleet and reported as `switchedOff` on the sweep summary, and a
// demo hotel never enters the fan-out at all because the discovery query drops
// it. Giving either a per-hotel refusal would put a counter on the route that
// could only ever read zero.

export interface GateInput {
  /** Rows read for this window, already filtered by the query. */
  rows: readonly WakeEventRow[];
  /** How many wakes this hotel has already had on its own calendar today. */
  wakesToday: number;
}

export type GateVerdict =
  | { wake: false; refusal: 'quiet' | 'daily_wake_cap'; events: number }
  | { wake: true; events: readonly WakeEventRow[] };

/**
 * The deterministic half of the whole feature, in eight lines.
 *
 * Everything above it is a read; everything below it costs money. Nothing here
 * touches a clock, a database or a model, so "why did it wake" always has an
 * answer somebody can reproduce from the rows.
 */
export function decideWake(input: GateInput): GateVerdict {
  const events = keepInterestingEvents(input.rows).slice(0, MAX_EVENTS_PER_WAKE);
  if (events.length === 0) return { wake: false, refusal: 'quiet', events: 0 };
  // AFTER the interesting count, not before: a quiet hotel is quiet whether or
  // not it has already spoken today, and reporting a capped hotel as capped
  // when nothing happened would make the counter read like a hotel being
  // silenced rather than a hotel with nothing to say.
  if (input.wakesToday >= MAX_WAKES_PER_DAY) {
    return { wake: false, refusal: 'daily_wake_cap', events: events.length };
  }
  return { wake: true, events };
}

// ─── The topic ──────────────────────────────────────────────────────────────

/**
 * The handle a "no thank you" attaches to. DERIVED IN CODE, never authored by
 * the model.
 *
 * The manners ledger keys declines, drops and the once-a-day rule on this
 * string. A model that wrote a slightly different topic each time it prepared a
 * note would quietly undo every No a person had ever given: the same
 * interruption would arrive under a new name and the ledger would have nothing
 * to match it against. So the model never sees this and never chooses it.
 *
 * The GRAIN is the department, not the event, and that is the honest reading of
 * what somebody is turning down. "Stop telling me the moment a work order
 * opens" is a sentence about a class of interruption, not about one work order,
 * and two Nos on it should mean what it says. It is also stable across days,
 * which is what makes a No survive midnight.
 */
export function wakeTopicFor(events: readonly WakeEventRow[]): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.eventCategory, (counts.get(event.eventCategory) ?? 0) + 1);
  }
  // Most events wins; ties broken alphabetically so the same batch always
  // produces the same topic no matter what order the rows came back in.
  const winner = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return `wake:${winner ? winner[0] : 'system'}`;
}

// ─── The window ─────────────────────────────────────────────────────────────

export interface WakeWindow {
  /** Exclusive lower bound. Everything at or before this was already read. */
  sinceIso: string;
  /** Inclusive upper bound, and the value the cursor advances to. */
  untilIso: string;
  /** True when MAX_LOOKBACK_MINUTES had to shorten the window. Recorded rather
   *  than hidden: a clamped window means the sweep had not run in hours, which
   *  is a fact about the schedule, not about the hotel. */
  clamped: boolean;
}

/**
 * The slice of time this sweep is responsible for.
 *
 * `until` is the caller's `now`, so the cursor never advances past events that
 * have not been written yet, and a row that lands one millisecond later belongs
 * to the next window rather than being skipped.
 */
export function wakeWindow(lastLookedAtIso: string, now: Date): WakeWindow {
  const floorMs = now.getTime() - MAX_LOOKBACK_MINUTES * 60_000;
  const cursorMs = Date.parse(lastLookedAtIso);
  const usable = Number.isFinite(cursorMs) ? cursorMs : floorMs;
  const clamped = usable < floorMs;
  return {
    sinceIso: new Date(clamped ? floorMs : usable).toISOString(),
    untilIso: now.toISOString(),
    clamped,
  };
}
