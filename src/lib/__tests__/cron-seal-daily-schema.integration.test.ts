/**
 * PROOF, against a real Postgres, that the nightly seal only reads columns that
 * exist.
 *
 * WHY THIS TEST EXISTS
 * `/api/cron/seal-daily` read `properties.config` for its cleaning minutes.
 * That column has never existed — not in any migration, not in production.
 * Migration 0016, which the code seemed to be written against, added
 * `timezone` / `dashboard_stale_minutes` / `scraper_window_*` and no `config`.
 * PostgREST answers a bad column with `42703 column properties.config does not
 * exist`, and the call site destructured `{ data }` without ever looking at
 * `error`, so `data` came back null, the `?? {}` fallback swallowed it, and
 * every hotel's sealed `recommended_staff` was computed from hard-coded
 * defaults instead of the times its manager set. Silently. Into ML training
 * labels. `src/lib/db/plan-snapshots.ts` carried the identical bug.
 *
 * That is the sixth instance of the same class in this codebase. So this test
 * does not check one column — it reads EVERY `.select()` out of the route's
 * source and asserts each named column against the real migrated schema. A
 * seventh phantom column in this file cannot reach production green.
 *
 * WHY IT PARSES THE SOURCE INSTEAD OF EXERCISING THE HANDLER
 * The repo's standing rule is to test behaviour, not source text, and this is
 * the carve-out it names: a no-runtime invariant. The assertion target is not
 * another string — it is `information_schema.columns` on a database built from
 * the real migrations. Running the handler would not catch it either: the whole
 * failure mode is that a bad column produces a *successful-looking* response, so
 * a green handler run is exactly what the bug looks like.
 *
 * The companion guard — that every `.select()` in the file takes a string
 * literal — is what stops the check being escaped by hiding a column list
 * behind a constant.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';

const ROUTE = join(__dirname, '..', '..', 'app', 'api', 'cron', 'seal-daily', 'route.ts');

/** `.from('x')` followed by `.select('a, b')`, across line breaks. */
const FROM_SELECT = /\.from\(\s*'([a-z_]+)'\s*\)\s*\.select\(\s*'([^']*)'\s*[,)]/g;
/** `.select(` whose first argument starts with an identifier character — i.e. a
 *  constant or variable rather than a quoted column list. Deliberately does NOT
 *  match a bare `.select()`, which is how the prose above refers to the call. */
const NON_LITERAL_SELECT = /\.select\(\s*[A-Za-z_$]/g;

type Read = { table: string; columns: string[] };

function selectsInRoute(source: string): Read[] {
  const reads: Read[] = [];
  for (const m of source.matchAll(FROM_SELECT)) {
    const columns = m[2]
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    reads.push({ table: m[1], columns });
  }
  return reads;
}

let pg: PGlite;
let source: string;
/** table -> the columns that table really has, per the migrated schema. */
const schema = new Map<string, Set<string>>();

describe('seal-daily reads no column that does not exist', () => {
  before(async () => {
    source = readFileSync(ROUTE, 'utf8');
    ({ pg } = await applyMigrationsToPglite());
    const { rows } = await pg.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public'`,
    );
    for (const r of rows) {
      if (!schema.has(r.table_name)) schema.set(r.table_name, new Set());
      schema.get(r.table_name)!.add(r.column_name);
    }
  });

  after(async () => {
    // The WASM backend exits the process with status 100 if it is still open
    // when the event loop drains, which turns a green run red.
    await pg?.close();
  });

  test('the parser actually finds the route\'s reads', () => {
    const reads = selectsInRoute(source);
    // A regex that quietly matches nothing would make every assertion below
    // vacuously true — the failure mode this whole file exists to prevent.
    assert.ok(
      reads.length >= 7,
      `expected to find the seal's table reads, found ${reads.length}`,
    );
    const tables = new Set(reads.map((r) => r.table));
    for (const required of ['properties', 'daily_logs', 'cleaning_events', 'pms_in_house_snapshot']) {
      assert.ok(tables.has(required), `expected a read of ${required}, found ${[...tables].join(', ')}`);
    }
  });

  test('every column the seal selects exists in the migrated schema', () => {
    const missing: string[] = [];
    const unverifiable: string[] = [];

    for (const { table, columns } of selectsInRoute(source)) {
      const real = schema.get(table);
      if (!real) {
        // The migration fixture is best-effort by design (Class C migrations are
        // skipped). A table it could not build is not evidence of a bug — but a
        // table it DID build with a column missing absolutely is.
        unverifiable.push(table);
        continue;
      }
      for (const column of columns) {
        if (!real.has(column)) missing.push(`${table}.${column}`);
      }
    }

    if (unverifiable.length > 0) {
      console.log(`  (not in the pglite schema, unverified: ${[...new Set(unverifiable)].join(', ')})`);
    }
    assert.deepEqual(
      missing,
      [],
      `seal-daily selects ${missing.length} column(s) that do not exist: ${missing.join(', ')}`,
    );
  });

  test('properties.config — the column that was never there — is still not there', () => {
    // Pins the specific fact, so that if somebody ever adds a `config` column
    // this test tells them to come read why the old code was wrong rather than
    // going quietly green.
    const properties = schema.get('properties');
    assert.ok(properties, 'the properties table must exist in the migrated schema');
    assert.equal(
      properties.has('config'),
      false,
      'properties.config now exists — revisit the seal-daily / plan-snapshots fixes before trusting it',
    );
    // And the real columns the fix reads instead are all present.
    for (const column of [
      'checkout_minutes', 'stayover_day1_minutes', 'stayover_day2_minutes', 'shift_minutes',
    ]) {
      assert.ok(properties.has(column), `properties.${column} must exist — the seal reads it`);
    }
  });

  test('no select in the route hides its columns behind a constant', () => {
    const escapes = [...source.matchAll(NON_LITERAL_SELECT)];
    assert.equal(
      escapes.length,
      0,
      'every .select() in seal-daily must take a string literal, or the column check above can be walked around',
    );
  });
});
