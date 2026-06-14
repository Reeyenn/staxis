/**
 * Tests for src/lib/pms/recipe-coverage.ts — the PURE app-side coverage parser
 * behind the PMS coverage editor (feature/cua-coverage-editor).
 *
 * Covers: column extraction across every ActionRecipe shape; the two knowledge
 * envelope shapes (current `actions` vs legacy `feeds`); the editable gate; and
 * the required / drill-down / learnable rules that drive Edit/Add/Delete.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  columnsFromAction,
  parseKnowledgeCoverage,
  addableFeeds,
  prettifyKey,
  REQUIRED_ACTION_KEYS,
  DRILLDOWN_ACTION_KEYS,
  LEARNABLE_ACTION_KEYS,
} from '@/lib/pms/recipe-coverage';

describe('columnsFromAction', () => {
  test('table mode → parse.hint.columns', () => {
    const cols = columnsFromAction({
      parse: { mode: 'table', hint: { rowSelector: 'tr', columns: { room_number: 'td.rm', status: 'td.st' } } },
    });
    assert.deepEqual(cols, { room_number: 'td.rm', status: 'td.st' });
  });

  test('csv mode → parse.hint.columns', () => {
    const cols = columnsFromAction({ parse: { mode: 'csv', hint: { columns: { a: 'A', b: 'B' } } } });
    assert.deepEqual(cols, { a: 'A', b: 'B' });
  });

  test('api mode → parse.hint.columns', () => {
    const cols = columnsFromAction({ parse: { mode: 'api', hint: { url: '/x', columns: { id: '$.id' } } } });
    assert.deepEqual(cols, { id: '$.id' });
  });

  test('inline_text mode → parse.fields', () => {
    const cols = columnsFromAction({ parse: { mode: 'inline_text', fields: { total: '.tot' } } });
    assert.deepEqual(cols, { total: '.tot' });
  });

  test('drillDown.listColumns wins over parse', () => {
    const cols = columnsFromAction({
      drillDown: { listColumns: { guest: '.g' } },
      parse: { mode: 'table', hint: { columns: { ignored: '.x' } } },
    });
    assert.deepEqual(cols, { guest: '.g' });
  });

  test('coerces non-string selector values to strings; tolerates junk', () => {
    assert.deepEqual(columnsFromAction({ parse: { mode: 'table', hint: { columns: { n: 3 } } } }), { n: '3' });
    assert.deepEqual(columnsFromAction(null), {});
    assert.deepEqual(columnsFromAction({}), {});
    assert.deepEqual(columnsFromAction({ parse: { mode: 'weird' } }), {});
    assert.deepEqual(columnsFromAction({ parse: { mode: 'table', hint: { columns: [] } } }), {});
  });
});

describe('parseKnowledgeCoverage — actions (current) shape', () => {
  const knowledge = {
    schema: 1,
    actions: {
      getRoomStatus: { parse: { mode: 'table', hint: { rowSelector: 'tr', columns: { room_number: 'td' } } } },
      getGuests: { drillDown: { listColumns: { name: '.n' } } },
      getCancellations: { parse: { mode: 'table', hint: { columns: { pms_reservation_id: '.id' } } } },
    },
  };

  test('is editable and lists every feed', () => {
    const parsed = parseKnowledgeCoverage(knowledge);
    assert.equal(parsed.shape, 'actions');
    assert.equal(parsed.editable, true);
    assert.deepEqual(parsed.feeds.map((f) => f.actionKey).sort(), ['getCancellations', 'getGuests', 'getRoomStatus']);
  });

  test('required + table + columns are populated from contracts/recipe', () => {
    const parsed = parseKnowledgeCoverage(knowledge);
    const rs = parsed.feeds.find((f) => f.actionKey === 'getRoomStatus')!;
    assert.equal(rs.required, true);
    assert.equal(rs.table, 'pms_room_status_log');
    assert.deepEqual(rs.columns, { room_number: 'td' });
    assert.equal(rs.canTakeover, true);
  });

  test('drill-down feed is present but NOT takeover-editable', () => {
    const parsed = parseKnowledgeCoverage(knowledge);
    const guests = parsed.feeds.find((f) => f.actionKey === 'getGuests')!;
    assert.equal(guests.canTakeover, false);
    assert.equal(guests.required, false);
  });
});

describe('parseKnowledgeCoverage — legacy feeds shape', () => {
  const legacy = {
    schema: 1,
    feeds: {
      room_status: { mode: 'dom_table', selectors: {} },
      arrivals_departures: { mode: 'csv_download' },
      housekeeping: {},
    },
  };

  test('is read-only (not editable) and maps legacy keys', () => {
    const parsed = parseKnowledgeCoverage(legacy);
    assert.equal(parsed.shape, 'legacy');
    assert.equal(parsed.editable, false);
    const rs = parsed.feeds.find((f) => f.key === 'room_status')!;
    assert.equal(rs.actionKey, 'getRoomStatus');
    assert.equal(rs.canTakeover, false); // legacy is never takeover-editable
    assert.equal(rs.source, 'legacy');
    const hk = parsed.feeds.find((f) => f.key === 'housekeeping')!;
    assert.equal(hk.actionKey, null); // housekeeping has no editable action
  });

  test('actions shape wins when both are present', () => {
    const both = { schema: 1, actions: { getRoomStatus: { parse: { mode: 'table', hint: { columns: {} } } } }, feeds: { room_status: {} } };
    assert.equal(parseKnowledgeCoverage(both).shape, 'actions');
  });

  test('empty / malformed envelope → empty', () => {
    assert.equal(parseKnowledgeCoverage({}).shape, 'empty');
    assert.equal(parseKnowledgeCoverage(null).shape, 'empty');
    assert.equal(parseKnowledgeCoverage({ actions: {} }).shape, 'empty');
  });
});

describe('addableFeeds', () => {
  test('excludes present, drill-down, and non-learnable feeds', () => {
    const present = new Set(['getRoomStatus', 'getArrivals']);
    const add = addableFeeds(present).map((a) => a.actionKey);
    assert.ok(!add.includes('getRoomStatus'), 'present feed excluded');
    assert.ok(!add.includes('getGuests'), 'drill-down feed excluded');
    assert.ok(!add.includes('getDashboardCounts'), 'non-learnable feed excluded');
    assert.ok(add.includes('getCancellations'), 'a learnable, absent feed is addable');
    assert.ok(add.includes('getWorkOrders'), 'absent core feed is addable');
  });

  test('every addable feed is learnable and not drill-down', () => {
    for (const a of addableFeeds(new Set())) {
      assert.ok(LEARNABLE_ACTION_KEYS.has(a.actionKey));
      assert.ok(!DRILLDOWN_ACTION_KEYS.has(a.actionKey));
    }
  });
});

describe('catalogue invariants', () => {
  test('required keys are the 4 core feeds and all learnable', () => {
    assert.deepEqual([...REQUIRED_ACTION_KEYS].sort(), ['getArrivals', 'getDepartures', 'getRoomStatus', 'getWorkOrders']);
    for (const k of REQUIRED_ACTION_KEYS) assert.ok(LEARNABLE_ACTION_KEYS.has(k));
  });

  test('prettifyKey humanizes a get* key', () => {
    assert.equal(prettifyKey('getFutureBookings'), 'Future bookings');
  });
});
