// Regression fix: pms_reservations.status has a LIVE DB CHECK
// (booked/checked_in/checked_out/cancelled/no_show or null) but an empty 0207
// descriptor allowed_values, so a raw learned status used to write straight
// through and the CHECK rejected the WHOLE arrivals/departures reservation row
// (batch loss). Giving the column its canonical enumValues routes it through
// generic_enum: known/learned → canonical, anything else → null (status is
// optional, so the reservation still writes). These pin that behavior.

import './ws-polyfill.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveColumnParser } from '../target-contract.js';
import { getParser } from '../parsers/registry.js';
import { sanitizeReservationLifecycle, getValidator } from '../validators-phase2.js';
import '../parsers/generic.js';

const CANON = ['booked', 'checked_in', 'checked_out', 'cancelled', 'no_show'];

describe('pms_reservations.status is normalized, never raw (no batch loss)', () => {
  for (const action of ['getArrivals', 'getDepartures'] as const) {
    test(`${action}.status routes through generic_enum with null-on-unknown`, () => {
      // Legacy / unlearned recipe (no learned mapping): still an enum parser,
      // and 'unknown' is NOT a CHECK value so onUnknown must be null.
      const r = resolveColumnParser(action, 'status', { valueTranslations: {} });
      assert.equal(r?.parser, 'generic_enum');
      assert.equal(r?.config?.onUnknown ?? null, null);
    });

    test(`${action}.status uses the self-learned mapping when present`, () => {
      const r = resolveColumnParser(action, 'status', {
        valueTranslations: { 'pms_reservations.status': { 'Due In': 'checked_in', 'Due Out': 'checked_out' } },
      });
      assert.equal(r?.parser, 'generic_enum');
      assert.deepEqual(r?.config?.mapping, { 'Due In': 'checked_in', 'Due Out': 'checked_out' });
    });
  }

  test('generic_enum never emits a non-canonical raw value', () => {
    const ge = getParser('generic_enum')!;
    // Unknown raw, no mapping → null (not the raw string) → passes the CHECK.
    assert.equal(ge('Reserved', { onUnknown: null }), null);
    assert.equal(ge('Due In', { onUnknown: null }), null);
    // With a learned mapping the PMS word maps to a canonical value.
    assert.equal(ge('Due In', { mapping: { 'Due In': 'checked_in' }, onUnknown: null }), 'checked_in');
    // An unmapped value alongside a mapping still nulls (never raw).
    assert.equal(ge('Weird', { mapping: { 'Due In': 'checked_in' }, onUnknown: null }), null);
    // Whatever it returns is canonical or null — never a CHECK violation.
    for (const v of ['Reserved', 'In House', 'CHECKED IN', 'no-show', '']) {
      const out = ge(v, { mapping: { 'CHECKED IN': 'checked_in' }, onUnknown: null });
      assert.ok(out === null || CANON.includes(out as string), `got non-canonical: ${out}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Migration 0345 — reservation lifecycle coherence
// ═══════════════════════════════════════════════════════════════════════════
// 0345 folded pms_future_bookings / pms_no_shows / pms_cancellations into
// pms_reservations and added four CHECK constraints:
//
//   pms_res_cancel_coherent        status='cancelled' ⇔ cancelled_date set
//   pms_res_noshow_coherent        status='no_show'   ⇔ no_show_date set
//   pms_res_fee_requires_cancel    a fee only on a cancelled reservation
//   pms_res_booked_before_arrival  booked_at <= arrival_date
//
// Same batch-loss hazard as the status enum above, one layer down: the writer
// sends ONE .upsert() per batch, so a single incoherent row destroys the whole
// batch and the feed looks like a healthy empty poll. The sanitizer runs first
// so the CHECKs are a backstop that never fires on real data.

/** The 0345 CHECK constraints, re-expressed in TypeScript. */
function violatedChecks(row: Record<string, unknown>): string[] {
  const bad: string[] = [];
  const status = row.status ?? null;
  const cancelled = row.cancelled_date ?? null;
  const noShow = row.no_show_date ?? null;
  const fee = row.cancellation_fee_cents ?? null;
  const bookedAt = row.booked_at ?? null;
  const arrival = row.arrival_date ?? null;

  if ((status === 'cancelled') !== (cancelled !== null)) bad.push('pms_res_cancel_coherent');
  if ((status === 'no_show') !== (noShow !== null)) bad.push('pms_res_noshow_coherent');
  if (fee !== null && status !== 'cancelled') bad.push('pms_res_fee_requires_cancel');
  if (bookedAt !== null && arrival !== null && String(bookedAt) > String(arrival)) {
    bad.push('pms_res_booked_before_arrival');
  }
  return bad;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

describe('sanitizeReservationLifecycle — 0345 coherence', () => {
  test('a cancelled row with no cancelled_date comes out with one stamped', () => {
    const { clean, warnings } = sanitizeReservationLifecycle({
      pms_reservation_id: 'R-1', status: 'cancelled', arrival_date: '2026-08-01',
    });
    assert.equal(clean.status, 'cancelled');
    assert.match(String(clean.cancelled_date), ISO_DATE);
    assert.deepEqual(violatedChecks(clean), []);
    assert.ok(warnings.some((w) => w.includes('cancelled_date')));
  });

  test('a cancelled_date with no status infers status=cancelled', () => {
    const { clean } = sanitizeReservationLifecycle({
      pms_reservation_id: 'R-2', cancelled_date: '2026-07-20',
    });
    assert.equal(clean.status, 'cancelled');
    assert.equal(clean.cancelled_date, '2026-07-20');
    assert.deepEqual(violatedChecks(clean), []);
  });

  test('a no_show row with no no_show_date falls back to arrival_date', () => {
    const { clean } = sanitizeReservationLifecycle({
      pms_reservation_id: 'R-3', status: 'no_show', arrival_date: '2026-07-19',
    });
    assert.equal(clean.no_show_date, '2026-07-19');
    assert.deepEqual(violatedChecks(clean), []);
  });

  test('an explicit cancellation outranks a no-show on the same row', () => {
    const { clean } = sanitizeReservationLifecycle({
      pms_reservation_id: 'R-4',
      status: 'no_show',
      no_show_date: '2026-07-18',
      cancelled_date: '2026-07-17',
    });
    assert.equal(clean.status, 'cancelled');
    assert.equal(clean.cancelled_date, '2026-07-17');
    assert.equal(clean.no_show_date, null);
    assert.deepEqual(violatedChecks(clean), []);
  });

  test('a cancelled_date on a row reported as booked corrects the status, it does not discard the date', () => {
    const { clean } = sanitizeReservationLifecycle({
      pms_reservation_id: 'R-5',
      status: 'booked',
      cancelled_date: '2026-07-01',
      no_show_date: '2026-07-02',
      cancellation_fee_cents: 5000,
      cancellation_reason: 'guest called',
    });
    assert.equal(clean.status, 'cancelled');
    assert.equal(clean.no_show_date, null);
    assert.equal(clean.cancellation_fee_cents, 5000);
    assert.deepEqual(violatedChecks(clean), []);
  });

  test('a cancellation fee with no cancellation anywhere is dropped', () => {
    const { clean } = sanitizeReservationLifecycle({
      pms_reservation_id: 'R-6', status: 'checked_out', cancellation_fee_cents: 2500,
    });
    assert.equal(clean.status, 'checked_out');
    assert.equal(clean.cancellation_fee_cents, null);
    assert.deepEqual(violatedChecks(clean), []);
  });

  test('booked_at after arrival_date is a parse error, not a fact', () => {
    const { clean, warnings } = sanitizeReservationLifecycle({
      pms_reservation_id: 'R-7', status: 'booked',
      booked_at: '2026-09-09', arrival_date: '2026-08-01',
    });
    assert.equal(clean.booked_at, null);
    assert.ok(warnings.some((w) => w.includes('booked_at')));
    assert.deepEqual(violatedChecks(clean), []);
  });

  test('a plausible booked_at survives untouched', () => {
    const { clean } = sanitizeReservationLifecycle({
      pms_reservation_id: 'R-8', status: 'booked',
      booked_at: '2026-06-02', arrival_date: '2026-08-01',
    });
    assert.equal(clean.booked_at, '2026-06-02');
    assert.deepEqual(violatedChecks(clean), []);
  });

  test('nights_derived is never sent — it is GENERATED ALWAYS in Postgres', () => {
    const { clean } = sanitizeReservationLifecycle({
      pms_reservation_id: 'R-9', status: 'booked', nights_derived: 3,
    });
    assert.ok(!('nights_derived' in clean), 'sending a generated column is a hard insert error');
  });

  test('the input row is never mutated', () => {
    const input: Record<string, unknown> = { pms_reservation_id: 'R-10', status: 'cancelled' };
    sanitizeReservationLifecycle(input);
    assert.equal(input.cancelled_date, undefined);
  });

  // The property the batch actually depends on: whatever combination a
  // half-parsed report produces, the sanitized row is writable.
  test('no combination of status x lifecycle dates survives as a CHECK violation', () => {
    const statuses = [undefined, null, 'booked', 'checked_in', 'checked_out', 'cancelled', 'no_show'];
    const cancelledDates = [undefined, null, '2026-07-01'];
    const noShowDates = [undefined, null, '2026-07-02'];
    const fees = [undefined, null, 1200];
    let checked = 0;
    for (const status of statuses) {
      for (const cancelled_date of cancelledDates) {
        for (const no_show_date of noShowDates) {
          for (const cancellation_fee_cents of fees) {
            const { clean } = sanitizeReservationLifecycle({
              pms_reservation_id: 'R', arrival_date: '2026-07-05',
              status, cancelled_date, no_show_date, cancellation_fee_cents,
            });
            assert.deepEqual(
              violatedChecks(clean), [],
              `violates 0345 for status=${status} cancelled=${cancelled_date} noShow=${no_show_date} fee=${cancellation_fee_cents}`,
            );
            checked++;
          }
        }
      }
    }
    assert.equal(checked, 7 * 3 * 3 * 3);
  });
});

describe('VALIDATOR_REGISTRY.pms_reservations applies the lifecycle sanitizer', () => {
  test('the registered validator returns a coherent clean row', () => {
    const validator = getValidator('pms_reservations');
    assert.ok(validator, 'pms_reservations validator must be registered');
    const result = validator!({
      pms_reservation_id: 'R-100',
      status: 'cancelled',
      arrival_date: '2026-08-10',
      departure_date: '2026-08-12',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(violatedChecks(result.ok ? (result.clean ?? {}) : {}), []);
  });

  test('a row missing pms_reservation_id is still rejected outright', () => {
    const validator = getValidator('pms_reservations')!;
    assert.equal(validator({ status: 'cancelled' }).ok, false);
  });

  test('an unknown status is dropped by layer 2, so the lifecycle clears with it', () => {
    const validator = getValidator('pms_reservations')!;
    const result = validator({
      pms_reservation_id: 'R-101', status: 'ANNULLIERT', cancellation_fee_cents: 900,
    });
    assert.equal(result.ok, true);
    const clean = result.ok ? (result.clean ?? {}) : {};
    // validateReservation drops the unknown enum; the sanitizer then has no
    // cancellation to attach the fee to.
    assert.equal(clean.status, undefined);
    assert.equal(clean.cancellation_fee_cents, null);
    assert.deepEqual(violatedChecks(clean), []);
  });
});
