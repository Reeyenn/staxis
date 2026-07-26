/**
 * The Spanish half of a hotel finding's two receipt lines.
 *
 * The bug this file stands on: every hotel detector writes its basis lines in
 * English only, `toQueueFinding` has always had a `basisEs` seam, and nothing
 * on the hotel side filled it — so a Spanish-reading manager got a Spanish
 * headline over an English "based on…" line on every card in the product. The
 * portfolio checks had the same defect and were fixed; the hotel detectors,
 * which are all of them, were not.
 *
 * What is asserted here:
 *   1. The detector ids this module dispatches on are the detectors' REAL ids.
 *      They are string literals (so an API route does not drag ten detector
 *      modules and their feed graph into its bundle), and a literal that
 *      silently stops matching is a translation that silently stops happening.
 *   2. Each renderer produces Spanish that is not the English, from the
 *      receipt's own fields — including the numerals.
 *   3. A detector whose basis CANNOT be rebuilt from what it stores keeps its
 *      English rather than getting half a translated sentence.
 *   4. A malformed receipt costs the translation, never the card.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hotelBasisSpanish,
  SPANISH_BASIS_DETECTORS,
  NO_SPANISH_BASIS_DETECTORS,
} from '@/lib/findings/basis-spanish';

import { repeatRoomWorkOrdersDetector } from '@/lib/findings/detectors/repeat-room-work-orders';
import { repeatEquipmentWorkOrdersDetector } from '@/lib/findings/detectors/repeat-equipment-work-orders';
import { workOrderRateBaselineDetector } from '@/lib/findings/detectors/work-order-rate-baseline';
import { supplySpendBaselineDetector } from '@/lib/findings/detectors/supply-spend-baseline';
import { inventoryUsageBaselineDetector } from '@/lib/findings/detectors/inventory-usage-baseline';
import { expectedActivityDetector } from '@/lib/findings/detectors/expected-activity';
import { preventiveDueDetector } from '@/lib/findings/detectors/preventive-due';
import { cleaningPlanHealthDetector } from '@/lib/findings/detectors/cleaning-plan-health';
import { roomAttentionDetector } from '@/lib/findings/detectors/room-attention';
import { operationalPatternDetector } from '@/lib/findings/detectors/operational-patterns';

// ─── 1. the ids are real ────────────────────────────────────────────────────

describe('the detector ids this module dispatches on', () => {
  test('every id it claims to translate is a real detector id', () => {
    assert.equal(SPANISH_BASIS_DETECTORS.repeatRoomWorkOrders, repeatRoomWorkOrdersDetector.declaration.id);
    assert.equal(
      SPANISH_BASIS_DETECTORS.repeatEquipmentWorkOrders,
      repeatEquipmentWorkOrdersDetector.declaration.id,
    );
    assert.equal(SPANISH_BASIS_DETECTORS.workOrderRateBaseline, workOrderRateBaselineDetector.declaration.id);
    assert.equal(SPANISH_BASIS_DETECTORS.supplySpendBaseline, supplySpendBaselineDetector.declaration.id);
    assert.equal(SPANISH_BASIS_DETECTORS.inventoryUsageBaseline, inventoryUsageBaselineDetector.declaration.id);
    assert.equal(SPANISH_BASIS_DETECTORS.expectedActivityStopped, expectedActivityDetector.declaration.id);
    assert.equal(SPANISH_BASIS_DETECTORS.preventiveDue, preventiveDueDetector.declaration.id);
    assert.equal(SPANISH_BASIS_DETECTORS.cleaningPlanHealth, cleaningPlanHealthDetector.declaration.id);
  });

  test('every id it deliberately stays silent on is also a real detector id', () => {
    assert.equal(NO_SPANISH_BASIS_DETECTORS.roomNeedsAttention, roomAttentionDetector.declaration.id);
    assert.equal(NO_SPANISH_BASIS_DETECTORS.operationalPattern, operationalPatternDetector.declaration.id);
  });

  test('a detector nobody has taught it about gets nothing rather than a guess', () => {
    assert.equal(hotelBasisSpanish('some_detector_shipped_next_month', { values: { a: 1 } }), null);
  });
});

// ─── 2. the sentences ───────────────────────────────────────────────────────

describe('repeat room work orders', () => {
  const receipt = {
    params: { location: 'Room 214', window_days: 30 },
    values: { work_orders: 4, still_open: 2, last_logged: '2026-07-24' },
  };

  test('the receipt line is Spanish, and it is not the English one', () => {
    const es = hotelBasisSpanish(repeatRoomWorkOrdersDetector.declaration.id, receipt);
    assert.ok(es?.evidence);
    assert.match(es.evidence, /órdenes de trabajo/);
    assert.doesNotMatch(es.evidence, /work order/);
    assert.doesNotMatch(es.evidence, /logged at/);
  });

  test('every number in it came off the receipt', () => {
    const es = hotelBasisSpanish(repeatRoomWorkOrdersDetector.declaration.id, receipt)!;
    assert.match(es.evidence!, /\b4\b/);
    assert.match(es.evidence!, /\b30\b/);
    assert.match(es.evidence!, /Room 214/); // the hotel's own label, left alone
    assert.match(es.evidence!, /2026-07-24/);
  });

  test('one work order is singular', () => {
    const es = hotelBasisSpanish(repeatRoomWorkOrdersDetector.declaration.id, {
      params: { location: 'Room 101', window_days: 30 },
      values: { work_orders: 1, last_logged: '2026-07-24' },
    })!;
    assert.match(es.evidence!, /1 orden de trabajo /);
    assert.doesNotMatch(es.evidence!, /1 órdenes/);
  });
});

describe('repeat equipment work orders', () => {
  test('names the asset and where it covers', () => {
    const es = hotelBasisSpanish(repeatEquipmentWorkOrdersDetector.declaration.id, {
      params: { equipment_id: 'e1', equipment_name: 'Ice machine', window_days: 60 },
      values: { work_orders: 3, covers: '2nd floor', last_logged: '2026-07-20' },
    })!;
    assert.match(es.evidence!, /Ice machine/);
    assert.match(es.evidence!, /2nd floor/);
    assert.match(es.evidence!, /60 días/);
    assert.doesNotMatch(es.evidence!, /logged against/);
  });

  test('an asset with no location does not render an empty bracket', () => {
    const es = hotelBasisSpanish(repeatEquipmentWorkOrdersDetector.declaration.id, {
      params: { equipment_name: 'Pool pump', window_days: 60 },
      values: { work_orders: 3, covers: null, last_logged: '2026-07-20' },
    })!;
    assert.doesNotMatch(es.evidence!, /\(\)/);
  });
});

describe('the weekly baselines', () => {
  test('work-order rate: Spanish receipt, English money line left alone', () => {
    const es = hotelBasisSpanish(workOrderRateBaselineDetector.declaration.id, {
      params: { baseline_weeks: 12, current_end: '2026-07-25', current_start: '2026-07-19' },
      values: { current_work_orders: 19, p25_per_week: 6, p75_per_week: 9 },
    })!;
    assert.match(es.evidence!, /semanas anteriores/);
    assert.doesNotMatch(es.evidence!, /weekdays/);
    // The English money line quotes a band of EXTRA work orders that the
    // receipt does not carry, so there is no honest Spanish for it.
    assert.equal(es.price, null);
  });

  test('supply spend: BOTH lines come back in Spanish, money included', () => {
    const es = hotelBasisSpanish(supplySpendBaselineDetector.declaration.id, {
      params: { baseline_weeks: 12, current_end: '2026-07-25' },
      values: { current_cents: 214_000, p25_cents: 82_000, p75_cents: 114_000 },
    })!;
    assert.match(es.evidence!, /12 semanas/);
    assert.ok(es.price);
    assert.match(es.price, /\$820/);
    assert.match(es.price, /\$1,140/);
    assert.match(es.price, /\$2,140/);
    assert.doesNotMatch(es.price, /comparable weeks/);
  });

  test('supply spend with the money fields missing keeps the receipt and drops only the price', () => {
    const es = hotelBasisSpanish(supplySpendBaselineDetector.declaration.id, {
      params: { baseline_weeks: 12, current_end: '2026-07-25' },
      values: {},
    })!;
    assert.ok(es.evidence);
    assert.equal(es.price, null);
  });
});

describe('inventory usage baseline', () => {
  test('says what was counted and against how many past counts', () => {
    const es = hotelBasisSpanish(inventoryUsageBaselineDetector.declaration.id, {
      params: { item_id: 'i1', interval_end: '2026-07-24', interval_days: 7 },
      values: { baseline_intervals: 6, item_name: 'Bath towels', unit: 'each' },
    })!;
    assert.match(es.evidence!, /2026-07-24/);
    assert.match(es.evidence!, /6 conteos/);
    assert.doesNotMatch(es.evidence!, /stock counted/);
  });
});

describe('expected activity stopped', () => {
  test('rebuilds the cadence sentence from the receipt', () => {
    const es = hotelBasisSpanish(expectedActivityDetector.declaration.id, {
      params: { stream: 'inventory_counts', as_of: '2026-07-25' },
      values: {
        last_seen: '2026-07-02',
        days_silent: 23,
        typical_gap_days: 3.5,
        long_but_normal_gap_days: 6,
        occurrences_on_record: 12,
      },
    })!;
    assert.match(es.evidence!, /12 veces registradas/);
    assert.match(es.evidence!, /2026-07-02/);
    assert.match(es.evidence!, /3\.5/);
    assert.doesNotMatch(es.evidence!, /on record/);
  });
});

describe('preventive due', () => {
  test('the ordinary arm: last done, the cadence, and how late it now is', () => {
    const es = hotelBasisSpanish(preventiveDueDetector.declaration.id, {
      params: { preventive_task_id: 't1', task_name: 'Cambiar filtros HVAC', frequency_days: 90 },
      values: { days_overdue: 25, days_since_last_done: 115, days_since_called: null },
    })!;
    assert.match(es.evidence!, /25 días de retraso/);
    assert.match(es.evidence!, /115 días/);
    assert.match(es.evidence!, /cada 90 días/);
    assert.doesNotMatch(es.evidence!, /past due/);
  });

  test('the follow-up arm is a DIFFERENT sentence, chosen off the payload', () => {
    const ordinary = hotelBasisSpanish(preventiveDueDetector.declaration.id, {
      params: { task_name: 'Revisar la caldera', frequency_days: 30 },
      values: { days_overdue: 4, days_since_last_done: 34, days_since_called: null },
    })!;
    const followUp = hotelBasisSpanish(preventiveDueDetector.declaration.id, {
      params: { task_name: 'Revisar la caldera', frequency_days: 30 },
      values: { days_overdue: 4, days_since_last_done: 34, days_since_called: 6 },
    })!;
    assert.notEqual(ordinary.evidence, followUp.evidence);
    assert.match(followUp.evidence!, /avisado hace 6 días/);
    assert.doesNotMatch(followUp.evidence!, /marked done/);
  });

  test('due today is not "0 días de retraso"', () => {
    const es = hotelBasisSpanish(preventiveDueDetector.declaration.id, {
      params: { task_name: 'Prueba de alarma', frequency_days: 30 },
      values: { days_overdue: 0, days_since_last_done: 30, days_since_called: null },
    })!;
    assert.match(es.evidence!, /vence hoy/);
    assert.doesNotMatch(es.evidence!, /\bde retraso\b/);
  });

  // The one card in the product whose whole subject is "we cannot count this
  // yet". Without its own arm it fell through to null and a Spanish reader got
  // the English receipt under a Spanish headline — the exact split this module
  // exists to close.
  test('the unstarted arm says there is no date to count from, and claims no lateness', () => {
    const es = hotelBasisSpanish(preventiveDueDetector.declaration.id, {
      params: { preventive_task_id: 't9', task_name: 'Prueba de generador', frequency_days: 90 },
      values: {
        last_done: null, last_done_at: null, due_on: null,
        days_since_last_done: null, days_overdue: null, days_since_called: null,
      },
    })!;
    assert.ok(es, 'the unstarted card fell back to English');
    assert.match(es.evidence!, /cada 90 días/);
    assert.match(es.evidence!, /no hay ninguna fecha registrada/);
    assert.doesNotMatch(es.evidence!, /retraso|vence hoy/, 'nothing here is late');
    assert.doesNotMatch(es.evidence!, /undefined|null/);
  });

  test('a receipt with no lateness AND no cadence is still null, not a sentence with holes', () => {
    assert.equal(
      hotelBasisSpanish(preventiveDueDetector.declaration.id, {
        params: { task_name: 'Prueba de generador' },
        values: { last_done: null, days_overdue: null },
      }),
      null,
    );
  });

  test('an unknown last-completion is said, not invented', () => {
    const es = hotelBasisSpanish(preventiveDueDetector.declaration.id, {
      params: { task_name: 'Prueba de alarma', frequency_days: 30 },
      values: { days_overdue: 12, days_since_last_done: null, days_since_called: null },
    })!;
    assert.match(es.evidence!, /no se sabe/);
  });
});

describe('cleaning plan health', () => {
  test('both counts survive into the Spanish', () => {
    const es = hotelBasisSpanish(cleaningPlanHealthDetector.declaration.id, {
      params: { business_date: '2026-07-25', dry_run: true },
      values: { rooms_evaluated: 48, rooms_failed: 5, rooms: ['101', '102'] },
    })!;
    assert.match(es.evidence!, /5 de 48 habitaciones/);
    assert.doesNotMatch(es.evidence!, /failed rule evaluation/);
  });
});

// ─── 3. the ones it must NOT translate ──────────────────────────────────────

describe('the detectors whose basis cannot be rebuilt', () => {
  test('room attention keeps its English — its sentence carries a figure the receipt never sees', () => {
    // The nudge layer writes "…for 120 min. Usually takes ~25 min." The ~25
    // reaches no field, so any Spanish here would be a shorter, different
    // claim wearing the same slot.
    const es = hotelBasisSpanish(roomAttentionDetector.declaration.id, {
      params: { business_date: '2026-07-25', room_number: '214', alert_type: 'clean_slow' },
      values: { minutes: 120, nudge_severity: 'attention', staff_name: 'Maria' },
    });
    assert.equal(es, null);
  });

  test('operational patterns keep their English — one metric shape carries two medians the receipt drops', () => {
    const es = hotelBasisSpanish(operationalPatternDetector.declaration.id, {
      params: { window_days: 30, target_kind: 'room', target_value: '214', detail: 'hvac' },
      values: { count: 4, category: 'maintenance', target_label: 'Room 214' },
    });
    assert.equal(es, null);
  });
});

// ─── 4. a malformed receipt costs the translation, never the card ───────────

describe('when the receipt is not what the renderer expected', () => {
  test('missing fields produce null rather than a sentence with holes in it', () => {
    assert.equal(hotelBasisSpanish(repeatRoomWorkOrdersDetector.declaration.id, { params: {}, values: {} }), null);
    assert.equal(hotelBasisSpanish(supplySpendBaselineDetector.declaration.id, { params: {}, values: {} }), null);
    assert.equal(hotelBasisSpanish(preventiveDueDetector.declaration.id, { params: {}, values: {} }), null);
  });

  test('wrong-typed fields produce null rather than "undefined" in the prose', () => {
    const es = hotelBasisSpanish(repeatRoomWorkOrdersDetector.declaration.id, {
      params: { location: 42, window_days: 'thirty' },
      values: { work_orders: '4' },
    });
    assert.equal(es, null);
  });

  test('no receipt at all is null', () => {
    assert.equal(hotelBasisSpanish(preventiveDueDetector.declaration.id, null), null);
    assert.equal(hotelBasisSpanish(preventiveDueDetector.declaration.id, undefined), null);
  });

  test('nothing it returns is ever the empty string masquerading as a sentence', () => {
    const es = hotelBasisSpanish(cleaningPlanHealthDetector.declaration.id, {
      values: { rooms_evaluated: 48, rooms_failed: 5 },
    })!;
    assert.ok(es.evidence!.length > 10);
  });
});
