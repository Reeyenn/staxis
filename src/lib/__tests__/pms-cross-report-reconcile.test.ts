/**
 * Cross-report reconciliation (src/lib/pms/cross-report-reconcile.ts).
 *
 * Transplanted from the robot-era cross-feed-reconcile. The two rules that
 * matter are ABSTAIN-BY-DEFAULT and PAGINATION SOUNDNESS, and they pull in
 * opposite directions, so both edges are pinned here:
 *
 *   • too eager and every correct-but-truncated report false-fails, which is
 *     how a safety check gets switched off;
 *   • too shy and an empty report sails past its own house counter, which is
 *     the wrong-row-set bug the module exists to catch.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCounter,
  reconcileCrossReport,
  type CrossReportInput,
} from '@/lib/pms/cross-report-reconcile';

function verdictFor(result: ReturnType<typeof reconcileCrossReport>, counter: string) {
  return result.checks.find((c) => c.counter === counter);
}

const CLEAN_ROOMS = [
  { room: '101', status: 'occupied' },
  { room: '102', status: 'occupied_dirty' },
  { room: '103', status: 'vacant_clean' },
  { room: '104', status: 'vacant_dirty' },
];

describe('abstain-by-default', () => {
  it('reports no_signal when there are no counters at all', () => {
    const r = reconcileCrossReport({ reports: { arrivals: { rowCount: 12 } }, counters: {} });
    assert.equal(r.signal, 'no_signal');
    assert.equal(r.mismatched, 0);
  });

  it('abstains a check whose report never arrived', () => {
    const r = reconcileCrossReport({ reports: {}, counters: { arrivals_remaining_today: 6 } });
    assert.equal(r.signal, 'no_signal');
    assert.equal(verdictFor(r, 'arrivals_remaining_today')?.reason, 'report_unavailable');
  });

  it('abstains an unparseable or negative counter', () => {
    const r = reconcileCrossReport({
      reports: { arrivals: { rowCount: 12 } },
      counters: { arrivals_remaining_today: Number.NaN, departures_remaining_today: -3 },
    });
    assert.equal(r.signal, 'no_signal');
    assert.equal(verdictFor(r, 'arrivals_remaining_today')?.reason, 'counter_unavailable');
    assert.equal(verdictFor(r, 'departures_remaining_today')?.reason, 'counter_negative');
  });

  it('a counter of zero proves nothing and abstains', () => {
    const r = reconcileCrossReport({
      reports: { arrivals: { rowCount: 0, rowsComplete: true } },
      counters: { arrivals_remaining_today: 0 },
    });
    assert.equal(verdictFor(r, 'arrivals_remaining_today')?.reason, 'counter_zero_uninformative');
  });
});

describe('lower bound — the sound inequality', () => {
  it('a report with at least as many rows as the counter witnesses it', () => {
    const r = reconcileCrossReport({
      reports: { arrivals: { rowCount: 14 } },
      counters: { arrivals_remaining_today: 6 },
    });
    assert.equal(r.signal, 'pass');
    assert.equal(verdictFor(r, 'arrivals_remaining_today')?.verdict, 'match');
  });

  it('satisfaction counts even when the report is NOT known-complete', () => {
    // A first page that already meets the counter witnesses it whether or not
    // more pages follow.
    const r = reconcileCrossReport({
      reports: { arrivals: { rowCount: 25, rowsComplete: false } },
      counters: { arrivals_remaining_today: 6 },
    });
    assert.equal(verdictFor(r, 'arrivals_remaining_today')?.verdict, 'match');
  });

  it('PAGINATION SOUNDNESS: a shortfall on an incomplete report ABSTAINS', () => {
    // 25 rows of a 60-row report is not a contradiction — the rest is on the
    // next page. Failing here would false-fail every paginated report.
    const r = reconcileCrossReport({
      reports: { arrivals: { rowCount: 25, rowsComplete: false } },
      counters: { arrivals_remaining_today: 40 },
    });
    assert.equal(r.signal, 'no_signal');
    assert.match(verdictFor(r, 'arrivals_remaining_today')!.reason, /not_known_complete/);
  });

  it('a shortfall on a KNOWN-COMPLETE report is a real mismatch', () => {
    const r = reconcileCrossReport({
      reports: { arrivals: { rowCount: 25, rowsComplete: true } },
      counters: { arrivals_remaining_today: 40 },
    });
    assert.equal(r.signal, 'fail');
    assert.equal(verdictFor(r, 'arrivals_remaining_today')?.verdict, 'mismatch');
  });

  it('an EMPTY known-complete report against a small positive counter still fails', () => {
    // The absolute tolerance of 2 would otherwise swallow "0 rows vs counter
    // of 1" — which is exactly the empty-report bug.
    const r = reconcileCrossReport({
      reports: { arrivals: { rowCount: 0, rowsComplete: true } },
      counters: { arrivals_remaining_today: 1 },
    });
    assert.equal(r.signal, 'fail');
    assert.match(verdictFor(r, 'arrivals_remaining_today')!.reason, /empty_report/);
  });

  it('an empty report that is NOT known-complete abstains — a blank first page proves nothing', () => {
    const r = reconcileCrossReport({
      reports: { arrivals: { rowCount: 0, rowsComplete: false } },
      counters: { arrivals_remaining_today: 5 },
    });
    assert.equal(r.signal, 'no_signal');
  });

  it('a report with no row count at all abstains', () => {
    const r = reconcileCrossReport({
      reports: { arrivals: {} },
      counters: { arrivals_remaining_today: 5 },
    });
    assert.equal(verdictFor(r, 'arrivals_remaining_today')?.reason, 'no_report_count');
  });
});

describe('exact predicate — the strong form over a complete row set', () => {
  const input: CrossReportInput = {
    reports: { roomStatus: { rowCount: 4, rows: CLEAN_ROOMS, rowsComplete: true } },
    counters: { total_occupied_rooms: 2, total_vacant_clean: 1 },
  };

  it('counts matching rows exactly when the whole report is in hand', () => {
    const r = reconcileCrossReport(input);
    assert.equal(r.signal, 'pass');
    assert.equal(verdictFor(r, 'total_occupied_rooms')?.mode, 'exact');
    assert.equal(verdictFor(r, 'total_occupied_rooms')?.observed, 2);
  });

  it('normalises status spellings the way the room board does', () => {
    const r = reconcileCrossReport({
      reports: {
        roomStatus: {
          rowCount: 2,
          rows: [{ status: 'Vacant-Clean' }, { status: '  VACANT CLEAN ' }],
          rowsComplete: true,
        },
      },
      counters: { total_vacant_clean: 2 },
    });
    assert.equal(verdictFor(r, 'total_vacant_clean')?.observed, 2);
  });

  it('falls back to the lower bound when the row set is not complete', () => {
    const r = reconcileCrossReport({
      reports: { roomStatus: { rowCount: 40, rows: CLEAN_ROOMS.slice(0, 2), rowsComplete: false } },
      counters: { total_occupied_rooms: 30 },
    });
    assert.equal(verdictFor(r, 'total_occupied_rooms')?.mode, 'lower_bound');
  });

  it('a badly-off exact count is a mismatch', () => {
    const r = reconcileCrossReport({
      reports: { roomStatus: { rowCount: 4, rows: CLEAN_ROOMS, rowsComplete: true } },
      counters: { total_occupied_rooms: 38 },
    });
    assert.equal(r.signal, 'fail');
  });

  it('a predicate that throws does not take the whole reconciliation down', () => {
    const r = reconcileCrossReport({
      reports: {
        roomStatus: {
          rowCount: 1,
          // A getter that throws models a hostile parsed row.
          rows: [Object.defineProperty({}, 'status', { get() { throw new Error('boom'); } })],
          rowsComplete: true,
        },
      },
      counters: { total_occupied_rooms: 0 },
    });
    assert.ok(r.checks.length > 0);
  });
});

describe('one mismatch fails the whole reconciliation, matches alone pass it', () => {
  it('fails when any check contradicts', () => {
    const r = reconcileCrossReport({
      reports: {
        arrivals: { rowCount: 14 },
        roomStatus: { rowCount: 0, rowsComplete: true },
      },
      counters: { arrivals_remaining_today: 6, total_occupied_rooms: 30 },
    });
    assert.equal(r.signal, 'fail');
    assert.equal(r.matched, 1);
    assert.equal(r.mismatched, 1);
  });
});

describe('parseCounter', () => {
  it('reads a plain number, a labelled cell, and thousands separators', () => {
    assert.equal(parseCounter(42), 42);
    assert.equal(parseCounter('Occupied: 42'), 42);
    assert.equal(parseCounter('1,204'), 1204);
  });
  it('refuses anything with no digits', () => {
    assert.equal(parseCounter('—'), null);
    assert.equal(parseCounter(null), null);
    assert.equal(parseCounter(Number.NaN), null);
  });
});
