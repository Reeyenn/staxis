// ─── Exam days: cleaning_plan_health ─────────────────────────────────────────
//
// The thinnest detector in the layer, and the one with the most surprising
// history. It does not report "room 214 needs a departure clean" — that is
// routine work with a home of its own. It reports the thing nobody currently
// reports: that the plan FAILED to compute for some rooms, so today's
// housekeeping list is quietly incomplete.
//
// WHY THERE IS NO `clean_positive` DAY HERE, AND WHY THAT IS A FINDING IN
// ITSELF (see POSITIVE_UNREACHABLE_FROM_DATA in ../index.ts)
// The detector fires on `PropertyRunResult.errors`, which the engine only fills
// when a rule THROWS while evaluating one room. Every rule and every context
// builder in src/lib/rules-engine is null-safe by construction, so no
// arrangement of hotel rows can produce that array — it is a defensive catch,
// not a data-driven branch. Rather than invent a fake feed to manufacture a
// green tick, the corpus says so out loud and grades the positive through the
// detector's own frozen eval case.
//
// WHAT THESE DAYS DO GRADE IS THE THING THAT WAS ACTUALLY BROKEN.
// Building this corpus is how we found that `buildRoomContexts` was selecting
// `pms_reservations.rate_code` — a column that has never existed. PostgREST
// answers one bad name by failing the WHOLE read, the engine rethrows, and the
// cleaning plan had therefore been dying before it evaluated a single room, on
// every hotel, on every five-minute tick, since the engine shipped. Day 01
// below is the day that catches it coming back: it demands the detector be
// CHECKED, and a detector whose feed throws is skipped, not silent.

import type { ExamDay, ExamPlanter } from '../types';

/** A hotel with a real morning: arrivals, departures, and people staying on. */
async function aRealMorning(ctx: ExamPlanter): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    const room = String(101 + i);
    await ctx.pmsRoom({ room, roomType: i % 4 === 0 ? 'suite' : 'king', isSuite: i % 4 === 0 });
    if (i % 3 === 0) {
      // Checking out today.
      await ctx.pmsReservation({
        room,
        arrivalDate: ctx.ago(3),
        departureDate: ctx.businessDate,
        notes: i === 0 ? 'VIP — platinum guest, pet friendly, service dog' : null,
      });
      await ctx.roomStatus({ room, status: 'vacant_dirty' });
      await ctx.hkAssignment({ room, cleaningType: 'departure' });
    } else if (i % 3 === 1) {
      // Staying on.
      await ctx.pmsReservation({
        room,
        arrivalDate: ctx.ago(9),
        departureDate: ctx.ago(-4),
        notes: i === 4 ? 'green choice — no daily clean please' : null,
      });
      await ctx.roomStatus({ room, status: 'occupied' });
      await ctx.hkAssignment({ room, cleaningType: 'stayover' });
    } else {
      // Arriving today.
      await ctx.pmsReservation({
        room,
        arrivalDate: ctx.businessDate,
        departureDate: ctx.ago(-2),
        status: 'booked',
      });
      await ctx.roomStatus({ room, status: 'vacant_clean' });
    }
  }
}

export const cleaningPlanHealthDays: ExamDay[] = [
  {
    id: 'plan-01',
    title: 'a full morning that plans cleanly',
    kind: 'clean_negative',
    detector: 'cleaning_plan_health',
    why:
      'Twelve rooms, four checkouts, four stayovers, four arrivals, a VIP with a service dog ' +
      'and a guest who declined housekeeping. Every rule in the engine gets something to chew ' +
      'on, and NOTHING fails — so the check must run and say nothing. It is the running that ' +
      'is being graded: a feed that throws would show up as a skip.',
    async seed(ctx) {
      await aRealMorning(ctx);
    },
    expect: [],
    silent: [
      {
        detectorId: 'cleaning_plan_health',
        why: 'The plan computed for every room the engine considered. Silence here is the good answer.',
      },
    ],
  },

  {
    id: 'plan-02',
    title: 'a hotel that does not use Staxis for housekeeping',
    kind: 'hard_negative',
    detector: 'cleaning_plan_health',
    why:
      'The rooms, reservations and assignments are all there, and housekeeping is switched off ' +
      'for this hotel. Evaluating its cleaning plan behind its back — and then reporting on the ' +
      'result — is exactly the kind of thing that makes a section toggle meaningless.',
    enabledSections: { housekeeping: false },
    async seed(ctx) {
      await aRealMorning(ctx);
    },
    expect: [],
    silent: [
      {
        detectorId: 'cleaning_plan_health',
        why: 'Housekeeping is off: the feed returns an empty plan and the check has nothing to say.',
      },
    ],
  },

  {
    id: 'plan-03',
    title: 'a hotel with rooms and nobody in them',
    kind: 'edge_negative',
    detector: 'cleaning_plan_health',
    why:
      'No reservations, no assignments, so no room has anything to be planned. Zero rooms ' +
      'evaluated and zero failures are not the same number wearing different hats, and only ' +
      'one of them is a finding.',
    async seed(ctx) {
      for (let i = 0; i < 8; i += 1) await ctx.pmsRoom({ room: String(101 + i) });
    },
    expect: [],
    silent: [
      { detectorId: 'cleaning_plan_health', why: 'An empty day is not a broken plan.' },
    ],
  },
];
