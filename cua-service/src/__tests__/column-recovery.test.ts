/**
 * Blank required-column recovery (feature/cua-column-recovery).
 *
 * Offline proof of the recovery decision core against the exact live failure
 * (prod knowledge file 56980b3b: arrivals/departures missing arrival_date +
 * departure_date; work orders missing pms_work_order_id/status/out_of_order):
 *
 *   1. Classification — dead/unparseable detection over live-DOM rows, sparse
 *      columns never misclassified, non-core targets untouched.
 *   2. The value gate — runtime-faithful parsing, wrong-cell rejection
 *      (duplicate selector / identical date vectors / date order / semantic
 *      window / key distinctness / sequential row numbers), all the
 *      worse-than-blank protections.
 *   3. Single-sample URL templating — key anchoring required, ambiguity and
 *      frozen-date guards fail closed.
 *   4. Gate ↔ adapter symmetry — effectiveColumnsFromAction and the adapter
 *      wire EXACTLY the same recovered columns (no gate-passes-but-runtime-
 *      blank split brain), and computeFeedGaps clears recovered feeds without
 *      the gate itself changing.
 *   5. Runtime enrichment decision logic — caps, cache scoping, any-row
 *      failure reporting (reconcile safety lives on top of it).
 *   6. Residual finalization — failed recovery ships blanks (park), never a
 *      dead/rejected selector; bounded drill preconditions.
 */

// MUST be first: WebSocket shim + env placeholders before any module that
// transitively builds the Supabase client (mapper.ts via its imports).
import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  auditRequiredColumns,
  gateRecoveredColumn,
  certifyColumns,
  learnedForGate,
  buildRecoveryHint,
  expectedShapeFor,
  isBetterCandidate,
  MIN_UNPARSEABLE_SAMPLES,
  DETAIL_PER_POLL_MAX,
} from '../column-recovery.js';
import { parseColumnSelector } from '../extractors/dom-rows.js';
import { templateFromSample, looksLikeDateToken, substituteTemplate } from '../url-template.js';
import {
  drillDownDetailEligible,
  recoveredDetailColumns,
  effectiveColumnsFromAction,
  missingRequiredColumns,
} from '../target-contract.js';
import { computeFeedGaps } from '../mapping-driver.js';
import { recipeToTableTemplates } from '../recipe-adapter.js';
import {
  enrichRowsWithDetail,
  findRowsWithAllBlankDetail,
  __clearDetailCacheForTests,
} from '../extractors/template-runner.js';
import { finalizeRecoveredSuccess, drillPreconditions, type PageAudit } from '../mapper.js';
import type { ActionRecipe, Recipe } from '../types.js';

const TODAY = '2026-06-12';

// ─── 1. Selector convention ─────────────────────────────────────────────────

describe('parseColumnSelector (@attr convention)', () => {
  test('plain CSS stays CSS', () => {
    assert.deepEqual(parseColumnSelector('td:nth-child(2)'), { css: 'td:nth-child(2)', attr: null });
    assert.deepEqual(parseColumnSelector('.'), { css: '.', attr: null });
  });
  test('trailing @attr splits', () => {
    assert.deepEqual(parseColumnSelector('td a@href'), { css: 'td a', attr: 'href' });
    assert.deepEqual(parseColumnSelector('.@data-id'), { css: '.', attr: 'data-id' });
    assert.deepEqual(parseColumnSelector('@title'), { css: '.', attr: 'title' });
  });
  test('@ inside an attribute CSS selector does not split', () => {
    assert.deepEqual(parseColumnSelector('[data-x="a@b"]'), { css: '[data-x="a@b"]', attr: null });
  });
});

// ─── 2. Classification (stage 0) ────────────────────────────────────────────

const rowsOf = (n: number, make: (i: number) => Record<string, string>) =>
  Array.from({ length: n }, (_, i) => make(i));

describe('auditRequiredColumns', () => {
  test('the live failure: present selectors whose values are blank everywhere → dead', () => {
    const columns = {
      pms_reservation_id: 'td:nth-child(14)',
      guest_name: 'td:nth-child(2)',
      arrival_date: 'td:nth-child(5)',
      departure_date: 'td:nth-child(6)',
    };
    const rows = rowsOf(6, (i) => ({
      pms_reservation_id: `R${1000 + i}`,
      guest_name: `Guest ${i}`,
      arrival_date: '',
      departure_date: '',
    }));
    const audit = auditRequiredColumns('getArrivals', columns, rows, learnedForGate('getArrivals', undefined));
    assert.deepEqual(audit.dead.sort(), ['arrival_date', 'departure_date']);
    assert.deepEqual(audit.structurallyMissing, []);
    assert.deepEqual(audit.recoveryTargets.sort(), ['arrival_date', 'departure_date']);
  });

  test('empty-string selectors → structurallyMissing (today\'s check preserved)', () => {
    const columns = { pms_work_order_id: '', description: 'td:nth-child(4)', status: '', out_of_order: '' };
    const rows = rowsOf(4, (i) => ({ description: `Fix thing ${i}` }));
    const audit = auditRequiredColumns('getWorkOrders', columns, rows, learnedForGate('getWorkOrders', undefined));
    assert.deepEqual(audit.structurallyMissing.sort(), ['out_of_order', 'pms_work_order_id', 'status']);
  });

  test('sparse column (1 non-blank in 50) is NOT dead', () => {
    const columns = {
      pms_work_order_id: '.@data-id', description: 'td:nth-child(4)',
      status: 'td:nth-child(2)', out_of_order: 'td:nth-child(7)',
    };
    const rows = rowsOf(50, (i) => ({
      pms_work_order_id: `${4000 + i}`, description: 'x',
      status: 'Open', out_of_order: i === 41 ? 'Y' : '',
    }));
    const learned = learnedForGate('getWorkOrders', { status: { Open: 'open' } });
    const audit = auditRequiredColumns('getWorkOrders', columns, rows, learned);
    assert.ok(!audit.dead.includes('out_of_order'));
    assert.ok(!audit.recoveryTargets.includes('out_of_order'));
  });

  test('wrong-cell selector (date column extracting status words) → unparseable', () => {
    const columns = {
      pms_reservation_id: 'td:nth-child(14)', guest_name: 'td:nth-child(2)',
      arrival_date: 'td:nth-child(3)', departure_date: 'td:nth-child(6)',
    };
    const rows = rowsOf(5, (i) => ({
      pms_reservation_id: `R${i}`, guest_name: 'G',
      arrival_date: 'Confirmed', departure_date: '06/13/2026',
    }));
    const audit = auditRequiredColumns('getArrivals', columns, rows, learnedForGate('getArrivals', undefined));
    assert.deepEqual(audit.unparseable, ['arrival_date']);
  });

  test(`fewer than ${MIN_UNPARSEABLE_SAMPLES} non-blank values never declares unparseable`, () => {
    const columns = {
      pms_reservation_id: 'td:nth-child(14)', guest_name: 'td:nth-child(2)',
      arrival_date: 'td:nth-child(3)', departure_date: 'td:nth-child(6)',
    };
    const rows = [
      { pms_reservation_id: 'R1', guest_name: 'G', arrival_date: 'junk', departure_date: '06/13/2026' },
      { pms_reservation_id: 'R2', guest_name: 'G', arrival_date: 'junk', departure_date: '06/13/2026' },
    ];
    const audit = auditRequiredColumns('getArrivals', columns, rows, learnedForGate('getArrivals', undefined));
    assert.deepEqual(audit.unparseable, []);
  });

  test('non-core target → empty audit; zero rows → structural only', () => {
    assert.deepEqual(
      auditRequiredColumns('getGuests', { pms_guest_id: '' }, rowsOf(3, () => ({})), undefined).recoveryTargets,
      [],
    );
    const audit = auditRequiredColumns(
      'getArrivals',
      { pms_reservation_id: 'td', guest_name: 'td', arrival_date: '', departure_date: 'td' },
      [],
      undefined,
    );
    assert.deepEqual(audit.recoveryTargets, ['arrival_date']);
    assert.deepEqual(audit.dead, []);
  });
});

// ─── 3. The value gate ──────────────────────────────────────────────────────

describe('gateRecoveredColumn (worse-than-blank protections)', () => {
  const baseArrivals = {
    actionKey: 'getArrivals' as const,
    learned: learnedForGate('getArrivals', undefined),
    todayIso: TODAY,
  };

  test('accepts real dates near today (with one junk header row tolerated)', () => {
    const verdict = gateRecoveredColumn({
      ...baseArrivals,
      column: 'arrival_date',
      values: ['Arrival', '06/12/2026', '06/12/2026', '06/13/2026'],
      allValues: { arrival_date: ['Arrival', '06/12/2026', '06/12/2026', '06/13/2026'] },
      selector: 'td:nth-child(5) span@title',
      allSelectors: { arrival_date: 'td:nth-child(5) span@title', guest_name: 'td:nth-child(2)' },
    });
    assert.equal(verdict.ok, true);
  });

  test('rejects a column of non-dates (parse majority)', () => {
    const verdict = gateRecoveredColumn({
      ...baseArrivals,
      column: 'arrival_date',
      values: ['Confirmed', 'Confirmed', 'Booked'],
      allValues: { arrival_date: ['Confirmed', 'Confirmed', 'Booked'] },
      selector: 'td:nth-child(3)',
      allSelectors: { arrival_date: 'td:nth-child(3)' },
    });
    assert.equal(verdict.ok, false);
    assert.match((verdict as { reason: string }).reason, /parse_majority/);
  });

  test('rejects all-blank and duplicate selectors', () => {
    assert.equal(gateRecoveredColumn({
      ...baseArrivals, column: 'arrival_date', values: ['', '', ''],
      allValues: { arrival_date: ['', '', ''] }, selector: 'td', allSelectors: { arrival_date: 'td' },
    }).ok, false);
    const dup = gateRecoveredColumn({
      ...baseArrivals, column: 'arrival_date', values: ['06/12/2026'],
      allValues: { arrival_date: ['06/12/2026'] },
      selector: 'td:nth-child(6)',
      allSelectors: { arrival_date: 'td:nth-child(6)', departure_date: 'td:nth-child(6)' },
    });
    assert.equal(dup.ok, false);
    assert.match((dup as { reason: string }).reason, /duplicate_selector/);
  });

  test('rejects a date column vector-identical to the other date column', () => {
    const vec = ['06/12/2026', '06/12/2026', '06/12/2026'];
    const verdict = gateRecoveredColumn({
      ...baseArrivals,
      column: 'departure_date',
      values: vec,
      allValues: { departure_date: vec, arrival_date: [...vec] },
      selector: 'td:nth-child(9)',
      allSelectors: { departure_date: 'td:nth-child(9)', arrival_date: 'td:nth-child(5)' },
    });
    assert.equal(verdict.ok, false);
    assert.match((verdict as { reason: string }).reason, /identical_date_vector/);
  });

  test('rejects arrival > departure (swapped columns)', () => {
    const verdict = gateRecoveredColumn({
      ...baseArrivals,
      column: 'arrival_date',
      values: ['06/12/2026', '06/12/2026', '06/13/2026'],
      allValues: {
        arrival_date: ['06/12/2026', '06/12/2026', '06/13/2026'],
        departure_date: ['06/14/2026', '06/13/2026', '06/10/2026'], // row 3 violates
      },
      selector: 'td:nth-child(5)',
      allSelectors: { arrival_date: 'td:nth-child(5)', departure_date: 'td:nth-child(6)' },
    });
    assert.equal(verdict.ok, false);
    assert.match((verdict as { reason: string }).reason, /date_order_violation/);
  });

  test('semantic window: arrivals\' arrival_date must cluster around today', () => {
    const verdict = gateRecoveredColumn({
      ...baseArrivals,
      column: 'arrival_date',
      values: ['01/05/2025', '03/20/2025', '11/02/2024'],
      allValues: { arrival_date: ['01/05/2025', '03/20/2025', '11/02/2024'] },
      selector: 'td:nth-child(4)',
      allSelectors: { arrival_date: 'td:nth-child(4)' },
    });
    assert.equal(verdict.ok, false);
    assert.match((verdict as { reason: string }).reason, /semantic_date_window/);
  });

  const baseWO = {
    actionKey: 'getWorkOrders' as const,
    todayIso: TODAY,
  };

  test('key column: constant, 1-based-sequential, and mirrored values reject; real ids pass', () => {
    const allSelectors = { pms_work_order_id: '.@data-id', room_number: 'td:nth-child(1)' };
    const constant = gateRecoveredColumn({
      ...baseWO, learned: learnedForGate('getWorkOrders', undefined),
      column: 'pms_work_order_id', values: ['#', '#', '#'],
      allValues: { pms_work_order_id: ['#', '#', '#'] }, selector: '.@data-id', allSelectors,
    });
    assert.equal(constant.ok, false);
    assert.match((constant as { reason: string }).reason, /constant_key/);

    const rowNumbers = gateRecoveredColumn({
      ...baseWO, learned: learnedForGate('getWorkOrders', undefined),
      column: 'pms_work_order_id', values: ['1', '2', '3', '4'],
      allValues: { pms_work_order_id: ['1', '2', '3', '4'] }, selector: '.@data-id', allSelectors,
    });
    assert.equal(rowNumbers.ok, false);
    assert.match((rowNumbers as { reason: string }).reason, /sequential_key/);

    // 0-based row indexes (data-row-index) are row numbers too.
    const zeroBased = gateRecoveredColumn({
      ...baseWO, learned: learnedForGate('getWorkOrders', undefined),
      column: 'pms_work_order_id', values: ['0', '1', '2', '3'],
      allValues: { pms_work_order_id: ['0', '1', '2', '3'] }, selector: '.@data-row-index', allSelectors,
    });
    assert.equal(zeroBased.ok, false);
    assert.match((zeroBased as { reason: string }).reason, /sequential_key/);

    // room_number keys are EXEMPT from the sequential check — a small motel's
    // rooms legitimately are 1..N (getRoomStatus's key column).
    const sequentialRooms = gateRecoveredColumn({
      actionKey: 'getRoomStatus', todayIso: TODAY,
      learned: learnedForGate('getRoomStatus', { status: { Occupied: 'occupied', Vacant: 'vacant_clean' } }),
      column: 'room_number', values: ['1', '2', '3', '4'],
      allValues: { room_number: ['1', '2', '3', '4'], status: ['Occupied', 'Vacant', 'Occupied', 'Vacant'] },
      selector: 'td:nth-child(1)',
      allSelectors: { room_number: 'td:nth-child(1)', status: 'td:nth-child(2)' },
    });
    assert.equal(sequentialRooms.ok, true);

    const mirrored = gateRecoveredColumn({
      ...baseWO, learned: learnedForGate('getWorkOrders', undefined),
      column: 'pms_work_order_id', values: ['101', '102', '110'],
      allValues: { pms_work_order_id: ['101', '102', '110'], room_number: ['101', '102', '110'] },
      selector: '.@data-id', allSelectors,
    });
    assert.equal(mirrored.ok, false);
    assert.match((mirrored as { reason: string }).reason, /key_mirrors/);

    // Consecutive ids NOT starting at 1 (real WO sequence) pass.
    const realIds = gateRecoveredColumn({
      ...baseWO, learned: learnedForGate('getWorkOrders', undefined),
      column: 'pms_work_order_id', values: ['4031', '4032', '4033'],
      allValues: { pms_work_order_id: ['4031', '4032', '4033'], room_number: ['101', '102', '110'] },
      selector: '.@data-id', allSelectors,
    });
    assert.equal(realIds.ok, true);
  });

  test('enum column needs a usable vocabulary: model-emitted mapping passes, none fails', () => {
    const withMapping = gateRecoveredColumn({
      ...baseWO,
      learned: learnedForGate('getWorkOrders', { status: { 'Open': 'open', 'In Progress': 'in_progress' } }),
      column: 'status', values: ['Open', 'In Progress', 'Open'],
      allValues: { status: ['Open', 'In Progress', 'Open'] },
      selector: 'td:nth-child(2)', allSelectors: { status: 'td:nth-child(2)' },
    });
    assert.equal(withMapping.ok, true);

    const withoutMapping = gateRecoveredColumn({
      ...baseWO,
      learned: learnedForGate('getWorkOrders', undefined),
      column: 'status', values: ['Open', 'In Progress', 'Open'],
      allValues: { status: ['Open', 'In Progress', 'Open'] },
      selector: 'td:nth-child(2)', allSelectors: { status: 'td:nth-child(2)' },
    });
    assert.equal(withoutMapping.ok, false);

    // getRoomStatus.status has 'unknown' in its canonical set, so at runtime
    // EVERY string "parses" via onUnknown — the gate must not let a wrong
    // cell self-grade through that fallback (review P1): assessment forces
    // onUnknown=null, so unmapped junk still rejects.
    const roomStatusJunk = gateRecoveredColumn({
      actionKey: 'getRoomStatus', todayIso: TODAY,
      learned: learnedForGate('getRoomStatus', undefined),
      column: 'status', values: ['Floor 2', 'Floor 2', 'Floor 3'],
      allValues: { status: ['Floor 2', 'Floor 2', 'Floor 3'] },
      selector: 'td:nth-child(4)', allSelectors: { status: 'td:nth-child(4)' },
    });
    assert.equal(roomStatusJunk.ok, false);
    assert.match((roomStatusJunk as { reason: string }).reason, /parse_majority/);
  });

  test('boolean flag column accepts sparse Y/N (blank cells ignored)', () => {
    const verdict = gateRecoveredColumn({
      ...baseWO,
      learned: learnedForGate('getWorkOrders', undefined),
      column: 'out_of_order', values: ['Y', '', '', 'N'],
      allValues: { out_of_order: ['Y', '', '', 'N'] },
      selector: 'td:nth-child(7) input@value', allSelectors: { out_of_order: 'td:nth-child(7) input@value' },
    });
    assert.equal(verdict.ok, true);
  });
});

// ─── 3b. First-emission certification (feature/cua-prove-columns) ────────────

describe('certifyColumns (first-emission proof of ALL required columns)', () => {
  const TODAY_ISO = TODAY; // 2026-06-12

  // A correct arrivals map: key distinct, names text, dates near-today + ordered.
  const correctArrivals = {
    pms_reservation_id: ['R1001', 'R1002', 'R1003'],
    guest_name: ['John Smith', 'Jane Doe', 'Bob Lee'],
    arrival_date: ['06/12/2026', '06/12/2026', '06/13/2026'],
    departure_date: ['06/14/2026', '06/15/2026', '06/14/2026'],
  };
  const arrivalsSelectors = {
    pms_reservation_id: 'td:nth-child(1) a@href',
    guest_name: 'td:nth-child(2)',
    arrival_date: 'td:nth-child(5)',
    departure_date: 'td:nth-child(6)',
  };

  test('a correct populated table → every required column certified', () => {
    const verdicts = certifyColumns({
      actionKey: 'getArrivals',
      columns: ['pms_reservation_id', 'guest_name', 'arrival_date', 'departure_date'],
      allValues: correctArrivals,
      allSelectors: arrivalsSelectors,
      learned: learnedForGate('getArrivals', undefined),
      todayIso: TODAY_ISO,
      hasValueEvidence: true,
    });
    for (const col of ['pms_reservation_id', 'guest_name', 'arrival_date', 'departure_date']) {
      assert.equal(verdicts.get(col)?.verdict, 'certified', `${col} should certify`);
    }
  });

  test('THE GAP: a check-in ↔ check-out swap on a plain HTML table is caught (failed), not shipped', () => {
    // arrival_date selector points at the CHECKOUT cell (future dates), and
    // departure_date at the CHECK-IN cell (today) — the classic silent corruption.
    const swapped = {
      pms_reservation_id: ['R1001', 'R1002', 'R1003'],
      guest_name: ['John Smith', 'Jane Doe', 'Bob Lee'],
      arrival_date: ['06/15/2026', '06/16/2026', '06/17/2026'],   // really checkout
      departure_date: ['06/12/2026', '06/12/2026', '06/13/2026'], // really checkin
    };
    const verdicts = certifyColumns({
      actionKey: 'getArrivals',
      columns: ['arrival_date', 'departure_date'],
      allValues: swapped,
      allSelectors: arrivalsSelectors,
      learned: learnedForGate('getArrivals', undefined),
      todayIso: TODAY_ISO,
      hasValueEvidence: true,
    });
    // arrival_date is provably wrong (later than departure AND far from today).
    assert.equal(verdicts.get('arrival_date')?.verdict, 'failed');
    // departure_date is also caught by the same date-order invariant.
    assert.equal(verdicts.get('departure_date')?.verdict, 'failed');
  });

  test('a status string mapped into a date column → failed (parse majority)', () => {
    const verdicts = certifyColumns({
      actionKey: 'getArrivals',
      columns: ['arrival_date'],
      allValues: { arrival_date: ['Confirmed', 'Confirmed', 'Booked'] },
      allSelectors: { arrival_date: 'td:nth-child(3)' },
      learned: learnedForGate('getArrivals', undefined),
      todayIso: TODAY_ISO,
      hasValueEvidence: true,
    });
    assert.equal(verdicts.get('arrival_date')?.verdict, 'failed');
    assert.match((verdicts.get('arrival_date') as { reason: string }).reason, /parse_majority/);
  });

  test('no value evidence (empty/unreadable feed) → every column UNCERTAIN, never certified', () => {
    const verdicts = certifyColumns({
      actionKey: 'getArrivals',
      columns: ['pms_reservation_id', 'guest_name', 'arrival_date', 'departure_date'],
      allValues: {},
      allSelectors: arrivalsSelectors,
      learned: learnedForGate('getArrivals', undefined),
      todayIso: TODAY_ISO,
      hasValueEvidence: false,
    });
    for (const col of ['pms_reservation_id', 'guest_name', 'arrival_date', 'departure_date']) {
      assert.equal(verdicts.get(col)?.verdict, 'uncertain', `${col} should be uncertain with no evidence`);
    }
  });

  test('a wide multi-day arrivals view (correct order) → semantic-window miss is UNCERTAIN, not failed/blanked', () => {
    // Far-future dates (PMS shows a rolling window, not today-only) but arrival<=
    // departure on every row → only the soft semantic-window heuristic trips. We
    // must NOT blank a correct column (that could cascade to quarantine) — park it.
    const verdicts = certifyColumns({
      actionKey: 'getArrivals',
      columns: ['arrival_date'],
      allValues: {
        arrival_date: ['07/20/2026', '07/21/2026', '07/22/2026'],
        departure_date: ['07/22/2026', '07/23/2026', '07/24/2026'],
      },
      allSelectors: { arrival_date: 'td:nth-child(5)', departure_date: 'td:nth-child(6)' },
      learned: learnedForGate('getArrivals', undefined),
      todayIso: TODAY_ISO,
      hasValueEvidence: true,
    });
    const v = verdicts.get('arrival_date');
    assert.equal(v?.verdict, 'uncertain');
    assert.match((v as { reason: string }).reason, /semantic_date_window/);
  });

  test('plain-text column mirroring another mapped column → uncertain (not blindly certified)', () => {
    const verdicts = certifyColumns({
      actionKey: 'getArrivals',
      columns: ['guest_name'],
      allValues: {
        guest_name: ['A100', 'A200', 'A300'],
        pms_reservation_id: ['A100', 'A200', 'A300'], // selector pointed at the id cell
      },
      allSelectors: { guest_name: 'td:nth-child(2)', pms_reservation_id: 'td:nth-child(1)' },
      learned: learnedForGate('getArrivals', undefined),
      todayIso: TODAY_ISO,
      hasValueEvidence: true,
    });
    const v = verdicts.get('guest_name');
    assert.equal(v?.verdict, 'uncertain');
    assert.match((v as { reason: string }).reason, /text_mirror/);
  });

  test('a constant plain-text column → uncertain (a header/label echoed down the column)', () => {
    const verdicts = certifyColumns({
      actionKey: 'getWorkOrders',
      columns: ['description'],
      allValues: { description: ['Maintenance', 'Maintenance', 'Maintenance'] },
      allSelectors: { description: 'td:nth-child(2)' },
      learned: learnedForGate('getWorkOrders', undefined),
      todayIso: TODAY_ISO,
      hasValueEvidence: true,
    });
    const v = verdicts.get('description');
    assert.equal(v?.verdict, 'uncertain');
    assert.match((v as { reason: string }).reason, /constant_text/);
  });

  test('a sparse-but-real boolean (out_of_order set on 1 row in 8) certifies, not all_blank-rejected', () => {
    // The mapper feeds certifyColumns the FULL deadness window, so a column blank
    // in most rows but real in one is proven, not falsely failed. Guards the
    // sparse-column regression.
    const verdicts = certifyColumns({
      actionKey: 'getWorkOrders',
      columns: ['out_of_order'],
      allValues: { out_of_order: ['', '', '', '', '', '', '', 'Y'] },
      allSelectors: { out_of_order: 'td:nth-child(7) input@value' },
      learned: learnedForGate('getWorkOrders', undefined),
      todayIso: TODAY_ISO,
      hasValueEvidence: true,
    });
    assert.equal(verdicts.get('out_of_order')?.verdict, 'certified');
  });

  test('work-orders: a correct status enum with model vocab certifies; the key mirroring another column fails', () => {
    // status maps cleanly via the model's emitted vocabulary → certified.
    const certified = certifyColumns({
      actionKey: 'getWorkOrders',
      columns: ['status'],
      allValues: { status: ['Open', 'In Progress', 'Open'] },
      allSelectors: { status: 'td:nth-child(3)' },
      learned: learnedForGate('getWorkOrders', { status: { Open: 'open', 'In Progress': 'in_progress' } }),
      todayIso: TODAY_ISO,
      hasValueEvidence: true,
    });
    assert.equal(certified.get('status')?.verdict, 'certified');

    // The key column whose values mirror another column is provably wrong.
    const mirrored = certifyColumns({
      actionKey: 'getWorkOrders',
      columns: ['pms_work_order_id'],
      allValues: {
        pms_work_order_id: ['101', '102', '103'],
        room_number: ['101', '102', '103'],
      },
      allSelectors: { pms_work_order_id: 'td:nth-child(1)', room_number: 'td:nth-child(5)' },
      learned: learnedForGate('getWorkOrders', undefined),
      todayIso: TODAY_ISO,
      hasValueEvidence: true,
    });
    assert.equal(mirrored.get('pms_work_order_id')?.verdict, 'failed');
  });
});

describe('learnedForGate', () => {
  test('keys mappings by table.column and drops hallucinated canonicals', () => {
    const learned = learnedForGate('getWorkOrders', {
      status: { 'Open': 'open', 'Weird': 'not_a_real_status' },
      not_an_enum_column: { x: 'y' },
    });
    assert.deepEqual(learned.valueTranslations, {
      'pms_work_orders_v2.status': { Open: 'open' },
    });
  });
});

// ─── 4. Single-sample URL templating ────────────────────────────────────────

describe('templateFromSample', () => {
  const row = { pms_reservation_id: 'ABC123', guest_name: 'John Smith', room_number: '12' };

  test('anchors the key in a query param and substitutes round-trip', () => {
    const r = templateFromSample(
      'https://pms.example.com/Reservation/view?id=ABC123&tab=summary',
      row,
      'pms_reservation_id',
    );
    assert.equal(r.ok, true);
    assert.equal(r.template, 'https://pms.example.com/Reservation/view?id={pms_reservation_id}&tab=summary');
    assert.equal(
      substituteTemplate(r.template!, { pms_reservation_id: 'XYZ9' }),
      'https://pms.example.com/Reservation/view?id=XYZ9&tab=summary',
    );
  });

  test('anchors whole path segments', () => {
    const r = templateFromSample('https://pms.example.com/workorder/4031/view', { pms_work_order_id: '4031' }, 'pms_work_order_id');
    assert.equal(r.ok, true);
    assert.equal(r.template, 'https://pms.example.com/workorder/{pms_work_order_id}/view');
  });

  test('fails closed: key not anchored / substring matches; non-key values stay frozen', () => {
    // Key value nowhere in the URL.
    assert.equal(templateFromSample('https://pms.example.com/view?idx=7', row, 'pms_reservation_id').ok, false);
    // Substring inside a token must NOT anchor (whole-component matching).
    assert.equal(
      templateFromSample('https://pms.example.com/view?s=xABC123x', row, 'pms_reservation_id').ok,
      false,
    );
    // ONLY the key anchors — an optional column's value (room) stays a frozen
    // literal so a per-row blank can never become a required URL param
    // (review P1: it would perma-fail a reconcile feed at poll time).
    const keyOnly = templateFromSample(
      'https://pms.example.com/view?id=4031&room=101',
      { pms_work_order_id: '4031', room_number: '101' },
      'pms_work_order_id',
    );
    assert.equal(keyOnly.ok, true);
    assert.equal(keyOnly.template, 'https://pms.example.com/view?id={pms_work_order_id}&room=101');
    assert.deepEqual(keyOnly.placeholders, ['pms_work_order_id']);
  });

  test('fails closed on session-token-shaped components (frozen sessions rot)', () => {
    const r = templateFromSample(
      'https://pms.example.com/view?id=ABC123&jsessionid=1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D',
      row,
      'pms_reservation_id',
    );
    assert.equal(r.ok, false);
    assert.match(r.reason!, /session/i);
  });

  test('key value shorter than the anchor floor surfaces an actionable reason', () => {
    const r = templateFromSample('https://pms.example.com/view?id=12', { pms_work_order_id: '12' }, 'pms_work_order_id');
    assert.equal(r.ok, false);
    assert.match(r.reason!, /shorter than/);
  });

  test('fails closed on an unanchored date-like component (frozen-date trap)', () => {
    const r = templateFromSample(
      'https://pms.example.com/view?id=ABC123&bd=06%2F12%2F2026',
      row,
      'pms_reservation_id',
    );
    assert.equal(r.ok, false);
    assert.match(r.reason!, /date-like/);
    assert.equal(looksLikeDateToken('06/12/2026'), true);
    assert.equal(looksLikeDateToken('2026-06-12'), true);
    assert.equal(looksLikeDateToken('20260612'), true);  // YYYYMMDD
    assert.equal(looksLikeDateToken('06122026'), true);  // MMDDYYYY
    assert.equal(looksLikeDateToken('ABC123'), false);
    assert.equal(looksLikeDateToken('12345678'), false); // order number, no century
    assert.equal(looksLikeDateToken('1.2'), false);      // version segment, not a date
  });

  test('requires an absolute URL', () => {
    assert.equal(templateFromSample('/Reservation/view?id=ABC123', row, 'pms_reservation_id').ok, false);
  });
});

// ─── 5. Gate ↔ adapter symmetry ─────────────────────────────────────────────

const recoveredArrivals = (overrides?: Partial<NonNullable<ActionRecipe['drillDown']>>): ActionRecipe => ({
  steps: [{ kind: 'goto', url: 'https://pms.example.com/arrivals' }],
  parse: {
    mode: 'table',
    hint: {
      rowSelector: 'table tbody tr',
      columns: {
        pms_reservation_id: 'td:nth-child(14)', guest_name: 'td:nth-child(2)',
        arrival_date: '', departure_date: '',
      },
    },
  },
  drillDown: {
    listUrl: 'https://pms.example.com/arrivals',
    listRowSelector: 'table tbody tr',
    listColumns: {
      pms_reservation_id: 'td:nth-child(14)', guest_name: 'td:nth-child(2)',
      arrival_date: '', departure_date: '',
    },
    detailUrlTemplate: 'https://pms.example.com/Reservation/view?id={pms_reservation_id}',
    detailUrlParams: { pms_reservation_id: 'pms_reservation_id' },
    detailColumns: { arrival_date: '#stay-arrival', departure_date: '#stay-departure', room_number: '#room' },
    fieldCoverage: { arrival_date: '2/2', departure_date: '2/2' },
    samplesDrilled: 1,
    templateVerified: true,
    ...(overrides ?? {}),
  },
});

describe('gate ↔ adapter symmetry (no split brain)', () => {
  test('verified key-anchored drillDown makes recovered REQUIRED columns effective', () => {
    const action = recoveredArrivals();
    assert.equal(drillDownDetailEligible(action), true);
    // required-only pick: room_number (optional) is NOT wired.
    assert.deepEqual(Object.keys(recoveredDetailColumns('getArrivals', action)).sort(),
      ['arrival_date', 'departure_date']);
    assert.deepEqual(missingRequiredColumns('getArrivals', effectiveColumnsFromAction('getArrivals', action)), []);
  });

  test('unverified template / unresolvable placeholder → NOT effective (gate keeps the gap)', () => {
    const unverified = recoveredArrivals({ templateVerified: false });
    assert.equal(drillDownDetailEligible(unverified), false);
    assert.deepEqual(
      missingRequiredColumns('getArrivals', effectiveColumnsFromAction('getArrivals', unverified)).sort(),
      ['arrival_date', 'departure_date'],
    );
    const orphanPlaceholder = recoveredArrivals({
      detailUrlTemplate: 'https://pms.example.com/Reservation/view?id={confirmation_code}',
    });
    assert.equal(drillDownDetailEligible(orphanPlaceholder), false);
  });

  test('non-core drilldown targets are untouched', () => {
    const action = recoveredArrivals();
    assert.deepEqual(recoveredDetailColumns('getGuests', action), {});
  });

  test('computeFeedGaps clears a recovered feed without touching the gate logic', () => {
    const actions: Recipe['actions'] = {
      getArrivals: recoveredArrivals(),
      getDepartures: recoveredArrivals(),
    };
    const gaps = computeFeedGaps(actions);
    const incomplete = gaps.missingRequired.filter((g) => g.reason === 'incomplete_columns');
    assert.deepEqual(incomplete, []);
    // The un-recovered feeds still gap exactly as before.
    assert.deepEqual(
      gaps.missingRequired.map((g) => `${g.target}:${g.reason}`).sort(),
      ['getRoomStatus:not_found', 'getWorkOrders:not_found'],
    );
  });

  test('adapter wires rowDetail + detail_page fields for exactly the effective columns', () => {
    const recipe: Recipe = {
      schema: 1,
      login: { startUrl: 'https://pms.example.com', steps: [], successSelectors: [] },
      actions: { getArrivals: recoveredArrivals() },
      valueTranslations: {},
    };
    const { templates } = recipeToTableTemplates(recipe);
    const t = templates.find((x) => x.sourceActionKey === 'getArrivals')!;
    assert.ok(t.rowDetail);
    assert.deepEqual(Object.keys(t.rowDetail!.columns).sort(), ['arrival_date', 'departure_date']);
    assert.equal(t.rowDetail!.urlTemplate, 'https://pms.example.com/Reservation/view?id={pms_reservation_id}');
    assert.equal(t.fields.arrival_date!.origin, 'detail_page');
    assert.equal(t.fields.arrival_date!.parser, 'generic_date');
    assert.equal(t.fields.arrival_date!.selectorOrColumn, '#stay-arrival');
    // optional detail col NOT wired; list fields unchanged.
    assert.equal(t.fields.room_number, undefined);
    assert.equal(t.fields.pms_reservation_id!.origin, 'list_row');
  });

  test('adapter leaves an unverified drillDown collapsed (today\'s behavior)', () => {
    const recipe: Recipe = {
      schema: 1,
      login: { startUrl: 'https://pms.example.com', steps: [], successSelectors: [] },
      actions: { getArrivals: recoveredArrivals({ templateVerified: false }) },
      valueTranslations: {},
    };
    const { templates } = recipeToTableTemplates(recipe);
    const t = templates.find((x) => x.sourceActionKey === 'getArrivals')!;
    assert.equal(t.rowDetail, undefined);
    assert.equal(t.fields.arrival_date!.origin, 'list_row');
  });
});

// ─── 6. Runtime enrichment decision logic ───────────────────────────────────

describe('enrichRowsWithDetail', () => {
  const rowDetail = {
    urlTemplate: 'https://pms.example.com/Reservation/view?id={pms_reservation_id}',
    urlParams: { pms_reservation_id: 'pms_reservation_id' },
    columns: { arrival_date: '#arr', departure_date: '#dep' },
  };

  test('happy path enriches every row in place', async () => {
    __clearDetailCacheForTests();
    const rows: Array<Record<string, unknown>> = [
      { pms_reservation_id: 'A1', guest_name: 'G1' },
      { pms_reservation_id: 'B2', guest_name: 'G2' },
    ];
    const fetched: string[] = [];
    const result = await enrichRowsWithDetail({
      rows, rowDetail,
      fetcher: async (url) => {
        fetched.push(url);
        return { arrival_date: '06/12/2026', departure_date: '06/14/2026' };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.enrichedCount, 2);
    assert.equal(rows[0]!.arrival_date, '06/12/2026');
    assert.equal(fetched.length, 2);
    assert.match(fetched[0]!, /id=A1$/);
  });

  test('cache: scoped reuse, tenant isolation, disabled without a scope', async () => {
    __clearDetailCacheForTests();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return { arrival_date: '06/12/2026', departure_date: '06/14/2026' };
    };
    const mkRows = () => [{ pms_reservation_id: 'A1' }];
    await enrichRowsWithDetail({ rows: mkRows(), rowDetail, fetcher, cacheScope: 'hotel-1:v3' });
    await enrichRowsWithDetail({ rows: mkRows(), rowDetail, fetcher, cacheScope: 'hotel-1:v3' });
    assert.equal(calls, 1); // second run served from cache
    await enrichRowsWithDetail({ rows: mkRows(), rowDetail, fetcher, cacheScope: 'hotel-2:v1' });
    assert.equal(calls, 2); // different hotel never shares entries
    await enrichRowsWithDetail({ rows: mkRows(), rowDetail, fetcher });
    await enrichRowsWithDetail({ rows: mkRows(), rowDetail, fetcher });
    assert.equal(calls, 4); // no scope → no caching
  });

  test('any systematic row failure reports ok:false with counts (reconcile safety upstream)', async () => {
    __clearDetailCacheForTests();
    const rows = [{ pms_reservation_id: 'A1' }, { pms_reservation_id: 'B2' }, { pms_reservation_id: '' }];
    const result = await enrichRowsWithDetail({
      rows, rowDetail,
      fetcher: async (url) => {
        if (url.includes('B2')) throw new Error('boom');
        return { arrival_date: '06/12/2026', departure_date: '06/14/2026' };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.enrichedCount, 1);
    assert.equal(result.failedCount, 2); // one fetch error + one blank URL param
  });

  test(`row cap: more than ${DETAIL_PER_POLL_MAX} rows refuses outright`, async () => {
    __clearDetailCacheForTests();
    const rows = Array.from({ length: DETAIL_PER_POLL_MAX + 1 }, (_, i) => ({ pms_reservation_id: `R${i}` }));
    const result = await enrichRowsWithDetail({
      rows, rowDetail, fetcher: async () => ({ arrival_date: 'x', departure_date: 'y' }),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason!, /too_many_rows_for_detail/);
  });

  test('time budget: rows past the deadline fail, never hang', async () => {
    __clearDetailCacheForTests();
    let t = 0;
    const rows = [{ pms_reservation_id: 'A1' }, { pms_reservation_id: 'B2' }];
    const result = await enrichRowsWithDetail({
      rows, rowDetail,
      now: () => { t += 15_000; return t; }, // 2nd row checks at +30s > 20s budget
      fetcher: async () => ({ arrival_date: '06/12/2026', departure_date: '06/14/2026' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.enrichedCount, 1);
    assert.match(result.reason!, /budget/);
  });
});

// ─── 7. Residual finalization + drill preconditions ─────────────────────────

const auditWith = (
  outstanding: Array<[string, 'missing' | 'dead' | 'unparseable' | 'rejected']>,
  probeRows: Array<Record<string, string>> = [],
  totalMatched = probeRows.length,
): PageAudit => ({
  verified: true,
  pageUrl: 'https://pms.example.com/arrivals',
  probeRows,
  totalMatched,
  outstanding: new Map(outstanding),
  problems: [],
});

describe('finalizeRecoveredSuccess (residual policy)', () => {
  const success = {
    ok: true as const,
    action: {
      steps: [],
      parse: {
        mode: 'table' as const,
        hint: {
          rowSelector: 'tbody tr',
          columns: {
            pms_reservation_id: 'td:nth-child(14)', guest_name: 'td:nth-child(2)',
            arrival_date: 'td:nth-child(9)', departure_date: '', status: 'td:nth-child(3)',
          },
        },
      },
    },
  };

  test('dead/rejected columns ship BLANK; unparseable keeps its selector', () => {
    const out = finalizeRecoveredSuccess({
      success,
      audit: auditWith([['arrival_date', 'dead'], ['departure_date', 'missing'], ['status', 'unparseable']]),
    });
    assert.equal(out.action.parse.mode, 'table');
    const cols = out.action.parse.mode === 'table' ? out.action.parse.hint.columns : {};
    assert.equal(cols.arrival_date, '');           // verified dead → park honestly
    assert.equal(cols.departure_date, '');
    assert.equal(cols.status, 'td:nth-child(3)');  // unparseable → keep (thin evidence rule)
    assert.equal(out.action.drillDown, undefined);
  });

  test('a successful drill attaches drillDown with the finalized list map', () => {
    const out = finalizeRecoveredSuccess(
      {
        success,
        audit: auditWith([['arrival_date', 'dead'], ['departure_date', 'missing']]),
      },
      {
        ok: true,
        tokensUsed: 0,
        drillDown: {
          listUrl: 'https://pms.example.com/arrivals',
          listRowSelector: 'tbody tr',
          listColumns: {},
          detailUrlTemplate: 'https://pms.example.com/Reservation/view?id={pms_reservation_id}',
          detailUrlParams: { pms_reservation_id: 'pms_reservation_id' },
          detailColumns: { arrival_date: '#arr', departure_date: '#dep' },
          fieldCoverage: { arrival_date: '2/2', departure_date: '2/2' },
          samplesDrilled: 1,
          templateVerified: true,
        },
      },
    );
    assert.ok(out.action.drillDown);
    // listColumns mirror the finalized map → the eligibility predicate can
    // resolve {pms_reservation_id} and the gate counts the recovered columns.
    assert.equal(out.action.drillDown!.listColumns.pms_reservation_id, 'td:nth-child(14)');
    assert.equal(out.action.drillDown!.listColumns.arrival_date, '');
    assert.deepEqual(
      missingRequiredColumns('getArrivals', effectiveColumnsFromAction('getArrivals', out.action)),
      [],
    );
  });
});

describe('finalizeRecoveredSuccess — unprovenRequiredColumns stamp (feature/cua-prove-columns)', () => {
  const read = (action: ActionRecipe): string[] | undefined =>
    (action as { unprovenRequiredColumns?: string[] }).unprovenRequiredColumns;

  const success = {
    ok: true as const,
    action: {
      steps: [],
      parse: {
        mode: 'table' as const,
        hint: {
          rowSelector: 'tbody tr',
          columns: {
            pms_reservation_id: 'td:nth-child(1)', guest_name: 'td:nth-child(2)',
            arrival_date: 'td:nth-child(5)', departure_date: 'td:nth-child(6)',
          },
        },
      },
    },
  };

  test('fully-certified emission carries NO field (legacy/clean shape preserved)', () => {
    const out = finalizeRecoveredSuccess({ success, audit: auditWith([]) });
    assert.equal(read(out.action), undefined);
  });

  test('an unparseable column keeps its selector AND is recorded unproven', () => {
    const out = finalizeRecoveredSuccess({
      success,
      audit: auditWith([['arrival_date', 'unparseable']]),
    });
    const cols = out.action.parse.mode === 'table' ? out.action.parse.hint.columns : {};
    assert.equal(cols.arrival_date, 'td:nth-child(5)');       // selector kept (thin-evidence rule)
    assert.deepEqual(read(out.action), ['arrival_date']);     // but never auto-promoted
  });

  test('a blanked (dead/rejected) column is NOT in the unproven list — it is a gap, not a live column', () => {
    const out = finalizeRecoveredSuccess({
      success,
      audit: auditWith([['arrival_date', 'dead'], ['departure_date', 'rejected']]),
    });
    assert.equal(read(out.action), undefined); // both blanked → handled by computeFeedGaps
  });

  test('an UNCERTAIN audit (empty/unreadable feed) records every still-shipping required column', () => {
    const audit: PageAudit = {
      verified: false,
      pageUrl: 'https://pms.example.com/arrivals',
      probeRows: [],
      totalMatched: 0,
      outstanding: new Map(),
      uncertain: new Set(['arrival_date', 'departure_date']),
      problems: [],
    };
    const out = finalizeRecoveredSuccess({ success, audit });
    assert.deepEqual(read(out.action)?.sort(), ['arrival_date', 'departure_date']);
    // selectors are kept — they may be perfect, just unproven on an empty feed.
    const cols = out.action.parse.mode === 'table' ? out.action.parse.hint.columns : {};
    assert.equal(cols.arrival_date, 'td:nth-child(5)');
  });

  test('a column recovered on the detail page (drill) is proven-by-drill → excluded from unproven', () => {
    const out = finalizeRecoveredSuccess(
      { success, audit: auditWith([['arrival_date', 'unparseable']]) },
      {
        ok: true,
        tokensUsed: 0,
        drillDown: {
          listUrl: 'https://pms.example.com/arrivals',
          listRowSelector: 'tbody tr',
          listColumns: {},
          detailUrlTemplate: 'https://pms.example.com/r?id={pms_reservation_id}',
          detailUrlParams: { pms_reservation_id: 'pms_reservation_id' },
          detailColumns: { arrival_date: '#arr' },
          fieldCoverage: { arrival_date: '1/1' },
          samplesDrilled: 1,
          templateVerified: true,
        },
      },
    );
    assert.equal(read(out.action), undefined); // arrival_date proven by the drill
  });
});

describe('drillPreconditions', () => {
  const probe = (n: number) =>
    rowsOf(n, (i) => ({ pms_reservation_id: `R${i}`, guest_name: 'G' }));

  test('passes with ≥2 distinct keys under the runtime row cap', () => {
    const pre = drillPreconditions('getArrivals', auditWith([['arrival_date', 'dead']], probe(4)));
    assert.equal(pre.ok, true);
  });

  test('fails when the key itself is unrecovered, keys are not distinct, or the list is too big', () => {
    assert.equal(
      drillPreconditions('getArrivals', auditWith([['pms_reservation_id', 'dead']], probe(4))).ok,
      false,
    );
    const constantKeys = rowsOf(4, () => ({ pms_reservation_id: 'SAME' }));
    assert.equal(
      drillPreconditions('getArrivals', auditWith([['arrival_date', 'dead']], constantKeys)).ok,
      false,
    );
    assert.equal(
      drillPreconditions('getArrivals', auditWith([['arrival_date', 'dead']], probe(4), DETAIL_PER_POLL_MAX + 5)).ok,
      false,
    );
  });
});

describe('isBetterCandidate (verified beats unverified)', () => {
  test('an unverified clean-looking emission never displaces a verified candidate', () => {
    // The regression the review caught: wandered page mid-recovery degrades
    // the audit to structural-only; its "0 outstanding" must not win.
    assert.equal(
      isBetterCandidate(
        { verified: false, outstandingCount: 0 },
        { verified: true, outstandingCount: 2 },
      ),
      false,
    );
    assert.equal(
      isBetterCandidate({ verified: true, outstandingCount: 2 }, { verified: false, outstandingCount: 0 }),
      true,
    );
  });
  test('among equals fewer outstanding wins, ties go to the newer emission', () => {
    assert.equal(isBetterCandidate({ verified: true, outstandingCount: 1 }, { verified: true, outstandingCount: 2 }), true);
    assert.equal(isBetterCandidate({ verified: true, outstandingCount: 2 }, { verified: true, outstandingCount: 1 }), false);
    assert.equal(isBetterCandidate({ verified: true, outstandingCount: 1 }, { verified: true, outstandingCount: 1 }), true);
    assert.equal(isBetterCandidate({ verified: false, outstandingCount: 3 }, null), true);
  });
});

describe('findRowsWithAllBlankDetail (reconcile blank-success hole)', () => {
  const columns = { status: '#st', out_of_order: '#ooo' };
  test('counts rows whose recovered values are ALL blank (login-wall artifact)', () => {
    assert.equal(findRowsWithAllBlankDetail([
      { pms_work_order_id: '1', status: 'Open', out_of_order: '' },   // partial = data
      { pms_work_order_id: '2', status: '', out_of_order: '' },       // all-blank = artifact
      { pms_work_order_id: '3', status: '', out_of_order: undefined },
    ], columns), 2);
    assert.equal(findRowsWithAllBlankDetail([], columns), 0);
    assert.equal(findRowsWithAllBlankDetail([{ a: '' }], {}), 0);
  });
});

// ─── 8. Hint sanity ─────────────────────────────────────────────────────────

describe('recovery hint', () => {
  test('names each problem column, teaches @attr, and keeps the softened escape', () => {
    const hint = buildRecoveryHint(
      'getWorkOrders',
      [
        { column: 'pms_work_order_id', kind: 'missing' },
        { column: 'out_of_order', kind: 'dead', probedRows: 12 },
        { column: 'status', kind: 'rejected', detail: 'parse_majority:0/3' },
      ],
      2, 3,
    );
    assert.match(hint, /pms_work_order_id/);
    assert.match(hint, /@attributeName/);
    assert.match(hint, /empty string ""/);
    assert.match(hint, /unique identifier/); // key-column expected shape
    assert.match(hint, /parse_majority:0\/3/);
    assert.match(expectedShapeFor('getArrivals', 'arrival_date'), /calendar date/);
  });
});
