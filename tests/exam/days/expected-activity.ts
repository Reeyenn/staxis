// ─── Exam days: expected_activity_stopped ────────────────────────────────────
//
// Staff data fails by OMISSION, and nothing else in Staxis catches that. Every
// other check reads what was written down; this one reads what wasn't. A hotel
// that logged its numbers every day for six weeks and has logged nothing for
// nine days does not have a quieter hotel — it has a data problem, and every
// screen downstream is still saying "all clear".
//
// THE RHYTHM IS THE HOTEL'S, NEVER OURS.
// There is no configured cadence anywhere in the detector. Day 03 is the one
// that proves it: a hotel whose counts sometimes slip nine days has DEMONSTRATED
// that nine days is survivable there, and a card on day eight is how a watcher
// turns into noise. Day 04 is the other half — a hotel that has done a thing
// twice has no rhythm to break, so it gets silence rather than a scold measured
// against a cadence Staxis invented.

import type { ExamDay, ExamPlanter } from '../types';

/** Daily numbers recorded every day, ending `silentDays` ago. */
async function dailyLogs(ctx: ExamPlanter, days: number, silentDays: number): Promise<void> {
  for (let i = 0; i < days; i += 1) await ctx.dailyLog(ctx.ago(silentDays + i));
}

/** Counts on a steady rhythm, the most recent one `silentDays` ago. */
async function counts(
  ctx: ExamPlanter,
  spec: { everyNDays: number; occurrences: number; silentDays: number; varianceCents?: number[] },
): Promise<void> {
  let stock = 2_000;
  for (let i = spec.occurrences - 1; i >= 0; i -= 1) {
    stock -= 12;
    await ctx.count({
      date: ctx.ago(spec.silentDays + i * spec.everyNDays),
      stock,
      varianceValueCents: spec.varianceCents?.[spec.occurrences - 1 - i] ?? null,
    });
  }
}

/** A hotel that logs maintenance about weekly and is still doing it. */
async function healthyMaintenance(ctx: ExamPlanter): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await ctx.workOrder({ date: ctx.ago(2 + i * 7), location: `Room ${201 + i}` });
  }
}

export const expectedActivityDays: ExamDay[] = [
  {
    id: 'absence-01',
    title: 'nobody has recorded the daily numbers in nine days',
    kind: 'clean_positive',
    detector: 'expected_activity_stopped',
    why:
      'Forty consecutive days of daily logs, then nine days of nothing. This is the shape that ' +
      'caught a real dead cron on the live hotel the week the layer shipped.',
    async seed(ctx) {
      await dailyLogs(ctx, 40, 9);
      await counts(ctx, { everyNDays: 3, occurrences: 8, silentDays: 1 });
      await healthyMaintenance(ctx);
    },
    expect: [
      {
        detectorId: 'expected_activity_stopped',
        key: 'stopped:daily_log_closings',
        why: 'Nine days against a rhythm of one. Magnitude is the silence itself, in days.',
        magnitude: [9, 9],
        // A question, not an instruction: Staxis does not know whether the
        // stream died or the hotel stopped, and says so by asking.
        disposition: 'ask',
        price: 'none',
        priceBasisMatches: /nothing in this hotel's own records puts a price on this/,
        summaryMatches: /Nobody has been recording the daily numbers for 9 days/,
      },
    ],
    silent: [
      {
        detectorId: 'expected_activity_stopped',
        why:
          'The OTHER two streams are healthy — counting and maintenance both happened this week. ' +
          'One card, not three.',
      },
      { detectorId: 'repeat_room_work_orders', why: 'Four tickets in thirty days, all different rooms.' },
    ],
  },

  {
    id: 'absence-02',
    title: 'counting stopped, and this hotel knows what counting is worth',
    kind: 'clean_positive',
    detector: 'expected_activity_stopped',
    why:
      'Counts every three days for a month and a half, then nine days of nothing — priced from ' +
      'the only honest basis there is: the stock their own counts have been finding the books ' +
      'could not account for.',
    async seed(ctx) {
      await dailyLogs(ctx, 40, 1);
      await counts(ctx, {
        everyNDays: 3,
        occurrences: 12,
        silentDays: 9,
        varianceCents: [4_000, 4_500, 5_000, 5_500, 6_000, 6_500, 7_000, 7_500, 8_000, 8_500, 9_000, 9_500],
      });
      await healthyMaintenance(ctx);
    },
    expect: [
      {
        detectorId: 'expected_activity_stopped',
        key: 'stopped:inventory_counts',
        why: 'Nine days silent against a three-day rhythm, with a six-day tolerance.',
        magnitude: [9, 9],
        disposition: 'ask',
        price: {
          lowCents: [5_000, 5_000],
          highCents: [8_500, 8_500],
          basisMatches: /each turned up \$54–\$81 of stock the books could not account for/,
        },
      },
    ],
    silent: [
      {
        detectorId: 'inventory_usage_baseline',
        why: 'Twelve counts is enough to have an opinion about the rate, and the rate has not moved.',
      },
      { detectorId: 'repeat_room_work_orders', why: 'Four tickets in thirty days, all different rooms.' },
    ],
  },

  {
    id: 'absence-03',
    title: 'a hotel whose counts sometimes slip nine days',
    kind: 'hard_negative',
    detector: 'expected_activity_stopped',
    why:
      'The typical gap here is three days, but this hotel has taken nine more than once and ' +
      'nothing bad happened. Eight days of quiet is inside what they have DEMONSTRATED is ' +
      'survivable, so a card on day eight would be pure noise.',
    async seed(ctx) {
      await dailyLogs(ctx, 40, 1);
      // Gaps: 2, 3, 4, 9, 3, 2, 3, 9, 2, 3, 4 — a real hotel's rhythm, not a metronome's.
      const daysAgo = [8, 12, 15, 17, 26, 29, 31, 34, 43, 47, 50, 52];
      let stock = 2_000;
      for (const day of [...daysAgo].reverse()) {
        stock -= 12;
        await ctx.count({ date: ctx.ago(day), stock });
      }
      await healthyMaintenance(ctx);
    },
    expect: [],
    silent: [
      {
        detectorId: 'expected_activity_stopped',
        why: 'Eight days is shorter than the long-but-normal wait this hotel routinely takes.',
      },
      { detectorId: 'repeat_room_work_orders', why: 'Four tickets in thirty days, all different rooms.' },
    ],
  },

  {
    id: 'absence-04',
    title: 'a hotel that has counted twice, ever',
    kind: 'hard_negative',
    detector: 'expected_activity_stopped',
    why:
      'Forty days since the last count and it means nothing, because two occurrences is not a ' +
      'habit. No rhythm on record → no expectation → no finding. That is the honesty rule, and ' +
      'it is why this detector says nothing at all about a hotel in its first month.',
    async seed(ctx) {
      await dailyLogs(ctx, 40, 1);
      await counts(ctx, { everyNDays: 5, occurrences: 2, silentDays: 40 });
    },
    expect: [],
    silent: [
      {
        detectorId: 'expected_activity_stopped',
        why: 'Two counts is not a cadence, however long the silence since.',
      },
    ],
  },

  {
    id: 'absence-05',
    title: 'exactly at the tolerance',
    kind: 'edge_positive',
    detector: 'expected_activity_stopped',
    why:
      'A three-day rhythm earns a six-day tolerance — twice the usual gap. Six days of silence ' +
      'is the first day worth mentioning, and it must be mentioned.',
    async seed(ctx) {
      await dailyLogs(ctx, 40, 1);
      await counts(ctx, { everyNDays: 3, occurrences: 12, silentDays: 6 });
    },
    expect: [
      {
        detectorId: 'expected_activity_stopped',
        key: 'stopped:inventory_counts',
        why: 'Six days silent, tolerance six.',
        magnitude: [6, 6],
        price: 'none',
        priceBasisMatches: /no dollar figure: this hotel has only 0 records/,
      },
    ],
    silent: [
      { detectorId: 'inventory_usage_baseline', why: 'The rate is steady; only the counting stopped.' },
    ],
  },

  {
    id: 'absence-06',
    title: 'one day inside the tolerance',
    kind: 'edge_negative',
    detector: 'expected_activity_stopped',
    why:
      'Five days of quiet on a three-day rhythm. Every hotel has a slow week; a watcher that ' +
      'speaks here is a watcher nobody reads by Friday.',
    async seed(ctx) {
      await dailyLogs(ctx, 40, 1);
      await counts(ctx, { everyNDays: 3, occurrences: 12, silentDays: 5 });
    },
    expect: [],
    silent: [
      { detectorId: 'expected_activity_stopped', why: 'Inside the tolerance the hotel earned.' },
      { detectorId: 'inventory_usage_baseline', why: 'The rate is steady; nothing to say.' },
    ],
  },
];
