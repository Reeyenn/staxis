/**
 * UNIVERSALITY TEST (feat/pms-universal-translate).
 *
 * Proves the headline claim: a BRAND-NEW PMS the system has never seen — with a
 * DIFFERENT date format (DD.MM.YYYY) AND a DIFFERENT status vocabulary (German
 * words) AND European money formatting — normalizes correctly through the REAL
 * runtime pipeline using ONLY the generic parsers + a self-learned mapping. No
 * PMS-X-specific code anywhere. No ca_* parser is touched for PMS X.
 *
 * "PMS X":
 *   - dates  : "13.06.2026"  (day.month.year, dot separator)
 *   - status : Belegt / Frei-Sauber / Frei-Schmutzig / Ausser-Betrieb
 *   - money  : "1.234,56 €"  (European grouping: . thousands, , decimal)
 */

// MUST be first: install the WebSocket shim before any supabase-importing
// module is evaluated (ESM evaluates imports in source order). generic-table-
// writer builds the Supabase client at module load (Node 20 has no native WS).
import './ws-polyfill.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { inferDateFormat, sanitizeEnumMapping } from '../value-learning.js';
import { recipeToTableTemplates } from '../recipe-adapter.js';
import { applyTemplateParsers } from '../extractors/template-runner.js';
import { validateRows, type TableSchemaDescriptor } from '../persistence/generic-table-writer.js';
import { getParser } from '../parsers/registry.js';
import '../parsers/generic.js'; // the UNIVERSAL parsers under test
import type { Recipe } from '../types.js';

const PID = '00000000-0000-0000-0000-000000000099';

// Canonical room-status set (our schema's allowed_values; identical for every PMS).
const ROOM_STATUS_CANON = ['occupied', 'vacant_clean', 'vacant_dirty', 'inspected', 'out_of_order', 'unknown'];

// Descriptors verbatim from migrations 0207 / 0276 (the writer reads these).
const ROOM_STATUS_DESCRIPTOR: TableSchemaDescriptor = {
  table_name: 'pms_room_status_log',
  write_strategy: 'append',
  snapshot_scope_default: 'full',
  natural_key: ['property_id', 'room_number', 'changed_at'],
  reconcile_key_field: null,
  columns: [
    { name: 'room_number', type: 'text', required: true, nullable: false },
    { name: 'status', type: 'text', required: true, nullable: false, allowed_values: ROOM_STATUS_CANON },
    { name: 'changed_at', type: 'timestamptz', required: true, nullable: false },
    { name: 'changed_by', type: 'text', required: false, nullable: true },
  ],
};

const FUTURE_BOOKINGS_DESCRIPTOR: TableSchemaDescriptor = {
  table_name: 'pms_future_bookings',
  write_strategy: 'upsert',
  snapshot_scope_default: 'delta',
  natural_key: ['property_id', 'pms_reservation_id'],
  reconcile_key_field: null,
  columns: [
    { name: 'pms_reservation_id', type: 'text', required: true, nullable: false },
    { name: 'guest_name', type: 'text', required: false, nullable: true },
    { name: 'arrival_date', type: 'date', required: true, nullable: false },
    { name: 'departure_date', type: 'date', required: false, nullable: true },
    { name: 'rate_per_night_cents', type: 'bigint', required: false, nullable: true },
    { name: 'total_amount_cents', type: 'bigint', required: false, nullable: true },
    { name: 'captured_at', type: 'timestamptz', required: true, nullable: false },
  ],
};

// ─── 1. Date-format learning (the M/D-vs-D/M crux) ───────────────────────────

describe('PMS X — date format is LEARNED, not guessed', () => {
  test('inferDateFormat resolves DD.MM.YYYY → DMY (a >12 day disambiguates)', () => {
    const fmt = inferDateFormat(['13.06.2026', '02.11.2026', '25.12.2026']);
    assert.equal(fmt?.order, 'DMY');
    assert.equal(fmt?.separator, '.');
    assert.equal(fmt?.confidence, 'high');
  });

  test('all-ambiguous samples ABSTAIN (low confidence) — never a silent coin-flip', () => {
    const amb = inferDateFormat(['06.07.2026', '08.09.2026']); // every token ≤ 12
    assert.equal(amb?.confidence, 'low');
  });

  test('generic_date with the learned DMY format parses PMS X dates correctly', () => {
    const gd = getParser('generic_date')!;
    const fmt = inferDateFormat(['13.06.2026', '02.11.2026', '25.12.2026'])!;
    assert.equal(gd('13.06.2026', { dateFormat: fmt }), '2026-06-13');
    assert.equal(gd('02.11.2026', { dateFormat: fmt }), '2026-11-02');
    assert.equal(gd('25.12.2026', { dateFormat: fmt }), '2026-12-25');
    // calendar-invalid → null (NEVER a fake ISO string that explodes at Postgres)
    assert.equal(gd('32.01.2026', { dateFormat: fmt }), null);
  });

  test('learning PREVENTS silent corruption of an ambiguous date', () => {
    const gd = getParser('generic_date')!;
    const fmt = inferDateFormat(['13.06.2026', '02.11.2026'])!; // → DMY high
    // Without the learned order, "06.07.2026" is ambiguous; the heuristic assumes
    // US M/D → June 7 (WRONG for PMS X).
    assert.equal(gd('06.07.2026'), '2026-06-07');
    // With the learned DMY order, the SAME string is correctly July 6.
    assert.equal(gd('06.07.2026', { dateFormat: fmt }), '2026-07-06');
  });
});

// ─── 2. Enum vocabulary learning (German status words) ───────────────────────

describe('PMS X — status vocabulary is SELF-LEARNED', () => {
  const modelEmitted = {
    'Belegt': 'occupied',
    'Frei-Sauber': 'vacant_clean',
    'Frei-Schmutzig': 'vacant_dirty',
    'Ausser-Betrieb': 'out_of_order',
    'Gesperrt': 'blocked_made_up', // model hallucination — NOT a canonical value
  };

  test('sanitizeEnumMapping keeps only real canonical targets (drops hallucinations)', () => {
    const clean = sanitizeEnumMapping(modelEmitted, ROOM_STATUS_CANON);
    assert.equal(clean['Belegt'], 'occupied');
    assert.equal(clean['Frei-Schmutzig'], 'vacant_dirty');
    assert.equal(clean['Gesperrt'], undefined); // dropped — not in canonical set
  });

  test('generic_enum translates learned values; unseen → safe default + no throw', () => {
    const clean = sanitizeEnumMapping(modelEmitted, ROOM_STATUS_CANON);
    const ge = getParser('generic_enum')!;
    assert.equal(ge('Belegt', { mapping: clean, onUnknown: 'unknown' }), 'occupied');
    assert.equal(ge('Ausser-Betrieb', { mapping: clean, onUnknown: 'unknown' }), 'out_of_order');
    // case/space-insensitive lookup
    assert.equal(ge('  belegt ', { mapping: clean, onUnknown: 'unknown' }), 'occupied');
    // an unrecognized value never crashes the batch — it maps to the safe default
    assert.equal(ge('Sperrung', { mapping: clean, onUnknown: 'unknown' }), 'unknown');
    assert.equal(ge('Sperrung', { mapping: clean }), null); // default onUnknown = null
  });
});

// ─── 3. Money formatting (locale-agnostic) ───────────────────────────────────

describe('PMS X — money normalizes from any locale to integer cents', () => {
  test('generic_currency handles European AND US grouping', () => {
    const gc = getParser('generic_currency')!;
    assert.equal(gc('1.234,56 €'), 123456); // European: . thousands, , decimal
    assert.equal(gc('$1,234.56'), 123456);  // US: , thousands, . decimal
    assert.equal(gc('2.500,00'), 250000);
    assert.equal(gc('€89,90'), 8990);
    assert.equal(gc('--'), null);           // sentinel
  });
});

// ─── 4. END-TO-END through the REAL pipeline — no PMS-X code, no ca_* ─────────

describe('PMS X — full pipeline: recipe → templates → parse → validateRows', () => {
  // What the mapper would have SAVED in PMS X's knowledge file after learning.
  const learned = {
    valueTranslations: { 'pms_room_status_log.status': sanitizeEnumMapping(
      { 'Belegt': 'occupied', 'Frei-Sauber': 'vacant_clean', 'Frei-Schmutzig': 'vacant_dirty', 'Ausser-Betrieb': 'out_of_order' },
      ROOM_STATUS_CANON,
    ) },
    dateFormat: inferDateFormat(['13.06.2026', '02.11.2026', '25.12.2026'])!,
  };

  test('room-status feed: German words + the learned mapping → canonical, validates', () => {
    const recipe: Recipe = {
      schema: 1,
      login: { startUrl: 'https://pmsx.example/login', steps: [], successSelectors: ['#home'] },
      actions: {
        getRoomStatus: {
          steps: [{ kind: 'goto', url: 'https://pmsx.example/rooms' }],
          parse: { mode: 'table', hint: { rowSelector: 'tr.room', columns: { room_number: 'td.no', status: 'td.st' } } },
        },
      },
    };
    const { templates } = recipeToTableTemplates(recipe, learned);
    const tmpl = templates.find((t) => t.tableName === 'pms_room_status_log')!;
    assert.ok(tmpl, 'room-status template built');
    // The status field is wired to the GENERIC enum parser carrying the LEARNED
    // German→canonical mapping — NOT the ca_status fallback.
    assert.equal(tmpl.fields.status!.parser, 'generic_enum');
    assert.equal(tmpl.fields.status!.parserConfig?.mapping?.['Belegt'], 'occupied');

    const rawRows = [
      { 'td.no': '101', 'td.st': 'Belegt' },
      { 'td.no': '102', 'td.st': 'Frei-Schmutzig' },
      { 'td.no': '103', 'td.st': 'Ausser-Betrieb' },
    ];
    const parsed = rawRows.map((r) => applyTemplateParsers(r, tmpl, 'list_row'));
    assert.equal(parsed[0]!.status, 'occupied');
    assert.equal(parsed[1]!.status, 'vacant_dirty');
    assert.equal(parsed[2]!.status, 'out_of_order');

    const stamped = parsed.map((p) => ({ ...p, property_id: PID, changed_at: new Date('2026-06-13T12:00:00Z').toISOString() }));
    const v = validateRows(stamped, ROOM_STATUS_DESCRIPTOR);
    assert.equal(v.valid.length, 3, `all 3 PMS-X rows valid; rejected: ${JSON.stringify(v.rejected)}`);
    assert.equal(v.rejected.length, 0);
  });

  test('future-bookings feed: DD.MM.YYYY dates + European money → ISO + cents, validates', () => {
    const recipe: Recipe = {
      schema: 1,
      login: { startUrl: 'https://pmsx.example/login', steps: [], successSelectors: ['#home'] },
      actions: {
        getFutureBookings: {
          steps: [{ kind: 'goto', url: 'https://pmsx.example/reservations' }],
          parse: { mode: 'table', hint: { rowSelector: 'tr.res', columns: {
            pms_reservation_id: 'td.id', arrival_date: 'td.arr', rate_per_night_cents: 'td.rate',
          } } },
        },
      },
    };
    const { templates } = recipeToTableTemplates(recipe, learned);
    const tmpl = templates.find((t) => t.tableName === 'pms_future_bookings')!;
    assert.ok(tmpl, 'future-bookings template built');
    assert.equal(tmpl.fields.arrival_date!.parser, 'generic_date');
    assert.equal(tmpl.fields.arrival_date!.parserConfig?.dateFormat?.order, 'DMY');
    assert.equal(tmpl.fields.rate_per_night_cents!.parser, 'generic_currency');

    const rawRows = [
      { 'td.id': 'R-900', 'td.arr': '13.06.2026', 'td.rate': '1.234,56 €' },
      { 'td.id': 'R-901', 'td.arr': '02.11.2026', 'td.rate': '89,90 €' },
    ];
    const parsed = rawRows.map((r) => applyTemplateParsers(r, tmpl, 'list_row'));
    assert.equal(parsed[0]!.arrival_date, '2026-06-13');
    assert.equal(parsed[0]!.rate_per_night_cents, 123456);
    assert.equal(parsed[1]!.arrival_date, '2026-11-02');
    assert.equal(parsed[1]!.rate_per_night_cents, 8990);

    const stamped = parsed.map((p) => ({ ...p, property_id: PID, captured_at: new Date().toISOString() }));
    const v = validateRows(stamped, FUTURE_BOOKINGS_DESCRIPTOR);
    assert.equal(v.valid.length, 2, `all PMS-X booking rows valid; rejected: ${JSON.stringify(v.rejected)}`);
    assert.equal(v.rejected.length, 0);
  });

  test('NO ca_* parser is referenced anywhere in PMS X — translation is fully generic', () => {
    const recipe: Recipe = {
      schema: 1,
      login: { startUrl: 'https://pmsx.example/login', steps: [], successSelectors: ['#home'] },
      actions: {
        getRoomStatus: {
          steps: [{ kind: 'goto', url: 'https://pmsx.example/rooms' }],
          parse: { mode: 'table', hint: { rowSelector: 'tr', columns: { room_number: 'a', status: 'b' } } },
        },
        getFutureBookings: {
          steps: [{ kind: 'goto', url: 'https://pmsx.example/res' }],
          parse: { mode: 'table', hint: { rowSelector: 'tr', columns: { pms_reservation_id: 'a', arrival_date: 'b', rate_per_night_cents: 'c' } } },
        },
      },
    };
    const { templates } = recipeToTableTemplates(recipe, learned);
    const allParsers = templates.flatMap((t) => Object.values(t.fields).map((f) => f.parser).filter(Boolean));
    assert.ok(allParsers.length > 0, 'sanity: some parsers were wired');
    for (const p of allParsers) {
      assert.ok(!String(p).startsWith('ca_'), `PMS X wired a Choice-Advantage parser (${p}) — translation is not universal`);
    }
  });
});
