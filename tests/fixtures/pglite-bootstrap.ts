/**
 * pglite fixture for RLS integration tests.
 *
 * As of v3-revised, this fixture is a THIN WRAPPER around
 * `pglite-migrate.ts`, which applies the REAL production migrations from
 * `supabase/migrations/` to an in-memory PGlite instance. The hand-rolled
 * 3-table schema from the previous version is gone — what the test sees
 * is what production has.
 *
 * Why: a hand-rolled fixture drifts. A future migration renaming
 * `accounts.property_access` would have left the fixture's local copy
 * still calling the old name, so the test would silently pass against
 * stale schema while production broke. Applying real migrations means
 * any drift surfaces as an integration-test failure.
 *
 * The seed step (insert UID_A/UID_B/UID_ADMIN + property rows) lives
 * here in this fixture because the integration test needs deterministic
 * fixtures regardless of which migrations apply.
 */

import { applyMigrationsToPglite, type MigrationReport } from './pglite-migrate';
import type { PGlite } from '@electric-sql/pglite';

export type PgliteFixture = {
  pg: PGlite;
  migrationReport: MigrationReport;
  /** Run a statement as the service role (bypasses RLS via superuser). */
  runAsService: (sql: string, params?: unknown[]) => Promise<unknown>;
  /** Run a statement as `authenticated` with the given JWT sub claim. */
  runAsUser: (
    userId: string,
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};

/**
 * Build the RLS test fixture: apply real migrations, then grant DML on
 * tenant-scoped tables to `authenticated` so RLS is the gate (Supabase's
 * default permissive grants). Without the grants, writes would fail with
 * "permission denied" which is a different code path from RLS rejection,
 * making the test less representative.
 */
export async function setupRlsFixture(): Promise<PgliteFixture> {
  const { pg, report } = await applyMigrationsToPglite();

  // Grant authenticated DML on the canonical per-property tables we test
  // against. The real migrations don't grant — they assume Supabase's
  // default grants — so we mirror that for the test environment.
  //
  // Tables not in this list still get RLS-tested (cross-tenant SELECT
  // denial) but cross-tenant INSERT/UPDATE/DELETE denial only works if
  // the role has the grant. We grant on all currently-existing public
  // tables for parity.
  await pg.exec(`
    do $$
    declare t record;
    begin
      for t in
        select tablename from pg_tables where schemaname = 'public'
      loop
        execute format('grant select, insert, update, delete on public.%I to authenticated', t.tablename);
      end loop;
    end $$;
  `);

  const runAsService = async (sql: string, params?: unknown[]) => {
    if (params && params.length > 0) {
      return pg.query(sql, params);
    }
    return pg.exec(sql);
  };

  const runAsUser = async (
    userId: string,
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }> => {
    // Wrap in a transaction so SET LOCAL is scoped to this call only.
    await pg.exec('begin');
    try {
      await pg.exec(`set local role authenticated`);
      // Mirror a normal authenticated session that completed MFA. The claims
      // object feeds auth.jwt(); the legacy scalar GUCs continue to feed
      // auth.uid()/auth.role(). Everything is transaction-local, so the
      // anon-like checks outside runAsUser remain unverified.
      await pg.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await pg.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
      await pg.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({
        sub: userId,
        role: 'authenticated',
        mfa_verified: true,
      })]);
      let result: { rows: Record<string, unknown>[] };
      if (params && params.length > 0) {
        result = (await pg.query(sql, params)) as { rows: Record<string, unknown>[] };
      } else {
        const r = await pg.exec(sql);
        // pg.exec returns an array of statement results; take the last one
        // with rows.
        const rows: Record<string, unknown>[] = [];
        for (const s of r) {
          if (s && Array.isArray((s as { rows: unknown[] }).rows)) {
            for (const row of (s as { rows: Record<string, unknown>[] }).rows) {
              rows.push(row);
            }
          }
        }
        result = { rows };
      }
      await pg.exec('commit');
      return result;
    } catch (e) {
      await pg.exec('rollback').catch(() => undefined);
      throw e;
    }
  };

  return { pg, migrationReport: report, runAsService, runAsUser };
}
