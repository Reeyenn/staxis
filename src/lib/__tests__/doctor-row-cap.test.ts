/**
 * THE HEALTH CHECK THAT STOPS BEING HEALTHY AT ROW 1001.
 *
 * PostgREST on this project caps EVERY response at 1000 rows no matter what
 * `.limit()` asks for. That is not a guess: `src/lib/supabase-paginate.ts` was
 * written for it in July, and it was re-verified against production on
 * 2026-08-07 by asking the live REST endpoint for `limit=5000` on a table with
 * 9,098 rows and getting back exactly 1000.
 *
 * `supabase_migrations_applied` read `applied_migrations` in one shot. That
 * works at 387 migrations and it does not degrade gracefully at 1001: every
 * version past the cap reads as NOT APPLIED, so the check returns `fail`, the
 * doctor returns 503, and `post-deploy-smoke-test.yml` blocks every deploy —
 * on a database where nothing is wrong at all, with no change to blame and a
 * fix message listing six hundred migrations to "apply".
 *
 * The bar for this file is the standing one: would it fail if somebody
 * reverted the paging? The fake client below enforces the same 1000-row cap
 * the real one does, so it does.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { fetchAllRows, SUPABASE_PAGE_SIZE } from '@/lib/supabase-paginate';
import {
  EXPECTED_MIGRATIONS,
  checkAppliedMigrations,
} from '@/app/api/admin/doctor/route';

/**
 * A Supabase stand-in that behaves like the deployment does: it serves
 * `.range(from, to)` honestly, and it will never hand back more than
 * SUPABASE_PAGE_SIZE rows in one response, exactly like PostgREST's max-rows.
 *
 * Deliberately NOT a mock that records calls. The question is not "did it call
 * .range" — it is "does the verdict the founder sees match the database", and
 * only a client that can actually truncate can answer that.
 */
type PageResult<T> = { data: T[] | null; error: unknown };
interface FakeBuilder {
  select(): FakeBuilder;
  order(column: string): FakeBuilder;
  not(): FakeBuilder;
  eq(): FakeBuilder;
  lt(): FakeBuilder;
  limit(): FakeBuilder;
  range(from: number, to: number): FakeBuilder;
  then(resolve: (value: PageResult<Record<string, unknown>>) => unknown): unknown;
}
interface FakeClient { from(table: string): FakeBuilder }

/** The fake, in the shape the doctor's injectable parameter wants. */
function asDoctorClient(client: FakeClient): Parameters<typeof checkAppliedMigrations>[0] {
  return client as unknown as Parameters<typeof checkAppliedMigrations>[0];
}

function cappedClient(rowsByTable: Record<string, Array<Record<string, unknown>>>): FakeClient {
  return {
    from(table: string) {
      let from = 0;
      let to = Number.POSITIVE_INFINITY;
      let sortKey: string | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        // Honoured, because that is the other half of the contract: PostgREST
        // ranges are only stable when the query asks for an order, and a query
        // that does not ask gets rows in whatever order the table stores them.
        order: (column: string) => { sortKey = column; return chain; },
        not: () => chain,
        eq: () => chain,
        lt: () => chain,
        limit: () => chain,
        range: (a: number, b: number) => { from = a; to = b; return chain; },
        then: (resolve: (v: unknown) => unknown) => {
          const stored = rowsByTable[table];
          if (!stored) {
            return resolve({ data: null, error: { message: `relation "${table}" does not exist` } });
          }
          const all = sortKey === null
            ? stored
            : [...stored].sort((x, y) =>
              String(x[sortKey as string]).localeCompare(String(y[sortKey as string])));
          const wanted = Number.isFinite(to) ? to - from + 1 : all.length;
          const page = all.slice(from, from + Math.min(wanted, SUPABASE_PAGE_SIZE));
          return resolve({ data: page, error: null });
        },
      };
      return chain as unknown as FakeBuilder;
    },
  };
}

describe('the paging helper is what the deployment actually needs', () => {
  test('a single response can never exceed the server row cap', async () => {
    const all = Array.from({ length: 2_500 }, (_, i) => ({ id: i }));
    const client = cappedClient({ things: all });
    // One un-paged read is what every uncapped .select() in this codebase gets.
    const oneShot = await new Promise<{ data: unknown[] | null }>((resolve) => {
      (client.from('things') as unknown as { select: () => { then: (r: (v: unknown) => unknown) => unknown } })
        .select().then(resolve as (v: unknown) => unknown);
    });
    assert.equal(
      oneShot.data?.length,
      SUPABASE_PAGE_SIZE,
      'the fake client is not modelling the cap, so nothing below proves anything',
    );
  });

  test('paging returns every row the un-paged read would have dropped', async () => {
    const all = Array.from({ length: 2_500 }, (_, i) => ({ id: i }));
    const client = cappedClient({ things: all });
    const rows = await fetchAllRows<{ id: number }>((from, to) => (
      (client.from('things') as unknown as {
        select: () => { range: (a: number, b: number) => PromiseLike<{ data: { id: number }[] | null; error: unknown }> };
      }).select().range(from, to)
    ));
    assert.equal(rows.length, 2_500);
  });
});

describe('supabase_migrations_applied past the thousandth migration', () => {
  /** A live database that is exactly right: every expected version applied. */
  function perfectlyAppliedRows(): Array<{ version: string }> {
    return EXPECTED_MIGRATIONS.map((version) => ({ version }));
  }

  test('a healthy database with today\'s migration count reads ok', async () => {
    const result = await checkAppliedMigrations(
      asDoctorClient(cappedClient({ applied_migrations: perfectlyAppliedRows() })),
    );
    assert.equal(result.status, 'ok', result.detail);
  });

  test('a healthy database past the row cap still reads ok', async () => {
    // Push the table past 1000 rows. The padding rows are versions the doctor
    // does not expect, which is a `warn` at most (the "unexpected version"
    // branch); what must NOT happen is the REAL ones scrolling off the end of
    // a truncated response and being reported as missing.
    //
    // They are stored FIRST because an un-ordered PostgREST read returns rows
    // in the table's own order, not in version order. That is precisely the
    // risk: which thousand rows survive the cap is not something the caller
    // gets to choose, so a check that reads one page is reading an arbitrary
    // subset and calling it the whole truth.
    const padding = Array.from(
      { length: Math.max(0, 1_400 - EXPECTED_MIGRATIONS.length) },
      (_, i) => ({ version: `9${String(i).padStart(4, '0')}` }),
    );
    const result = await checkAppliedMigrations(
      asDoctorClient(cappedClient({ applied_migrations: [...padding, ...perfectlyAppliedRows()] })),
    );

    assert.notEqual(
      result.status,
      'fail',
      'the doctor reports a perfectly healthy database as broken once the '
      + 'applied_migrations table passes the 1000-row response cap. That is a 503 '
      + 'from /api/admin/doctor and a blocked deploy gate, with no change to blame. '
      + `Got: ${result.detail}`,
    );
    assert.doesNotMatch(
      result.detail,
      /missing from live DB/,
      `every expected migration IS applied here. Detail said: ${result.detail}`,
    );
  });

  test('a genuinely missing migration is still reported', async () => {
    // The check must not have been softened into never failing: drop one.
    const rows = perfectlyAppliedRows().slice(1);
    const result = await checkAppliedMigrations(asDoctorClient(cappedClient({ applied_migrations: rows })));
    assert.equal(result.status, 'fail', 'a missing migration has to stay a hard fail');
    assert.match(result.detail, /missing from live DB/);
  });

  test('an absent table is still the gentle "0015 not applied yet" warning', async () => {
    const result = await checkAppliedMigrations(asDoctorClient(cappedClient({})));
    assert.equal(result.status, 'warn');
    assert.match(result.detail, /applied_migrations table not present/);
  });
});
