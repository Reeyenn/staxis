// ─── Exam days: room_needs_attention ─────────────────────────────────────────
//
// The nudge layer's operational alerts, ported into the ledger without touching
// the nudge cron: a room that has been in progress far longer than a clean
// usually takes. What changed when it became a finding is that "room 214 ran
// long again" now survives as something countable instead of vanishing the
// moment the notification was read.
//
// THE IDENTITY IS (WHAT, WHICH ROOM, WHICH DAY), and it has to be. A room
// running long today and running long tomorrow are two events, not one ongoing
// problem, which is why this detector's cards go stale after a single day.
//
// Day 05 is the one that matters for trust: a clean that TOOK three hours and
// finished is not a room that needs somebody. Nagging about finished work is
// the fastest way to teach a housekeeping manager to ignore the pill.

import type { ExamDay } from '../types';

export const roomAttentionDays: ExamDay[] = [
  {
    id: 'attn-01',
    title: 'room 214 has been in progress for two hours',
    kind: 'clean_positive',
    detector: 'room_needs_attention',
    why:
      'A clean usually takes twenty-five minutes. Two hours in with nothing back means the ' +
      'housekeeper is stuck, or the room is worse than the board says, or somebody forgot to ' +
      'close it — all three are worth a manager walking up there.',
    async seed(ctx) {
      for (const room of ['211', '212', '213', '214']) await ctx.pmsRoom({ room });
      await ctx.hkAssignment({ room: '211', completed: true });
      await ctx.hkAssignment({ room: '212' });
      await ctx.hkAssignment({ room: '213', startedMinutesAgo: 20 });
      await ctx.hkAssignment({ room: '214', startedMinutesAgo: 120 });
    },
    expect: [
      {
        detectorId: 'room_needs_attention',
        key: 'overdue_room:{businessDate}:214',
        why: 'Magnitude is the observed minutes — the number a manager would check against.',
        magnitude: [120, 130],
        disposition: 'recommend',
        severity: 'attention',
        target: { kind: 'room', value: '214' },
        price: 'none',
        summaryMatches: /Room 214 has been in progress for 1[23]\d min/,
      },
    ],
    silent: [
      {
        detectorId: 'cleaning_plan_health',
        why:
          'The cleaning plan computed for every room on this board. This is also the day that ' +
          'proves the rules engine can read its own reservations table at all.',
      },
    ],
  },

  {
    id: 'attn-02',
    title: 'a normal morning on the housekeeping board',
    kind: 'clean_negative',
    detector: 'room_needs_attention',
    why:
      'Six rooms, two done, one twenty minutes in, three not started. This is what every ' +
      'morning looks like and none of it is a finding.',
    async seed(ctx) {
      for (const room of ['201', '202', '203', '204', '205', '206']) await ctx.pmsRoom({ room });
      await ctx.hkAssignment({ room: '201', completed: true });
      await ctx.hkAssignment({ room: '202', completed: true });
      await ctx.hkAssignment({ room: '203', startedMinutesAgo: 20 });
      await ctx.hkAssignment({ room: '204' });
      await ctx.hkAssignment({ room: '205' });
      await ctx.hkAssignment({ room: '206' });
    },
    expect: [],
    silent: [
      { detectorId: 'room_needs_attention', why: 'Nothing has been open long enough to matter.' },
      { detectorId: 'cleaning_plan_health', why: 'The plan computed for the whole board.' },
    ],
  },

  {
    id: 'attn-03',
    title: 'ninety-one minutes',
    kind: 'edge_positive',
    detector: 'room_needs_attention',
    why: 'Ninety minutes is the line. One minute past it is the first minute worth a nudge.',
    async seed(ctx) {
      await ctx.pmsRoom({ room: '214' });
      await ctx.hkAssignment({ room: '214', startedMinutesAgo: 91 });
    },
    expect: [
      {
        detectorId: 'room_needs_attention',
        key: 'overdue_room:{businessDate}:214',
        why: 'Just over the line, and the line is where it is on purpose.',
        magnitude: [91, 99],
        target: { kind: 'room', value: '214' },
      },
    ],
    silent: [{ detectorId: 'cleaning_plan_health', why: 'One room, planned fine.' }],
  },

  {
    id: 'attn-04',
    title: 'eighty-five minutes',
    kind: 'edge_negative',
    detector: 'room_needs_attention',
    why:
      'An hour and a half is a long clean, not a stuck one. A detector that speaks here would ' +
      'fire on every deep clean in the building.',
    async seed(ctx) {
      await ctx.pmsRoom({ room: '214' });
      await ctx.hkAssignment({ room: '214', startedMinutesAgo: 85 });
    },
    expect: [],
    silent: [
      { detectorId: 'room_needs_attention', why: 'Inside the ninety-minute line.' },
      { detectorId: 'cleaning_plan_health', why: 'One room, planned fine.' },
    ],
  },

  {
    id: 'attn-05',
    title: 'a three-hour clean that FINISHED',
    kind: 'hard_negative',
    detector: 'room_needs_attention',
    why:
      'The room was open for two hundred minutes and is done. Nobody needs to walk up there. ' +
      'A detector that measures elapsed time without checking whether the work ended turns ' +
      'every hard morning into a pile of false alarms.',
    async seed(ctx) {
      await ctx.pmsRoom({ room: '214' });
      await ctx.pmsRoom({ room: '215' });
      await ctx.hkAssignment({ room: '214', startedMinutesAgo: 200, completed: true });
      await ctx.hkAssignment({ room: '215', startedMinutesAgo: 15 });
    },
    expect: [],
    silent: [
      { detectorId: 'room_needs_attention', why: 'Finished work is not work in progress.' },
      { detectorId: 'cleaning_plan_health', why: 'The plan computed for both rooms.' },
    ],
  },
];
