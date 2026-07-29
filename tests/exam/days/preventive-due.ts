// ─── Exam days: preventive_due ───────────────────────────────────────────────
//
// "Water heater flush is due — last done 210 days ago." Staxis cannot know when
// anything at a hotel was last serviced: no PMS carries it, and the ABSENCE of a
// work order is exactly what the problem looks like. So the hotel says it once,
// in Maintenance → Preventive, and this counts forward forever.
//
// WHY THIS DETECTOR IS GRADED DIFFERENTLY FROM EVERY OTHER ONE HERE
// Every other detector in this corpus learns what is normal from the hotel's own
// trailing weeks, so its hard negatives are all shapes of "too little history to
// speak". This one infers NOTHING — the cadence and the last-done date are both
// assertions a human at this hotel made — so it has no baseline to be short of,
// and a day with three weeks of data is not a hard negative for it at all.
//
// Its hard negatives are the three ways a date can look like lateness and not be
// one, and all three are pinned below:
//
//   pm-03  NEVER DONE is not overdue — and is not silence either. With no
//          completion there is no elapsed interval, so counting from created_at
//          would invent a service history the hotel never claimed: the single
//          most tempting wrong answer in the whole feature, because a task
//          somebody set up and never did looks like the most neglected thing in
//          the building. What the day now pins is the narrow line between the
//          two failures: exactly one card per unstarted schedule, at magnitude
//          ZERO, whose sentence reports the missing date and makes no claim of
//          lateness anywhere in it. Silence was the other failure — a hotel that
//          asked to be reminded about something and never could be.
//   pm-04  SOMEBODY HAS BEEN CALLED. Still late, deliberately quiet — a card
//          that kept shouting after a manager arranged the work is the nag this
//          layer exists not to be.
//   pm-05  DUE TOMORROW is not due. The boundary a `<` turned `<=` would move,
//          firing every card at every hotel one day early with no other symptom.
//
// The seeds are deliberately thin on everything except schedules. That is not
// laziness: a preventive card is the one finding in the library that a brand-new
// hotel with no work orders, no counts and no deliveries can legitimately
// produce, and a day that had to plant history first would be testing something
// this detector does not do.

import { setFindingStatus } from '@/lib/findings/store';

import type { ExamDay } from '../types';

/**
 * Schedule ids, fixed per day.
 *
 * The finding's key IS `task:<uuid>` and its target IS the same uuid, so a label
 * cannot name a finding whose id it does not already know — and the grader's
 * substitutions cover `{item0}` and `{businessDate}`, not this. Fixed constants
 * keep the id in the same file as the `expect` entry that quotes it. Distinct
 * across days because `preventive_tasks.id` is a primary key even though each
 * day gets its own hotel.
 */
const PM = (day: number, slot = 1): string =>
  `dddddd33-0000-4000-8000-${String(day).padStart(6, '0')}${String(slot).padStart(6, '0')}`;

export const preventiveDueDays: ExamDay[] = [
  {
    id: 'pm-01',
    title: 'the water heater flush this hotel said was every 180 days, 30 days past its date',
    kind: 'clean_positive',
    detector: 'preventive_due',
    why:
      'The whole trade in one card: they typed the rhythm and the last-done date once, and ' +
      'Staxis has been counting ever since. It arrives with the fix attached, and with no ' +
      'dollar figure at all — what this hotel paid to fix things that BROKE is not what ' +
      'preventive service costs.',
    async seed(ctx) {
      await ctx.preventiveTask({
        id: PM(1, 1),
        name: 'Water heater flush',
        frequencyDays: 180,
        lastDoneDaysAgo: 210,
      });
      // Two schedules that are current. They make the feed busy, and they are
      // the reason a detector that simply fired on every row it read would fail
      // this day rather than pass it.
      await ctx.preventiveTask({
        id: PM(1, 2),
        name: 'PTAC filter clean',
        frequencyDays: 90,
        lastDoneDaysAgo: 30,
        area: 'Guest rooms',
      });
      await ctx.preventiveTask({
        id: PM(1, 3),
        name: 'Elevator inspection',
        frequencyDays: 365,
        lastDoneDaysAgo: 100,
      });
    },
    expect: [
      {
        detectorId: 'preventive_due',
        key: `task:${PM(1, 1)}`,
        why: 'Last done 210 days ago on a 180-day rhythm, so it came due 30 days back.',
        magnitude: [30, 30],
        disposition: 'propose',
        // 30 days late on a 180-day cadence is late, not a skipped cycle.
        severity: 'attention',
        target: { kind: 'preventive_task', value: PM(1, 1) },
        action: { kind: 'create_work_order' },
        price: 'none',
        priceBasisMatches: /no dollar figure: what this hotel has paid to fix things that broke/,
        summaryMatches:
          /^Water heater flush \(Building\) is 30 days past due\. Last done 210 days ago\. This hotel does it every 180 days\.$/,
      },
    ],
    silent: [],
  },

  {
    id: 'pm-02',
    title: 'four schedules, every one of them current',
    kind: 'clean_negative',
    detector: 'preventive_due',
    why:
      'A hotel keeping on top of its upkeep. Four schedules the detector reads in full and has ' +
      'every opportunity to be wrong about — the difference between a day that proves precision ' +
      'and a day that is merely empty.',
    async seed(ctx) {
      await ctx.preventiveTask({ id: PM(2, 1), name: 'Water heater flush', frequencyDays: 180, lastDoneDaysAgo: 20 });
      await ctx.preventiveTask({ id: PM(2, 2), name: 'PTAC filter clean', frequencyDays: 90, lastDoneDaysAgo: 14 });
      await ctx.preventiveTask({ id: PM(2, 3), name: 'Fire extinguisher check', frequencyDays: 365, lastDoneDaysAgo: 200 });
      await ctx.preventiveTask({ id: PM(2, 4), name: 'Clean dryer lint ducts', frequencyDays: 30, lastDoneDaysAgo: 1 });
    },
    expect: [],
    silent: [
      {
        detectorId: 'preventive_due',
        why: 'Every schedule is inside its own cadence. Nothing here is late.',
      },
    ],
  },

  {
    id: 'pm-03',
    title: 'a schedule somebody set up a year ago and has never recorded doing',
    // Fires, and the whole day is about WHAT it is allowed to say. "Due" is a
    // claim that a known interval has elapsed since a known event; with no
    // completion there is no elapsed interval, so every assertion below pins the
    // absence of a lateness claim — magnitude zero, no offer, no "past due" in
    // the sentence — rather than the absence of a card.
    kind: 'clean_positive',
    detector: 'preventive_due',
    why:
      'The most tempting wrong answer in the feature, next to the second-most tempting. "Due" is ' +
      'a claim that a known interval has elapsed since a known event, and with no completion ' +
      'there is no elapsed interval — the only dates available to count from are when somebody ' +
      'typed a row and today, and both invent a service history this hotel never claimed. So: ' +
      'unstarted, not overdue, and said out loud once rather than swallowed.',
    async seed(ctx) {
      await ctx.preventiveTask({
        id: PM(3, 1),
        name: 'Generator load test',
        frequencyDays: 90,
        lastDoneDaysAgo: null,
      });
      // A second never-done schedule, so the day cannot pass by accident on a
      // detector that merely skipped for want of records.
      await ctx.preventiveTask({
        id: PM(3, 2),
        name: 'Backflow preventer test',
        frequencyDays: 365,
        lastDoneDaysAgo: null,
        area: 'Mechanical room',
      });
      // And one current schedule, so the feed clears its declared minimum and
      // the detector genuinely RUNS rather than being reported as a skip.
      await ctx.preventiveTask({
        id: PM(3, 3),
        name: 'PTAC filter clean',
        frequencyDays: 90,
        lastDoneDaysAgo: 10,
        area: 'Guest rooms',
      });
    },
    expect: [
      {
        detectorId: 'preventive_due',
        key: `task:${PM(3, 1)}:never_started`,
        why: 'Nobody has ever recorded doing it, so Staxis cannot count forward — and says so.',
        // ZERO, and the bound is exact. A magnitude here is a lateness, and any
        // non-zero number would be one invented out of a created_at.
        magnitude: [0, 0],
        // Nothing to decide and nothing Staxis can do: a work order for a job
        // with no history would be Staxis guessing the schedule had lapsed.
        disposition: 'fyi',
        severity: 'info',
        target: { kind: 'preventive_task', value: PM(3, 1) },
        action: 'none',
        price: 'none',
        priceBasisMatches: /no dollar figure: nothing here is late yet/,
        // The sentence itself is the assertion: it names the missing date, and
        // the regex would fail the moment "past due" or "overdue" appeared.
        summaryMatches:
          /^Generator load test \(Building\) is on this hotel's upkeep schedule, every 90 days, but has never been marked done, so Staxis cannot tell when it is next due\. Record when it was last done and it starts counting\.$/,
      },
      {
        detectorId: 'preventive_due',
        key: `task:${PM(3, 2)}:never_started`,
        why: 'The second unstarted schedule, so the day cannot pass on a detector that fired once by luck.',
        magnitude: [0, 0],
        disposition: 'fyi',
        severity: 'info',
        target: { kind: 'preventive_task', value: PM(3, 2) },
        action: 'none',
        price: 'none',
      },
    ],
    // No `silent` entry for preventive_due here: it speaks on this day. pm-02
    // is the hard proof that it stays quiet on a hotel that is up to date, and
    // pm-04 that it stays quiet once somebody has been called.
    silent: [],
  },

  {
    id: 'pm-04',
    title: 'thirty-five days late, and somebody was called about it two days ago',
    kind: 'hard_negative',
    detector: 'preventive_due',
    why:
      'Still late, deliberately quiet. A manager who arranged the work and then got the same ' +
      'card again the next morning learns that telling Staxis anything is pointless — so the ' +
      'card rests for a week and then asks once. This is the day that proves the rest is real ' +
      'and not merely promised.',
    async seed(ctx) {
      await ctx.preventiveTask({
        id: PM(4, 1),
        name: 'Fire extinguisher check',
        frequencyDays: 365,
        lastDoneDaysAgo: 400,
        calledDaysAgo: 2,
        calledBy: 'Dana',
      });
      await ctx.preventiveTask({ id: PM(4, 2), name: 'PTAC filter clean', frequencyDays: 90, lastDoneDaysAgo: 10, area: 'Guest rooms' });
    },
    expect: [],
    silent: [
      {
        detectorId: 'preventive_due',
        why: 'Overdue, but arranged two days ago — inside the week the follow-up waits.',
      },
    ],
  },

  {
    id: 'pm-05',
    title: 'due tomorrow',
    kind: 'edge_negative',
    detector: 'preventive_due',
    why:
      'One day under the line. A `<` that became a `<=` would fire every preventive card at ' +
      'every hotel one day early, and the only symptom would be dates a manager slowly stops ' +
      'believing.',
    async seed(ctx) {
      await ctx.preventiveTask({
        id: PM(5, 1),
        name: 'Water heater flush',
        frequencyDays: 180,
        lastDoneDaysAgo: 179,
      });
    },
    expect: [],
    silent: [
      { detectorId: 'preventive_due', why: 'Due tomorrow is not due today.' },
    ],
  },

  {
    id: 'pm-06',
    title: 'due exactly today',
    kind: 'edge_positive',
    detector: 'preventive_due',
    why:
      'The other side of the same line, and the reason it is worth two days: a detector that ' +
      'only fired once something was OVERDUE would be silently late by a day forever, which is ' +
      'the sort of off-by-one no manager could ever report as a bug.',
    async seed(ctx) {
      await ctx.preventiveTask({
        id: PM(6, 1),
        name: 'Water heater flush',
        frequencyDays: 180,
        lastDoneDaysAgo: 180,
      });
    },
    expect: [
      {
        detectorId: 'preventive_due',
        key: `task:${PM(6, 1)}`,
        why: 'Zero days late is due. The card says "due today" rather than "0 days past due".',
        magnitude: [0, 0],
        disposition: 'propose',
        severity: 'attention',
        target: { kind: 'preventive_task', value: PM(6, 1) },
        action: { kind: 'create_work_order' },
        price: 'none',
        summaryMatches: /is due today\. Last done 180 days ago\. This hotel does it every 180 days\.$/,
      },
    ],
    silent: [],
  },

  {
    id: 'pm-07',
    title: 'called eight days ago, and it still is not done',
    kind: 'clean_positive',
    detector: 'preventive_due',
    why:
      'The other half of the rest: it ENDS. A card that went quiet and never came back would ' +
      'lose the job entirely the first time a vendor did not turn up. It comes back as a ' +
      'question rather than an offer — somebody is already on it, and Staxis putting a second ' +
      'ticket on the board for the same job is the failure this layer is built to avoid.',
    async seed(ctx) {
      await ctx.preventiveTask({
        id: PM(7, 1),
        name: 'Fire extinguisher check',
        frequencyDays: 365,
        lastDoneDaysAgo: 400,
        calledDaysAgo: 8,
        calledBy: 'Dana',
      });
    },
    expect: [
      {
        detectorId: 'preventive_due',
        key: `task:${PM(7, 1)}`,
        why: 'Eight days past the seven-day rest, so it asks — once.',
        magnitude: [35, 35],
        // Not `propose`: a follow-up carries no button, so it must not wear the
        // eyebrow that says a decision is waiting.
        disposition: 'recommend',
        severity: 'attention',
        target: { kind: 'preventive_task', value: PM(7, 1) },
        action: 'none',
        price: 'none',
        summaryMatches:
          /^Fire extinguisher check \(Building\) still has not been done, 35 days past due\. Somebody was called about it 8 days ago\.$/,
      },
    ],
    silent: [],
  },

  {
    id: 'pm-08',
    title: 'a weekly job three weeks late is a skipped cycle, not a slipped date',
    kind: 'clean_positive',
    detector: 'preventive_due',
    why:
      'Severity scales off the hotel\'s OWN cadence rather than off a number invented here. ' +
      'Twenty-three days late on a weekly pool check means three rounds nobody did; the same ' +
      'twenty-three days on an annual inspection is a rounding error. A fixed day-count ' +
      'threshold would have to be wrong for one of them.',
    async seed(ctx) {
      await ctx.preventiveTask({
        id: PM(8, 1),
        name: 'Pool chemical balance check',
        frequencyDays: 7,
        lastDoneDaysAgo: 30,
        area: 'Pool',
      });
      // The same lateness on a long cadence, to prove the scaling rather than
      // merely the loud case: 23 days late on 365 is still only "attention".
      await ctx.preventiveTask({
        id: PM(8, 2),
        name: 'Elevator inspection',
        frequencyDays: 365,
        lastDoneDaysAgo: 388,
      });
    },
    expect: [
      {
        detectorId: 'preventive_due',
        key: `task:${PM(8, 1)}`,
        why: 'Three whole weekly rounds missed. A full cadence late or more is critical.',
        magnitude: [23, 23],
        severity: 'critical',
        target: { kind: 'preventive_task', value: PM(8, 1) },
      },
      {
        detectorId: 'preventive_due',
        key: `task:${PM(8, 2)}`,
        why: 'Identical lateness, annual rhythm: late, but not a skipped round.',
        magnitude: [23, 23],
        severity: 'attention',
        target: { kind: 'preventive_task', value: PM(8, 2) },
      },
    ],
    silent: [],
  },

  {
    id: 'pm-09',
    title: 'a week later it is a week later, not a second card',
    kind: 'silencer',
    detector: 'preventive_due',
    why:
      'The identity of this problem is the SCHEDULE. A dedupe key that carried the days-late ' +
      'count would open a fresh card every single night for as long as the job went undone — ' +
      'the exact pile-up the ledger exists to prevent, and it would pass every other day here.',
    async seed(ctx) {
      await ctx.preventiveTask({
        id: PM(9, 1),
        name: 'Water heater flush',
        frequencyDays: 180,
        lastDoneDaysAgo: 190,
      });
    },
    expect: [
      {
        detectorId: 'preventive_due',
        key: `task:${PM(9, 1)}`,
        why: 'Night one: ten days past its date.',
        magnitude: [10, 10],
        disposition: 'propose',
      },
    ],
    silent: [],
    secondNight: {
      why:
        'A manager reads it and taps "known problem" at ten days late. Seventeen is not twice ' +
        'ten AND fourteen more, so it stays quiet — consent to ten was not consent to a skipped ' +
        'year, but it was consent to a fortnight.',
      async handOfTheManager(ctx) {
        const rows = await ctx.pg.query<{ id: string }>(
          `select id from findings
             where property_id = $1 and dedupe_key = $2`,
          [ctx.propertyId, `preventive_due:task:${PM(9, 1)}`],
        );
        await setFindingStatus(ctx.propertyId, rows.rows[0].id, 'known_problem', null, ctx.now);
      },
      async mutate(ctx) {
        // Seven more days of nobody doing it, expressed as the last-done date
        // receding — which is how this schedule's lateness actually grows.
        await ctx.pg.query(
          `update preventive_tasks set last_completed_at = $2 where id = $1`,
          [PM(9, 1), ctx.atNoon(ctx.ago(197))],
        );
      },
      // Silenced, and 17 does not clear the escalation bar (>= 20 AND >= 24).
      // Nothing surfaces, and the row is still the one row.
      expect: [],
      maxTotalRows: 1,
    },
  },
];
