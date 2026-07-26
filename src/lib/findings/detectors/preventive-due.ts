// ─── Detector: upkeep that has come due ──────────────────────────────────────
//
// "Water heater flush is due — last done 6 months ago."
//
// THE ONE THING THIS DETECTOR IS FOR
// Staxis cannot know when anything at a hotel was last serviced. No PMS carries
// it, no invoice reliably says it, and no amount of watching the work-order
// board will tell you that the water heater has not been flushed since March —
// because the absence of a ticket is exactly what the problem looks like. So the
// hotel says it ONCE, in Maintenance → Preventive, and this counts forward
// forever. That is the entire trade: one sentence typed in, and a thing that
// never forgets.
//
// WHY THIS ONE MAY SPEAK ON A THREE-WEEK-OLD HOTEL
// Every other Phase-2 detector learns what is normal from the hotel's own
// trailing weeks and is deliberately, structurally silent until it has enough of
// them. This one infers NOTHING. The cadence and the last-done date are both
// assertions a human at this hotel made, and "you said every 90 days, you said
// May 10th, it is now August" is arithmetic over their own words. There is no
// baseline to be short of, which is why its declared minimum is simply "at least
// one schedule exists".
//
// ═══ A SCHEDULE THAT HAS NEVER BEEN DONE IS NOT OVERDUE ═══
// The honest and slightly uncomfortable call, pinned in the eval cases below.
//
// `last_completed_at` is nullable and a row can genuinely carry null. The
// tempting behaviour is to treat those as maximally overdue and shout — a task
// somebody set up and never did looks like the most neglected thing in the
// building. But "due" is a claim that a KNOWN interval has elapsed since a KNOWN
// event, and with no event there is no elapsed interval. The only dates
// available to count from instead are `created_at` — which is when somebody
// typed a row, not when anybody serviced anything — and today, which would make
// every new schedule instantly overdue. Both invent a service history the hotel
// never claimed, and this system's whole standing with a manager rests on not
// doing that.
//
// It is also nearly unreachable in practice, which is why silence costs so
// little: the Preventive tab's own New-task form defaults last-done to TODAY
// when the manager leaves the backfill blank, so every schedule created through
// the product has a date. A null is a legacy or hand-written row. The tab still
// shows it (its own board bands off the same field); Staxis simply does not
// claim to know it is late.
//
// MONEY: NONE, EVER. There is no honest dollar figure for "the flush is due".
// `work_orders.repair_cost` is what this hotel paid to fix things that BROKE —
// a reactive number — and quoting it as the cost of preventive service, or as
// the saving from doing it, would be exactly the invented figure the range
// format exists to prevent. The card carries no price and says why in its
// evidence.

import { createPreventiveWorkOrderParams } from '../actions/catalog/create-work-order';
import type { FindingActionDraft } from '../actions/types';
import { plural } from '../pricing';
import { registerDetector } from '../registry';
import { daysBetweenDates, type PreventiveScheduleEntry, type PreventiveScheduleFeed } from '../history';
import type {
  Detector,
  DetectorContext,
  DetectorParams,
  FindingDraft,
} from '../types';
import { readFeed } from '../types';

const RECEIPT = 'preventive_tasks_due';

/**
 * How long a "somebody has been called" rest lasts before Staxis asks whether
 * the work actually happened.
 *
 * SEVEN DAYS, and the founder's own words set the bar: a reminder, not a nag.
 * The window has to clear the realistic time for an arranged vendor to turn up —
 * a plumber booked on Monday is not late on Tuesday — while staying short enough
 * that the question still lands as "did that happen?" rather than as an audit of
 * something everyone has forgotten. A week is also the unit a hotel manager
 * already thinks in, so "I'll chase it if it hasn't happened by next week" is
 * the promise this makes and keeps.
 *
 * Each tap re-arms it. A manager who says "called again" gets another quiet
 * week, so a genuinely slow vendor never produces a daily card — and a manager
 * who stops answering is handled by the self-demotion pass that governs every
 * check, not by a second give-up rule invented here.
 */
export const FOLLOW_UP_DAYS = 7;

// ═══ EVERY DATE IN A SENTENCE IS AN ELAPSED COUNT, NOT A CALENDAR DATE ═══
//
// "last done 210 days ago", never "last done Dec 28, 2025". Two reasons, and
// the second one was found the hard way, on the first live run.
//
//   1. It is better copy. The founder's own phrasing was "last done 6 months
//      ago", and a manager reading a card wants the gap, not a date they then
//      have to subtract today from.
//
//   2. THE PROSE GUARD CANNOT VERIFY A TRANSLATED MONTH. The nightly judge
//      rephrases these summaries into English and Spanish, and prose-guard.ts
//      refuses any month name that is not in the payload — a month is a factual
//      claim about when. Given "Dec 28, 2025" the model quite reasonably wrote
//      "diciembre", which is not a token this finding supplied, so the guard
//      threw the whole Spanish rendering away and the card fell back to English.
//      That was six of fourteen rejections on the very first run: a
//      Spanish-speaking manager would have received English preventive cards
//      forever, and nothing would have looked broken.
//
//      Elapsed counts have no such problem — every number in the sentence is
//      also in `evidence.values`, which is exactly what the guard checks
//      against. The ISO date still lives in the receipt, where it is rendered as
//      a value rather than as prose and is what an auditor actually wants.

/** What this schedule currently is, from the hotel's own two dates plus today. */
export type ScheduleState =
  | { kind: 'not_due' }
  /** Never recorded a completion — see the header. Not a claim of lateness. */
  | { kind: 'never_done' }
  /** Due (or past due) and nobody has said they are dealing with it. */
  | { kind: 'due'; daysOverdue: number; dueDate: string }
  /** Somebody was called, recently enough that the card should stay quiet. */
  | { kind: 'resting'; daysSinceCalled: number }
  /** Somebody was called, long enough ago to ask whether it happened. */
  | { kind: 'follow_up'; daysOverdue: number; daysSinceCalled: number; dueDate: string };

/**
 * The state machine, as a pure function of three dates. Exported because it is
 * the whole behaviour of this detector and deserves to be asserted directly
 * rather than inferred from which drafts came out.
 *
 * ORDER MATTERS: the called-state is checked BEFORE due-ness is reported, so a
 * manager who has arranged the work does not keep getting the original card.
 * But it is checked AFTER the never-done and not-due gates, so a stale
 * `called_at` on a task that has since been done and is not due again cannot
 * resurrect a card about nothing.
 */
export function scheduleState(task: PreventiveScheduleEntry, today: string): ScheduleState {
  if (!task.lastDoneDate || !task.nextDueDate) return { kind: 'never_done' };

  const daysOverdue = daysBetweenDates(task.nextDueDate, today);
  // An unparseable stored date is "we cannot say", never "it is fine" and never
  // a NaN comparison that happens to be false.
  if (daysOverdue === null) return { kind: 'not_due' };
  // Due ON the day, not before. `>= 0` is the whole boundary: a task due
  // tomorrow says nothing today.
  if (daysOverdue < 0) return { kind: 'not_due' };

  if (task.calledDate) {
    const daysSinceCalled = daysBetweenDates(task.calledDate, today);
    if (daysSinceCalled !== null && daysSinceCalled >= 0) {
      return daysSinceCalled < FOLLOW_UP_DAYS
        ? { kind: 'resting', daysSinceCalled }
        : { kind: 'follow_up', daysOverdue, daysSinceCalled, dueDate: task.nextDueDate };
    }
    // A called date in the future is not a rest anybody asked for. Fall through
    // and treat the task as plainly due — the database refuses to store one
    // (0366), so this is the belt to that migration's braces.
  }

  return { kind: 'due', daysOverdue, dueDate: task.nextDueDate };
}

/**
 * The lateness, in words, for a sentence: "due today", "1 day past due".
 *
 * Handles zero itself so both callers read correctly. A task can reach the
 * follow-up card on the very day it comes due — somebody called about it eight
 * days ago, in advance — and "still has not been done — today" is not a
 * sentence.
 */
function lateness(daysOverdue: number): string {
  return daysOverdue === 0 ? 'due today' : `${plural(daysOverdue, 'day')} past due`;
}

/**
 * The longest a schedule's name may be before it reaches a prompt.
 *
 * Same 120 as `equipment.name` (`equipment/validate.ts`, CHECK
 * `agent_knowledge_questions_suggested_equipment_name_ck` in 0368), because
 * these two are the same kind of thing — a short label a manager types for a
 * piece of the building — and two different limits for one kind of thing is a
 * limit somebody will pick wrong later.
 *
 * WHY IT MATTERS HERE. `preventive_tasks.name` had no limit anywhere: not on
 * the column, not in the form, not at this boundary. A schedule named with a
 * 40,000-character paste lands in the summary, the basis and the evidence of
 * every card this detector writes — six copies per run — and all six go to the
 * nightly judge inside one batched call. That is somebody else's spend cap,
 * a truncated batch, and a card nobody can read, from one text field. 0370 adds
 * the column CHECK and the form adds `maxLength`; this is the third layer,
 * because rows written before those existed are still in the table.
 */
export const PREVENTIVE_TASK_NAME_MAX_CHARS = 120;

function draftFor(task: PreventiveScheduleEntry, today: string): FindingDraft | null {
  const state = scheduleState(task, today);
  if (state.kind === 'not_due' || state.kind === 'never_done' || state.kind === 'resting') {
    return null;
  }

  // Capped ONCE, here, so every one of the six places the name appears below
  // gets the same bounded string. Capping at each use site is how five of them
  // end up capped and the sixth does not.
  const taskName = task.name.slice(0, PREVENTIVE_TASK_NAME_MAX_CHARS);
  const cadence = plural(task.frequencyDays, 'day');
  const where = task.area ? ` (${task.area})` : '';
  // Elapsed, not calendar — see the note above. Null only if the stored date is
  // unparseable, and `scheduleState` has already refused to call that due.
  const sinceLastDone = task.lastDoneDate
    ? daysBetweenDates(task.lastDoneDate, today)
    : null;
  const lastDoneAgo = sinceLastDone === null ? null : `${plural(sinceLastDone, 'day')} ago`;

  const isFollowUp = state.kind === 'follow_up';

  return {
    // Identity is the SCHEDULE. Being a week later, or turning into a follow-up,
    // is the same problem wearing a different sentence — it lands on this row.
    key: `task:${task.id}`,
    // A STATEMENT, NOT A QUESTION — and that is a fix, not a preference.
    // This sentence used to end "Did it happen?", and the nightly judge did
    // exactly what it is built to do: classified the card as a question and
    // sorted it to `ask`, which routes findings to the drip-question surface.
    // That surface has no "Yes, it got done" button, so the one tap that moves
    // this schedule's last-done date silently disappeared from the product.
    // The buttons are where the asking belongs; the prose states what is true.
    summary: isFollowUp
      ? `${taskName}${where} still has not been done — ${lateness(state.daysOverdue)}. ` +
        `Somebody was called about it ${plural(state.daysSinceCalled, 'day')} ago.`
      : `${taskName}${where} is ${lateness(state.daysOverdue)}` +
        `${lastDoneAgo ? ` — last done ${lastDoneAgo},` : ' —'} and this hotel does it every ${cadence}.`,
    // A full extra cycle late is a different kind of late: the hotel has not
    // merely slipped a date, it has skipped a whole round. Self-scaling off the
    // hotel's own cadence rather than off a number invented here — 30 days late
    // on a weekly filter and 30 days late on an annual inspection are not the
    // same news.
    severity: state.daysOverdue >= task.frequencyDays ? 'critical' : 'attention',
    // A follow-up is not an offer. Somebody is already dealing with it, and
    // Staxis putting a SECOND ticket on the board for a job a vendor has already
    // been called about is the failure this whole layer is built to avoid. The
    // card still asks — it just asks with words instead of a button.
    disposition: isFollowUp ? 'recommend' : 'propose',
    magnitude: state.daysOverdue,
    evidence: {
      queryId: RECEIPT,
      params: {
        preventive_task_id: task.id,
        task_name: taskName,
        area: task.area,
        frequency_days: task.frequencyDays,
      },
      values: {
        last_done: task.lastDoneDate,
        // The same completion as a raw instant. NOT for the receipt — it is
        // what the attached offer freezes and what the execute transaction
        // re-compares, so that "has anybody done this since?" is answered
        // exactly rather than to the nearest day.
        last_done_at: task.lastDoneAtIso,
        due_on: state.dueDate,
        // In the payload because it is IN THE SENTENCE. prose-guard.ts checks
        // every numeral the judge writes against these values, so a number the
        // card says and the evidence does not carry would get the whole
        // rephrasing thrown away.
        days_since_last_done: sinceLastDone,
        days_overdue: state.daysOverdue,
        somebody_called_on: task.calledDate,
        // Same reason as days_since_last_done: the follow-up sentence says it.
        days_since_called: isFollowUp ? state.daysSinceCalled : null,
        called_by: task.calledBy,
        price_basis:
          'no dollar figure: what this hotel has paid to fix things that broke is not what ' +
          'preventive service costs, and there is no honest number to put here',
      },
      basis: isFollowUp
        ? `${taskName} is ${lateness(state.daysOverdue)}; somebody was called ` +
          `${plural(state.daysSinceCalled, 'day')} ago and it is still not marked done`
        : `${taskName} was last done ${lastDoneAgo ?? 'an unknown time ago'} and this hotel's ` +
          `schedule says every ${cadence}, so it is now ${lateness(state.daysOverdue)}`,
      // The chip on this schedule's own record in the Preventive tab.
      target: { kind: 'preventive_task', value: task.id },
    },
    // No price, ever. See the header.
    price: null,
    // The claim rests on dates a human typed, not on a measurement taken at some
    // earlier moment: it is exactly as true today as it was when they typed it.
    asOf: null,
    weakestInputAgeDays: 0,
  };
}

export function detectPreventiveDue(ctx: DetectorContext): FindingDraft[] {
  const feed: PreventiveScheduleFeed = readFeed(ctx, 'preventive_schedule');
  const out: FindingDraft[] = [];
  for (const task of feed.tasks) {
    const draft = draftFor(task, ctx.businessDate);
    if (draft) out.push(draft);
  }
  // Latest first, so the per-run cap keeps the ones that have waited longest.
  return out.sort((a, b) => b.magnitude - a.magnitude);
}

/**
 * The fix: put this upkeep job on the maintenance board.
 *
 * PURE, and reading only the draft — the plan a manager approves tomorrow
 * morning is computed here, tonight, from the same evidence the card renders.
 *
 * Returns null for a FOLLOW-UP draft. Somebody has already been called, so a
 * work order from Staxis would be a second person dispatched to the same job.
 * (It also could not honestly decline: the re-verification asks whether the task
 * has been marked done since, and on a follow-up the answer is "no" by
 * construction — an offer that can never decline is one this layer does not
 * make.) Follow-ups are `recommend` for the same reason, so the runner's
 * disposition gate would refuse the action anyway; this is the second lock.
 */
export function preventiveActionFor(draft: FindingDraft): FindingActionDraft | null {
  const p = draft.evidence.params;
  const v = draft.evidence.values;

  const taskId = typeof p.preventive_task_id === 'string' ? p.preventive_task_id : '';
  const taskName = typeof p.task_name === 'string' ? p.task_name : '';
  const frequencyDays = typeof p.frequency_days === 'number' ? p.frequency_days : 0;
  const dueDate = typeof v.due_on === 'string' ? v.due_on : '';
  const lastDone = typeof v.last_done === 'string' ? v.last_done : null;
  const area = typeof p.area === 'string' ? p.area : null;

  if (!taskId || !taskName || frequencyDays < 1 || !dueDate) return null;
  // Somebody has been called: this is the follow-up card, not the offer.
  if (typeof v.somebody_called_on === 'string' && v.somebody_called_on) return null;

  return {
    kind: 'create_work_order',
    params: createPreventiveWorkOrderParams({
      taskId,
      taskName,
      area,
      frequencyDays,
      lastDoneDate: lastDone,
      dueDate,
    }),
    // What must STILL be true at the tap: nobody has marked this task done since
    // Staxis offered. Compared as an INSTANT, not a date — the window this
    // protects is a manager marking the flush done at 9am and tapping a card
    // they opened at 8:55.
    verify: {
      preventive_task_id: taskId,
      task_name: taskName,
      last_completed_at: lastDoneAtOf(draft),
    },
  };
}

/**
 * The raw completion instant the offer is frozen against.
 *
 * Lives in `evidence.values.last_done_at` — written by the detector, carried
 * through unchanged. Empty string rather than null because the frozen `verify`
 * is compared in SQL with `nullif(… ,'')::timestamptz`, and jsonb null and an
 * absent key would each need their own branch there.
 */
function lastDoneAtOf(draft: FindingDraft): string {
  const raw = draft.evidence.values.last_done_at;
  return typeof raw === 'string' ? raw : '';
}

// ── eval cases ──────────────────────────────────────────────────────────────
// EVAL_BUSINESS_DATE is 2026-01-01, so every date below is chosen relative to
// that day.

const task = (over: Partial<PreventiveScheduleEntry> = {}): PreventiveScheduleEntry => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Water heater flush',
  area: 'Building',
  frequencyDays: 180,
  lastDoneDate: '2025-07-01',
  lastDoneAtIso: '2025-07-01T00:00:00+00:00',
  nextDueDate: '2025-12-28',
  calledDate: null,
  calledBy: null,
  ...over,
});

const feed = (tasks: PreventiveScheduleEntry[]): PreventiveScheduleFeed => ({
  tasks,
  asOfDate: '2026-01-01',
});

export const preventiveDueDetector: Detector<DetectorParams> = {
  declaration: {
    id: 'preventive_due',
    description:
      'An upkeep job the hotel put on a schedule has come due — with an offer to put it on the maintenance board, and a follow-up when somebody says they have called about it.',
    inputs: ['preventive_schedule'],
    requires: [
      {
        feed: 'preventive_schedule',
        // One schedule is enough. There is no baseline here to be short of —
        // see the header on why this detector infers nothing.
        minRecords: 1,
        because:
          'this hotel has not put any upkeep jobs on a schedule yet, so there is nothing to count forward from',
      },
    ],
    receiptQueryId: RECEIPT,
    defaultDisposition: 'propose',
    defaultSeverity: 'attention',
    // Silencing at 10 days late is consent to 10, not to a skipped year.
    escalation: { factor: 2, minDelta: 14 },
    maxPerRun: 6,
    // Three nights of not being re-found means the task was done, rested or
    // deleted. The card should not outlive any of those.
    staleAfterDays: 3,
    actionTemplate: preventiveActionFor,
    evalCases: [
      {
        name: 'a schedule three days past its date is one finding keyed on the task',
        feeds: { preventive_schedule: feed([task({ nextDueDate: '2025-12-29' })]) },
        expectKeys: ['task:11111111-1111-4111-8111-111111111111'],
        expectMagnitude: { 'task:11111111-1111-4111-8111-111111111111': 3 },
      },
      {
        name: 'due EXACTLY today fires, at zero days late',
        feeds: { preventive_schedule: feed([task({ nextDueDate: '2026-01-01' })]) },
        expectKeys: ['task:11111111-1111-4111-8111-111111111111'],
        expectMagnitude: { 'task:11111111-1111-4111-8111-111111111111': 0 },
      },
      {
        name: 'due TOMORROW says nothing at all',
        feeds: { preventive_schedule: feed([task({ nextDueDate: '2026-01-02' })]) },
        expectKeys: [],
      },
      {
        name: 'a schedule that has never been done is not overdue — it is unstarted, and Staxis says nothing',
        feeds: {
          preventive_schedule: feed([
            task({ lastDoneDate: null, lastDoneAtIso: null, nextDueDate: null }),
          ]),
        },
        expectKeys: [],
      },
      {
        name: 'somebody was called two days ago, so the card rests',
        feeds: {
          preventive_schedule: feed([
            task({ nextDueDate: '2025-12-01', calledDate: '2025-12-30', calledBy: 'Dana' }),
          ]),
        },
        expectKeys: [],
      },
      {
        name: 'somebody was called eight days ago, so the follow-up comes back',
        feeds: {
          preventive_schedule: feed([
            task({ nextDueDate: '2025-12-01', calledDate: '2025-12-24', calledBy: 'Dana' }),
          ]),
        },
        expectKeys: ['task:11111111-1111-4111-8111-111111111111'],
        expectMagnitude: { 'task:11111111-1111-4111-8111-111111111111': 31 },
      },
      {
        name: 'a hotel with no schedules says nothing, and that is a real answer',
        feeds: { preventive_schedule: feed([]) },
        expectKeys: [],
      },
    ],
  },
  detect(ctx: DetectorContext): FindingDraft[] {
    return detectPreventiveDue(ctx);
  },
};

registerDetector(preventiveDueDetector);
