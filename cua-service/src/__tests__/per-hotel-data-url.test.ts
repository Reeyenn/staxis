/**
 * Tests for feature/cua-per-hotel-data — the DATA-read counterpart to the
 * per-hotel LOGIN fix (per-hotel-login-url.test.ts).
 *
 * Covered offline (no DB / Claude / Playwright):
 *   - rehostFeedUrl: re-host a recorded feed URL onto THIS hotel's tenant
 *     origin. Per-hotel wins; Choice-Advantage / single-host / cross-host /
 *     malformed all fall back to verbatim; {placeholder} tokens survive.
 *   - The 3 newly-wired parser contracts (getDashboardCounts / getRoomLayout /
 *     getHistoricalOccupancy): a raw scraped row flows recipe → recipe-adapter
 *     (attaches the descriptor-driven parsers) → template-runner → validateRows
 *     and PASSES — proving each feed now WRITES rows (it rejected before).
 *   - validateRevenueDaily leniency: occupancy-only rows pass layer-2; present
 *     values are still fully checked; the RevPAR cross-check still fires.
 *
 * Importing session-driver pulls in Playwright + the Supabase client at module
 * load, so ws-polyfill must come first (same constraint as the login test).
 */

// MUST be first — installs the WebSocket shim before any supabase-importing
// module is evaluated (session-driver builds the client at module load).
import './ws-polyfill.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { rehostFeedUrl } from '../session-driver.js';
import { recipeToTableTemplates } from '../recipe-adapter.js';
import { applyTemplateParsers } from '../extractors/template-runner.js';
import { validateRows, type TableSchemaDescriptor } from '../persistence/generic-table-writer.js';
import { TARGET_VALUE_CONTRACTS, parserForLearnedColumn } from '../target-contract.js';
import { validateRevenueDaily } from '../validators-phase2.js';
import '../parsers/generic.js'; // side-effect: register the universal parsers
import type { Recipe } from '../types.js';

const PID = '00000000-0000-0000-0000-000000000001';

// ─── Task 1 — rehostFeedUrl (the per-hotel data-read helper) ─────────────────

describe('rehostFeedUrl — swap the LEARNED tenant origin for the per-hotel one', () => {
  const FAMILY = 'https://hotel-learned.opera-cloud.com/login';
  const PER_HOTEL = 'https://hotel-a.opera-cloud.com/signin';

  test('re-hosts a feed URL on the learned origin to the per-hotel origin', () => {
    assert.equal(
      rehostFeedUrl('https://hotel-learned.opera-cloud.com/reports/arrivals', FAMILY, PER_HOTEL),
      'https://hotel-a.opera-cloud.com/reports/arrivals',
    );
  });

  test('preserves the full path, query and hash exactly', () => {
    assert.equal(
      rehostFeedUrl('https://hotel-learned.opera-cloud.com/r/x?from=1&to=2#frag', FAMILY, PER_HOTEL),
      'https://hotel-a.opera-cloud.com/r/x?from=1&to=2#frag',
    );
  });

  test('preserves {today}/{date}/{placeholder} tokens verbatim (no percent-encoding)', () => {
    // A `new URL().toString()` round-trip would turn {today} into %7Btoday%7D and
    // break the stale-date guard / detail substitution.
    assert.equal(
      rehostFeedUrl('https://hotel-learned.opera-cloud.com/api/occ?date={today}', FAMILY, PER_HOTEL),
      'https://hotel-a.opera-cloud.com/api/occ?date={today}',
    );
    assert.equal(
      rehostFeedUrl('https://hotel-learned.opera-cloud.com/Res/view?id={pms_reservation_id}', FAMILY, PER_HOTEL),
      'https://hotel-a.opera-cloud.com/Res/view?id={pms_reservation_id}',
    );
  });

  test('no per-hotel URL (Choice Advantage) → returned byte-for-byte (family fallback)', () => {
    const feed = 'https://hotel-learned.opera-cloud.com/reports/arrivals';
    assert.equal(rehostFeedUrl(feed, FAMILY, null), feed);
    assert.equal(rehostFeedUrl(feed, FAMILY, undefined), feed);
    assert.equal(rehostFeedUrl(feed, FAMILY, ''), feed);
    assert.equal(rehostFeedUrl(feed, FAMILY, '   '), feed);
  });

  test('per-hotel origin == learned origin (single-host PMS / mapper tenant) → no-op', () => {
    // Choice Advantage: every hotel shares one host; tenancy is by login/session.
    const caFamily = 'https://www.choiceadvantage.com/cas/login';
    const caPerHotel = 'https://www.choiceadvantage.com/cas/login?ihc=ABC123';
    const caFeed = 'https://www.choiceadvantage.com/cas/Welcome.init?report=arrivals';
    assert.equal(rehostFeedUrl(caFeed, caFamily, caPerHotel), caFeed);
    // The mapper tenant itself (per-hotel URL == family startUrl).
    const feed = 'https://hotel-learned.opera-cloud.com/x';
    assert.equal(rehostFeedUrl(feed, FAMILY, FAMILY), feed);
  });

  test('feed on a DIFFERENT host (SSO / shared report server) → left exactly as learned', () => {
    const sso = 'https://idp.okta.com/app/launch';
    assert.equal(rehostFeedUrl(sso, FAMILY, PER_HOTEL), sso);
    const sharedReports = 'https://reports.opera-cloud.com/shared/occ';
    assert.equal(rehostFeedUrl(sharedReports, FAMILY, PER_HOTEL), sharedReports);
  });

  test('normalizes a schemeless per-hotel URL before swapping (data-entry input)', () => {
    assert.equal(
      rehostFeedUrl('https://hotel-learned.opera-cloud.com/r/x', FAMILY, 'hotel-a.opera-cloud.com/signin'),
      'https://hotel-a.opera-cloud.com/r/x',
    );
  });

  test('keeps a non-default port from the per-hotel origin', () => {
    assert.equal(
      rehostFeedUrl('https://hotel-learned.opera-cloud.com/r', FAMILY, 'https://hotel-a.opera-cloud.com:8443/login'),
      'https://hotel-a.opera-cloud.com:8443/r',
    );
  });

  test('boundary-safe: a look-alike suffix host is NOT treated as the learned origin', () => {
    // `https://hotel-learned.opera-cloud.com.evil.com/...` must not prefix-match
    // `https://hotel-learned.opera-cloud.com`.
    const evil = 'https://hotel-learned.opera-cloud.com.evil.com/steal';
    assert.equal(rehostFeedUrl(evil, FAMILY, PER_HOTEL), evil);
  });

  test('host comparison is case-insensitive; output uses the per-hotel origin casing', () => {
    assert.equal(
      rehostFeedUrl('https://HOTEL-LEARNED.OPERA-CLOUD.COM/r/x', FAMILY, PER_HOTEL),
      'https://hotel-a.opera-cloud.com/r/x',
    );
  });

  test('malformed / relative / non-http feed URL → returned unchanged (never throws)', () => {
    assert.doesNotThrow(() => rehostFeedUrl('not a url', FAMILY, PER_HOTEL));
    assert.equal(rehostFeedUrl('not a url', FAMILY, PER_HOTEL), 'not a url');
    assert.equal(rehostFeedUrl('/reports/arrivals', FAMILY, PER_HOTEL), '/reports/arrivals');
    assert.equal(rehostFeedUrl('javascript:alert(1)', FAMILY, PER_HOTEL), 'javascript:alert(1)');
    assert.equal(rehostFeedUrl('', FAMILY, PER_HOTEL), '');
  });

  test('blank family startUrl (no learned origin) → unchanged', () => {
    assert.equal(rehostFeedUrl('https://x.example.com/y', '', PER_HOTEL), 'https://x.example.com/y');
  });

  test('two hotels on the same family resolve a feed to DIFFERENT origins', () => {
    const feed = 'https://hotel-learned.mews.com/reports/dash';
    const family = 'https://hotel-learned.mews.com/login';
    const a = rehostFeedUrl(feed, family, 'https://hotel-a.mews.com/login');
    const b = rehostFeedUrl(feed, family, 'https://hotel-b.mews.com/login');
    assert.equal(a, 'https://hotel-a.mews.com/reports/dash');
    assert.equal(b, 'https://hotel-b.mews.com/reports/dash');
    assert.notEqual(a, b);
  });

  test('rewritten feed host == per-hotel login host (drives allowedHost consistently)', () => {
    // allowedHost is derived from the per-hotel login URL; after re-hosting, the
    // feed host matches it, so safeGoto's same-site guard is correct (not skewed).
    const rewritten = rehostFeedUrl('https://hotel-learned.opera-cloud.com/r', FAMILY, PER_HOTEL);
    assert.equal(new URL(rewritten).host, new URL(PER_HOTEL).host);
  });
});

// ─── Task 1 — applied to a real adapter-built template (the wiring contract) ──

describe('rehostFeedUrl applied to recipeToTableTemplates output (source.url + rowDetail)', () => {
  test('a built feed template re-hosts its source URL to the per-hotel origin', () => {
    const family = 'https://learned.opera-cloud.com/login';
    const perHotel = 'https://hotel-a.opera-cloud.com/login';
    const recipe: Recipe = {
      schema: 1,
      login: { startUrl: family, steps: [{ kind: 'click', selector: 'b' }], successSelectors: ['.d'] },
      actions: {
        getRoomLayout: {
          steps: [{ kind: 'goto', url: 'https://learned.opera-cloud.com/rooms' }],
          parse: { mode: 'table', hint: { rowSelector: 'tr', columns: { room_number: 'td.n', max_occupancy: 'td.m' } } },
        },
      },
    };
    const tmpl = recipeToTableTemplates(recipe).templates.find((t) => t.tableName === 'pms_rooms_inventory');
    assert.ok(tmpl);
    assert.equal(tmpl!.sources[0]!.url, 'https://learned.opera-cloud.com/rooms', 'adapter records the LEARNED url');
    // Simulate what session-driver.rehostFeedUrlsForHotel does to source.url.
    tmpl!.sources[0]!.url = rehostFeedUrl(tmpl!.sources[0]!.url, family, perHotel);
    assert.equal(tmpl!.sources[0]!.url, 'https://hotel-a.opera-cloud.com/rooms');
  });
});

// ─── Task 2 — descriptor fixtures verbatim from migration 0207 ───────────────

const IN_HOUSE_DESCRIPTOR: TableSchemaDescriptor = {
  table_name: 'pms_in_house_snapshot',
  write_strategy: 'upsert',
  snapshot_scope_default: 'full',
  natural_key: ['property_id'],
  reconcile_key_field: null,
  columns: [
    { name: 'total_guests_in_house', type: 'integer', required: false, nullable: true, range_min: 0 },
    { name: 'total_occupied_rooms', type: 'integer', required: true, nullable: false, range_min: 0 },
    { name: 'total_vacant_clean', type: 'integer', required: false, nullable: true, range_min: 0 },
    { name: 'arrivals_remaining_today', type: 'integer', required: true, nullable: false, range_min: 0 },
    { name: 'departures_remaining_today', type: 'integer', required: true, nullable: false, range_min: 0 },
    { name: 'captured_at', type: 'timestamptz', required: true, nullable: false },
  ],
};

const ROOMS_INVENTORY_DESCRIPTOR: TableSchemaDescriptor = {
  table_name: 'pms_rooms_inventory',
  write_strategy: 'upsert',
  snapshot_scope_default: 'full',
  natural_key: ['property_id', 'room_number'],
  reconcile_key_field: null,
  columns: [
    { name: 'room_number', type: 'text', required: true, nullable: false },
    { name: 'room_type', type: 'text', required: false, nullable: true },
    { name: 'bed_config', type: 'text', required: false, nullable: true },
    { name: 'max_occupancy', type: 'integer', required: false, nullable: true, range_min: 0, range_max: 20 },
    { name: 'floor', type: 'text', required: false, nullable: true },
  ],
};

const REVENUE_DESCRIPTOR: TableSchemaDescriptor = {
  table_name: 'pms_revenue_daily',
  write_strategy: 'upsert',
  snapshot_scope_default: 'full',
  natural_key: ['property_id', 'date'],
  reconcile_key_field: null,
  columns: [
    { name: 'date', type: 'date', required: true, nullable: false },
    { name: 'rooms_revenue_cents', type: 'bigint', required: true, nullable: false, range_min: 0 },
    { name: 'fnb_revenue_cents', type: 'bigint', required: false, nullable: true, range_min: 0 },
    { name: 'tax_cents', type: 'bigint', required: false, nullable: true, range_min: 0 },
    { name: 'occupied_rooms', type: 'integer', required: true, nullable: false, range_min: 0 },
    { name: 'occupancy_pct', type: 'numeric', required: true, nullable: false, range_min: 0, range_max: 100 },
    { name: 'adr_cents', type: 'bigint', required: true, nullable: false, range_min: 0 },
    { name: 'revpar_cents', type: 'bigint', required: true, nullable: false, range_min: 0 },
  ],
};

/** Build a 1-action table recipe so recipe-adapter wires that target's parsers. */
function recipeFor(actionKey: keyof Recipe['actions'], columns: Record<string, string>): Recipe {
  const actions = {} as Recipe['actions'];
  actions[actionKey] = {
    steps: [{ kind: 'goto', url: 'https://pms.example.com/x' }],
    parse: { mode: 'table', hint: { rowSelector: 'tr', columns } },
  };
  return {
    schema: 1,
    login: { startUrl: 'https://pms.example.com/login', steps: [{ kind: 'click', selector: 'b' }], successSelectors: ['.d'] },
    actions,
  };
}

function pipelineRow(
  actionKey: keyof Recipe['actions'],
  table: string,
  columns: Record<string, string>,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const tmpl = recipeToTableTemplates(recipeFor(actionKey, columns)).templates.find((t) => t.tableName === table);
  assert.ok(tmpl, `expected a ${table} template`);
  return applyTemplateParsers(raw, tmpl!, 'list_row');
}

describe('Task 2 — the 3 feeds now extract-and-WRITE (raw DOM strings → parsers → validateRows PASS)', () => {
  test('getDashboardCounts: string counts normalize → pms_in_house_snapshot row PASSES', () => {
    const cols = {
      total_guests_in_house: 's.g', total_occupied_rooms: 's.occ', total_vacant_clean: 's.vc',
      arrivals_remaining_today: 's.arr', departures_remaining_today: 's.dep',
    };
    const raw = { 's.g': '60', 's.occ': '42', 's.vc': '10', 's.arr': '5', 's.dep': '3' };
    const row = pipelineRow('getDashboardCounts', 'pms_in_house_snapshot', cols, raw);
    assert.equal(row.total_occupied_rooms, 42);            // generic_integer "42" → 42 (was a rejecting string)
    assert.equal(row.arrivals_remaining_today, 5);
    // captured_at is writer-stamped (required timestamptz) — mirror that here.
    const v = validateRows([{ ...row, property_id: PID, captured_at: '2026-06-10T12:00:00.000Z' }], IN_HOUSE_DESCRIPTOR);
    assert.equal(v.rejected.length, 0, JSON.stringify(v.rejected));
    assert.equal(v.valid.length, 1);
  });

  test('getRoomLayout: string max_occupancy normalizes → pms_rooms_inventory row PASSES', () => {
    const cols = { room_number: 's.rn', room_type: 's.rt', bed_config: 's.bc', max_occupancy: 's.mo', floor: 's.fl' };
    const raw = { 's.rn': '204', 's.rt': 'King', 's.bc': '1 King', 's.mo': '2', 's.fl': '2' };
    const row = pipelineRow('getRoomLayout', 'pms_rooms_inventory', cols, raw);
    assert.equal(row.max_occupancy, 2);                    // generic_integer "2" → 2
    const v = validateRows([{ ...row, property_id: PID }], ROOMS_INVENTORY_DESCRIPTOR);
    assert.equal(v.rejected.length, 0, JSON.stringify(v.rejected));
    assert.equal(v.valid.length, 1);
  });

  test('getHistoricalOccupancy: currency/percent strings normalize → pms_revenue_daily row PASSES', () => {
    const cols = {
      date: 's.d', rooms_revenue_cents: 's.rev', fnb_revenue_cents: 's.fnb', tax_cents: 's.tax',
      occupied_rooms: 's.occ', occupancy_pct: 's.pct', adr_cents: 's.adr', revpar_cents: 's.rp',
    };
    const raw = {
      's.d': '2026-06-10', 's.rev': '$12,345.00', 's.fnb': '$500.00', 's.tax': '$50.00',
      's.occ': '42', 's.pct': '75.5%', 's.adr': '$120.00', 's.rp': '$90.60',
    };
    const row = pipelineRow('getHistoricalOccupancy', 'pms_revenue_daily', cols, raw);
    assert.equal(row.rooms_revenue_cents, 1234500);        // generic_currency $-string → cents
    assert.equal(row.adr_cents, 12000);
    assert.equal(row.revpar_cents, 9060);
    assert.equal(row.occupancy_pct, 75.5);                 // generic_number "75.5%" → 75.5
    const stamped = { ...row, property_id: PID };
    const v = validateRows([stamped], REVENUE_DESCRIPTOR);
    assert.equal(v.rejected.length, 0, JSON.stringify(v.rejected));
    assert.equal(v.valid.length, 1);
    // And it survives the layer-2 validator (full row: RevPAR ≈ ADR × occ/100).
    assert.deepEqual(validateRevenueDaily(stamped), { ok: true });
  });

  test('contrast: the SAME revenue row WITHOUT the parser contract rejects on type', () => {
    // Prove the contract is load-bearing: feed validateRows the raw strings.
    const v = validateRows([{
      property_id: PID, date: '2026-06-10', rooms_revenue_cents: '$12,345.00',
      occupied_rooms: '42', occupancy_pct: '75.5%', adr_cents: '$120.00', revpar_cents: '$90.60',
    }], REVENUE_DESCRIPTOR);
    assert.equal(v.valid.length, 0);
  });
});

describe('Task 2 — parserForLearnedColumn resolves for the 3 newly-wired feeds', () => {
  test('getDashboardCounts integer columns → generic_integer; getRoomLayout text → undefined', () => {
    assert.equal(parserForLearnedColumn('getDashboardCounts', 'total_occupied_rooms'), 'generic_integer');
    assert.equal(parserForLearnedColumn('getDashboardCounts', 'arrivals_remaining_today'), 'generic_integer');
    assert.equal(parserForLearnedColumn('getRoomLayout', 'max_occupancy'), 'generic_integer');
    assert.equal(parserForLearnedColumn('getRoomLayout', 'room_number'), undefined); // text
    assert.equal(parserForLearnedColumn('getRoomLayout', 'room_type'), undefined);
  });

  test('getHistoricalOccupancy date/currency/numeric columns map to the right generic parsers', () => {
    assert.equal(parserForLearnedColumn('getHistoricalOccupancy', 'date'), 'generic_date');
    assert.equal(parserForLearnedColumn('getHistoricalOccupancy', 'rooms_revenue_cents'), 'generic_currency');
    assert.equal(parserForLearnedColumn('getHistoricalOccupancy', 'adr_cents'), 'generic_currency');
    assert.equal(parserForLearnedColumn('getHistoricalOccupancy', 'occupied_rooms'), 'generic_integer');
    assert.equal(parserForLearnedColumn('getHistoricalOccupancy', 'occupancy_pct'), 'generic_number');
  });

  test('the 3 feeds are present with the table names that match recipe-adapter routes', () => {
    assert.equal(TARGET_VALUE_CONTRACTS.getDashboardCounts?.table, 'pms_in_house_snapshot');
    assert.equal(TARGET_VALUE_CONTRACTS.getRoomLayout?.table, 'pms_rooms_inventory');
    assert.equal(TARGET_VALUE_CONTRACTS.getHistoricalOccupancy?.table, 'pms_revenue_daily');
  });
});

// ─── Task 3 — validateRevenueDaily leniency ──────────────────────────────────

describe('Task 3 — validateRevenueDaily: present-only metric checks', () => {
  test('an occupancy-only row (no revenue/ADR/RevPAR) PASSES layer-2', () => {
    assert.deepEqual(
      validateRevenueDaily({ date: '2026-06-10', occupied_rooms: 40, occupancy_pct: 80 }),
      { ok: true },
    );
  });

  test('null metrics (the writer\'s "not extracted" sentinel) are treated as absent', () => {
    assert.deepEqual(
      validateRevenueDaily({
        date: '2026-06-10', occupied_rooms: 40, occupancy_pct: 80,
        rooms_revenue_cents: null, adr_cents: null, revpar_cents: null,
      }),
      { ok: true },
    );
  });

  test('a full, self-consistent revenue row still PASSES', () => {
    assert.deepEqual(
      validateRevenueDaily({
        date: '2026-06-10', occupied_rooms: 42, occupancy_pct: 75.5,
        rooms_revenue_cents: 1234500, adr_cents: 12000, revpar_cents: 9060,
      }),
      { ok: true },
    );
  });

  test('a PRESENT but invalid metric still rejects (leniency ≠ skipping the check)', () => {
    assert.equal(validateRevenueDaily({ date: '2026-06-10', occupied_rooms: 40, occupancy_pct: 80, adr_cents: -5 }).ok, false);
    assert.equal(validateRevenueDaily({ date: '2026-06-10', occupied_rooms: 40, occupancy_pct: 150 }).ok, false); // pct > 100
    assert.equal(validateRevenueDaily({ date: '2026-06-10', occupied_rooms: 40, rooms_revenue_cents: 1.5 }).ok, false);
  });

  test('the RevPAR cross-check still fires when ADR + occ + RevPAR are all present', () => {
    const bad = validateRevenueDaily({
      date: '2026-06-10', occupied_rooms: 42, occupancy_pct: 75.5,
      adr_cents: 12000, revpar_cents: 1, // wildly off vs ADR×occ
    });
    assert.equal(bad.ok, false);
    assert.match((bad as { reason: string }).reason, /RevPAR mismatch/);
  });

  test('still requires date and occupied_rooms (nothing else loosened)', () => {
    assert.equal(validateRevenueDaily({ occupied_rooms: 40, occupancy_pct: 80 }).ok, false);        // no date
    assert.equal(validateRevenueDaily({ date: '2026-06-10', occupancy_pct: 80 }).ok, false);        // no occupied_rooms
  });
});
