/**
 * golden-fixtures.ts — regression gate (feature/cua-self-heal-reach).
 *
 * Proves the gate BLOCKS a real recipe regression yet ALLOWS a legitimately
 * changed feed (different data, fewer rows, an empty day) — the distinction the
 * whole feature turns on. Also proves the loader is absent ⟹ skip (no-op = today)
 * and that a committed fixture round-trips from the __tests__/fixtures dir into
 * the gate (the "wire fixtures into npm test" requirement).
 */

import './ws-polyfill.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  gateAgainstFixture,
  buildGoldenFixture,
  deriveColumnShape,
  registerGoldenFixture,
  loadGoldenFixture,
  clearGoldenFixtures,
  KNOWN_GOLDEN_FIXTURES,
  type GoldenFixture,
  type FreshExtractionShape,
} from '../golden-fixtures.js';

// npm test runs from the cua-service/ root, so resolve fixtures from cwd
// (avoids import.meta, which the CommonJS lint target rejects).
const FIXTURES_DIR = join(process.cwd(), 'src', '__tests__', 'fixtures');

function fixture(over: Partial<GoldenFixture> = {}): GoldenFixture {
  return {
    pmsFamily: 'fam', actionKey: 'getArrivals', capturedAt: '2026-06-14T00:00:00Z',
    parseMode: 'table',
    columns: ['arrival_date', 'guest_name', 'pms_reservation_id'],
    columnVerdicts: { pms_reservation_id: 'certified', guest_name: 'certified', arrival_date: 'certified' },
    rowCount: 12, ...over,
  };
}
function fresh(over: Partial<FreshExtractionShape> = {}): FreshExtractionShape {
  return {
    parseMode: 'table',
    columns: ['arrival_date', 'guest_name', 'pms_reservation_id'],
    columnVerdicts: { pms_reservation_id: 'certified', guest_name: 'certified', arrival_date: 'certified' },
    hasValueEvidence: true, rowCount: 9, ...over,
  };
}

describe('gateAgainstFixture — regressed vs changed', () => {
  test('clean (same shape, different rows) → allow', () => {
    const v = gateAgainstFixture({ fixture: fixture(), fresh: fresh({ rowCount: 40 }) });
    assert.equal(v.regressed, false);
  });

  test('a previously-CERTIFIED column DROPPED → REGRESSED (block)', () => {
    const v = gateAgainstFixture({
      fixture: fixture(),
      fresh: fresh({ columns: ['guest_name', 'pms_reservation_id'], columnVerdicts: { guest_name: 'certified', pms_reservation_id: 'certified' } }),
    });
    assert.equal(v.regressed, true);
    if (v.regressed) assert.ok(v.columns.some((c) => c.includes('arrival_date')));
  });

  test('certified → FAILED with value evidence → REGRESSED (block)', () => {
    const v = gateAgainstFixture({
      fixture: fixture(),
      fresh: fresh({ columnVerdicts: { pms_reservation_id: 'certified', guest_name: 'certified', arrival_date: 'failed' } }),
    });
    assert.equal(v.regressed, true);
  });

  test('certified → failed but NO value evidence (empty day) → ALLOW (cannot prove regression)', () => {
    const v = gateAgainstFixture({
      fixture: fixture(),
      fresh: fresh({ hasValueEvidence: false, rowCount: 0, columnVerdicts: { pms_reservation_id: 'failed', guest_name: 'failed', arrival_date: 'failed' } }),
    });
    assert.equal(v.regressed, false);
  });

  test('certified → uncertain (with evidence) → ALLOW (abstain; the promotion gate handles unproven)', () => {
    const v = gateAgainstFixture({
      fixture: fixture(),
      fresh: fresh({ columnVerdicts: { pms_reservation_id: 'certified', guest_name: 'certified', arrival_date: 'uncertain' } }),
    });
    assert.equal(v.regressed, false);
  });

  test('a column the fixture never certified is not guarded (no false block)', () => {
    const fx = fixture({ columnVerdicts: { pms_reservation_id: 'certified', guest_name: 'certified', arrival_date: 'uncertain' } });
    const v = gateAgainstFixture({ fixture: fx, fresh: fresh({ columnVerdicts: { pms_reservation_id: 'certified', guest_name: 'certified', arrival_date: 'failed' } }) });
    assert.equal(v.regressed, false); // arrival_date wasn't certified in the fixture
  });
});

describe('deriveColumnShape (privacy-safe)', () => {
  test('classifies coarse types, never echoes raw values', () => {
    assert.equal(deriveColumnShape(['2026-06-15', '2026-06-16']), 'date');
    assert.equal(deriveColumnShape(['06/15/2026', '06/16/2026']), 'date');
    assert.equal(deriveColumnShape(['1', '2', '3']), 'int');
    assert.equal(deriveColumnShape(['1.5', '2.0']), 'numeric');
    assert.equal(deriveColumnShape(['yes', 'no', 'yes']), 'boolean');
    assert.equal(deriveColumnShape([]), 'blank');
    assert.match(deriveColumnShape(['clean', 'dirty', 'clean', 'dirty']), /^enum:/);
    assert.equal(deriveColumnShape(['Smith, John', 'Doe, Jane', 'Lee, Sam', 'Park, Ann', 'Cruz, Bo']), 'text');
  });
});

describe('buildGoldenFixture (privacy)', () => {
  test('snapshots derived structure only — NO raw values', () => {
    const fx = buildGoldenFixture({
      pmsFamily: 'fam', actionKey: 'getArrivals', capturedAt: '2026-06-15T00:00:00Z', parseMode: 'table',
      columns: ['guest_name', 'pms_reservation_id'],
      columnVerdicts: { guest_name: 'certified', pms_reservation_id: 'certified' },
      allValues: { guest_name: ['Smith, John', 'Doe, Jane', 'Lee, Sam'], pms_reservation_id: ['R1', 'R2', 'R3'] },
      rowCount: 3,
    });
    const serialized = JSON.stringify(fx);
    assert.ok(!serialized.includes('Smith'), 'raw guest names must never be stored in a fixture');
    assert.deepEqual(fx.columns, ['guest_name', 'pms_reservation_id']); // sorted
    assert.equal(fx.columnShapes!.guest_name, 'text');
  });
});

describe('registry — absent ⟹ skip', () => {
  test('loadGoldenFixture returns null when none registered (gate is a no-op)', () => {
    clearGoldenFixtures();
    assert.equal(loadGoldenFixture('fam', 'getArrivals'), null);
  });
  test('register + load round-trips; clear empties it', () => {
    clearGoldenFixtures();
    registerGoldenFixture(fixture());
    assert.ok(loadGoldenFixture('fam', 'getArrivals'));
    clearGoldenFixtures();
    assert.equal(loadGoldenFixture('fam', 'getArrivals'), null);
  });
  test('KNOWN_GOLDEN_FIXTURES is EMPTY by default → gate inert in prod (no rollout re-park)', () => {
    assert.equal(KNOWN_GOLDEN_FIXTURES.length, 0);
  });
});

describe('committed fixture wired into npm test', () => {
  test('a JSON golden fixture from __tests__/fixtures loads + gates', () => {
    const raw = readFileSync(join(FIXTURES_DIR, 'choice_advantage.getArrivals.golden.json'), 'utf8');
    const fx = JSON.parse(raw) as GoldenFixture;
    registerGoldenFixture(fx);
    const loaded = loadGoldenFixture('choice_advantage', 'getArrivals');
    assert.ok(loaded);
    // A re-learn that dropped the arrival_date column regresses against it.
    const v = gateAgainstFixture({
      fixture: loaded!,
      fresh: { parseMode: 'table', columns: ['departure_date', 'guest_name', 'pms_reservation_id'], columnVerdicts: { departure_date: 'certified', guest_name: 'certified', pms_reservation_id: 'certified' }, hasValueEvidence: true, rowCount: 15 },
    });
    assert.equal(v.regressed, true);
    clearGoldenFixtures();
  });
});
