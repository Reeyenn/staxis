// ─── Detector: the cleaning plan could not be computed ───────────────────────
//
// A THIN WRAPPER around the existing cleaning rules engine. Deliberately thin.
//
// The rules engine emits into housekeeping (cleaning_tasks), and housekeeping
// is another workstream's, freshly rebuilt. Rewriting its twelve rules as
// findings detectors would mean touching that code and risking a live hotel's
// room assignments for an internal tidy-up nobody asked for. So the engine is
// left exactly as it is — same module, same 5-minute cron, same writes — and
// the findings runner calls it in DRY-RUN, which evaluates every rule and
// writes nothing.
//
// WHAT THIS DETECTOR ACTUALLY REPORTS
// Not "room 214 needs a departure clean" — that is routine work, it already has
// a home in cleaning_tasks, and duplicating it into the findings queue would
// bury the queue in a hundred cards a day. What it reports is the thing nobody
// currently reports: that the plan FAILED to compute for some rooms. Today
// those errors are logged and forgotten. A hotel whose cleaning plan silently
// skips six rooms every morning has a real problem, and this is the first place
// it becomes visible.
//
// The dry run's room count also lands in the run summary, which is how "the
// rules engine ran and everything was fine" becomes distinguishable from "the
// rules engine has been broken for a week".

import { registerDetector } from '../registry';
import type { Detector, DetectorContext, DetectorParams, FindingDraft } from '../types';
import { readFeed } from '../types';

const RECEIPT = 'rules_engine_dry_run';

export const cleaningPlanHealthDetector: Detector<DetectorParams> = {
  declaration: {
    id: 'cleaning_plan_health',
    description:
      "Rooms the cleaning plan could not be worked out for — today's housekeeping list is incomplete and nobody was told.",
    inputs: ['cleaning_plan'],
    requires: [
      {
        feed: 'cleaning_plan',
        minRecords: 0,
        because:
          'housekeeping is switched off for this hotel, or no rooms had reservations or a plan entry today',
      },
    ],
    receiptQueryId: RECEIPT,
    defaultDisposition: 'recommend',
    defaultSeverity: 'attention',
    escalation: { factor: 2, minDelta: 2 },
    // One problem: "the plan is incomplete". Never one card per broken room.
    maxPerRun: 1,
    staleAfterDays: 2,
    evalCases: [
      {
        name: 'rooms the plan could not be computed for become one finding',
        feeds: {
          cleaning_plan: {
            property_id: 'p',
            business_date: '2026-07-25',
            engine_run_id: 'r',
            rooms_evaluated: 40,
            tasks_upserted: 0,
            tasks_skipped_in_progress: 0,
            rooms_no_task: 0,
            errors: [
              { room_number: '101', error: 'boom' },
              { room_number: '102', error: 'boom' },
            ],
            duration_ms: 5,
            outcomes: [],
            dry_run: true,
          },
        },
        businessDate: '2026-07-25',
        expectKeys: ['plan_errors:2026-07-25'],
        expectMagnitude: { 'plan_errors:2026-07-25': 2 },
      },
      {
        name: 'a clean run says nothing — the run summary carries the liveness proof instead',
        feeds: {
          cleaning_plan: {
            property_id: 'p',
            business_date: '2026-07-25',
            engine_run_id: 'r',
            rooms_evaluated: 40,
            tasks_upserted: 12,
            tasks_skipped_in_progress: 0,
            rooms_no_task: 28,
            errors: [],
            duration_ms: 5,
            outcomes: [],
            dry_run: true,
          },
        },
        businessDate: '2026-07-25',
        expectKeys: [],
      },
    ],
  },
  detect(ctx: DetectorContext): FindingDraft[] {
    const plan = readFeed(ctx, 'cleaning_plan');
    if (plan.errors.length === 0) return [];

    const rooms = plan.errors.map((e) => e.room_number);
    const shown = rooms.slice(0, 5).join(', ');
    return [
      {
        key: `plan_errors:${ctx.businessDate}`,
        summary:
          `The cleaning plan could not be worked out for ${rooms.length} room` +
          `${rooms.length === 1 ? '' : 's'} today (${shown}${rooms.length > 5 ? '…' : ''}). ` +
          'Those rooms are missing from the housekeeping list.',
        severity: 'attention',
        magnitude: rooms.length,
        evidence: {
          queryId: RECEIPT,
          params: { business_date: ctx.businessDate, dry_run: true },
          values: {
            rooms_evaluated: plan.rooms_evaluated,
            rooms_failed: rooms.length,
            rooms: rooms.slice(0, 20),
            first_error: plan.errors[0]?.error ?? null,
          },
          basis: `${rooms.length} of ${plan.rooms_evaluated} rooms failed rule evaluation`,
        },
        price: null,
      },
    ];
  },
};

registerDetector(cleaningPlanHealthDetector);
