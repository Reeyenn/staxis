/**
 * Pre-merge gate: verify every supabase/migrations/*.sql file is registered
 * in production's applied_migrations table.
 *
 * Yesterday's mess: migrations 0124 + 0125 shipped in code but I forgot to
 * `psql -f` them against prod. Smoke test caught it AFTER the push to main;
 * by then Sentry had been blasting for an hour. This script runs on every
 * PR (see .github/workflows/check-migrations-applied.yml) and exits non-zero
 * if any file in supabase/migrations/ has no matching row in
 * applied_migrations. PR can't merge until I (or you) apply the missing
 * file with scripts/apply-migration.ts.
 *
 * Connection: same pattern as scripts/apply-migration.ts — direct pg
 * connection through the Supabase pooler.
 *
 * Required env (from GitHub Actions secrets):
 *   SUPABASE_DB_HOST, SUPABASE_DB_PASSWORD, SUPABASE_PROJECT_REF
 *
 * Exit codes:
 *   0 — every file is applied
 *   1 — one or more files are missing from prod (drift)
 *   2 — connection / setup error (don't block PR on infra hiccups; the
 *       workflow continues-on-error for code 2, hard-fails on 1)
 */

import { Client } from 'pg';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS_DIR = 'supabase/migrations';

async function main() {
  const host = process.env.SUPABASE_DB_HOST;
  const password = process.env.SUPABASE_DB_PASSWORD;
  const projectRef = process.env.SUPABASE_PROJECT_REF;

  if (!host || !password || !projectRef) {
    console.error(
      '✗ Missing SUPABASE_DB_HOST / SUPABASE_DB_PASSWORD / SUPABASE_PROJECT_REF.',
    );
    console.error(
      '  In CI: ensure the workflow exposes these GitHub Actions secrets.',
    );
    process.exit(2);
  }

  let files: string[];
  try {
    files = readdirSync(resolve(MIGRATIONS_DIR))
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();
  } catch (e) {
    console.error(`✗ Cannot read ${MIGRATIONS_DIR}: ${(e as Error).message}`);
    process.exit(2);
  }

  if (files.length === 0) {
    console.error(`✗ No migration files found in ${MIGRATIONS_DIR}.`);
    process.exit(2);
  }

  const expectedVersions = files.map((f) => f.slice(0, 4));

  const pg = new Client({
    host,
    port: 5432,
    database: 'postgres',
    user: `postgres.${projectRef}`,
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  });

  try {
    await pg.connect();
  } catch (e) {
    console.error(`✗ Could not connect to prod DB: ${(e as Error).message}`);
    process.exit(2);
  }

  let applied: Set<string>;
  try {
    const res = await pg.query<{ version: string }>(
      'select version from applied_migrations',
    );
    applied = new Set(res.rows.map((r) => r.version));
  } catch (e) {
    console.error(
      `✗ Reading applied_migrations failed: ${(e as Error).message}`,
    );
    process.exit(2);
  } finally {
    await pg.end();
  }

  const missing = expectedVersions.filter((v) => !applied.has(v));

  if (missing.length === 0) {
    console.log(
      `✓ All ${expectedVersions.length} migrations are applied to prod.`,
    );
    process.exit(0);
  }

  const missingFiles = missing.map((v) =>
    files.find((f) => f.startsWith(v + '_')) ?? `${v}_*.sql`,
  );

  console.error('');
  console.error('✗ MIGRATION DRIFT — these migrations exist in code but NOT in prod:');
  for (const f of missingFiles) {
    console.error(`    supabase/migrations/${f}`);
  }
  console.error('');
  console.error('To unblock this PR, apply each one:');
  for (const f of missingFiles) {
    console.error(
      `    SUPABASE_DB_HOST=… SUPABASE_DB_PASSWORD=… SUPABASE_PROJECT_REF=… \\`,
    );
    console.error(`      npx tsx scripts/apply-migration.ts supabase/migrations/${f}`);
  }
  console.error('');
  console.error(
    'Then push an empty commit (or any commit) to re-run this check.',
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(`✗ Unhandled: ${(e as Error).message}`);
  process.exit(2);
});
