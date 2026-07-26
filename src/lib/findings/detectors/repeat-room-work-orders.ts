// ─── Detector: one place that keeps breaking ─────────────────────────────────
//
// "Room 214 has had 4 work orders in the last 30 days."
//
// Every one of those tickets was small enough to fix and forget. Nobody adds
// them up, because nobody is looking at the room — they are looking at faults.
// The pattern only exists in the aggregate, which is exactly the kind of thing
// a piece of code that never gets tired is good for.
//
// THIS IS THE FIRST DETECTOR THAT COMES WITH A FIX.
// Its declaration carries an `actionTemplate`, so a card it writes arrives with
// "create a work order for a full inspection?" and one tap does it. That is
// also why its default disposition is `propose` rather than `recommend`: an
// offer with a button on it is a decision waiting, and the Staxis pill counts
// exactly those.
//
// A DRAFT WITH NOTHING STILL OPEN IS A RECOMMENDATION, NOT AN OFFER.
// If the team has already closed every ticket at that location, the pattern is
// still worth knowing and the card still says so — but Staxis has nothing to
// add to a board where somebody is evidently already on it, so those drafts
// override the disposition down to `recommend` and carry no action.
//
// WHY IT READS `work_orders` AND NOT `pms_work_orders_v2`
// The operational-signal layer already has a "repeated maintenance in room X"
// aggregator, and it reads the PMS mirror — which is empty fleet-wide since the
// robot was decommissioned. Nothing about that module changed; it still runs,
// still emits, and will light up again the day a PMS feed does. This detector
// reads the board the hotel's own staff type into, which is where the data
// actually is. Two feeds, same question, different sources.
//
// MONEY, OR SILENCE
// The only honest dollar figure here is what THIS hotel has actually paid to
// fix things (`work_orders.repair_cost`). A hotel that has never filled that in
// gets a card with no number and an evidence line saying exactly why. Borrowing
// an average repair cost from anywhere else would be the invented number the
// whole range format exists to prevent.

import { createWorkOrderParams } from '../actions/catalog/create-work-order';
import type { FindingActionDraft } from '../actions/types';
import { formatCentsBand, plural, priceFromBand, sampleBand } from '../pricing';
import { registerDetector } from '../registry';
import type { LocationWorkOrders, RoomWorkOrderHistory } from '../history';
import type {
  Detector,
  DetectorContext,
  DetectorParams,
  FindingDraft,
  FindingTarget,
} from '../types';
import { readFeed } from '../types';

const RECEIPT = 'work_orders_by_location_30d';

/** The window a "lately" claim covers. Matches the operational-signal layer's
 *  own 30 days, so the two never disagree about what "recently" means. */
export const WINDOW_DAYS = 30;

/**
 * Three tickets in a month at one place. Same threshold the operational-signal
 * layer uses for repeated maintenance (THRESHOLDS.maintenancePerRoomCategory),
 * deliberately: a hotel should not learn two different definitions of "this
 * keeps happening" from one app.
 */
export const MIN_WORK_ORDERS = 3;

/** Fewest recorded repair costs before this hotel's own numbers can support a
 *  range. Below it, the card says why there is no dollar figure. */
const MIN_COST_SAMPLES = 3;

/**
 * "Room 214" → the room number the rest of the app keys on, or no target.
 *
 * Deliberately conservative: a location is only claimed to BE a room when it
 * says so. "Lobby", "Hall 2F" and "Laundry Room" are real, common locations on
 * this board and none of them is a room — attaching a room target to one would
 * put a "Staxis sees a pattern here" chip on whichever room happened to share
 * the digits.
 */
export function roomTargetFor(location: string): FindingTarget | null {
  const match = /^room\s+([0-9a-z-]{1,12})$/i.exec(location.trim());
  if (!match) return null;
  return { kind: 'room', value: match[1].replace(/^0+(?=.)/, '') };
}

function draftFor(
  entry: LocationWorkOrders,
  history: RoomWorkOrderHistory,
): FindingDraft | null {
  if (entry.total < MIN_WORK_ORDERS) return null;

  const costBand = sampleBand(history.repairCostCentsSamples, { minSamples: MIN_COST_SAMPLES });
  const pricing = priceFromBand(
    costBand ? { low: costBand.low * entry.total, high: costBand.high * entry.total } : null,
    costBand
      ? `${plural(entry.total, 'work order')} at ${formatCentsBand(costBand)} each — the range of ` +
        `the ${plural(history.repairCostCentsSamples.length, 'repair cost')} this hotel has recorded`
      : '',
    history.repairCostCentsSamples.length < MIN_COST_SAMPLES
      ? 'no dollar figure: this hotel has recorded a repair cost on only ' +
        `${plural(history.repairCostCentsSamples.length, 'work order')}, which is not enough to ` +
        'say what a repair costs here'
      : 'no dollar figure: every repair cost this hotel has recorded is the same number, so ' +
        'there is no honest range to quote',
  );

  const stillOpen = entry.stillOpen;

  return {
    // Identity is the PLACE. A fifth work order tomorrow lands on this same row
    // rather than opening a second card, which is the whole point of the ledger.
    key: `location:${entry.location}`,
    summary:
      `${entry.location} has had ${plural(entry.total, 'work order')} in the last ` +
      `${WINDOW_DAYS} days — ${stillOpen === 0 ? 'all of them closed' : `${stillOpen} still open`}.`,
    severity: entry.total >= MIN_WORK_ORDERS * 2 ? 'critical' : 'attention',
    // Nothing left open means nothing for Staxis to add: the team is evidently
    // on it. Worth saying, not worth a button.
    disposition: stillOpen > 0 ? 'propose' : 'recommend',
    magnitude: entry.total,
    evidence: {
      queryId: RECEIPT,
      params: {
        location: entry.location,
        window_days: WINDOW_DAYS,
      },
      values: {
        work_orders: entry.total,
        still_open: stillOpen,
        last_logged: entry.lastDate,
        recorded_repair_costs: history.repairCostCentsSamples.length,
        price_basis: pricing.note,
      },
      basis:
        `${plural(entry.total, 'work order')} logged at ${entry.location} between ` +
        `${history.coverageStartDate ?? 'the start of the window'} and ${entry.lastDate}`,
      target: roomTargetFor(entry.location),
    },
    price: pricing.price,
  };
}

export function detectRepeatRoomWorkOrders(ctx: DetectorContext): FindingDraft[] {
  const history: RoomWorkOrderHistory = readFeed(ctx, 'room_work_order_history');
  const out: FindingDraft[] = [];
  for (const entry of history.locations) {
    const draft = draftFor(entry, history);
    if (draft) out.push(draft);
  }
  // Worst first, so the per-run cap keeps the places that matter.
  return out.sort((a, b) => b.magnitude - a.magnitude);
}

/**
 * The fix, frozen from what the card says.
 *
 * PURE, and reading only the draft — no clock, no database. The plan a manager
 * approves tomorrow morning is computed here, tonight, from the same evidence
 * the card renders.
 *
 * Returns null when nothing is still open. `verify` then has no floor to check
 * against (a count can never fall below zero), so an offer made on a location
 * with nothing open could never honestly decline — and an offer that can never
 * decline is the one this whole layer exists to avoid.
 */
export function workOrderActionFor(draft: FindingDraft): FindingActionDraft | null {
  const location = draft.evidence.params.location;
  const stillOpen = draft.evidence.values.still_open;
  if (typeof location !== 'string' || location.trim() === '') return null;
  if (typeof stillOpen !== 'number' || stillOpen < 1) return null;

  return {
    kind: 'create_work_order',
    params: createWorkOrderParams(location),
    // What must STILL be true at the tap: at least as many work orders at this
    // location are still open as there were when Staxis offered this. Closing
    // them is the hotel dealing with the problem, and Staxis piling another
    // ticket on top of that is the failure mode this check exists to prevent.
    verify: {
      location,
      window_days: WINDOW_DAYS,
      open_work_orders: stillOpen,
    },
  };
}

const feed = (locations: LocationWorkOrders[], repairCostCentsSamples: number[] = []) => ({
  locations,
  repairCostCentsSamples,
  coverageStartDate: '2026-06-25',
  windowDays: 98,
});

export const repeatRoomWorkOrdersDetector: Detector<DetectorParams> = {
  declaration: {
    id: 'repeat_room_work_orders',
    description:
      'One place in the hotel that keeps producing work orders — three or more in thirty days — with an offer to put a full inspection on the maintenance board.',
    inputs: ['room_work_order_history'],
    requires: [
      {
        feed: 'room_work_order_history',
        minRecords: MIN_WORK_ORDERS,
        because:
          'this hotel has logged fewer than three work orders in the window, which is not enough to tell a pattern from a bad week',
      },
    ],
    receiptQueryId: RECEIPT,
    // Every card this writes is a decision waiting, because every card this
    // writes can arrive with a fix attached. Drafts with nothing still open
    // override themselves down to 'recommend'.
    defaultDisposition: 'propose',
    defaultSeverity: 'attention',
    // Three known work orders is consent to three, not to nine.
    escalation: { factor: 2, minDelta: 3 },
    maxPerRun: 8,
    // The window is 30 days, so a location that stops appearing for a week has
    // genuinely stopped: its tickets aged out.
    staleAfterDays: 7,
    actionTemplate: workOrderActionFor,
    evalCases: [
      {
        name: 'a location with four work orders, two still open, is one finding keyed on the place',
        feeds: {
          room_work_order_history: feed([
            { location: 'Room 214', total: 4, stillOpen: 2, lastDate: '2026-07-24' },
          ]),
        },
        expectKeys: ['location:Room 214'],
        expectMagnitude: { 'location:Room 214': 4 },
      },
      {
        name: 'the same location with more work orders is the SAME problem, not a new one',
        feeds: {
          room_work_order_history: feed([
            { location: 'Room 214', total: 9, stillOpen: 5, lastDate: '2026-07-24' },
          ]),
        },
        expectKeys: ['location:Room 214'],
        expectMagnitude: { 'location:Room 214': 9 },
      },
      {
        name: 'two work orders at one place is a bad fortnight, not a pattern',
        feeds: {
          room_work_order_history: feed([
            { location: 'Room 214', total: 2, stillOpen: 2, lastDate: '2026-07-24' },
          ]),
        },
        expectKeys: [],
      },
      {
        name: 'a location where everything was closed is still worth saying',
        feeds: {
          room_work_order_history: feed([
            { location: 'Lobby', total: 3, stillOpen: 0, lastDate: '2026-07-20' },
          ]),
        },
        expectKeys: ['location:Lobby'],
      },
      {
        name: 'a hotel with no work orders says nothing, and that is a real answer',
        feeds: { room_work_order_history: feed([]) },
        expectKeys: [],
      },
    ],
  },
  detect(ctx: DetectorContext): FindingDraft[] {
    return detectRepeatRoomWorkOrders(ctx);
  },
};

registerDetector(repeatRoomWorkOrdersDetector);
