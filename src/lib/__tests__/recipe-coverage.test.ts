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
  UNDELETABLE_COLUMNS_BY_FEED,
  customColumnsFromAction,
  detectedColumnsFromAction,
  availablePageColumnsFor,
  authorSelectorForIndex,
  customColumnKeyConflict,
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
  test('excludes present and drill-down feeds', () => {
    const present = new Set(['getRoomStatus', 'getArrivals']);
    const add = addableFeeds(present).map((a) => a.actionKey);
    assert.ok(!add.includes('getRoomStatus'), 'present feed excluded');
    assert.ok(!add.includes('getGuests'), 'drill-down feed excluded');
    assert.ok(add.includes('getCancellations'), 'a learnable, absent feed is addable');
    assert.ok(add.includes('getWorkOrders'), 'absent core feed is addable');
    // getDashboardCounts / getRoomLayout / getHistoricalOccupancy ARE in the
    // mapper TARGETS loop, so they're now learnable + addable (they were
    // silently blocked when LEARNABLE_ACTION_KEYS drifted from TARGETS).
    assert.ok(add.includes('getDashboardCounts'), 'dashboard counts is addable');
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

// ── feature/cua-column-editor ──────────────────────────────────────────────

describe('customColumnsFromAction', () => {
  test('reads parse.hint.customColumns on a table feed', () => {
    const cc = customColumnsFromAction({
      parse: { mode: 'table', hint: { rowSelector: 'tr', columns: { a: 'td:nth-child(1)' }, customColumns: { rate_plan: 'td:nth-child(9)' } } },
    });
    assert.deepEqual(cc, { rate_plan: 'td:nth-child(9)' });
  });
  test('empty for non-table feeds and missing/garbage shapes', () => {
    assert.deepEqual(customColumnsFromAction({ parse: { mode: 'csv', hint: { columns: {}, customColumns: { x: 'y' } } } }), {});
    assert.deepEqual(customColumnsFromAction({ parse: { mode: 'table', hint: {} } }), {});
    assert.deepEqual(customColumnsFromAction(null), {});
  });
});

describe('detectedColumnsFromAction', () => {
  test('reads + sanitizes parse.hint.detectedColumns', () => {
    const d = detectedColumnsFromAction({
      parse: { mode: 'table', hint: { columns: {}, detectedColumns: [
        { index: 1, header: 'Conf. #' }, { index: 2, header: ' Guest ' },
        { index: 0, header: 'bad-index' }, { index: 3, header: '' }, { header: 'no-index' },
      ] } },
    });
    assert.deepEqual(d, [{ index: 1, header: 'Conf. #' }, { index: 2, header: 'Guest' }]);
  });
  test('empty when absent', () => {
    assert.deepEqual(detectedColumnsFromAction({ parse: { mode: 'table', hint: { columns: {} } } }), []);
  });
});

describe('availablePageColumnsFor', () => {
  test('excludes headers whose cell index is already captured (known OR custom)', () => {
    const action = {
      parse: { mode: 'table', hint: {
        rowSelector: 'tbody tr',
        columns: { guest_name: 'td:nth-child(2)' },                 // captures index 2
        customColumns: { conf: 'td:nth-child(1)' },                  // captures index 1
        detectedColumns: [
          { index: 1, header: 'Conf. #' },   // captured (custom) → excluded
          { index: 2, header: 'Guest' },      // captured (known) → excluded
          { index: 9, header: 'Rate Plan' },  // free → offered
        ],
      } },
    };
    assert.deepEqual(availablePageColumnsFor(action), [{ index: 9, header: 'Rate Plan' }]);
  });
  test('empty when the map has no detectedColumns (pre-feature map)', () => {
    assert.deepEqual(availablePageColumnsFor({ parse: { mode: 'table', hint: { columns: { a: 'td:nth-child(1)' } } } }), []);
  });
  test('dedupes repeated header text', () => {
    const action = { parse: { mode: 'table', hint: { columns: {}, detectedColumns: [
      { index: 4, header: 'Notes' }, { index: 5, header: 'notes' },
    ] } } };
    assert.equal(availablePageColumnsFor(action).length, 1);
  });
});

describe('authorSelectorForIndex', () => {
  test('templates off a clean positional sibling', () => {
    assert.equal(authorSelectorForIndex({ a: 'td:nth-child(2)' }, 9), 'td:nth-child(9)');
  });
  test('falls back to td:nth-child(index) when no positional sibling', () => {
    assert.equal(authorSelectorForIndex({ a: '.some-class' }, 7), 'td:nth-child(7)');
    assert.equal(authorSelectorForIndex({}, 3), 'td:nth-child(3)');
  });
  test('never lets a class/attr leak across columns', () => {
    // a class-anchored sibling is NOT a clean tag:nth-child → fall back to td.
    assert.equal(authorSelectorForIndex({ a: 'td.guest:nth-child(2)' }, 9), 'td:nth-child(9)');
  });
  test('rejects an invalid index', () => {
    assert.equal(authorSelectorForIndex({ a: 'td:nth-child(2)' }, 0), null);
  });
});

describe('customColumnKeyConflict', () => {
  test('rejects a typed contract column name (captured automatically)', () => {
    assert.ok(customColumnKeyConflict('getArrivals', 'rate_per_night_cents')); // optional contract col
    assert.ok(customColumnKeyConflict('getArrivals', 'guest_name'));            // essential
    assert.ok(customColumnKeyConflict('getArrivals', 'arrival_date'));          // contextual
  });
  test('rejects reserved/system names', () => {
    assert.ok(customColumnKeyConflict('getArrivals', 'raw'));
    assert.ok(customColumnKeyConflict('getArrivals', 'property_id'));
  });
  test('allows a genuinely-extra page column', () => {
    assert.equal(customColumnKeyConflict('getArrivals', 'rate_plan'), null);
    assert.equal(customColumnKeyConflict('getArrivals', 'guarantee'), null);
  });
  test('non-core feed has no contract → any non-reserved key is fine', () => {
    assert.equal(customColumnKeyConflict('getRevenueDaily', 'anything'), null);
  });
});

describe('UNDELETABLE_COLUMNS_BY_FEED + FeedView wiring', () => {
  test('core identity + page-context date columns are protected', () => {
    assert.ok(UNDELETABLE_COLUMNS_BY_FEED.getArrivals.has('guest_name'));
    assert.ok(UNDELETABLE_COLUMNS_BY_FEED.getArrivals.has('arrival_date'));
    assert.ok(!UNDELETABLE_COLUMNS_BY_FEED.getArrivals.has('room_number')); // optional → removable
  });
  test('parseKnowledgeCoverage surfaces custom/available/undeletable per feed', () => {
    const parsed = parseKnowledgeCoverage({ actions: {
      getArrivals: { parse: { mode: 'table', hint: {
        rowSelector: 'tbody tr',
        columns: { pms_reservation_id: 'td:nth-child(1)', guest_name: 'td:nth-child(2)' },
        customColumns: { rate_plan: 'td:nth-child(9)' },
        detectedColumns: [{ index: 1, header: 'Conf' }, { index: 5, header: 'City' }],
      } } },
    } });
    const f = parsed.feeds.find((x) => x.actionKey === 'getArrivals')!;
    assert.deepEqual(f.customColumns, { rate_plan: 'td:nth-child(9)' });
    assert.deepEqual(f.availablePageColumns, [{ index: 5, header: 'City' }]); // index 1 captured
    assert.ok(f.undeletableColumns.includes('guest_name'));
  });
});
