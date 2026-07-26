// ─── Exam days: repeat_equipment_work_orders ─────────────────────────────────
//
// "The 2019 PTAC batch has had four work orders in the last sixty days." Four
// faults, four different rooms, four different weeks, four different people
// writing the ticket — and not one of them remarkable on its own. The
// per-location detector cannot see this at all: by ITS grouping it is four rooms
// with one ticket each, which is a hotel being run properly. The only thing
// those tickets share is the asset behind them.
//
// WHICH MAKES THE HARD NEGATIVE THE MOST IMPORTANT DAY IN THIS FILE.
// A detector that groups by asset is one sloppy threshold away from announcing
// "your equipment is failing" at a hotel whose ice machine, pool pump, lobby
// HVAC and laundry washer each needed attention once. That is not a batch dying,
// it is a building being maintained — and eq-wo-02 plants exactly it, with
// EIGHT linked tickets across four assets, so the detector has every chance to
// be wrong and has to decline it.
//
// eq-wo-03 is the other way to be wrong about the same data: four tickets on one
// real batch, spread over three months. The pattern is not there on the timescale
// the card would claim, and a sentence saying "4 work orders in the last 60 days"
// over tickets stretching back fourteen weeks is false on its face. The card, the
// receipt and the loader measure one window or this detector is quoting a number
// it did not compute.
//
// eq-wo-08 is the day that proves the SKIP. A hotel with a busy maintenance board
// and nothing on its equipment list must be reported as "we could not check
// this", never as silence — silence reads as a clean bill of health, and this
// detector's whole premise is that it only knows a batch exists when the hotel
// says so.

import { setFindingStatus } from '@/lib/findings/store';

import type { ExamDay, ExamPlanter } from '../types';

// Equipment ids live in the same file as the labels that quote them — and each
// DAY gets its own, because every exam day is its own hotel but `equipment.id`
// is a primary key across all of them. Sharing one constant between two days is
// a duplicate-key error at seed time, which is the loud version of the mistake;
// the quiet version would be one day's asset carrying another day's tickets.
const PTAC_01 = 'eee00001-0000-4000-8000-000000000001';
const PTAC_03 = 'eee00003-0000-4000-8000-000000000003';
const PTAC_04 = 'eee00004-0000-4000-8000-000000000004';
const ROOFTOP_05 = 'eee00005-0000-4000-8000-000000000005';
const PTAC_06 = 'eee00006-0000-4000-8000-000000000006';
const PTAC_07 = 'eee00007-0000-4000-8000-000000000007';

/** Background maintenance: one ticket each at a spread of places, unlinked. */
async function scatteredTickets(ctx: ExamPlanter, howMany: number, startDay = 3): Promise<void> {
  for (let i = 0; i < howMany; i += 1) {
    await ctx.workOrder({ date: ctx.ago(startDay + i), location: `Room ${301 + i}`, status: 'resolved' });
  }
}

export const repeatEquipmentWorkOrderDays: ExamDay[] = [
  {
    id: 'eq-wo-01',
    title: 'four tickets on the 2019 PTAC batch, in four different rooms',
    kind: 'clean_positive',
    detector: 'repeat_equipment_work_orders',
    why:
      'The pattern no per-room count can reach. Four faults across four rooms over two months, ' +
      'linked only by the asset the hotel itself described — and priced off the three repair ' +
      'costs this hotel has recorded against that very batch.',
    async seed(ctx) {
      await ctx.equipment({
        id: PTAC_01,
        name: 'PTAC units',
        location: 'Rooms 201-240',
        installYear: 2019,
      });
      await ctx.workOrder({ date: ctx.ago(4), location: 'Room 214', status: 'submitted', equipmentId: PTAC_01 });
      await ctx.workOrder({ date: ctx.ago(19), location: 'Room 227', status: 'resolved', repairCostCents: 21_000, equipmentId: PTAC_01 });
      await ctx.workOrder({ date: ctx.ago(37), location: 'Room 203', status: 'resolved', repairCostCents: 30_000, equipmentId: PTAC_01 });
      await ctx.workOrder({ date: ctx.ago(52), location: 'Room 236', status: 'resolved', repairCostCents: 39_000, equipmentId: PTAC_01 });
      await scatteredTickets(ctx, 5);
    },
    expect: [
      {
        detectorId: 'repeat_equipment_work_orders',
        key: `equipment:${PTAC_01}`,
        why: 'Four tickets against one asset inside sixty days, one of them still open.',
        magnitude: [4, 4],
        // Worth knowing, never worth a button: replacing forty units is a
        // capital decision and there is no version of it Staxis should perform.
        disposition: 'recommend',
        severity: 'attention',
        action: 'none',
        target: { kind: 'equipment', value: PTAC_01 },
        price: {
          // Four tickets at the $210-$390 this hotel has actually paid to fix
          // THIS batch — not the hotel-wide spread, which would be the looser
          // claim when the tighter one is available.
          lowCents: [80_000, 80_000],
          highCents: [160_000, 160_000],
          basisMatches:
            /4 work orders at \$210–\$390 each — the range of the 3 repair costs this hotel has recorded against this equipment/,
        },
        summaryMatches:
          /PTAC units \(installed 2019\) has had 4 work orders in the last 60 days — 1 still open\./,
      },
    ],
    silent: [],
  },

  {
    id: 'eq-wo-02',
    title: 'eight tickets across four unrelated assets — two each',
    kind: 'hard_negative',
    detector: 'repeat_equipment_work_orders',
    why:
      'The ice machine, the pool pump, the lobby HVAC and a laundry washer each needed attention ' +
      'twice this quarter. That is a building being maintained, not a batch dying. A detector ' +
      'that adds up unrelated assets to reach a threshold is finding a pattern in the fact that ' +
      'the hotel keeps a list.',
    async seed(ctx) {
      const assets = [
        { id: 'eee00002-0000-4000-8000-000000000001', name: 'Ice machine', category: 'appliance' },
        { id: 'eee00002-0000-4000-8000-000000000002', name: 'Pool pump', category: 'pool' },
        { id: 'eee00002-0000-4000-8000-000000000003', name: 'Lobby HVAC', category: 'hvac' },
        { id: 'eee00002-0000-4000-8000-000000000004', name: 'Laundry washer', category: 'laundry' },
      ];
      for (const [index, spec] of assets.entries()) {
        await ctx.equipment({ id: spec.id, name: spec.name, category: spec.category, location: spec.name });
        await ctx.workOrder({
          date: ctx.ago(6 + index * 3),
          location: `Room ${401 + index * 2}`,
          status: 'submitted',
          equipmentId: spec.id,
        });
        await ctx.workOrder({
          date: ctx.ago(30 + index * 4),
          location: `Room ${402 + index * 2}`,
          status: 'resolved',
          equipmentId: spec.id,
        });
      }
      await scatteredTickets(ctx, 4);
    },
    expect: [],
    silent: [
      {
        detectorId: 'repeat_equipment_work_orders',
        why:
          'Eight linked tickets, and not one asset reaching four. The bar is per-asset because ' +
          'the claim is per-asset.',
      },
    ],
  },

  {
    id: 'eq-wo-03',
    title: 'four tickets on one real batch — spread over three months',
    kind: 'hard_negative',
    detector: 'repeat_equipment_work_orders',
    why:
      'One fault a month on a forty-unit batch is a building, not a batch dying. Saying "4 work ' +
      'orders in the last 60 days" here would be false on its face, and the receipt would name a ' +
      'window three of the four tickets fall outside. The card and the loader measure one thing.',
    async seed(ctx) {
      await ctx.equipment({ id: PTAC_03, name: 'PTAC units', location: 'Rooms 201-240', installYear: 2019 });
      await ctx.workOrder({ date: ctx.ago(10), location: 'Room 214', status: 'submitted', equipmentId: PTAC_03 });
      await ctx.workOrder({ date: ctx.ago(38), location: 'Room 227', status: 'submitted', equipmentId: PTAC_03 });
      await ctx.workOrder({ date: ctx.ago(66), location: 'Room 203', status: 'submitted', equipmentId: PTAC_03 });
      await ctx.workOrder({ date: ctx.ago(94), location: 'Room 236', status: 'submitted', equipmentId: PTAC_03 });
      await scatteredTickets(ctx, 4);
    },
    expect: [],
    silent: [
      {
        detectorId: 'repeat_equipment_work_orders',
        why: 'Only one of the batch\'s four tickets is inside the window the card would claim.',
      },
    ],
  },

  {
    id: 'eq-wo-04',
    title: 'exactly three on one batch is a big hotel, not a pattern',
    kind: 'edge_negative',
    detector: 'repeat_equipment_work_orders',
    why:
      'Four is the bar, and it is four rather than three because a batch covering forty rooms ' +
      'produces the occasional unrelated fault as a matter of course. Three of those in two ' +
      'months is explicable by the size of the batch alone.',
    async seed(ctx) {
      await ctx.equipment({ id: PTAC_04, name: 'PTAC units', location: 'Rooms 201-240', installYear: 2019 });
      await ctx.workOrder({ date: ctx.ago(5), location: 'Room 214', status: 'submitted', equipmentId: PTAC_04 });
      await ctx.workOrder({ date: ctx.ago(24), location: 'Room 227', status: 'submitted', equipmentId: PTAC_04 });
      await ctx.workOrder({ date: ctx.ago(48), location: 'Room 203', status: 'submitted', equipmentId: PTAC_04 });
      await scatteredTickets(ctx, 4);
    },
    expect: [],
    silent: [{ detectorId: 'repeat_equipment_work_orders', why: 'Three is under the bar.' }],
  },

  {
    id: 'eq-wo-05',
    title: 'exactly four, all closed, and the price falls back to the hotel-wide range',
    kind: 'edge_positive',
    detector: 'repeat_equipment_work_orders',
    why:
      'Four in sixty days is the bar, and a batch nobody recorded an install year for still gets ' +
      'a sentence — it just does not claim one. With only two costs recorded against this asset ' +
      'there is no honest per-asset range, so the card falls back to what this hotel has paid on ' +
      'any work order AND SAYS SO. A basis line that did not name which of the two it used would ' +
      'be a number a manager cannot check.',
    async seed(ctx) {
      await ctx.equipment({ id: ROOFTOP_05, name: 'Rooftop HVAC units', location: 'Roof', installYear: null });
      await ctx.workOrder({ date: ctx.ago(6), location: 'Roof', status: 'resolved', repairCostCents: 18_000, equipmentId: ROOFTOP_05 });
      await ctx.workOrder({ date: ctx.ago(21), location: 'Roof', status: 'resolved', repairCostCents: 25_000, equipmentId: ROOFTOP_05 });
      await ctx.workOrder({ date: ctx.ago(40), location: 'Corridor 2F', status: 'resolved', equipmentId: ROOFTOP_05 });
      await ctx.workOrder({ date: ctx.ago(55), location: 'Corridor 3F', status: 'resolved', equipmentId: ROOFTOP_05 });
      // Unlinked repairs. These are what widen the hotel-wide sample to three
      // and let the fallback exist at all.
      await ctx.workOrder({ date: ctx.ago(12), location: 'Lobby', status: 'resolved', repairCostCents: 12_000 });
      await ctx.workOrder({ date: ctx.ago(33), location: 'Pool deck', status: 'resolved', repairCostCents: 40_000 });
      await scatteredTickets(ctx, 4);
    },
    expect: [
      {
        detectorId: 'repeat_equipment_work_orders',
        key: `equipment:${ROOFTOP_05}`,
        why: 'Four in sixty days, nothing left open, and no install year to claim.',
        magnitude: [4, 4],
        disposition: 'recommend',
        severity: 'attention',
        action: 'none',
        target: { kind: 'equipment', value: ROOFTOP_05 },
        price: {
          lowCents: [45_000, 45_000],
          highCents: [160_000, 160_000],
          basisMatches:
            /4 work orders at \$120–\$400 each — the range of the 4 repair costs this hotel has recorded on any work order/,
        },
        summaryMatches:
          /^Rooftop HVAC units has had 4 work orders in the last 60 days — all of them closed\.$/,
      },
    ],
    silent: [],
  },

  {
    id: 'eq-wo-06',
    title: 'a fifth and sixth fault tomorrow is the same batch, not a second card',
    kind: 'silencer',
    detector: 'repeat_equipment_work_orders',
    why:
      'The identity of this problem is the ASSET, and it is the asset ID rather than its name — ' +
      'so renaming "PTACs" to "PTAC units — rooms 201-240" does not orphan a card a manager has ' +
      'already silenced. A dedupe key carrying the count would open a new card every night a ' +
      'ticket landed, and would pass every non-silencer day in this corpus.',
    async seed(ctx) {
      await ctx.equipment({ id: PTAC_06, name: 'PTAC units', location: 'Rooms 201-240', installYear: 2019 });
      await ctx.workOrder({ date: ctx.ago(4), location: 'Room 214', status: 'submitted', equipmentId: PTAC_06 });
      await ctx.workOrder({ date: ctx.ago(18), location: 'Room 227', status: 'submitted', equipmentId: PTAC_06 });
      await ctx.workOrder({ date: ctx.ago(33), location: 'Room 203', status: 'submitted', equipmentId: PTAC_06 });
      await ctx.workOrder({ date: ctx.ago(50), location: 'Room 236', status: 'submitted', equipmentId: PTAC_06 });
      await scatteredTickets(ctx, 4);
    },
    expect: [
      {
        detectorId: 'repeat_equipment_work_orders',
        key: `equipment:${PTAC_06}`,
        why: 'Night one: four tickets on the batch.',
        magnitude: [4, 4],
      },
    ],
    silent: [],
    secondNight: {
      why: 'Two more units fail. One row, a bigger number — and eight is where it would turn critical, so six must not.',
      async mutate(ctx) {
        await ctx.workOrder({ date: ctx.ago(1), location: 'Room 218', status: 'submitted', equipmentId: PTAC_06 });
        await ctx.workOrder({ date: ctx.ago(1), location: 'Room 231', status: 'submitted', equipmentId: PTAC_06 });
      },
      expect: [
        {
          detectorId: 'repeat_equipment_work_orders',
          key: `equipment:${PTAC_06}`,
          why: 'Six now. Eight or more would make it critical; six is still attention.',
          magnitude: [6, 6],
          severity: 'attention',
        },
      ],
      maxTotalRows: 1,
    },
  },

  {
    id: 'eq-wo-07',
    title: 'known problem at four; eight is a different problem wearing the name',
    kind: 'silencer',
    detector: 'repeat_equipment_work_orders',
    why:
      'A manager who tapped "known problem" at four faults consented to four. Eight is twice that ' +
      'and four more in absolute terms, so it earns its way back onto the screen — and comes back ' +
      'CRITICAL, because eight failures in two months is no longer a batch to keep an eye on.',
    async seed(ctx) {
      await ctx.equipment({ id: PTAC_07, name: 'PTAC units', location: 'Rooms 201-240', installYear: 2019 });
      await ctx.workOrder({ date: ctx.ago(4), location: 'Room 214', status: 'submitted', equipmentId: PTAC_07 });
      await ctx.workOrder({ date: ctx.ago(18), location: 'Room 227', status: 'submitted', equipmentId: PTAC_07 });
      await ctx.workOrder({ date: ctx.ago(33), location: 'Room 203', status: 'submitted', equipmentId: PTAC_07 });
      await ctx.workOrder({ date: ctx.ago(50), location: 'Room 236', status: 'submitted', equipmentId: PTAC_07 });
      await scatteredTickets(ctx, 4);
    },
    expect: [
      {
        detectorId: 'repeat_equipment_work_orders',
        key: `equipment:${PTAC_07}`,
        why: 'Night one: the card the manager silences at four.',
        magnitude: [4, 4],
      },
    ],
    silent: [],
    secondNight: {
      why: 'Silenced at four, then four more units go. Back, and louder.',
      async handOfTheManager(ctx) {
        const rows = await ctx.pg.query<{ id: string }>(
          `select id from findings
             where property_id = $1
               and dedupe_key = $2`,
          [ctx.propertyId, `repeat_equipment_work_orders:equipment:${PTAC_07}`],
        );
        await setFindingStatus(ctx.propertyId, rows.rows[0].id, 'known_problem', null, ctx.now);
      },
      async mutate(ctx) {
        for (let i = 0; i < 4; i += 1) {
          await ctx.workOrder({
            date: ctx.ago(1),
            location: `Room ${205 + i}`,
            status: 'submitted',
            equipmentId: PTAC_07,
          });
        }
      },
      expect: [
        {
          detectorId: 'repeat_equipment_work_orders',
          key: `equipment:${PTAC_07}`,
          why: 'Eight is >= 4 x 2 AND >= 4 more than the four they consented to. Both conditions, on purpose.',
          magnitude: [8, 8],
          severity: 'critical',
        },
      ],
      maxTotalRows: 1,
    },
  },

  {
    id: 'eq-wo-08',
    title: 'a busy maintenance board at a hotel that tracks no equipment',
    kind: 'honest_skip',
    detector: 'repeat_equipment_work_orders',
    why:
      'This detector can only ever see what the hotel chose to describe. A hotel with twelve ' +
      'tickets and an empty equipment list must be reported as "we could not check this", with ' +
      'the reason — never as silence, which reads as a clean bill of health on equipment nobody ' +
      'has ever told Staxis about.',
    async seed(ctx) {
      await scatteredTickets(ctx, 12, 2);
    },
    expect: [],
    silent: [],
    skipped: [
      {
        detectorId: 'repeat_equipment_work_orders',
        becauseMatches: /nobody at this hotel has put any equipment on the list/,
        why: 'There is nothing to group work orders by until the hotel says what its equipment is.',
      },
    ],
  },
];
