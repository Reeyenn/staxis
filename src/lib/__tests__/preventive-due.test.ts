/**
 * The preventive detector's arithmetic and its copy, with no database in the
 * way.
 *
 * WHAT THESE ARE FOR
 * Every assertion below is a BOUNDARY — the day a card starts, the day a rest
 * ends, the difference between "never done" and "very overdue". Those are the
 * places a plausible edit does damage that nothing else notices: a `<` that
 * becomes `<=` fires every card one day early at every hotel, and the only
 * symptom is a manager who slowly stops believing the dates.
 *
 * The DB-backed half — the clock actually restarting, the work order closing the
 * loop, the tenant wall — is in preventive-due.integration.test.ts, because none
 * of that can be proven against a fake.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  FOLLOW_UP_DAYS,
  detectPreventiveDue,
  preventiveActionFor,
  scheduleState,
} from '@/lib/findings/detectors/preventive-due';
import {
  createPreventiveWorkOrderParams,
  createWorkOrderAction,
  createWorkOrderParams,
} from '@/lib/findings/actions/catalog/create-work-order';
import { closureButtons, isCardRenderable } from '@/components/concourse/finding-cards';
import { hasDomainClosure } from '@/lib/findings/types';
import { resolveFindingTarget } from '@/lib/findings/targeting';
import { daysBetweenDates } from '@/lib/findings/history';
import { fromPreventiveRow, toPreventiveRow } from '@/lib/db-mappers';
import type { PreventiveScheduleEntry } from '@/lib/findings/history';
import type { DetectorContext, FindingDisposition } from '@/lib/findings/types';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const TODAY = '2026-07-26';

function task(over: Partial<PreventiveScheduleEntry> = {}): PreventiveScheduleEntry {
  return {
    id: TASK_ID,
    name: 'Water heater flush',
    area: 'Building',
    frequencyDays: 180,
    lastDoneDate: '2026-01-01',
    lastDoneAtIso: '2026-01-01T00:00:00+00:00',
    nextDueDate: '2026-06-30',
    calledDate: null,
    calledBy: null,
    skippedDate: null,
    skippedBy: null,
    ...over,
  };
}

function ctx(tasks: PreventiveScheduleEntry[], businessDate = TODAY): DetectorContext {
  return {
    propertyId: 'p1',
    now: new Date(`${businessDate}T12:00:00Z`),
    timezone: 'America/Chicago',
    businessDate,
    feeds: {
      preventive_schedule: {
        value: { tasks, asOfDate: businessDate },
        recordCount: tasks.length,
        asOf: new Date(`${businessDate}T12:00:00Z`),
        weakestInputAgeDays: 0,
      },
    },
  };
}

// ─── The day it starts ──────────────────────────────────────────────────────

describe('a schedule comes due on its date, and not one day earlier', () => {
  test('the day BEFORE the due date, Staxis says nothing', () => {
    const state = scheduleState(task({ nextDueDate: '2026-07-27' }), TODAY);
    assert.equal(state.kind, 'not_due');
  });

  test('ON the due date it fires, at zero days late', () => {
    const state = scheduleState(task({ nextDueDate: TODAY }), TODAY);
    assert.equal(state.kind, 'due');
    assert.equal(state.kind === 'due' && state.daysOverdue, 0);
  });

  test('the day after, it is one day late', () => {
    const state = scheduleState(task({ nextDueDate: '2026-07-25' }), TODAY);
    assert.equal(state.kind === 'due' && state.daysOverdue, 1);
  });

  test('a long-overdue schedule reports its real lateness, not a capped one', () => {
    const state = scheduleState(task({ nextDueDate: '2025-07-26' }), TODAY);
    assert.equal(state.kind === 'due' && state.daysOverdue, 365);
  });

  test('the boundary is not a timezone artifact — noon anchors survive a DST shift', () => {
    // 2026-11-01 is the US fall-back. Midnight-anchored arithmetic across it
    // lands 25 hours apart and rounds to the wrong day.
    assert.equal(daysBetweenDates('2026-10-25', '2026-11-08'), 14);
    assert.equal(daysBetweenDates('2026-03-01', '2026-03-15'), 14);
  });
});

// ─── The honest silence ─────────────────────────────────────────────────────

describe('a schedule nobody has ever done is unstarted, not overdue', () => {
  const unstarted = { lastDoneDate: null, lastDoneAtIso: null, nextDueDate: null };

  test('no last-done means no claim of lateness, however old the row is', () => {
    const state = scheduleState(task(unstarted), TODAY);
    assert.equal(state.kind, 'never_done');
  });

  // The card exists so a hotel that asked to be reminded about something can
  // find out Staxis cannot count forward for it. Everything asserted here is
  // about what the card may NOT claim.
  //
  // MUTATION PROOF: make the never-done branch count from today (the tempting
  // wrong answer — `daysOverdue = 0` and disposition 'propose'), and the
  // magnitude, disposition, severity and summary assertions all fail at once.
  test('it produces exactly one card, and that card claims no lateness', () => {
    const drafts = detectPreventiveDue(ctx([task(unstarted)]));
    assert.equal(drafts.length, 1);
    const [draft] = drafts;
    assert.equal(draft.key, 'task:11111111-1111-4111-8111-111111111111:never_started');
    assert.equal(draft.magnitude, 0, 'a magnitude here would be a lateness nobody can compute');
    assert.equal(draft.disposition, 'fyi');
    assert.equal(draft.severity, 'info');
    assert.equal(draft.price, null);
    assert.doesNotMatch(draft.summary, /past due|overdue|late/i);
    assert.match(draft.summary, /never been marked done/);
    assert.equal(draft.evidence.values.days_overdue, null);
    assert.equal(draft.evidence.values.due_on, null);
  });

  test('the never-started card carries no offer — Staxis cannot raise a ticket for a job with no history', () => {
    const [draft] = detectPreventiveDue(ctx([task(unstarted)]));
    assert.equal(preventiveActionFor(draft), null);
  });

  test('its key is NOT the overdue card’s key, so silencing one cannot silence the other', () => {
    const [unstartedDraft] = detectPreventiveDue(ctx([task(unstarted)]));
    const [dueDraft] = detectPreventiveDue(ctx([task({ nextDueDate: daysAgo(3) })]));
    assert.notEqual(unstartedDraft.key, dueDraft.key);
  });

  test('an unparseable stored date is "we cannot say", never "it is fine to shout"', () => {
    const state = scheduleState(task({ nextDueDate: 'not-a-date' }), TODAY);
    assert.equal(state.kind, 'not_due');
  });
});

// ─── Somebody's been called ─────────────────────────────────────────────────

describe('called → resting → follow-up', () => {
  const overdue = { nextDueDate: '2026-06-01' };

  test('the day somebody is called, the card goes quiet', () => {
    const state = scheduleState(task({ ...overdue, calledDate: TODAY }), TODAY);
    assert.equal(state.kind, 'resting');
  });

  test('it stays quiet for the whole follow-up window', () => {
    const lastQuietDay = daysAgo(FOLLOW_UP_DAYS - 1);
    const state = scheduleState(task({ ...overdue, calledDate: lastQuietDay }), TODAY);
    assert.equal(state.kind, 'resting', `${lastQuietDay} should still be resting`);
    assert.deepEqual(detectPreventiveDue(ctx([task({ ...overdue, calledDate: lastQuietDay })])), []);
  });

  test('on the follow-up day itself it comes back and asks', () => {
    const called = daysAgo(FOLLOW_UP_DAYS);
    const state = scheduleState(task({ ...overdue, calledDate: called }), TODAY);
    assert.equal(state.kind, 'follow_up');
    assert.equal(state.kind === 'follow_up' && state.daysSinceCalled, FOLLOW_UP_DAYS);
  });

  test('the follow-up card says what is outstanding, and carries NO button', () => {
    const drafts = detectPreventiveDue(
      ctx([task({ ...overdue, calledDate: daysAgo(9), calledBy: 'Dana' })]),
    );
    assert.equal(drafts.length, 1);
    // `recommend`, not `propose`: somebody is already on it, so this is a
    // question rather than an offer. The runner's own gate refuses to attach an
    // action to a non-proposal, and the template refuses too — both, on purpose.
    assert.equal(drafts[0].disposition, 'recommend');
    assert.match(drafts[0].summary, /still has not been done/);
    assert.match(drafts[0].summary, /called about it 9 days ago/);
    assert.equal(preventiveActionFor(drafts[0]), null);
  });

  /**
   * REGRESSION, found on the first live run.
   *
   * The follow-up used to end "Did it happen?". The judge classified it as a
   * question and sorted it to `ask`, which routes a finding to the
   * drip-question card — a surface with no "Yes, it got done" button. The card,
   * and with it the only tap that moves this schedule's last-done date, left
   * the queue silently.
   */
  test('the prose does not invite the judge to file it as a question', () => {
    const [draft] = detectPreventiveDue(
      ctx([task({ ...overdue, calledDate: daysAgo(9), calledBy: 'Dana' })]),
    );
    assert.doesNotMatch(draft.summary, /\?/, 'the buttons ask; the sentence states');
  });

  test('and even if the judge files it as a question anyway, it stays a card', () => {
    // The structural half. `ask` and `drop` are the judge's to reach, but not
    // over a card that is the only place its outcome can be recorded.
    assert.equal(isCardRenderable({ disposition: 'ask', detectorId: 'preventive_due' }), true);
    assert.equal(isCardRenderable({ disposition: 'drop', detectorId: 'preventive_due' }), true);
    assert.ok(hasDomainClosure('preventive_due'));
    // Every other detector is untouched: the judge keeps its full remit there.
    assert.equal(isCardRenderable({ disposition: 'ask', detectorId: 'room_needs_attention' }), false);
    assert.equal(isCardRenderable({ disposition: 'ask' }), false);
    assert.equal(isCardRenderable({ disposition: 'propose' }), true);
    assert.ok(!hasDomainClosure('repeat_room_work_orders'));
  });

  test('a follow-up on the very day it comes due still reads as a sentence', () => {
    // Called in advance, eight days ago; due today. "still has not been done,
    // today." is not English, so zero has its own wording.
    const [draft] = detectPreventiveDue(
      ctx([task({ nextDueDate: TODAY, calledDate: daysAgo(8), calledBy: 'Dana' })]),
    );
    assert.match(draft.summary, /still has not been done, due today\./);
    assert.doesNotMatch(draft.summary, /done, today\./);
  });

  test('a due card that nobody has called about IS an offer', () => {
    const drafts = detectPreventiveDue(ctx([task(overdue)]));
    assert.equal(drafts[0].disposition, 'propose');
    assert.ok(preventiveActionFor(drafts[0]), 'a plain due card must carry the fix');
  });

  test('a call dated in the future cannot silence a card forever', () => {
    const state = scheduleState(task({ ...overdue, calledDate: '2027-01-01' }), TODAY);
    assert.equal(state.kind, 'due');
  });

  test('a stale call on a task that is no longer due resurrects nothing', () => {
    // Done last week, not due for months, but the called flag was never cleared.
    const state = scheduleState(
      task({ nextDueDate: '2026-12-01', calledDate: '2026-01-05' }),
      TODAY,
    );
    assert.equal(state.kind, 'not_due');
  });
});

// ─── What the card says ─────────────────────────────────────────────────────

describe('the card names the thing and shows its working', () => {
  test('it targets the schedule, so the chip can find it on its own record', () => {
    const [draft] = detectPreventiveDue(ctx([task({ nextDueDate: '2026-06-01' })]));
    assert.deepEqual(resolveFindingTarget(draft.evidence), {
      kind: 'preventive_task',
      value: TASK_ID,
    });
  });

  test('it carries NO price — a repair cost is not a service cost', () => {
    const [draft] = detectPreventiveDue(ctx([task({ nextDueDate: '2026-06-01' })]));
    assert.equal(draft.price, null);
    assert.match(String(draft.evidence.values.price_basis), /no dollar figure/);
  });

  test('a full cycle late is louder than merely late', () => {
    const late = detectPreventiveDue(ctx([task({ nextDueDate: '2026-07-01', frequencyDays: 180 })]));
    assert.equal(late[0].severity, 'attention');
    const skipped = detectPreventiveDue(
      ctx([task({ nextDueDate: '2026-01-01', frequencyDays: 180 })]),
    );
    assert.equal(skipped[0].severity, 'critical');
  });

  test('the worst-waited card sorts first, so the per-run cap keeps the right ones', () => {
    const drafts = detectPreventiveDue(
      ctx([
        task({ id: 'a', nextDueDate: '2026-07-20' }),
        task({ id: 'b', nextDueDate: '2026-01-20' }),
      ]),
    );
    assert.deepEqual(drafts.map((d) => d.magnitude), [187, 6]);
  });

  /**
   * REGRESSION, found on the first live run against a real hotel.
   *
   * The summary used to read "last done Dec 28, 2025". The nightly judge
   * rephrases these into Spanish, quite reasonably wrote "diciembre", and
   * prose-guard.ts refused it — a month name is a factual claim about when, and
   * that token was nowhere in the payload. Six of fourteen renderings were
   * thrown away, so every Spanish-speaking manager would have received English
   * preventive cards forever with nothing appearing broken.
   *
   * Both halves are asserted because both are load-bearing: no month names at
   * all, and every number the sentence says is a number the evidence carries.
   */
  test('the sentence is guard-safe: no month names, and every number is in the payload', () => {
    // Full names in both languages plus the unambiguous English abbreviations.
    // Bare "may" and "ago" are deliberately absent — they are also an English
    // modal and the English word in "206 days ago", and a guard that cried wolf
    // on its own correct output is a guard somebody deletes. The calendar-shape
    // check below is what catches a date whichever month it names.
    const MONTHS =
      /\b(january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i;
    // "Dec 28, 2025", "2025-12-28" — a calendar date in any dress.
    const CALENDAR = /\d{4}-\d{2}-\d{2}|\b\d{1,2},\s*\d{4}\b/;

    for (const t of [
      task({ nextDueDate: '2026-06-01' }),
      task({ nextDueDate: TODAY }),
      task({ nextDueDate: '2026-06-01', calledDate: daysAgo(9), calledBy: 'Dana' }),
      task({ nextDueDate: '2026-06-01', area: null }),
    ]) {
      const [draft] = detectPreventiveDue(ctx([t]));
      assert.ok(draft, 'expected a card to assert on');

      assert.doesNotMatch(
        draft.summary,
        MONTHS,
        `a month name in "${draft.summary}" cannot survive translation past the prose guard`,
      );
      assert.doesNotMatch(draft.evidence.basis, MONTHS);
      assert.doesNotMatch(draft.summary, CALENDAR, 'a card sentence states gaps, not dates');
      assert.doesNotMatch(draft.evidence.basis, CALENDAR);

      // Every digit run in the sentence must be a value the receipt carries.
      const carried = new Set(
        Object.values(draft.evidence.values)
          .concat(Object.values(draft.evidence.params))
          .filter((v) => typeof v === 'number')
          .map(String),
      );
      for (const numeral of draft.summary.match(/\d+/g) ?? []) {
        assert.ok(
          carried.has(numeral),
          `the card says "${numeral}" but no evidence value does — the guard would reject the rephrasing`,
        );
      }
    }
  });

  test('one schedule is one problem — the key does not carry the measurement', () => {
    const early = detectPreventiveDue(ctx([task({ nextDueDate: '2026-07-25' })]));
    const later = detectPreventiveDue(ctx([task({ nextDueDate: '2026-07-25' })], '2026-08-26'));
    assert.equal(early[0].key, later[0].key);
    assert.notEqual(early[0].magnitude, later[0].magnitude);
  });
});

// ─── The frozen plan ────────────────────────────────────────────────────────

describe('the offer attached to a due card', () => {
  const plan = () =>
    createPreventiveWorkOrderParams({
      taskId: TASK_ID,
      taskName: 'Water heater flush',
      area: 'Building',
      frequencyDays: 180,
      lastDoneDate: '2026-01-01',
      dueDate: '2026-06-30',
    });

  test('the catalog accepts it', () => {
    assert.equal(createWorkOrderAction.validate(plan()), null);
  });

  test('it carries the schedule link, which is what closes the loop', () => {
    assert.equal(plan().preventive_task_id, TASK_ID);
  });

  test('the plan does NOT move as the task gets later', () => {
    // The whole reason: proposeAction supersedes and re-proposes whenever the
    // plan changes, so a measurement baked in here would churn a brand-new
    // offer every single night for the same problem.
    const drafts = (day: string) => detectPreventiveDue(ctx([task({ nextDueDate: '2026-06-30' })], day));
    const monday = preventiveActionFor(drafts('2026-07-26')[0])!;
    const muchLater = preventiveActionFor(drafts('2026-09-26')[0])!;
    assert.deepEqual(monday.params, muchLater.params);
  });

  test('what must still be true at the tap is the last-done INSTANT', () => {
    const [draft] = detectPreventiveDue(ctx([task({ nextDueDate: '2026-06-30' })]));
    assert.deepEqual(preventiveActionFor(draft)!.verify, {
      preventive_task_id: TASK_ID,
      task_name: 'Water heater flush',
      last_completed_at: '2026-01-01T00:00:00+00:00',
    });
  });

  test('an id that is not an id is refused before it can be frozen', () => {
    assert.ok(
      createWorkOrderAction.validate({ ...plan(), preventive_task_id: 'Robert; DROP TABLE' }),
    );
  });

  test('half a link is refused in both directions', () => {
    const { preventive_task_name: _n, ...noName } = plan();
    assert.ok(createWorkOrderAction.validate(noName));
    const { preventive_task_id: _i, ...noId } = plan();
    assert.ok(createWorkOrderAction.validate(noId));
  });

  test('the sentence names the JOB, not the room, and does so in both languages', () => {
    const offer = createWorkOrderAction.offer(plan());
    assert.match(offer.en, /Water heater flush/);
    assert.match(offer.es, /Water heater flush/);
    assert.match(offer.es, /^¿Crear/);
    // The receipt says the part a manager cannot guess: closing that ticket is
    // what marks the upkeep task done.
    const receipt = createWorkOrderAction.receiptLine(
      { table: 'work_orders', id: 'w1', kind: 'created', label: 'x', where: 'Building' },
      plan(),
    );
    assert.match(receipt.en, /marks this upkeep task done/);
    assert.match(receipt.es, /queda marcada como hecha/);
  });

  test('the repeat-location plan is untouched — its frozen shape did not change', () => {
    // A new key here would change every standing offer's fingerprint and
    // supersede it for no visible reason. Byte-for-byte, deliberately.
    assert.deepEqual(Object.keys(createWorkOrderParams('Room 214')).sort(), [
      'description',
      'location',
      'outcome_check_days',
      'severity',
      'submitted_by_name',
      'submitter_role',
    ]);
    assert.match(createWorkOrderAction.offer(createWorkOrderParams('Room 214')).en, /full inspection/);
  });
});

// ─── The buttons ────────────────────────────────────────────────────────────

describe('a preventive card offers the two answers that exist', () => {
  const verdicts = (disposition: FindingDisposition, detectorId?: string) =>
    closureButtons({ disposition, detectorId }, 'en').map((b) => b.verdict);

  test('the due card: done, called, or stop watching', () => {
    assert.deepEqual(verdicts('propose', 'preventive_due'), ['pm_done', 'pm_called', 'muted']);
  });

  test('the follow-up card: same two facts, still mutable', () => {
    assert.deepEqual(verdicts('recommend', 'preventive_due'), ['pm_done', 'pm_called', 'muted']);
  });

  test('"known problem" is deliberately ABSENT — the whole point is that it remembers', () => {
    for (const d of ['propose', 'recommend'] as const) {
      assert.ok(!verdicts(d, 'preventive_due').includes('known_problem'));
    }
  });

  test('every other card is exactly as it was', () => {
    assert.deepEqual(verdicts('propose'), ['known_problem', 'resolved', 'muted']);
    assert.deepEqual(verdicts('recommend'), ['resolved', 'known_problem', 'muted']);
    assert.deepEqual(verdicts('fyi'), ['known_problem']);
    // A detector with no entry in the override table falls through unchanged —
    // adding a detector must not require touching that file.
    assert.deepEqual(verdicts('propose', 'repeat_room_work_orders'), [
      'known_problem',
      'resolved',
      'muted',
    ]);
  });

  test('both preventive buttons say what they cost, in both languages', () => {
    for (const lang of ['en', 'es'] as const) {
      const buttons = closureButtons({ disposition: 'propose', detectorId: 'preventive_due' }, lang);
      const done = buttons.find((b) => b.verdict === 'pm_done')!;
      const called = buttons.find((b) => b.verdict === 'pm_called')!;
      assert.ok(done.label.length > 0 && called.label.length > 0);
      assert.ok(done.hint, 'restarting the clock is a stored change and must be stated');
      assert.ok(called.hint, 'a manager who is not told about the week reads the follow-up as a nag');
      // Neither is behind a confirm: both are reversible by tapping the other.
      assert.equal(done.confirm, null);
      assert.equal(called.confirm, null);
    }
    // Muting is the one that cannot be walked back, so it asks first.
    const mute = closureButtons(
      { disposition: 'propose', detectorId: 'preventive_due' },
      'en',
    ).find((b) => b.verdict === 'muted')!;
    assert.ok(mute.confirm);
  });
});

// ─── The Maintenance tab's own write path ───────────────────────────────────

describe('the called flag survives the round trip through the row mapper', () => {
  test('setting it sends a real timestamp and a name', () => {
    const at = new Date('2026-07-26T15:00:00.000Z');
    const row = toPreventiveRow({ calledAt: at, calledBy: 'Maria' });
    assert.equal(row.called_at, '2026-07-26T15:00:00.000Z');
    assert.equal(row.called_by, 'Maria');
  });

  test('a patch that is not about the call omits the columns entirely', () => {
    // `dropUndefined` is what makes a partial patch partial. If `called_at`
    // leaked in as null here, every unrelated edit — renaming a task, changing
    // its cadence — would silently clear a pending follow-up.
    const row = toPreventiveRow({ frequencyDays: 90, notes: 'MERV 8' });
    assert.ok(!('called_at' in row), 'an unrelated edit must not touch the call');
    assert.ok(!('called_by' in row));
  });

  test('an explicit null CLEARS it, which is how a finished job stops following up', () => {
    const row = toPreventiveRow({ calledAt: null, calledBy: null });
    assert.equal(row.called_at, null);
    assert.equal(row.called_by, null);
  });

  test('and it reads back as a Date the board can render', () => {
    const task = fromPreventiveRow({
      id: 't1',
      property_id: 'p1',
      name: 'Water heater flush',
      frequency_days: 180,
      called_at: '2026-07-20T00:00:00+00:00',
      called_by: 'Dana',
    });
    assert.ok(task.calledAt instanceof Date);
    assert.equal(task.calledBy, 'Dana');
    // A task nobody called about reads as null, never as a bogus epoch date.
    const quiet = fromPreventiveRow({ id: 't2', property_id: 'p1', name: 'x', frequency_days: 30 });
    assert.equal(quiet.calledAt, null);
    assert.equal(quiet.calledBy, null);
  });
});

// ─── Day zero ───────────────────────────────────────────────────────────────

describe('a hotel that has set nothing up', () => {
  test('produces no cards and no empty-state lie', () => {
    assert.deepEqual(detectPreventiveDue(ctx([])), []);
  });
});

/** A hotel-local date N days before TODAY. */
function daysAgo(n: number): string {
  const at = Date.parse(`${TODAY}T12:00:00Z`) - n * 86_400_000;
  return new Date(at).toISOString().slice(0, 10);
}
