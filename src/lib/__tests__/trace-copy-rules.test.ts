/**
 * WHAT THE TRACE IS ALLOWED TO SAY.
 *
 * A producer walk, not a grep. Every sentence a trace carries is built by code
 * in src/lib/companion/trace, so this file RUNS that code over a spread of
 * fixture hotels and reads the output. A guard that grepped the source would
 * pass on a dash assembled at runtime and fail on a harmless rename, which is
 * the failure mode the house rule names.
 *
 * The rules being held:
 *   - no em dashes and no en dashes in prose (the money range keeps its en dash,
 *     which is the one place the product has always used one)
 *   - English only, no Spanish sibling strings
 *   - NO INVENTED NUMBERS. A dollar figure appears only when this hotel's own
 *     records support a range; when they do not, the words that stand in for it
 *     carry no figures at all.
 *   - the ask is one sentence and ends in a question
 *   - nothing people-sensitive is ever in an ask
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MONEY_RANGE_DASH } from '@/lib/findings/pricing';
import {
  detectMaintenanceRuns,
  type TraceWorkOrder,
} from '@/lib/companion/trace/detectors/maintenance-run';
import { detectInventoryDrift } from '@/lib/companion/trace/detectors/inventory-drift';
import { detectCalloutWeekday } from '@/lib/companion/trace/detectors/callout-weekday';
import type { TracePattern } from '@/lib/companion/trace/types';

const NOW = new Date('2026-08-02T15:00:00Z');

function wo(id: string, location: string, description: string, day: string, cost: number | null = null): TraceWorkOrder {
  return { id, location, description, open: true, createdAt: `${day}T12:00:00Z`, repairCost: cost };
}

/**
 * Every shape a trace can come out in, from the real detectors.
 *
 * Deliberately includes the priced and unpriced maintenance runs, a non-room
 * location, both inventory signals, and the attendance pattern, because the
 * dash and the number rules have to hold across all of them and each one
 * assembles its prose differently.
 */
function everyPattern(): TracePattern[] {
  const out: TracePattern[] = [];

  const unpriced = [
    wo('a', 'Room 222', 'AC rattles when it kicks on.', '2026-06-14'),
    wo('b', 'Room 218', 'Cools, then stops cooling by evening.', '2026-07-02'),
    wo('c', 'Room 214', 'AC blowing warm. Guest moved to 216.', '2026-07-30'),
  ];
  out.push(...detectMaintenanceRuns({ now: NOW, workOrders: unpriced, knownRooms: [] }));
  out.push(...detectMaintenanceRuns({
    now: NOW,
    workOrders: unpriced,
    knownRooms: ['214', '216', '218', '220', '222', '224'],
  }));
  out.push(...detectMaintenanceRuns({
    now: NOW,
    workOrders: [
      wo('a', 'Room 222', 'AC rattles.', '2026-06-14', 120),
      wo('b', 'Room 218', 'AC stops cooling.', '2026-07-02', 260),
      wo('c', 'Room 214', 'AC blowing warm.', '2026-07-30', 410),
    ],
    knownRooms: ['214', '216', '218', '222'],
  }));
  out.push(...detectMaintenanceRuns({
    now: NOW,
    workOrders: [
      wo('a', 'Lobby', 'Left entry door sticks in the morning.', '2026-06-20'),
      wo('b', 'Lobby', 'Door lock will not catch.', '2026-07-04'),
      wo('c', 'Lobby', 'Front door hinge dropped.', '2026-07-28'),
    ],
    knownRooms: [],
  }));

  out.push(...detectInventoryDrift({
    now: NOW,
    items: [{ id: 'i1', name: 'Bath towel, 27x54', parLevel: 600 }],
    counts: [
      { itemId: 'i1', countedStock: 600, countedAt: '2026-05-01T09:00:00Z' },
      { itemId: 'i1', countedStock: 500, countedAt: '2026-06-01T09:00:00Z' },
      { itemId: 'i1', countedStock: 400, countedAt: '2026-07-01T09:00:00Z' },
      { itemId: 'i1', countedStock: 200, countedAt: '2026-08-01T09:00:00Z' },
    ],
    deliveries: [
      { id: 'd1', itemId: 'i1', quantity: 240, unitCost: 4.1, vendorName: 'Gulf Linen', receivedAt: '2026-07-11T09:00:00Z' },
      { id: 'd2', itemId: 'i1', quantity: 240, unitCost: 4.85, vendorName: 'Gulf Linen', receivedAt: '2026-07-24T09:00:00Z' },
    ],
  }));

  out.push(...detectCalloutWeekday({
    now: NOW,
    callouts: [
      { id: 'a', staffId: 's1', staffName: 'Marisol Reyes', businessDate: '2026-06-24' },
      { id: 'b', staffId: 's1', staffName: 'Marisol Reyes', businessDate: '2026-07-08' },
      { id: 'c', staffId: 's1', staffName: 'Marisol Reyes', businessDate: '2026-07-22' },
    ],
  }));

  assert.ok(out.length >= 6, 'the walk must actually cover every shape');
  return out;
}

/** Every string a person can read, from one pattern. */
function prose(pattern: TracePattern): string[] {
  return [
    pattern.ask,
    pattern.kicker,
    pattern.body,
    pattern.basis,
    ...pattern.facts.flatMap((f) => [f.k, f.v]),
    ...pattern.anchors.map((a) => a.label),
    ...pattern.anchors.map((a) => a.note ?? ''),
    ...pattern.actions.map((a) => a.label),
    ...pattern.actions.map((a) => a.args.description ?? ''),
    ...(pattern.cost ? [pattern.cost.line, pattern.cost.basis] : []),
  ].filter((s) => s.length > 0);
}

describe('what a trace says', () => {
  test('no em dashes anywhere a person can read', () => {
    for (const pattern of everyPattern()) {
      for (const line of prose(pattern)) {
        assert.equal(line.includes('—'), false, `em dash in: ${line}`);
      }
    }
  });

  test('no en dashes outside a money range, which is the one place the product uses one', () => {
    // A money range is "$120–$410" and nothing else. Remove those, and any en
    // dash left over is prose using one, which is the thing being banned.
    const MONEY_RANGE = /\$[\d,.]+–\$[\d,.]+/g;
    for (const pattern of everyPattern()) {
      for (const line of prose(pattern)) {
        const withoutMoney = line.replace(MONEY_RANGE, '');
        assert.equal(
          withoutMoney.includes(MONEY_RANGE_DASH), false, `en dash in prose: ${line}`,
        );
      }
      if (pattern.cost?.figure?.includes(MONEY_RANGE_DASH)) {
        assert.match(pattern.cost.figure, /^\$[\d,.]+–\$[\d,.]+$/);
      }
    }
  });

  test('English only, with no Spanish sibling anywhere in the shape', () => {
    for (const pattern of everyPattern()) {
      const json = JSON.stringify(pattern);
      for (const word of ['¿', '¡', 'Habitación', 'habitacion', 'Mantenimiento', 'Inventario']) {
        assert.equal(json.includes(word), false, `Spanish in ${pattern.detectorId}: ${word}`);
      }
      // A key named `es` would be the first sign of a translation creeping back.
      assert.equal(/"(es|textEs|summaryEs)"\s*:/.test(json), false);
    }
  });

  test('a dollar figure exists only when the hotel\'s own records support one', () => {
    for (const pattern of everyPattern()) {
      if (!pattern.cost) continue;
      if (pattern.cost.figure === null) {
        // The words that stand in for a number must carry no number.
        assert.equal(/\d/.test(pattern.cost.line), false, `figure smuggled into: ${pattern.cost.line}`);
        assert.match(pattern.cost.basis, /No dollar figure/);
      } else {
        assert.match(pattern.cost.figure, /^\$/);
        assert.ok(pattern.cost.basis.length > 10, 'a figure must say where it came from');
      }
    }
  });

  test('the maintenance run with no recorded costs still says something true', () => {
    const unpriced = detectMaintenanceRuns({
      now: NOW,
      workOrders: [
        wo('a', 'Room 222', 'AC rattles.', '2026-06-14'),
        wo('b', 'Room 218', 'AC stops cooling.', '2026-07-02'),
        wo('c', 'Room 214', 'AC blowing warm.', '2026-07-30'),
      ],
      knownRooms: [],
    })[0];
    assert.equal(unpriced.cost?.figure, null);
    assert.match(unpriced.cost!.line, /One repair on the shared part now/);
  });

  test('the ask is one sentence, ends in a question, and never names a person', () => {
    for (const pattern of everyPattern()) {
      assert.match(pattern.ask, /\?$/, `ask does not ask: ${pattern.ask}`);
      assert.ok(pattern.ask.length < 200, `ask is a paragraph: ${pattern.ask}`);
      assert.equal(pattern.ask.includes('Marisol'), false);
    }
  });

  test('no sentence shouts, and none of them is empty', () => {
    for (const pattern of everyPattern()) {
      for (const line of prose(pattern)) {
        assert.equal(line.trim().length > 0, true);
        assert.equal(line.includes('!'), false, `exclamation in: ${line}`);
      }
    }
  });

  test('every action a card offers names a real tool and carries a real plan', () => {
    for (const pattern of everyPattern()) {
      for (const action of pattern.actions) {
        // The catalog has exactly one entry, and there is no merge tool in this
        // product, so no card may offer one.
        assert.equal(action.tool, 'create_work_order');
        assert.equal(action.label.toLowerCase().includes('merge'), false);
        assert.ok((action.args.description ?? '').length > 10);
      }
    }
  });
});
