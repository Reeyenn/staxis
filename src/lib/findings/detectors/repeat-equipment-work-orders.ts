// ─── Detector: a batch of equipment that may be dying ────────────────────────
//
// "PTAC units — rooms 201-240 has had 4 work orders in the last 60 days."
//
// THE PATTERN THIS EXISTS TO SEE, AND WHY NOTHING ELSE COULD SEE IT
// A batch of forty PTAC units installed in 2019 fails one room at a time. Room
// 214 in May, room 227 in June, room 203 and room 236 in July. Four faults, four
// different rooms, four different weeks, four different people writing the
// ticket — and not one of them is remarkable on its own. `repeat_room_work_orders`
// cannot see it, because by ITS grouping this is four rooms with one ticket each,
// which is a hotel being run normally. The only thing those tickets share is the
// asset behind them, and the only reason that link exists is that somebody at the
// hotel put the batch on the equipment list and attached the tickets to it.
//
// Which is the whole philosophy of the equipment list, showing up as arithmetic:
// Staxis can only find this pattern in a hotel that chose to describe its own
// equipment. Nothing here infers an asset, groups by a guessed serial number, or
// decides on the hotel's behalf that two tickets are about the same machine.
//
// FOUR IN SIXTY DAYS, NOT THREE IN THIRTY
// The per-location detector's bar is three in thirty, matched deliberately to the
// operational-signal layer so a hotel never learns two definitions of "this keeps
// happening". This one is different ON PURPOSE, and the difference is the physics
// rather than a preference. A room having a bad month is a NOW problem: go and
// look at it, and a window any longer would send somebody to inspect a room that
// has been fine for six weeks. A batch reaching the end of its life fails on a
// slower clock — one unit this month, two the next — and thirty days would see
// each of those as an unremarkable pair and never add them up. The founder framed
// it the same way ("4 tickets on the 2019 PTAC batch in 60 days"), and the
// loader counts over exactly the sixty days the card prints.
//
// BOTH DETECTORS CAN FIRE ON THE SAME TICKETS, AND THAT IS CORRECT.
// Four faults on the ice machine in the same laundry room produce a card about
// the room and a card about the machine. They are two true statements with two
// different remedies — inspect that room; think about replacing that batch — and
// suppressing either would mean deciding on the manager's behalf which of the two
// their problem is.
//
// MONEY, OR SILENCE
// The only honest dollar figures are ones this hotel has actually paid, so the
// range comes from `work_orders.repair_cost` and from nowhere else. Two bases, in
// order: what this hotel has paid to fix THIS asset (the tighter claim), then
// what it has paid to fix anything (the wider one). The basis line always says
// which of the two it used, and a hotel that records no costs gets a card with no
// number and an evidence line saying exactly why. Borrowing a replacement cost
// from a manufacturer, an average, or the asset's own `replacement_cost` field
// would be the invented number the whole range format exists to prevent.
//
// NO BUTTON, DELIBERATELY.
// `repeat_room_work_orders` can offer a fix because "put an inspection of room
// 214 on the board" is one unambiguous, reversible ticket. The remedy for a dying
// batch is a capital decision — replace forty units, or keep repairing them — and
// there is no version of that Staxis should perform. So this stays a
// recommendation: it tells the manager what it found and gets out of the way.

import { formatCentsBand, plural, priceFromBand, sampleBand } from '../pricing';
import { registerDetector } from '../registry';
import type { EquipmentWorkOrderHistory, EquipmentWorkOrders } from '../history';
import type {
  Detector,
  DetectorContext,
  DetectorParams,
  FindingDraft,
} from '../types';
import { readFeed } from '../types';

const RECEIPT = 'work_orders_by_equipment_60d';

/**
 * The window a "lately" claim covers, when the feed does not say.
 *
 * The number the card actually prints comes from `history.windowDays`, i.e. from
 * the loader that did the counting — one source, so the sentence and the receipt
 * can never disagree about what "recently" means. This constant is only the
 * fallback for a feed built without one.
 */
export const WINDOW_DAYS = 60;

/**
 * Four faults on one asset inside two months.
 *
 * Four rather than three because a batch that covers forty rooms will produce
 * the occasional unrelated fault as a matter of course, and three of those
 * spread over two months is a large hotel being a large hotel. Four is where the
 * count stops being explicable by the size of the batch.
 */
export const MIN_WORK_ORDERS = 4;

/** Fewest recorded repair costs before a set of numbers can support a range. */
const MIN_COST_SAMPLES = 3;

/** "PTAC units (installed 2019)" — the asset as the sentence names it. */
function describe(asset: EquipmentWorkOrders): string {
  return asset.installYear ? `${asset.name} (installed ${asset.installYear})` : asset.name;
}

function draftFor(
  asset: EquipmentWorkOrders,
  history: EquipmentWorkOrderHistory,
): FindingDraft | null {
  if (asset.total < MIN_WORK_ORDERS) return null;

  // The asset's own repair history first: "what does fixing one of THESE cost"
  // is a tighter and more defensible claim than the hotel-wide spread, and a
  // hotel that has recorded three of them has earned the tighter one.
  const ownBand = sampleBand(asset.repairCostCentsSamples, { minSamples: MIN_COST_SAMPLES });
  const hotelBand = ownBand
    ? null
    : sampleBand(history.hotelRepairCostCentsSamples, { minSamples: MIN_COST_SAMPLES });
  const band = ownBand ?? hotelBand;
  const sampleCount = ownBand
    ? asset.repairCostCentsSamples.length
    : history.hotelRepairCostCentsSamples.length;

  const pricing = priceFromBand(
    band ? { low: band.low * asset.total, high: band.high * asset.total } : null,
    band
      ? `${plural(asset.total, 'work order')} at ${formatCentsBand(band)} each — the range of the ` +
        `${plural(sampleCount, 'repair cost')} this hotel has recorded ` +
        `${ownBand ? 'against this equipment' : 'on any work order'}`
      : '',
    history.hotelRepairCostCentsSamples.length < MIN_COST_SAMPLES
      ? 'no dollar figure: this hotel has recorded a repair cost on only ' +
        `${plural(history.hotelRepairCostCentsSamples.length, 'work order')}, which is not enough ` +
        'to say what a repair costs here'
      : 'no dollar figure: every repair cost this hotel has recorded is the same number, so ' +
        'there is no honest range to quote',
  );

  // Whatever the loader actually counted over. Never a second opinion.
  const windowDays = history.windowDays > 0 ? Math.round(history.windowDays) : WINDOW_DAYS;

  return {
    // Identity is the ASSET. A fifth ticket tomorrow lands on this same row
    // rather than opening a second card — the whole point of the ledger. The id
    // rather than the name, so renaming "PTACs" to "PTAC units — rooms 201-240"
    // does not orphan a card a manager has already silenced.
    key: `equipment:${asset.id}`,
    summary:
      `${describe(asset)} has had ${plural(asset.total, 'work order')} in the last ` +
      `${windowDays} days — ${
        asset.stillOpen === 0 ? 'all of them closed' : `${asset.stillOpen} still open`
      }.`,
    severity: asset.total >= MIN_WORK_ORDERS * 2 ? 'critical' : 'attention',
    magnitude: asset.total,
    evidence: {
      queryId: RECEIPT,
      params: {
        equipment_id: asset.id,
        equipment_name: asset.name,
        window_days: windowDays,
      },
      values: {
        work_orders: asset.total,
        still_open: asset.stillOpen,
        last_logged: asset.lastDate,
        install_year: asset.installYear,
        covers: asset.location,
        recorded_repair_costs_on_this_equipment: asset.repairCostCentsSamples.length,
        price_basis: pricing.note,
      },
      basis:
        `${plural(asset.total, 'work order')} logged against ${asset.name}` +
        `${asset.location ? ` (${asset.location})` : ''} between ` +
        `${history.coverageStartDate ?? 'the start of the window'} and ${asset.lastDate}`,
      // The chip on this asset's own detail sheet. Structural, never recovered
      // from the dedupe key — see ../targeting.ts on why that matters.
      target: { kind: 'equipment', value: asset.id },
    },
    price: pricing.price,
  };
}

export function detectRepeatEquipmentWorkOrders(ctx: DetectorContext): FindingDraft[] {
  const history: EquipmentWorkOrderHistory = readFeed(ctx, 'equipment_work_order_history');
  const out: FindingDraft[] = [];
  for (const asset of history.equipment) {
    const draft = draftFor(asset, history);
    if (draft) out.push(draft);
  }
  // Worst first, so the per-run cap keeps the assets that matter.
  return out.sort((a, b) => b.magnitude - a.magnitude);
}

const feed = (
  equipment: EquipmentWorkOrders[],
  overrides: Partial<EquipmentWorkOrderHistory> = {},
): EquipmentWorkOrderHistory => ({
  equipment,
  registeredCount: overrides.registeredCount ?? Math.max(equipment.length, 1),
  hotelRepairCostCentsSamples: overrides.hotelRepairCostCentsSamples ?? [],
  coverageStartDate: overrides.coverageStartDate ?? '2026-05-27',
  // What the loader counts over — the same number the card prints.
  windowDays: overrides.windowDays ?? WINDOW_DAYS,
});

const asset = (over: Partial<EquipmentWorkOrders> = {}): EquipmentWorkOrders => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'PTAC units — rooms 201-240',
  location: 'Rooms 201-240',
  installYear: 2019,
  total: 4,
  stillOpen: 2,
  lastDate: '2026-07-24',
  repairCostCentsSamples: [],
  ...over,
});

export const repeatEquipmentWorkOrdersDetector: Detector<DetectorParams> = {
  declaration: {
    id: 'repeat_equipment_work_orders',
    description:
      'One piece of the hotel\'s own equipment that keeps producing work orders — four or more in sixty days — with what this hotel has actually paid to repair it.',
    inputs: ['equipment_work_order_history'],
    requires: [
      {
        feed: 'equipment_work_order_history',
        // ONE registered asset, not one linked ticket. A hotel that tracks no
        // equipment gets a counted skip with a reason ("nobody has put any
        // equipment on the list"); a hotel that tracks equipment and had a quiet
        // two months gets SILENCE, which is the correct answer and a good one.
        // Collapsing the two would report a healthy hotel as a starved one.
        minRecords: 1,
        because:
          'nobody at this hotel has put any equipment on the list yet, so there is nothing to ' +
          'group work orders by — Staxis only knows a batch exists when the hotel says it does',
      },
    ],
    receiptQueryId: RECEIPT,
    // Worth knowing, never worth a button: the remedy for a dying batch is a
    // capital decision, and there is no version of "replace forty PTAC units"
    // that Staxis should perform. See the header.
    defaultDisposition: 'recommend',
    defaultSeverity: 'attention',
    // Four known failures is consent to four, not to twelve.
    escalation: { factor: 2, minDelta: 4 },
    maxPerRun: 8,
    // The window is 60 days, so an asset that stops appearing for a fortnight
    // has genuinely stopped: its tickets aged out.
    staleAfterDays: 14,
    evalCases: [
      {
        name: 'four tickets on one batch, two still open, is one finding keyed on the asset',
        feeds: { equipment_work_order_history: feed([asset()]) },
        expectKeys: ['equipment:11111111-1111-4111-8111-111111111111'],
        expectMagnitude: { 'equipment:11111111-1111-4111-8111-111111111111': 4 },
      },
      {
        name: 'the same batch with more tickets is the SAME problem, not a new one',
        feeds: { equipment_work_order_history: feed([asset({ total: 9, stillOpen: 5 })]) },
        expectKeys: ['equipment:11111111-1111-4111-8111-111111111111'],
        expectMagnitude: { 'equipment:11111111-1111-4111-8111-111111111111': 9 },
      },
      {
        name: 'three tickets in two months on a forty-unit batch is a big hotel, not a pattern',
        feeds: { equipment_work_order_history: feed([asset({ total: 3, stillOpen: 3 })]) },
        expectKeys: [],
      },
      {
        name: 'one ticket each on four unrelated assets is four faults, not one batch dying',
        feeds: {
          equipment_work_order_history: feed([
            asset({ id: '11111111-1111-4111-8111-111111111111', name: 'Ice machine', total: 1, stillOpen: 1 }),
            asset({ id: '22222222-2222-4222-8222-222222222222', name: 'Pool pump', total: 1, stillOpen: 0 }),
            asset({ id: '33333333-3333-4333-8333-333333333333', name: 'Lobby HVAC', total: 1, stillOpen: 1 }),
            asset({ id: '44444444-4444-4444-8444-444444444444', name: 'Laundry washer', total: 1, stillOpen: 1 }),
          ]),
        },
        expectKeys: [],
      },
      {
        name: 'a hotel whose registered equipment produced no work orders says nothing',
        feeds: { equipment_work_order_history: feed([], { registeredCount: 6 }) },
        expectKeys: [],
      },
    ],
  },
  detect(ctx: DetectorContext): FindingDraft[] {
    return detectRepeatEquipmentWorkOrders(ctx);
  },
};

registerDetector(repeatEquipmentWorkOrdersDetector);
