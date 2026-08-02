/**
 * THE FUEL. What the companion is allowed to claim it noticed.
 *
 * Every detector under src/lib/companion/trace/detectors is a pure function of
 * rows, so this file feeds it rows and reads what comes back. No database, no
 * clock of its own, no model.
 *
 * The plausible bugs it is aimed at:
 *   - a pattern that changes identity when a fourth ticket lands, which would
 *     silently reset somebody's No
 *   - a run of rooms invented from a floor number, or a sibling room named that
 *     this hotel does not have
 *   - two tickets promoted to a pattern, or three tickets with one still open
 *     offered as something to connect a line between
 *   - a dollar figure quoted from a hotel that has never recorded a repair cost
 *   - a percentage computed off raw totals rather than a daily rate, which
 *     would call every long gap between counts a crisis
 *   - a delivery counted twice because its correction row was read alongside it
 *   - an attendance pattern that could reach an unprompted surface
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  categoryOf,
  detectMaintenanceRuns,
  roomNumberOf,
  runOf,
  siblingRoomFor,
  type TraceWorkOrder,
} from '@/lib/companion/trace/detectors/maintenance-run';
import {
  dailyUsageBetween,
  detectInventoryDrift,
  type TraceCountPoint,
  type TraceDelivery,
  type TraceInventoryItem,
} from '@/lib/companion/trace/detectors/inventory-drift';
import {
  detectCalloutWeekday,
  weekdayOf,
  type TraceCallout,
} from '@/lib/companion/trace/detectors/callout-weekday';
import { tracePatternKey } from '@/lib/companion/trace/identity';

const NOW = new Date('2026-08-02T15:00:00Z');

function wo(over: Partial<TraceWorkOrder> & { id: string }): TraceWorkOrder {
  return {
    location: 'Room 214',
    description: 'AC blowing warm.',
    open: true,
    createdAt: '2026-07-20T09:00:00Z',
    repairCost: null,
    ...over,
  };
}

/** The hero: three rooms on one floor, one side, all about the same machine. */
const RUN: TraceWorkOrder[] = [
  wo({ id: 'a', location: 'Room 222', description: 'AC rattles when it kicks on.', createdAt: '2026-06-14T12:00:00Z' }),
  wo({ id: 'b', location: 'Room 218', description: 'Cools, then stops cooling by evening.', createdAt: '2026-07-02T12:00:00Z' }),
  wo({ id: 'c', location: 'Room 214', description: 'AC blowing warm. Guest moved.', createdAt: '2026-07-30T12:00:00Z' }),
];

describe('the maintenance run detector', () => {
  test('three tickets about one machine on one side of one floor is one pattern', () => {
    const found = detectMaintenanceRuns({ now: NOW, workOrders: RUN, knownRooms: [] });
    assert.equal(found.length, 1);
    assert.equal(found[0].page, 'maintenance');
    assert.equal(found[0].anchors.filter((a) => a.present).length, 3);
    assert.deepEqual(
      found[0].anchors.filter((a) => a.present).map((a) => a.domId),
      ['wo:a', 'wo:b', 'wo:c'],
    );
  });

  test('the identity survives a fourth ticket, so a No stays a No', () => {
    const before = detectMaintenanceRuns({ now: NOW, workOrders: RUN, knownRooms: [] })[0];
    const after = detectMaintenanceRuns({
      now: NOW,
      workOrders: [...RUN, wo({ id: 'd', location: 'Room 220', description: 'AC noisy.' })],
      knownRooms: [],
    })[0];
    assert.equal(before.key, after.key);
    // And it is derived from the subject, not random or time-based.
    assert.equal(before.key, tracePatternKey('maintenance_run', ['floor-2', 'even', 'hvac']));
  });

  test('two tickets is a bad fortnight, not a pattern', () => {
    const found = detectMaintenanceRuns({ now: NOW, workOrders: RUN.slice(0, 2), knownRooms: [] });
    assert.deepEqual(found, []);
  });

  test('three tickets with only one still open has nothing to connect', () => {
    const mostlyClosed = RUN.map((o, i) => (i === 0 ? o : { ...o, open: false }));
    assert.deepEqual(detectMaintenanceRuns({ now: NOW, workOrders: mostlyClosed, knownRooms: [] }), []);
  });

  test('a closed ticket still counts toward the pattern and is named, never drawn to', () => {
    const oneClosed = RUN.map((o, i) => (i === 0 ? { ...o, open: false } : o));
    const found = detectMaintenanceRuns({ now: NOW, workOrders: oneClosed, knownRooms: [] });
    assert.equal(found.length, 1);
    assert.equal(found[0].anchors.filter((a) => a.present).length, 2);
    const facts = found[0].facts.map((f) => f.v).join(' ');
    assert.match(facts, /Already closed/);
    assert.match(found[0].basis, /already closed/);
  });

  test('the two sides of a corridor are two different runs', () => {
    const mixed = [
      wo({ id: 'a', location: 'Room 214', description: 'AC blowing warm.' }),
      wo({ id: 'b', location: 'Room 216', description: 'AC blowing warm.' }),
      wo({ id: 'c', location: 'Room 215', description: 'AC blowing warm.' }),
      wo({ id: 'd', location: 'Room 217', description: 'AC blowing warm.' }),
    ];
    const found = detectMaintenanceRuns({ now: NOW, workOrders: mixed, knownRooms: [] });
    // Two on each side, and two is not a pattern on either.
    assert.deepEqual(found, []);
  });

  test('unrelated machines in the same rooms are not one thing', () => {
    const mixed = [
      wo({ id: 'a', location: 'Room 214', description: 'AC blowing warm.' }),
      wo({ id: 'b', location: 'Room 216', description: 'Toilet running all night.' }),
      wo({ id: 'c', location: 'Room 218', description: 'Bulb out over the desk.' }),
    ];
    assert.deepEqual(detectMaintenanceRuns({ now: NOW, workOrders: mixed, knownRooms: [] }), []);
  });

  test('a ticket whose words match nothing is never grouped', () => {
    const vague = [
      wo({ id: 'a', location: 'Room 214', description: 'Something is off in here.' }),
      wo({ id: 'b', location: 'Room 216', description: 'Guest was unhappy.' }),
      wo({ id: 'c', location: 'Room 218', description: 'Please look at this room.' }),
    ];
    assert.deepEqual(detectMaintenanceRuns({ now: NOW, workOrders: vague, knownRooms: [] }), []);
  });

  test('tickets older than the window are not part of lately', () => {
    const stale = RUN.map((o) => ({ ...o, createdAt: '2025-01-01T00:00:00Z' }));
    assert.deepEqual(detectMaintenanceRuns({ now: NOW, workOrders: stale, knownRooms: [] }), []);
  });

  test('a sibling room is only named when this hotel is known to have it', () => {
    const without = detectMaintenanceRuns({ now: NOW, workOrders: RUN, knownRooms: [] })[0];
    assert.equal(without.anchors.some((a) => !a.present), false);

    const withRooms = detectMaintenanceRuns({
      now: NOW,
      workOrders: RUN,
      knownRooms: ['214', '216', '218', '220', '222', '224'],
    })[0];
    const sibling = withRooms.anchors.find((a) => !a.present);
    assert.ok(sibling, 'expected the gap in the middle of the run to be named');
    // 216 and 220 are both inside the run and untouched; the lowest gap wins.
    assert.equal(sibling.label, 'ROOM 216');
    assert.equal(sibling.domId, '', 'a room with no ticket has nothing to draw to');
    assert.match(sibling.note ?? '', /no ticket/);
  });

  test('the sibling room is never one from another floor or the other side', () => {
    assert.equal(siblingRoomFor(['314', '316', '215'], { floor: 2, even: true }, ['214', '218']), null);
  });

  test('no dollar figure when this hotel has never recorded a repair cost', () => {
    const found = detectMaintenanceRuns({ now: NOW, workOrders: RUN, knownRooms: [] })[0];
    assert.equal(found.cost?.figure, null);
    assert.match(found.cost?.basis ?? '', /No dollar figure/);
    // And the words that stand in for it carry no number at all.
    assert.equal(/\d/.test(found.cost?.line ?? ''), false);
  });

  test('a dollar figure appears only from this hotel\'s own recorded costs', () => {
    const priced = RUN.map((o, i) => ({ ...o, repairCost: [120, 260, 410][i] }));
    const found = detectMaintenanceRuns({ now: NOW, workOrders: priced, knownRooms: [] })[0];
    assert.ok(found.cost?.figure, 'three recorded costs should support a range');
    // A range, never a point estimate.
    assert.match(found.cost!.figure!, /\$[\d,]+.\$[\d,]+/);
    assert.match(found.cost!.basis, /repair cost/);
  });

  test('every action the card offers names a tool that exists', () => {
    const found = detectMaintenanceRuns({
      now: NOW,
      workOrders: RUN,
      knownRooms: ['214', '216', '218', '222'],
    })[0];
    assert.ok(found.actions.length > 0);
    for (const action of found.actions) {
      assert.equal(action.tool, 'create_work_order');
      assert.ok(action.args.description && action.args.description.length > 10);
      assert.ok(action.args.location);
      assert.ok(['low', 'medium', 'urgent'].includes(action.args.severity ?? ''));
    }
  });

  test('a non-room location keeps its own name and reaches out to nobody', () => {
    const lobby = [
      wo({ id: 'a', location: 'Lobby', description: 'AC blowing warm at the desk.' }),
      wo({ id: 'b', location: 'Lobby', description: 'AC rattles in the morning.' }),
      wo({ id: 'c', location: 'Lobby', description: 'Thermostat will not hold.' }),
    ];
    const found = detectMaintenanceRuns({
      now: NOW, workOrders: lobby, knownRooms: ['214', '216'],
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].anchors.every((a) => a.present), true);
    assert.match(found[0].kicker, /Lobby/);
  });

  test('a hotel with nothing wrong produces nothing at all', () => {
    assert.deepEqual(detectMaintenanceRuns({ now: NOW, workOrders: [], knownRooms: [] }), []);
  });

  test('the word matcher stops at word boundaries', () => {
    assert.equal(categoryOf('Room is vacant and dusty'), null);
    assert.equal(categoryOf('A/C is dead'), 'hvac');
    assert.equal(categoryOf('Switchboard panel scuffed'), null);
    assert.equal(categoryOf('Light switch broken'), 'electrical');
  });

  test('a room number is read out of a free-text location, or not at all', () => {
    assert.equal(roomNumberOf('Room 214'), '214');
    assert.equal(roomNumberOf('rm 214'), '214');
    assert.equal(roomNumberOf('214'), '214');
    assert.equal(roomNumberOf('Hall 2F'), null);
    assert.equal(roomNumberOf('Laundry Room'), null);
    assert.deepEqual(runOf('214'), { floor: 2, even: true });
    assert.deepEqual(runOf('1215'), { floor: 12, even: false });
  });
});

// ─── Inventory ──────────────────────────────────────────────────────────────

const ITEM: TraceInventoryItem = { id: 'i1', name: 'Bath towel, 27x54', parLevel: 600 };

function count(day: string, stock: number): TraceCountPoint {
  return { itemId: 'i1', countedStock: stock, countedAt: `${day}T09:00:00Z` };
}

function delivery(over: Partial<TraceDelivery> & { id: string; day: string }): TraceDelivery {
  const { day, ...rest } = over;
  return {
    itemId: 'i1',
    quantity: 240,
    unitCost: null,
    vendorName: 'Gulf Linen',
    receivedAt: `${day}T09:00:00Z`,
    ...rest,
  };
}

describe('the inventory drift detector', () => {
  test('usage is a daily rate, so an uneven gap between counts is not a jump', () => {
    // 100 used over 20 days and 200 used over 40 days are the same hotel.
    const a = dailyUsageBetween(count('2026-05-01', 500), count('2026-05-21', 400), []);
    const b = dailyUsageBetween(count('2026-05-01', 500), count('2026-06-10', 300), []);
    assert.ok(a !== null && b !== null);
    assert.ok(Math.abs(a - b) < 0.001);
  });

  test('deliveries between two counts are added before the arithmetic', () => {
    const used = dailyUsageBetween(
      count('2026-05-01', 500),
      count('2026-05-31', 500),
      [delivery({ id: 'd', day: '2026-05-10', quantity: 300 })],
    );
    assert.ok(used !== null);
    assert.equal(Math.round(used * 30), 300);
  });

  test('a real jump against the hotel\'s own earlier periods is one pattern', () => {
    const found = detectInventoryDrift({
      now: NOW,
      items: [ITEM],
      counts: [
        count('2026-05-01', 600),
        count('2026-06-01', 500),
        count('2026-07-01', 400),
        count('2026-08-01', 200),
      ],
      deliveries: [],
    });
    const jump = found.find((p) => p.kicker.startsWith('Usage up'));
    assert.ok(jump, 'expected a usage pattern');
    assert.equal(jump.page, 'inventory');
    assert.deepEqual(jump.anchors.map((a) => a.domId), ['inv:i1']);
    // Baseline treatment: it says the thing and offers nothing, because there
    // is no "flag for recount" in this product.
    assert.deepEqual(jump.actions, []);
    assert.equal(jump.cost, null);
  });

  test('a small wobble is not a jump', () => {
    const found = detectInventoryDrift({
      now: NOW,
      items: [ITEM],
      counts: [count('2026-05-01', 600), count('2026-06-01', 500), count('2026-07-01', 390)],
      deliveries: [],
    });
    assert.equal(found.some((p) => p.kicker.startsWith('Usage up')), false);
  });

  test('a big percentage of a tiny number stays quiet', () => {
    const tiny: TraceInventoryItem = { id: 'i1', name: 'Ice bucket liner', parLevel: 4000 };
    const found = detectInventoryDrift({
      now: NOW,
      items: [tiny],
      counts: [count('2026-05-01', 100), count('2026-06-01', 98), count('2026-07-01', 93)],
      deliveries: [],
    });
    assert.equal(found.some((p) => p.kicker.startsWith('Usage up')), false);
  });

  test('two counts is not enough history to compare anything', () => {
    const found = detectInventoryDrift({
      now: NOW,
      items: [ITEM],
      counts: [count('2026-06-01', 600), count('2026-07-01', 100)],
      deliveries: [],
    });
    assert.deepEqual(found, []);
  });

  test('two prices for the same item is a pattern, quoted off the two rows', () => {
    const found = detectInventoryDrift({
      now: NOW,
      items: [ITEM],
      counts: [],
      deliveries: [
        delivery({ id: 'd1', day: '2026-07-11', unitCost: 4.1 }),
        delivery({ id: 'd2', day: '2026-07-24', unitCost: 4.85 }),
      ],
    });
    const split = found.find((p) => p.kicker.startsWith('Two prices'));
    assert.ok(split);
    assert.equal(split.cost?.figure, '$0.75');
    assert.match(split.facts.map((f) => f.v).join(' '), /\$4\.10/);
    assert.match(split.facts.map((f) => f.v).join(' '), /\$4\.85/);
    assert.deepEqual(split.actions, []);
  });

  test('a correction never gets compared against the row it corrects', () => {
    const found = detectInventoryDrift({
      now: NOW,
      items: [ITEM],
      counts: [],
      // Only the corrected row survives the server-side filter, so the detector
      // sees one price and has nothing to say. This is the shape the loader
      // hands it; the test pins the consequence.
      deliveries: [delivery({ id: 'd2', day: '2026-07-24', unitCost: 4.85 })],
    });
    assert.deepEqual(found, []);
  });

  test('two prices a few cents apart is a supplier, not a finding', () => {
    const found = detectInventoryDrift({
      now: NOW,
      items: [ITEM],
      counts: [],
      deliveries: [
        delivery({ id: 'd1', day: '2026-07-11', unitCost: 4.1 }),
        delivery({ id: 'd2', day: '2026-07-24', unitCost: 4.2 }),
      ],
    });
    assert.deepEqual(found, []);
  });
});

// ─── Attendance ─────────────────────────────────────────────────────────────

function callout(id: string, businessDate: string, staffId = 's1'): TraceCallout {
  return { id, staffId, staffName: 'Marisol Reyes', businessDate };
}

describe('the attendance weekday detector', () => {
  test('a business date is read as a calendar label, never shifted by a timezone', () => {
    // 2026-06-24 is a Wednesday. It stays one whatever the server is doing.
    assert.equal(weekdayOf('2026-06-24'), 3);
    assert.equal(weekdayOf('not a date'), null);
  });

  test('three callouts on one weekday is a pattern', () => {
    const found = detectCalloutWeekday({
      now: NOW,
      callouts: [
        callout('a', '2026-06-24'),
        callout('b', '2026-07-08'),
        callout('c', '2026-07-22'),
      ],
    });
    assert.equal(found.length, 1);
    assert.match(found[0].body, /Wednesday/);
    assert.equal(found[0].facts.length, 3);
  });

  test('everything it produces is people-sensitive, unanchored and unactionable', () => {
    const found = detectCalloutWeekday({
      now: NOW,
      callouts: [callout('a', '2026-06-24'), callout('b', '2026-07-08'), callout('c', '2026-07-22')],
    });
    for (const pattern of found) {
      // The one field that keeps it out of every unprompted surface.
      assert.equal(pattern.sensitivity, 'people');
      // Nothing to draw, nowhere to draw it, nothing to walk to.
      assert.equal(pattern.page, null);
      assert.deepEqual(pattern.anchors, []);
      assert.deepEqual(pattern.actions, []);
      assert.deepEqual(pattern.covers, []);
      // The ASK never contains the person's name. Only the card does, and the
      // card is only ever inside a panel somebody opened.
      assert.equal(pattern.ask.includes('Marisol'), false);
    }
  });

  test('two on a weekday is a coincidence', () => {
    const found = detectCalloutWeekday({
      now: NOW,
      callouts: [callout('a', '2026-06-24'), callout('b', '2026-07-08')],
    });
    assert.deepEqual(found, []);
  });

  test('somebody who calls out on every day of the week has no weekday pattern', () => {
    const found = detectCalloutWeekday({
      now: NOW,
      callouts: [
        callout('a', '2026-06-24'), callout('b', '2026-07-08'), callout('c', '2026-07-22'),
        callout('d', '2026-06-25'), callout('e', '2026-06-26'), callout('f', '2026-07-02'),
        callout('g', '2026-07-03'),
      ],
    });
    assert.deepEqual(found, []);
  });

  test('two people are never merged into one pattern', () => {
    const found = detectCalloutWeekday({
      now: NOW,
      callouts: [
        callout('a', '2026-06-24', 's1'),
        callout('b', '2026-07-08', 's2'),
        callout('c', '2026-07-22', 's1'),
      ],
    });
    assert.deepEqual(found, []);
  });

  test('a hotel with no callouts recorded says nothing, which is a real answer', () => {
    assert.deepEqual(detectCalloutWeekday({ now: NOW, callouts: [] }), []);
  });

  test('the identity is the person and the weekday, and survives a fourth callout', () => {
    const three = detectCalloutWeekday({
      now: NOW,
      callouts: [callout('a', '2026-06-24'), callout('b', '2026-07-08'), callout('c', '2026-07-22')],
    })[0];
    const four = detectCalloutWeekday({
      now: NOW,
      callouts: [
        callout('a', '2026-06-24'), callout('b', '2026-07-08'),
        callout('c', '2026-07-22'), callout('d', '2026-07-29'),
      ],
    })[0];
    assert.equal(three.key, four.key);
    assert.equal(three.key, tracePatternKey('callout_weekday', ['s1', '3']));
    // The key carries no name, because it is stored in a preferences blob.
    assert.equal(three.key.toLowerCase().includes('marisol'), false);
  });
});
