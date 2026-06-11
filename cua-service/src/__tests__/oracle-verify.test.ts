/**
 * Oracle-verify safety-core tests (feat/cua-mapper-discovery).
 *
 * These are the CORRECTNESS PROOFS for structured discovery: every test in the
 * "rejection" groups encodes a way the system could have silently emitted a
 * wrong or stale rowset, and proves it ABSTAINS instead. If one of these goes
 * red, do not loosen the assertion — the production failure it guards against
 * is silent DB corruption at a live hotel.
 *
 * Pure tests: no Playwright, no network, no LLM.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  reconcileRows,
  prefilterCandidates,
  checkDateParams,
  sanitizeHeaders,
  findSessionTokenParam,
  looksLikeMutation,
  sameRegistrableDomain,
  findRowArrays,
  getByPath,
  projectRows,
  extractRowsAtPath,
  deriveFormat,
  renderDateFormat,
  renderTemplateAtDate,
  isoAddDays,
  apiDateSafety,
  looksMasked,
  type ReconcileInput,
} from '../oracle-verify.js';
import type { CapturedCall } from '../network-capture.js';

const ANCHOR = '2026-06-10'; // the feed's business date in all fixtures
const NOW_MS = Date.UTC(2026, 5, 10, 19, 30, 0); // 2026-06-10T19:30Z

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** 6 arrivals as the DOM oracle shows them (US-format dates, $ money). */
function arrivalsDomRows(): Array<Record<string, string>> {
  return [1, 2, 3, 4, 5, 6].map((i) => ({
    pms_reservation_id: `R10${i}7`,
    guest_name: `Guest${i}, Test`,
    arrival_date: '06/10/2026',
    departure_date: '06/11/2026',
    room_number: `${100 + i}`,
    rate_per_night_cents: '$125.00',
  }));
}

/** The same 6 arrivals as a (projected) API rowset — ISO dates, clean ids. */
function arrivalsApiRows(): Array<Record<string, unknown>> {
  return [1, 2, 3, 4, 5, 6].map((i) => ({
    pms_reservation_id: `R10${i}7`,
    guest_name: `Guest${i}, Test`,
    arrival_date: '2026-06-10',
    departure_date: '2026-06-11',
    room_number: `${100 + i}`,
    rate_per_night_cents: 125,
  }));
}

const ARRIVALS_COLS = [
  'pms_reservation_id', 'guest_name', 'arrival_date', 'departure_date', 'room_number', 'rate_per_night_cents',
];

function arrivalsInput(over: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    actionKey: 'getArrivals',
    domRows: arrivalsDomRows(),
    apiRows: arrivalsApiRows(),
    mappedColumns: [...ARRIVALS_COLS],
    anchorIso: ANCHOR,
    mode: 'learn',
    ...over,
  };
}

function workOrdersDomRows(): Array<Record<string, string>> {
  return [1, 2, 3, 4, 5, 6].map((i) => ({
    pms_work_order_id: `WO-9${i}3`,
    description: `Fix item number ${i} in the room`,
    status: 'open',
    out_of_order: i % 2 === 0 ? 'Yes' : 'No',
    room_number: `${200 + i}`,
  }));
}

function workOrdersApiRows(): Array<Record<string, unknown>> {
  return [1, 2, 3, 4, 5, 6].map((i) => ({
    pms_work_order_id: `WO-9${i}3`,
    description: `Fix item number ${i} in the room`,
    status: 'open',
    out_of_order: i % 2 === 0,
    room_number: `${200 + i}`,
  }));
}

const WO_COLS = ['pms_work_order_id', 'description', 'status', 'out_of_order', 'room_number'];
const WO_ENUMS = { status: ['open', 'in_progress', 'resolved', 'cancelled'] };
const WO_DOM_ENUM_MAP = { status: { open: 'open', 'in progress': 'in_progress' } };

function workOrdersInput(over: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    actionKey: 'getWorkOrders',
    domRows: workOrdersDomRows(),
    apiRows: workOrdersApiRows(),
    mappedColumns: [...WO_COLS],
    enumValueSets: WO_ENUMS,
    domEnumMappings: WO_DOM_ENUM_MAP,
    mode: 'learn',
    ...over,
  };
}

const RS_ENUMS = { status: ['occupied', 'vacant', 'dirty', 'clean', 'out_of_order'] };
const RS_DOM_MAP = { status: { OCC: 'occupied', VAC: 'vacant' } };

function roomStatusDomRows(): Array<Record<string, string>> {
  return [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
    room_number: `${100 + i}`,
    status: i <= 4 ? 'OCC' : 'VAC',
    changed_by: '',
  }));
}

function roomStatusApiRows(statusFor: (i: number) => unknown): Array<Record<string, unknown>> {
  return [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
    room_number: `${100 + i}`,
    status: statusFor(i),
    changed_by: null,
  }));
}

// ─── Reconcile: the happy paths ──────────────────────────────────────────────

describe('reconcileRows — verified matches', () => {
  test('bijective arrivals rowset reconciles (ISO API dates vs MM/DD DOM)', () => {
    const r = reconcileRows(arrivalsInput());
    assert.equal(r.reconciles, true, r.reason);
    assert.equal(r.keyColumn, 'pms_reservation_id');
    assert.equal(r.matchedCount, 6);
    assert.equal(r.surplus, 0);
    assert.equal(r.usedPaginationException, false);
  });

  test('byte-identical ambiguous numeric API dates corroborate (same format both sides)', () => {
    const api = arrivalsApiRows().map((r) => ({ ...r, arrival_date: '06/10/2026', departure_date: '06/11/2026' }));
    const r = reconcileRows(arrivalsInput({ apiRows: api }));
    assert.equal(r.reconciles, true, r.reason);
  });

  test('legitimate pagination: API superset where EVERY row carries the anchor date', () => {
    const extra = [7, 8, 9, 10, 11, 12].map((i) => ({
      pms_reservation_id: `R20${i}`,
      guest_name: `Late${i}, Guest`,
      arrival_date: '2026-06-10',
      departure_date: '2026-06-12',
      room_number: `${110 + i}`,
      rate_per_night_cents: 99,
    }));
    const r = reconcileRows(arrivalsInput({ apiRows: [...arrivalsApiRows(), ...extra] }));
    assert.equal(r.reconciles, true, r.reason);
    assert.equal(r.usedPaginationException, true);
    assert.equal(r.surplus, 6);
  });

  test('work orders bijective with boolean coercion (Yes/No vs true/false)', () => {
    const r = reconcileRows(workOrdersInput());
    assert.equal(r.reconciles, true, r.reason);
  });

  test('masked guest names skip corroboration but dates still verify the rows', () => {
    const api = arrivalsApiRows().map((r) => ({ ...r, guest_name: '████ ███' }));
    const r = reconcileRows(arrivalsInput({ apiRows: api }));
    assert.equal(r.reconciles, true, r.reason);
    assert.deepEqual(r.maskAcceptedColumns, ['guest_name']);
  });

  test('optional currency column already in cents (100x hazard) is DROPPED, feed survives', () => {
    const api = arrivalsApiRows().map((r) => ({ ...r, rate_per_night_cents: 12500 }));
    const r = reconcileRows(arrivalsInput({ apiRows: api }));
    assert.equal(r.reconciles, true, r.reason);
    assert.ok(r.droppedOptionalColumns?.includes('rate_per_night_cents'));
  });

  test('optional numeric room_number (text column) is DROPPED, not emitted', () => {
    const api = arrivalsApiRows().map((r) => ({ ...r, room_number: 101 }));
    const r = reconcileRows(arrivalsInput({ apiRows: api }));
    assert.equal(r.reconciles, true, r.reason);
    assert.ok(r.droppedOptionalColumns?.includes('room_number'));
  });
});

// ─── Reconcile: every silent-wrong-data path must ABSTAIN ────────────────────

describe('reconcileRows — wrong/plausible candidates are rejected', () => {
  test('WRONG ENDPOINT: departures rowset (disjoint ids) against arrivals oracle', () => {
    const api = arrivalsApiRows().map((r, i) => ({ ...r, pms_reservation_id: `D55${i}1` }));
    const r = reconcileRows(arrivalsInput({ apiRows: api }));
    assert.equal(r.reconciles, false);
    assert.match(r.reason, /dom_keys_missing_from_api/);
  });

  test('THIS-WEEK superset: bigger rowset with varying dates is rejected', () => {
    const week = [...arrivalsApiRows()];
    for (let i = 0; i < 12; i++) {
      week.push({
        pms_reservation_id: `W${i}88`,
        guest_name: `Week${i}, Guest`,
        arrival_date: isoAddDays(ANCHOR, (i % 6) + 1), // future days this week
        departure_date: isoAddDays(ANCHOR, (i % 6) + 3),
        room_number: `${120 + i}`,
        rate_per_night_cents: 110,
      });
    }
    const r = reconcileRows(arrivalsInput({ apiRows: week }));
    assert.equal(r.reconciles, false);
    assert.match(r.reason, /pagination_api_date_mismatch/);
  });

  test('1-NIGHT-STAY TRAP: a "departing tomorrow" superset fails the SEMANTIC column binding', () => {
    // Every DOM arrival is a 1-night stay (departs tomorrow). A superset
    // endpoint of "all reservations departing tomorrow" contains all 6 DOM
    // rows PLUS long-stay guests who arrived days ago. The semantic column
    // for getArrivals is arrival_date — the long-stays break its uniformity.
    const longStays = [1, 2, 3, 4].map((i) => ({
      pms_reservation_id: `L77${i}`,
      guest_name: `Long${i}, Stay`,
      arrival_date: isoAddDays(ANCHOR, -3 - i),
      departure_date: '2026-06-11',
      room_number: `${130 + i}`,
      rate_per_night_cents: 80,
    }));
    const r = reconcileRows(arrivalsInput({ apiRows: [...arrivalsApiRows(), ...longStays] }));
    assert.equal(r.reconciles, false);
    assert.match(r.reason, /pagination_api_date_mismatch/);
  });

  test('PHANTOM ROWS: surplus rows on a feed with NO date anchor (work orders) are rejected', () => {
    const api = [...workOrdersApiRows(),
      { pms_work_order_id: 'WO-CANCELLED-1', description: 'Phantom', status: 'open', out_of_order: false, room_number: '299' },
      { pms_work_order_id: 'WO-CANCELLED-2', description: 'Phantom', status: 'open', out_of_order: false, room_number: '298' },
    ];
    const r = reconcileRows(workOrdersInput({ apiRows: api }));
    assert.equal(r.reconciles, false);
    assert.match(r.reason, /api_superset_no_date_anchor/);
  });

  test('AUTO-RESOLVE GUARD: even ONE work order missing from the API closes real WOs → reject', () => {
    const api = workOrdersApiRows().slice(0, 5); // 5 of 6 — 83% would have passed a "90%" rule
    const r = reconcileRows(workOrdersInput({ apiRows: api }));
    assert.equal(r.reconciles, false);
    assert.match(r.reason, /dom_keys_missing_from_api/);
  });

  test('small oracle (N<5) never attempts an api emission', () => {
    const r = reconcileRows(arrivalsInput({
      domRows: arrivalsDomRows().slice(0, 3),
      apiRows: arrivalsApiRows().slice(0, 3),
    }));
    assert.equal(r.reconciles, false);
    assert.equal(r.reason, 'dom_too_small');
  });

  test('truncated oracle cannot prove containment', () => {
    const r = reconcileRows(arrivalsInput({ domTruncated: true }));
    assert.equal(r.reconciles, false);
    assert.equal(r.reason, 'dom_truncated');
  });

  test('ROWNUM SMELL: 1-based consecutive integer keys are not identifiers', () => {
    const dom = arrivalsDomRows().map((r, i) => ({ ...r, pms_reservation_id: String(i + 1) }));
    const api = arrivalsApiRows().map((r, i) => ({ ...r, pms_reservation_id: String(i + 1) }));
    const r = reconcileRows(arrivalsInput({ domRows: dom, apiRows: api }));
    assert.equal(r.reconciles, false);
    assert.equal(r.reason, 'dom_key_sequential_rownums');
  });

  test('sequential ROOM NUMBERS (101..108) are a legitimate key — NOT rejected', () => {
    const r = reconcileRows({
      actionKey: 'getRoomStatus',
      domRows: roomStatusDomRows(),
      apiRows: roomStatusApiRows((i) => (i <= 4 ? 'OCC' : 'VAC')),
      mappedColumns: ['room_number', 'status'],
      enumValueSets: RS_ENUMS,
      domEnumMappings: RS_DOM_MAP,
      mode: 'learn',
    });
    assert.equal(r.reconciles, true, r.reason);
  });

  test('duplicate API keys are rejected', () => {
    const api = arrivalsApiRows();
    api[5] = { ...api[5]!, pms_reservation_id: api[0]!.pms_reservation_id };
    const r = reconcileRows(arrivalsInput({ apiRows: api }));
    assert.equal(r.reconciles, false);
    assert.match(r.reason, /api_key_duplicates|dom_keys_missing/);
  });

  test('numeric API values for a text-typed KEY column are rejected (writer would drop every row)', () => {
    const r = reconcileRows({
      actionKey: 'getRoomStatus',
      domRows: roomStatusDomRows(),
      apiRows: roomStatusApiRows(() => 'OCC').map((row, i) => ({ ...row, room_number: 101 + i })),
      mappedColumns: ['room_number', 'status'],
      enumValueSets: RS_ENUMS,
      domEnumMappings: RS_DOM_MAP,
    });
    assert.equal(r.reconciles, false);
    assert.equal(r.reason, 'api_key_not_string');
  });

  test('EPOCH date fields are rejected (runtime generic_date cannot parse them)', () => {
    const api = arrivalsApiRows().map((r) => ({ ...r, arrival_date: 1781049600000 }));
    const r = reconcileRows(arrivalsInput({ apiRows: api }));
    assert.equal(r.reconciles, false);
    assert.match(r.reason, /required_column_mismatch:arrival_date/);
  });

  test('DIFFERENT-ORDER numeric API dates are rejected (learned DOM order would misparse them)', () => {
    // DOM shows 06/10/2026 (MDY); API serves 10/06/2026 (DMY). Runtime would
    // apply the DOM-learned MDY order to the API string → October 6th. Reject.
    const api = arrivalsApiRows().map((r) => ({ ...r, arrival_date: '10/06/2026', departure_date: '11/06/2026' }));
    const r = reconcileRows(arrivalsInput({ apiRows: api }));
    assert.equal(r.reconciles, false);
    assert.match(r.reason, /required_column_mismatch:arrival_date/);
  });

  test('required column mismatching on matched rows (wrong dot-path luck) is rejected', () => {
    const api = arrivalsApiRows().map((r, i) => ({ ...r, departure_date: isoAddDays('2026-06-12', i) }));
    const r = reconcileRows(arrivalsInput({ apiRows: api }));
    assert.equal(r.reconciles, false);
    assert.match(r.reason, /required_column_mismatch:departure_date/);
  });

  test('key-only agreement with ZERO corroborating columns is rejected', () => {
    // Same ids but every other field empty on both sides → nothing proves the
    // rows are the same records (vs. a different feed sharing identifiers).
    const dom = arrivalsDomRows().map((r) => ({
      ...r, guest_name: '', arrival_date: '', departure_date: '', room_number: '', rate_per_night_cents: '',
    }));
    const api = arrivalsApiRows().map((r) => ({
      ...r, guest_name: null, arrival_date: null, departure_date: null, room_number: null, rate_per_night_cents: null,
    }));
    const r = reconcileRows(arrivalsInput({ domRows: dom, apiRows: api }));
    assert.equal(r.reconciles, false);
    // Either guard may fire first (required-column unverifiable, or the
    // zero-corroboration backstop) — the invariant is that key-only agreement
    // NEVER verifies.
    assert.match(r.reason, /required_column_unverifiable|no_corroborating_columns/);
  });

  test('required contract column missing from the mapping entirely is rejected', () => {
    const input = arrivalsInput();
    input.mappedColumns = input.mappedColumns.filter((c) => c !== 'departure_date');
    input.apiRows = input.apiRows.map((r) => { const { departure_date: _d, ...rest } = r; return rest; });
    const r = reconcileRows(input);
    assert.equal(r.reconciles, false);
    assert.match(r.reason, /required_column_not_mapped:departure_date/);
  });
});

// ─── Reconcile: enum vocabulary derivation ───────────────────────────────────

describe('reconcileRows — enum derivation', () => {
  test('derives API-side vocabulary from matched pairs (diverse + consistent)', () => {
    const r = reconcileRows({
      actionKey: 'getRoomStatus',
      domRows: roomStatusDomRows(),
      apiRows: roomStatusApiRows((i) => (i <= 4 ? '2' : '1')),
      mappedColumns: ['room_number', 'status'],
      enumValueSets: RS_ENUMS,
      domEnumMappings: RS_DOM_MAP,
    });
    assert.equal(r.reconciles, true, r.reason);
    assert.deepEqual(r.derivedEnumMappings, { status: { '2': 'occupied', '1': 'vacant' } });
  });

  test('INCONSISTENT pairing (same API raw → two canonicals) aborts', () => {
    const r = reconcileRows({
      actionKey: 'getRoomStatus',
      domRows: roomStatusDomRows(),
      apiRows: roomStatusApiRows(() => '2'), // '2' pairs with both OCC and VAC rows
      mappedColumns: ['room_number', 'status'],
      enumValueSets: RS_ENUMS,
      domEnumMappings: RS_DOM_MAP,
    });
    assert.equal(r.reconciles, false);
    assert.match(r.reason, /enum_inconsistent:status/);
  });

  test('CONTRADICTION: API uses a raw the agent learned, but pairing maps it elsewhere', () => {
    // API row for a VAC room says 'OCC' — but the agent learned OCC→occupied.
    // Classic wrong-column smell (occupancy flag posing as status).
    const r = reconcileRows({
      actionKey: 'getRoomStatus',
      domRows: roomStatusDomRows(),
      apiRows: roomStatusApiRows((i) => (i <= 4 ? 'VAC' : 'OCC')),
      mappedColumns: ['room_number', 'status'],
      enumValueSets: RS_ENUMS,
      domEnumMappings: RS_DOM_MAP,
    });
    assert.equal(r.reconciles, false);
    assert.match(r.reason, /enum_contradiction:status/);
  });

  test('LOW DIVERSITY: a single perfectly-correlated canonical cannot prove the column', () => {
    const dom = roomStatusDomRows().map((r) => ({ ...r, status: 'OCC' }));
    const r = reconcileRows({
      actionKey: 'getRoomStatus',
      domRows: dom,
      apiRows: roomStatusApiRows(() => '2'),
      mappedColumns: ['room_number', 'status'],
      enumValueSets: RS_ENUMS,
      domEnumMappings: RS_DOM_MAP,
    });
    assert.equal(r.reconciles, false);
    assert.match(r.reason, /enum_derivation_low_diversity:status/);
  });

  test('byte-matching vocabulary needs no derivation', () => {
    const r = reconcileRows({
      actionKey: 'getRoomStatus',
      domRows: roomStatusDomRows(),
      apiRows: roomStatusApiRows((i) => (i <= 4 ? 'OCC' : 'VAC')),
      mappedColumns: ['room_number', 'status'],
      enumValueSets: RS_ENUMS,
      domEnumMappings: RS_DOM_MAP,
    });
    assert.equal(r.reconciles, true, r.reason);
    assert.equal(r.derivedEnumMappings, undefined);
  });
});

// ─── Date templating: stale-date guard ───────────────────────────────────────

describe('checkDateParams — anchor dates template, everything else abstains', () => {
  test('whole-value anchor date param → {today:MM/DD/YYYY}', () => {
    const r = checkDateParams({
      url: 'https://pms.example.com/api/arrivals?date=06/10/2026&view=all',
      anchorIso: ANCHOR,
      nowMs: NOW_MS,
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.url, 'https://pms.example.com/api/arrivals?date={today:MM/DD/YYYY}&view=all');
    assert.equal(r.templatedCount, 1);
  });

  test('ISO anchor date in the URL PATH is templated', () => {
    const r = checkDateParams({
      url: 'https://pms.example.com/reports/2026-06-10/arrivals',
      anchorIso: ANCHOR,
      nowMs: NOW_MS,
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.url, 'https://pms.example.com/reports/{today:YYYY-MM-DD}/arrivals');
  });

  test('anchor date EMBEDDED in a compound query value is templated (never frozen)', () => {
    const r = checkDateParams({
      url: 'https://pms.example.com/api/list?filter=arrivals:06/10/2026',
      anchorIso: ANCHOR,
      nowMs: NOW_MS,
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.url, 'https://pms.example.com/api/list?filter=arrivals:{today:MM/DD/YYYY}');
  });

  test('NON-anchor date (range end) → abstain', () => {
    const r = checkDateParams({
      url: 'https://pms.example.com/api/list?start=06/10/2026&end=06/17/2026',
      anchorIso: ANCHOR,
      nowMs: NOW_MS,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /non_anchor_date/);
  });

  test('tomorrow as range end in a JSON body → abstain', () => {
    const r = checkDateParams({
      url: 'https://pms.example.com/api/list',
      body: '{"from":"2026-06-10","to":"2026-06-11"}',
      anchorIso: ANCHOR,
      nowMs: NOW_MS,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /non_anchor_date_in_body/);
  });

  test('JSON body anchor date is templated into bodyTemplate', () => {
    const r = checkDateParams({
      url: 'https://pms.example.com/api/list',
      body: '{"businessDate":"06/10/2026","page":1}',
      anchorIso: ANCHOR,
      nowMs: NOW_MS,
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.bodyTemplate, '{"businessDate":"{today:MM/DD/YYYY}","page":1}');
    assert.equal(r.templatedCount, 1);
  });

  test('PERCENT-ENCODED date param → abstain (encoding round-trip not provable)', () => {
    const r = checkDateParams({
      url: 'https://pms.example.com/api/list?date=06%2F10%2F2026',
      anchorIso: ANCHOR,
      nowMs: NOW_MS,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /encoded_date_param/);
  });

  test('id-named param whose value collides with today → abstain (it is an ID)', () => {
    const r = checkDateParams({
      url: 'https://pms.example.com/api/view?reservationId=06102026',
      anchorIso: ANCHOR,
      nowMs: NOW_MS,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /date_like_value_in_id_param/);
  });

  test('cache-buster epoch near now is STRIPPED (replay must prove it optional)', () => {
    const r = checkDateParams({
      url: `https://pms.example.com/api/list?date=06/10/2026&_=${NOW_MS - 60_000}`,
      anchorIso: ANCHOR,
      nowMs: NOW_MS,
    });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.strippedParams, ['_']);
    assert.ok(!r.url!.includes('_='));
  });

  test('MIDNIGHT-ALIGNED epoch in a cache-buster name is a date filter → abstain', () => {
    const midnight = Date.UTC(2026, 5, 10, 0, 0, 0) / 1000; // seconds, 00:00 today
    const r = checkDateParams({
      url: `https://pms.example.com/api/list?ts=${midnight}`,
      anchorIso: ANCHOR,
      nowMs: NOW_MS,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /untemplateable_epoch/);
  });

  test('epoch in a non-buster param (start=) → abstain', () => {
    const r = checkDateParams({
      url: `https://pms.example.com/api/list?start=${Math.floor(NOW_MS / 1000)}`,
      anchorIso: ANCHOR,
      nowMs: NOW_MS,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /untemplateable_epoch_param:start/);
  });

  test('compact YYYYMMDD anchor templates', () => {
    const r = checkDateParams({
      url: 'https://pms.example.com/api/list?d=20260610',
      anchorIso: ANCHOR,
      nowMs: NOW_MS,
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.url, 'https://pms.example.com/api/list?d={today:YYYYMMDD}');
  });

  test('8-digit number that is NOT a plausible date is left alone', () => {
    const r = checkDateParams({
      url: 'https://pms.example.com/api/list?acct=19872034',
      anchorIso: ANCHOR,
      nowMs: NOW_MS,
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.url, 'https://pms.example.com/api/list?acct=19872034');
    assert.equal(r.templatedCount, 0);
  });

  test('AMBIGUOUS M/D order day (06/06) yields an alternate render for the probe', () => {
    const r = checkDateParams({
      url: 'https://pms.example.com/api/list?date=06/06/2026',
      anchorIso: '2026-06-06',
      nowMs: Date.UTC(2026, 5, 6, 15, 0, 0),
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.url, 'https://pms.example.com/api/list?date={today:MM/DD/YYYY}');
    assert.equal(r.altUrl, 'https://pms.example.com/api/list?date={today:DD/MM/YYYY}');
  });

  test('TEXTUAL-month date (untemplateable grammar) anywhere → abstain, even when it IS today', () => {
    const inUrl = checkDateParams({
      url: 'https://pms.example.com/api/list?label=Jun%2010,%202026',
      anchorIso: ANCHOR,
      nowMs: NOW_MS,
    });
    assert.equal(inUrl.ok, false);
    assert.match(inUrl.reason!, /textual_date_in_url/);

    const inBody = checkDateParams({
      url: 'https://pms.example.com/api/list',
      body: '{"reportDate":"10 Jun 2026"}',
      anchorIso: ANCHOR,
      nowMs: NOW_MS,
    });
    assert.equal(inBody.ok, false);
    assert.match(inBody.reason!, /textual_date_in_body/);
  });

  test('FROZEN far-window epoch in a date-NAMED param (since=Jan 1) → abstain', () => {
    const jan1 = Math.floor(Date.UTC(2026, 0, 1, 0, 0, 1) / 1000);
    const r = checkDateParams({
      url: `https://pms.example.com/api/list?since=${jan1}`,
      anchorIso: ANCHOR,
      nowMs: NOW_MS,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /frozen_epoch_date_param:since/);
    // …while an opaque big number in a non-date param is left alone.
    const id = checkDateParams({
      url: `https://pms.example.com/api/list?accountRef=${jan1}`,
      anchorIso: ANCHOR,
      nowMs: NOW_MS,
    });
    assert.equal(id.ok, true, id.reason);
  });

  test('no dates at all → ok with zero templates (the immune class)', () => {
    const r = checkDateParams({
      url: 'https://pms.example.com/api/arrivals?view=today',
      anchorIso: ANCHOR,
      nowMs: NOW_MS,
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.templatedCount, 0);
    assert.equal(r.url, 'https://pms.example.com/api/arrivals?view=today');
  });
});

// ─── Request safety ──────────────────────────────────────────────────────────

describe('sanitizeHeaders / session tokens / mutation verbs', () => {
  test('CSRF header → abstain (static replay goes stale)', () => {
    const r = sanitizeHeaders({ accept: 'application/json', 'x-csrf-token': 'abc123' }, { method: 'GET' });
    assert.equal(r.ok, false);
  });

  test('authorization header → abstain', () => {
    const r = sanitizeHeaders({ authorization: 'Bearer xyz' }, { method: 'GET' });
    assert.equal(r.ok, false);
  });

  test('cookie is silently dropped (browser session carries it), allowlist kept', () => {
    const r = sanitizeHeaders(
      { Cookie: 'session=abc', Accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'x' },
      { method: 'POST', body: '{"a":1}' },
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.headers, {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
    });
  });

  test('JSON POST with no captured content-type → abstain (fetch-api would mislabel it)', () => {
    const r = sanitizeHeaders({ accept: '*/*' }, { method: 'POST', body: '{"date":"x"}' });
    assert.equal(r.ok, false);
  });

  test('session tokens hiding in params/body/path are caught', () => {
    assert.ok(findSessionTokenParam('https://p.com/api/list?sessionToken=abc'));
    assert.ok(findSessionTokenParam('https://p.com/api/list?_csrf=abc'));
    assert.ok(findSessionTokenParam('https://p.com/api/list;jsessionid=ABC123?x=1'));
    assert.ok(findSessionTokenParam('https://p.com/api/list', 'javax.faces.ViewState=abc&x=1'));
    assert.ok(findSessionTokenParam('https://p.com/api/list?pageToken=abc'));
    assert.equal(findSessionTokenParam('https://p.com/api/list?author=smith&date=1'), null);
  });

  test('mutation-verb POSTs are excluded; GETs and query-POSTs are not', () => {
    assert.equal(looksLikeMutation('POST', 'https://p.com/api/SaveWorkOrder'), true);
    assert.equal(looksLikeMutation('POST', 'https://p.com/api/workorders/markComplete'), true);
    assert.equal(looksLikeMutation('POST', 'https://p.com/api/GetSavedSearch'), false);
    assert.equal(looksLikeMutation('POST', 'https://p.com/api/arrivals/search'), false);
    assert.equal(looksLikeMutation('GET', 'https://p.com/api/deleteEverything'), false);
  });

  test('registrable-domain comparison incl. co.uk suffixes', () => {
    assert.equal(sameRegistrableDomain('app.pms.com', 'login.pms.com'), true);
    assert.equal(sameRegistrableDomain('pms.com', 'evil.com'), false);
    assert.equal(sameRegistrableDomain('api.hotel.co.uk', 'www.hotel.co.uk'), true);
    assert.equal(sameRegistrableDomain('hotel.co.uk', 'other.co.uk'), false);
  });
});

// ─── Prefilter ───────────────────────────────────────────────────────────────

function mkCall(over: Partial<CapturedCall> = {}): CapturedCall {
  return {
    url: 'https://pms.example.com/api/arrivals?date=06/10/2026',
    method: 'GET',
    requestBody: null,
    requestHeaders: { accept: 'application/json' },
    status: 200,
    contentType: 'application/json',
    responseBody: { data: { arrivals: arrivalsApiRowsRaw() } },
    ...over,
  };
}

/** Raw (un-projected) API rows as the server would send them. */
function arrivalsApiRowsRaw(): Array<Record<string, unknown>> {
  return [1, 2, 3, 4, 5, 6].map((i) => ({
    resvId: `R10${i}7`,
    guest: { name: `Guest${i}, Test` },
    arrivalDate: '2026-06-10',
    departureDate: '2026-06-11',
    room: `${100 + i}`,
  }));
}

describe('prefilterCandidates', () => {
  const base = {
    domRows: arrivalsDomRows(),
    keyColumn: 'pms_reservation_id',
    loginUrl: 'https://pms.example.com/login',
    feedPageUrl: 'https://pms.example.com/frontdesk/arrivals',
  };

  test('keeps the matching same-site JSON call', () => {
    const r = prefilterCandidates({ calls: [mkCall()], ...base });
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0]!.arrays[0]!.jsonPath, 'data.arrivals');
  });

  test('cross-host call is excluded even with perfect rows', () => {
    const r = prefilterCandidates({ calls: [mkCall({ url: 'https://analytics.evil.com/api?x=1' })], ...base });
    assert.equal(r.candidates.length, 0);
    assert.ok((r.skipped.cross_host_login ?? 0) > 0);
  });

  test('low key overlap (different records) is excluded without any LLM spend', () => {
    const other = { data: { arrivals: arrivalsApiRowsRaw().map((r, i) => ({ ...r, resvId: `X${i}` })) } };
    const r = prefilterCandidates({ calls: [mkCall({ responseBody: other })], ...base });
    assert.equal(r.candidates.length, 0);
    assert.ok((r.skipped.low_key_overlap ?? 0) > 0);
  });

  test('session-token call and mutation POST are excluded', () => {
    const r = prefilterCandidates({
      calls: [
        mkCall({ url: 'https://pms.example.com/api/arrivals?token=abc' }),
        mkCall({ url: 'https://pms.example.com/api/saveArrivals', method: 'POST', requestBody: 'x=1' }),
      ],
      ...base,
    });
    assert.equal(r.candidates.length, 0);
  });

  test('non-2xx and non-JSON are excluded; duplicates collapse to most recent', () => {
    const r = prefilterCandidates({
      calls: [mkCall(), mkCall(), mkCall({ status: 302 }), mkCall({ responseBody: null })],
      ...base,
    });
    assert.equal(r.candidates.length, 1);
  });
});

// ─── JSON structure helpers ──────────────────────────────────────────────────

describe('findRowArrays / getByPath / projectRows / extractRowsAtPath', () => {
  test('locates arrays of objects through object keys only', () => {
    const body = {
      meta: { count: 2 },
      data: { reservations: [{ a: 1 }, { a: 2 }], summary: { total: 2 } },
      grid: [[1, 2], [3, 4]],                 // array-of-arrays — not addressable
      wrapped: [{ inner: [{ b: 1 }] }],       // 'wrapped' is itself rows; 'wrapped.inner' is NOT addressable
    };
    const arrays = findRowArrays(body);
    assert.deepEqual(arrays.map((a) => a.jsonPath), ['data.reservations', 'wrapped']);
    assert.ok(!arrays.some((a) => a.jsonPath === 'wrapped.inner'), 'cannot path through an array');
  });

  test('root array is a candidate at the empty path', () => {
    const arrays = findRowArrays([{ a: 1 }, { a: 2 }]);
    assert.equal(arrays[0]!.jsonPath, '');
  });

  test('getByPath resolves nested fields; missing → undefined', () => {
    assert.equal(getByPath({ guest: { name: 'X' } }, 'guest.name'), 'X');
    assert.equal(getByPath({ guest: { name: 'X' } }, 'guest.phone'), undefined);
    assert.equal(getByPath({ 'guest.name': 'literal' }, 'guest.name'), undefined);
  });

  test('projectRows applies the columns mapping with dot-paths', () => {
    const rows = projectRows(arrivalsApiRowsRaw(), { pms_reservation_id: 'resvId', guest_name: 'guest.name' });
    assert.equal(rows[0]!.pms_reservation_id, 'R1017');
    assert.equal(rows[0]!.guest_name, 'Guest1, Test');
  });

  test('extractRowsAtPath mirrors the runtime contract (explicit path, envelope, single object)', () => {
    assert.equal(extractRowsAtPath({ data: { x: [{ a: 1 }] } }, 'data.x').ok, true);
    const env = extractRowsAtPath({ rows: [{ a: 1 }], results: [{ b: 2 }] }, '');
    assert.ok(env.ok && env.rows[0]!.a === 1, 'rows takes precedence over results');
    const single = extractRowsAtPath({ a: 1 }, '');
    assert.ok(single.ok && single.rows.length === 1);
    assert.equal(extractRowsAtPath({ data: [] }, 'data').ok, false);
  });
});

// ─── Date helpers ────────────────────────────────────────────────────────────

describe('date format derivation + rendering', () => {
  test('deriveFormat maps observed digits to the right token string', () => {
    assert.deepEqual(deriveFormat('06/10/2026', ANCHOR), ['MM/DD/YYYY']);
    assert.deepEqual(deriveFormat('10.06.2026', ANCHOR), ['DD.MM.YYYY']);
    assert.deepEqual(deriveFormat('6/10/2026', ANCHOR), ['M/DD/YYYY']);
    assert.deepEqual(deriveFormat('2026-06-10', ANCHOR), ['YYYY-MM-DD']);
    assert.deepEqual(deriveFormat('20260610', ANCHOR), ['YYYYMMDD']);
    assert.deepEqual(deriveFormat('06/10/26', ANCHOR), ['MM/DD/YY']);
    assert.deepEqual(deriveFormat('06/06/2026', '2026-06-06'), ['MM/DD/YYYY', 'DD/MM/YYYY']);
    assert.deepEqual(deriveFormat('07/11/2026', ANCHOR), []);
  });

  test('renderDateFormat + renderTemplateAtDate round-trip', () => {
    assert.equal(renderDateFormat('MM/DD/YYYY', '2026-06-09'), '06/09/2026');
    assert.equal(renderDateFormat('D.M.YY', '2026-06-09'), '9.6.26');
    assert.equal(
      renderTemplateAtDate('https://x.com/a?d={today:YYYYMMDD}&y={today:M/D/YYYY}', '2026-06-09'),
      'https://x.com/a?d=20260609&y=6/9/2026',
    );
  });

  test('isoAddDays crosses month boundaries', () => {
    assert.equal(isoAddDays('2026-06-10', -1), '2026-06-09');
    assert.equal(isoAddDays('2026-06-01', -1), '2026-05-31');
    assert.equal(isoAddDays('2026-12-31', 1), '2027-01-01');
  });

  test('apiDateSafety: ISO/textual safe, byte-equal safe, ambiguous/epoch unsafe', () => {
    assert.deepEqual(apiDateSafety('2026-06-10', '06/10/2026'), { safe: true, iso: '2026-06-10', byteEqual: false });
    assert.deepEqual(apiDateSafety('2026-06-10T00:00:00', '06/10/2026'), { safe: true, iso: '2026-06-10', byteEqual: false });
    assert.deepEqual(apiDateSafety('06/10/2026', '06/10/2026'), { safe: true, iso: null, byteEqual: true });
    assert.equal(apiDateSafety('10/06/2026', '06/10/2026').safe, false);
    assert.equal(apiDateSafety(1781049600000, '06/10/2026').safe, false);
  });

  test('looksMasked recognizes redaction shapes, not real values', () => {
    assert.equal(looksMasked('████'), true);
    assert.equal(looksMasked('***'), true);
    assert.equal(looksMasked('[REDACTED]'), true);
    assert.equal(looksMasked('xxx'), true);
    // Shape-preserving masks (capture chat masks names shape-identically).
    assert.equal(looksMasked('Xxxxx, Xxxx'), true);
    assert.equal(looksMasked('XXXX_XXXXX'), true);
    assert.equal(looksMasked('J*** S****'), true);
    // Real values must NOT be treated as masked.
    assert.equal(looksMasked('Smith, John'), false);
    assert.equal(looksMasked('DUE_IN'), false);
    assert.equal(looksMasked('x-ray suite'), false);
    assert.equal(looksMasked('101'), false);
    assert.equal(looksMasked(''), false);
  });
});
