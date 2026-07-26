// ─── Exam days: operational_pattern ──────────────────────────────────────────
//
// The oldest of the three Phase-1 ports. It reads the durable patterns the
// operational-signal layer already aggregates — repeated maintenance, clustered
// complaints, weekend noise on a floor, rooms that keep failing inspection,
// rooms that consistently take longer to clean — and gives them a STATUS
// instead of letting them expire as low-confidence memory rows.
//
// Its thresholds are the ones a hotel already learns from the drip questions
// and the dashboard, so these days pin them in one more place: three of a thing
// at one room in thirty days, or two high-severity complaints, and a room is
// only "slow to clean" at half again the hotel's own typical time. Day 03 is
// the trust case — a room that genuinely runs 20% long is a real fact and not a
// card, because a hotel told about every fifth-percentile room stops reading.

import type { ExamDay, ExamPlanter } from '../types';

/** Cleans at the hotel's typical pace, so a "slow room" has something to be
 *  slow against. */
async function typicalCleans(ctx: ExamPlanter, howMany = 10): Promise<void> {
  for (let i = 0; i < howMany; i += 1) {
    await ctx.cleaningEvent({ date: ctx.ago(2 + i), room: `${401 + i}`, minutes: 25 });
  }
}

export const operationalPatternDays: ExamDay[] = [
  {
    id: 'op-01',
    title: 'four HVAC tickets on room 305 in a month',
    kind: 'clean_positive',
    detector: 'operational_pattern',
    why:
      'Same room, same category, four times. The topic slug is the pattern IDENTITY and never ' +
      'the count, so this is the same row the drip question and the memory layer key on.',
    async seed(ctx) {
      for (const day of [3, 9, 16, 24]) {
        await ctx.pmsWorkOrder({ date: ctx.ago(day), room: '305', category: 'hvac' });
      }
      // Background: real, below every bar.
      await ctx.pmsWorkOrder({ date: ctx.ago(6), room: '210', category: 'plumbing' });
      await ctx.complaint({ date: ctx.ago(5), room: '412', category: 'service' });
      await typicalCleans(ctx);
    },
    expect: [
      {
        detectorId: 'operational_pattern',
        key: 'op_maint_305_hvac',
        why: 'Four is over the three-in-thirty-days bar for one room and one category.',
        magnitude: [4, 4],
        // Nothing for a manager to decide: it is a fact about the building,
        // filed where the rest of the app can find it.
        disposition: 'fyi',
        severity: 'attention',
        price: 'none',
        summaryMatches: /Room 305 has had repeated maintenance issues \(4 hvac work orders in 30 days\)/,
      },
    ],
    silent: [],
  },

  {
    id: 'op-02',
    title: 'a hotel with plenty going on and no pattern in it',
    kind: 'clean_negative',
    detector: 'operational_pattern',
    why:
      'Two HVAC tickets and two plumbing tickets on the same room are four tickets and zero ' +
      'patterns — the categories are what make a pattern, not the room. Same for complaints ' +
      'spread across three kinds and two failed inspections.',
    async seed(ctx) {
      await ctx.pmsWorkOrder({ date: ctx.ago(4), room: '305', category: 'hvac' });
      await ctx.pmsWorkOrder({ date: ctx.ago(11), room: '305', category: 'hvac' });
      await ctx.pmsWorkOrder({ date: ctx.ago(18), room: '305', category: 'plumbing' });
      await ctx.pmsWorkOrder({ date: ctx.ago(25), room: '305', category: 'plumbing' });
      await ctx.complaint({ date: ctx.ago(3), room: '412', category: 'noise' });
      await ctx.complaint({ date: ctx.ago(8), room: '412', category: 'service' });
      await ctx.complaint({ date: ctx.ago(14), room: '412', category: 'cleanliness' });
      await ctx.inspection({ date: ctx.ago(6), room: '210', result: 'fail' });
      await ctx.inspection({ date: ctx.ago(20), room: '210', result: 'fail' });
      await typicalCleans(ctx);
    },
    expect: [],
    silent: [
      {
        detectorId: 'operational_pattern',
        why: 'Nothing clears three of a kind at one place. Busy is not the same as broken.',
      },
    ],
  },

  {
    id: 'op-03',
    title: 'the room that takes 20% longer than typical',
    kind: 'hard_negative',
    detector: 'operational_pattern',
    why:
      'Room 301 really does run thirty minutes against a hotel that averages twenty-five. That ' +
      'is a true fact and a terrible card: half the rooms in any hotel are above its median. ' +
      'The bar is half again the typical time, and it is there so this stays quiet.',
    async seed(ctx) {
      await typicalCleans(ctx);
      for (let i = 0; i < 5; i += 1) {
        await ctx.cleaningEvent({ date: ctx.ago(2 + i), room: '301', minutes: 30 });
      }
      // And a genuinely slow room nobody has cleaned enough times to judge.
      for (let i = 0; i < 4; i += 1) {
        await ctx.cleaningEvent({ date: ctx.ago(2 + i), room: '302', minutes: 60 });
      }
    },
    expect: [],
    silent: [
      {
        detectorId: 'operational_pattern',
        why: 'One room is not slow enough to matter; the other has not been cleaned enough times to know.',
      },
    ],
  },

  {
    id: 'op-04',
    title: 'exactly three complaints about one room',
    kind: 'edge_positive',
    detector: 'operational_pattern',
    why: 'Three of a kind at one room in thirty days is the bar, and the bar has to hold.',
    async seed(ctx) {
      for (const day of [4, 12, 21]) {
        await ctx.complaint({ date: ctx.ago(day), room: '412', category: 'cleanliness' });
      }
      await typicalCleans(ctx);
    },
    expect: [
      {
        detectorId: 'operational_pattern',
        key: 'op_complaint_412_cleanliness',
        why: 'Three cleanliness complaints, one room, thirty days.',
        magnitude: [3, 3],
        disposition: 'fyi',
        summaryMatches: /Room 412 has had recurring guest complaints \(3 cleanliness complaints in 30 days\)/,
      },
    ],
    silent: [],
  },

  {
    id: 'op-05',
    title: 'two complaints, one of them serious',
    kind: 'edge_negative',
    detector: 'operational_pattern',
    why:
      'Two complaints is under the count bar, and ONE high-severity is under the severity bar ' +
      '(which is two). Either one alone fires; neither half does.',
    async seed(ctx) {
      await ctx.complaint({ date: ctx.ago(4), room: '412', category: 'cleanliness', severity: 'high' });
      await ctx.complaint({ date: ctx.ago(15), room: '412', category: 'cleanliness', severity: 'low' });
      await typicalCleans(ctx);
    },
    expect: [],
    silent: [
      { detectorId: 'operational_pattern', why: 'Under both bars at once.' },
    ],
  },
];
