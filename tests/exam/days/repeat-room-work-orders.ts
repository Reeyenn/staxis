// ─── Exam days: repeat_room_work_orders ──────────────────────────────────────
//
// "Room 214 has had four work orders in the last thirty days." Every one of
// them was small enough to fix and forget; nobody adds them up, because nobody
// is looking at the ROOM, they are looking at faults. The pattern only exists
// in the aggregate — which is the sort of thing a piece of code that never gets
// tired is good for.
//
// THIS IS THE FIRST DETECTOR WHOSE CARDS ARRIVE WITH A BUTTON, so these days
// grade the offer as well as the finding: an offer only exists when something
// is still open (nothing to add to a board somebody is evidently working), and
// the window the card claims has to be the window the execute transaction
// re-checks. Exam day 02 is that second one, and it is the day that caught a
// live bug: the loader was grouping locations over ninety-eight days while the
// card said thirty and `staxis_execute_finding_action` re-counted thirty.

import { setFindingStatus } from '@/lib/findings/store';

import type { ExamDay, ExamPlanter } from '../types';

/** Background maintenance: one ticket each at a spread of places. */
async function scatteredTickets(ctx: ExamPlanter, howMany: number, startDay = 3): Promise<void> {
  for (let i = 0; i < howMany; i += 1) {
    await ctx.workOrder({ date: ctx.ago(startDay + i), location: `Room ${301 + i}`, status: 'resolved' });
  }
}

export const repeatRoomWorkOrderDays: ExamDay[] = [
  {
    id: 'room-wo-01',
    title: 'four tickets on room 214, two still open',
    kind: 'clean_positive',
    detector: 'repeat_room_work_orders',
    why:
      'The pattern nobody sees because nobody looks at the room. Four faults in a month with ' +
      'two still open, so Staxis has something to add: an inspection of the place as a whole.',
    async seed(ctx) {
      await ctx.workOrder({ date: ctx.ago(2), location: 'Room 214', status: 'submitted' });
      await ctx.workOrder({ date: ctx.ago(9), location: 'Room 214', status: 'in_progress' });
      await ctx.workOrder({ date: ctx.ago(17), location: 'Room 214', status: 'resolved', repairCostCents: 21_000 });
      await ctx.workOrder({ date: ctx.ago(26), location: 'Room 214', status: 'resolved', repairCostCents: 39_000 });
      await ctx.workOrder({ date: ctx.ago(40), location: 'Lobby', status: 'resolved', repairCostCents: 26_000 });
      await scatteredTickets(ctx, 5);
    },
    expect: [
      {
        detectorId: 'repeat_room_work_orders',
        key: 'location:Room 214',
        why: 'Four tickets at one place inside thirty days, two of them still open.',
        magnitude: [4, 4],
        disposition: 'propose',
        severity: 'attention',
        target: { kind: 'room', value: '214' },
        action: { kind: 'create_work_order' },
        price: {
          // Four tickets at the $210-$390 this hotel has actually paid to fix things.
          lowCents: [80_000, 80_000],
          highCents: [160_000, 160_000],
          basisMatches: /4 work orders at \$210–\$390 each — the range of the 3 repair costs this hotel has recorded/,
        },
        summaryMatches: /Room 214 has had 4 work orders in the last 30 days — 2 still open\./,
      },
    ],
    silent: [],
  },

  {
    id: 'room-wo-02',
    title: 'four tickets on room 402 — spread over three months',
    kind: 'hard_negative',
    detector: 'repeat_room_work_orders',
    why:
      'One fault a month at the same room is a building, not a pattern. Saying "4 work orders ' +
      'in the last 30 days" here would be false on its face, and the one-tap offer would then ' +
      're-count thirty days, find nothing open, and tell the manager somebody is already on it ' +
      'when nobody is. The card, the receipt and the transaction must measure one thing.',
    async seed(ctx) {
      await ctx.workOrder({ date: ctx.ago(12), location: 'Room 402', status: 'submitted' });
      await ctx.workOrder({ date: ctx.ago(44), location: 'Room 402', status: 'submitted' });
      await ctx.workOrder({ date: ctx.ago(66), location: 'Room 402', status: 'submitted' });
      await ctx.workOrder({ date: ctx.ago(88), location: 'Room 402', status: 'submitted' });
      await scatteredTickets(ctx, 4);
    },
    expect: [],
    silent: [
      {
        detectorId: 'repeat_room_work_orders',
        why: 'Only one of room 402\'s four tickets is inside the window the card would claim.',
      },
    ],
  },

  {
    id: 'room-wo-03',
    title: 'a busy maintenance board with nothing repeating',
    kind: 'clean_negative',
    detector: 'repeat_room_work_orders',
    why:
      'Twenty tickets in thirty days across twenty places is a hotel being run properly. A ' +
      'detector that finds a pattern in that is finding one in noise.',
    async seed(ctx) {
      await scatteredTickets(ctx, 20, 2);
    },
    expect: [],
    silent: [
      { detectorId: 'repeat_room_work_orders', why: 'Busy, and not one place twice.' },
    ],
  },

  {
    id: 'room-wo-04',
    title: 'two tickets at one place is a bad fortnight',
    kind: 'edge_negative',
    detector: 'repeat_room_work_orders',
    why:
      'Three in thirty days is the bar, matched deliberately to the operational-signal layer so ' +
      'a hotel never learns two definitions of "this keeps happening" from one app.',
    async seed(ctx) {
      await ctx.workOrder({ date: ctx.ago(4), location: 'Room 214', status: 'submitted' });
      await ctx.workOrder({ date: ctx.ago(19), location: 'Room 214', status: 'submitted' });
      await scatteredTickets(ctx, 4);
    },
    expect: [],
    silent: [{ detectorId: 'repeat_room_work_orders', why: 'Two is under the bar.' }],
  },

  {
    id: 'room-wo-05',
    title: 'exactly three, and the team has already closed all of them',
    kind: 'edge_positive',
    detector: 'repeat_room_work_orders',
    why:
      'Worth knowing — three faults in a month at one place is a pattern. Not worth a button: ' +
      'somebody is evidently on it, so the card drops to a recommendation and carries no offer. ' +
      'And with two recorded repair costs there is no honest range, so it quotes no money.',
    async seed(ctx) {
      await ctx.workOrder({ date: ctx.ago(3), location: 'Room 214', status: 'resolved', repairCostCents: 18_000 });
      await ctx.workOrder({ date: ctx.ago(14), location: 'Room 214', status: 'resolved', repairCostCents: 25_000 });
      await ctx.workOrder({ date: ctx.ago(27), location: 'Room 214', status: 'resolved' });
      await scatteredTickets(ctx, 4, 5);
    },
    expect: [
      {
        detectorId: 'repeat_room_work_orders',
        key: 'location:Room 214',
        why: 'Three in thirty days, nothing left open.',
        magnitude: [3, 3],
        disposition: 'recommend',
        action: 'none',
        target: { kind: 'room', value: '214' },
        price: 'none',
        priceBasisMatches: /recorded a repair cost on only 2 work orders/,
        summaryMatches: /Room 214 has had 3 work orders in the last 30 days — all of them closed\./,
      },
    ],
    silent: [],
  },

  {
    id: 'room-wo-06',
    title: 'a fifth fault tomorrow is the same room, not a second card',
    kind: 'silencer',
    detector: 'repeat_room_work_orders',
    why:
      'The identity of this problem is the PLACE. A dedupe key that carried the count would ' +
      'open a new card every night a ticket landed, which is precisely the pile-up the ledger ' +
      'exists to prevent — and it would pass every non-silencer day in this corpus.',
    async seed(ctx) {
      await ctx.workOrder({ date: ctx.ago(2), location: 'Room 214', status: 'submitted' });
      await ctx.workOrder({ date: ctx.ago(9), location: 'Room 214', status: 'in_progress' });
      await ctx.workOrder({ date: ctx.ago(17), location: 'Room 214', status: 'submitted' });
      await scatteredTickets(ctx, 4);
    },
    expect: [
      {
        detectorId: 'repeat_room_work_orders',
        key: 'location:Room 214',
        why: 'Night one: three tickets, all open.',
        magnitude: [3, 3],
      },
    ],
    silent: [],
    secondNight: {
      why: 'Two more faults at the same room. One row, a bigger number, a louder severity.',
      async mutate(ctx) {
        await ctx.workOrder({ date: ctx.ago(1), location: 'Room 214', status: 'submitted' });
        await ctx.workOrder({ date: ctx.ago(1), location: 'Room 214', status: 'submitted' });
      },
      expect: [
        {
          detectorId: 'repeat_room_work_orders',
          key: 'location:Room 214',
          why: 'Five now. Six or more would make it critical; five is still attention.',
          magnitude: [5, 5],
          severity: 'attention',
        },
      ],
      maxTotalRows: 1,
    },
  },

  {
    id: 'room-wo-07',
    title: 'known problem at three; six is a different problem wearing the name',
    kind: 'silencer',
    detector: 'repeat_room_work_orders',
    why:
      'A manager who tapped "known problem" at three faults consented to three. Six is twice ' +
      'that and three more in absolute terms, so it earns its way back onto the screen — and ' +
      'comes back CRITICAL, because six in a month is a different room.',
    async seed(ctx) {
      await ctx.workOrder({ date: ctx.ago(2), location: 'Room 214', status: 'submitted' });
      await ctx.workOrder({ date: ctx.ago(9), location: 'Room 214', status: 'in_progress' });
      await ctx.workOrder({ date: ctx.ago(17), location: 'Room 214', status: 'submitted' });
      await scatteredTickets(ctx, 4);
    },
    expect: [
      {
        detectorId: 'repeat_room_work_orders',
        key: 'location:Room 214',
        why: 'Night one: the card the manager silences at three.',
        magnitude: [3, 3],
      },
    ],
    silent: [],
    secondNight: {
      why: 'Silenced at three, then three more land. Back, and louder.',
      async handOfTheManager(ctx) {
        const rows = await ctx.pg.query<{ id: string }>(
          `select id from findings
             where property_id = $1 and dedupe_key = 'repeat_room_work_orders:location:Room 214'`,
          [ctx.propertyId],
        );
        await setFindingStatus(ctx.propertyId, rows.rows[0].id, 'known_problem', null, ctx.now);
      },
      async mutate(ctx) {
        for (let i = 0; i < 3; i += 1) {
          await ctx.workOrder({ date: ctx.ago(1), location: 'Room 214', status: 'submitted' });
        }
      },
      expect: [
        {
          detectorId: 'repeat_room_work_orders',
          key: 'location:Room 214',
          why: 'Six is >= 3 x 2 AND >= 3 more than the three they consented to. Both conditions, on purpose.',
          magnitude: [6, 6],
          severity: 'critical',
        },
      ],
      maxTotalRows: 1,
    },
  },
];
