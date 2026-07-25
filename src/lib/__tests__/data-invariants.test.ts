/**
 * Tests for the data-layer doctrine gate (scripts/audit-data-invariants.mjs).
 *
 * The gate itself runs in `npm run lint`. These tests exist because a lint rule
 * that never fires is indistinguishable from one that is broken: they drive the
 * script against a SYNTHETIC schema and assert each rule actually fires, and
 * they pin the legacy-exemption list so it can only shrink.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KNOWN_LEGACY_MONEY_COLUMNS,
  FAMILY_SCOPED_PMS_TABLES,
} from '../../../scripts/audit-data-invariants.mjs';

const SCRIPT = join(process.cwd(), 'scripts', 'audit-data-invariants.mjs');

/** Run the audit against a synthetic migration set. Returns { code, output }. */
function runAudit(migrations: Record<string, string>): { code: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'staxis-dinv-'));
  const docs = join(dir, 'EMPTY.md');
  try {
    for (const [name, sql] of Object.entries(migrations)) writeFileSync(join(dir, name), sql);
    writeFileSync(docs, '# no invariant claims\n');
    try {
      const out = execFileSync('node', [SCRIPT], {
        encoding: 'utf8',
        env: { ...process.env, STAXIS_MIGRATIONS_DIR: dir, STAXIS_INVARIANT_DOCS: docs },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, output: out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BASE = `
create table if not exists public.properties (
  id uuid primary key,
  timezone text
);
`;

describe('audit-data-invariants — the rules actually fire', () => {
  test('a clean new pms_ fact table passes', () => {
    const { code, output } = runAudit({
      '0001_base.sql': BASE,
      '0350_new.sql': `
        create table if not exists public.pms_widget_daily (
          id uuid primary key,
          property_id uuid not null references public.properties(id),
          business_date date not null,
          source_ingest_id uuid not null,
          revenue_cents bigint
        );
      `,
    });
    assert.equal(code, 0, output);
  });

  test('DINV-1 fires on a pms_ table with no property_id', () => {
    const { code, output } = runAudit({
      '0001_base.sql': BASE,
      '0350_new.sql': `
        create table if not exists public.pms_orphan_thing (
          id uuid primary key,
          source_ingest_id uuid not null,
          note text
        );
      `,
    });
    assert.equal(code, 1);
    assert.match(output, /DINV-1[\s\S]*pms_orphan_thing/);
  });

  test('DINV-1 fires on a nullable property_id', () => {
    const { code, output } = runAudit({
      '0001_base.sql': BASE,
      '0350_new.sql': `
        create table if not exists public.pms_loose_thing (
          id uuid primary key,
          property_id uuid references public.properties(id),
          source_ingest_id uuid not null
        );
      `,
    });
    assert.equal(code, 1);
    assert.match(output, /DINV-1[\s\S]*pms_loose_thing[\s\S]*nullable/);
  });

  test('DINV-1 does NOT fire on a single-column primary key (PK implies NOT NULL)', () => {
    const { code, output } = runAudit({
      '0001_base.sql': BASE,
      '0350_new.sql': `
        create table if not exists public.pms_snapshot_thing (
          property_id uuid primary key references public.properties(id),
          source_ingest_id uuid not null,
          captured_at timestamptz
        );
      `,
    });
    assert.equal(code, 0, output);
  });

  test('DINV-3 fires on a post-floor fact table with no lineage column', () => {
    const { code, output } = runAudit({
      '0001_base.sql': BASE,
      '0351_new.sql': `
        create table if not exists public.pms_unsourced_daily (
          id uuid primary key,
          property_id uuid not null references public.properties(id),
          business_date date not null
        );
      `,
    });
    assert.equal(code, 1);
    assert.match(output, /DINV-3[\s\S]*pms_unsourced_daily/);
  });

  test('DINV-3 does NOT fire retroactively on pre-floor tables', () => {
    const { code, output } = runAudit({
      '0001_base.sql': BASE,
      '0202_old.sql': `
        create table if not exists public.pms_legacy_daily (
          id uuid primary key,
          property_id uuid not null references public.properties(id)
        );
      `,
    });
    assert.equal(code, 0, output);
  });

  test('DINV-6 fires on dollars-as-numeric', () => {
    const { code, output } = runAudit({
      '0001_base.sql': BASE,
      '0350_new.sql': `
        create table if not exists public.widget_orders (
          id uuid primary key,
          total_cost numeric(10,2)
        );
      `,
    });
    assert.equal(code, 1);
    assert.match(output, /DINV-6[\s\S]*widget_orders\.total_cost/);
  });

  test('DINV-6 exempts the *_usd suffix (sub-cent AI token telemetry)', () => {
    const { code, output } = runAudit({
      '0001_base.sql': BASE,
      '0350_new.sql': `
        create table if not exists public.widget_costs (
          id uuid primary key,
          cost_usd numeric(12,6)
        );
      `,
    });
    assert.equal(code, 0, output);
  });

  test('DINV-6 fires on a STALE legacy exemption', () => {
    // Runs against the REAL schema (staleness only means something there) with
    // one bogus exemption injected. Proves that fixing a legacy column forces
    // removing its exemption instead of leaving a permanent hole.
    let code = 0;
    let output = '';
    try {
      output = execFileSync('node', [SCRIPT], {
        encoding: 'utf8',
        env: { ...process.env, STAXIS_EXTRA_LEGACY_MONEY: 'fake_table.fake_cost' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      code = e.status ?? 1;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    assert.equal(code, 1, output);
    assert.match(output, /lists fake_table\.fake_cost, which is no longer a money-shaped/);
  });
});

describe('audit-data-invariants — allowlists are pinned', () => {
  test('the legacy money list can only shrink', () => {
    // 14 dollar-as-numeric columns existed when DINV-6 landed (2026-07-24).
    // Raising this number is how the rule dies: a new money column would just
    // be added to the exemption list. Fix the column instead.
    assert.ok(
      KNOWN_LEGACY_MONEY_COLUMNS.size <= 14,
      `KNOWN_LEGACY_MONEY_COLUMNS grew to ${KNOWN_LEGACY_MONEY_COLUMNS.size} (ceiling 14). ` +
      'New money columns must be *_cents (or *_usd for sub-cent telemetry).',
    );
  });

  test('only the four verified non-per-hotel pms_ tables skip tenant scoping', () => {
    // Widening this list must be a deliberate act, which is the point of
    // pinning it. pms_feed_catalog was added 2026-07-25 when the feed-health
    // and data-invariant workstreams merged: it is a GLOBAL catalogue of feed
    // TYPES ('roomStatus', 'arrivals', …) and the table each lands in, not a
    // per-hotel fact. The per-hotel half is pms_feed_expectations, which does
    // carry property_id and is NOT exempt.
    assert.deepEqual(
      [...FAMILY_SCOPED_PMS_TABLES].sort(),
      ['pms_feed_catalog', 'pms_knowledge_files', 'pms_table_schemas', 'pms_writeback_recipes'],
    );
  });
});
