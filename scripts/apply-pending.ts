/**
 * Apply every supabase/migrations/*.sql file that prod's
 * applied_migrations table hasn't seen yet.
 *
 * Why this exists (Round 18):
 *
 * The migration CI gate (scripts/check-migrations-applied.ts) blocks
 * merges when prod hasn't received a migration that's in code. The
 * companion gap was that operators still had to apply each pending
 * file by hand:
 *     npx tsx scripts/apply-migration.ts supabase/migrations/0127_foo.sql
 *     npx tsx scripts/apply-migration.ts supabase/migrations/0128_bar.sql
 *     ...
 * Tedious + error-prone (skip a file, ordering, etc.). This script
 * computes the diff and applies missing files in version order.
 *
 * Usage:
 *     # Dry run — just list what would be applied:
 *     npx tsx scripts/apply-pending.ts
 *
 *     # Actually apply:
 *     npx tsx scripts/apply-pending.ts --yes
 *
 * Required env (from ~/.config/staxis/tokens.env):
 *     SUPABASE_DB_HOST, SUPABASE_DB_PASSWORD, SUPABASE_PROJECT_REF
 *
 * Each migration runs in its own transaction (`BEGIN; <sql>; COMMIT;`).
 * If one fails, the script aborts BEFORE attempting the next — this
 * mirrors apply-migration.ts and means partial applies stop at a
 * known-good state.
 *
 * Exit codes:
 *   0 — nothing pending OR every pending migration applied
 *   1 — at least one migration failed
 *   2 — connection/setup error
 */

import { Client } from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS_DIR = 'supabase/migrations';

async function main() {
  const apply = process.argv.includes('--yes') || process.argv.includes('-y');

  const host = process.env.SUPABASE_DB_HOST;
  const password = process.env.SUPABASE_DB_PASSWORD;
  const projectRef = process.env.SUPABASE_PROJECT_REF;

  if (!host || !password || !projectRef) {
    console.error(
      '✗ Missing SUPABASE_DB_HOST / SUPABASE_DB_PASSWORD / SUPABASE_PROJECT_REF.',
    );
    console.error(
      '  Source ~/.config/staxis/tokens.env before running this script.',
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
    console.error(`✗ Could not connect: ${(e as Error).message}`);
    process.exit(2);
  }

  let applied: Set<string>;
  try {
    const res = await pg.query<{ version: string }>(
      'select version from applied_migrations',
    );
    applied = new Set(res.rows.map((r) => r.version));
  } catch (e) {
    console.error(`✗ Reading applied_migrations failed: ${(e as Error).message}`);
    await pg.end();
    process.exit(2);
  }

  const pending = files.filter((f) => !applied.has(f.slice(0, 4)));

  if (pending.length === 0) {
    console.log('✓ Nothing pending. All migrations already applied to prod.');
    await pg.end();
    process.exit(0);
  }

  console.log(`Found ${pending.length} pending migration(s):`);
  for (const f of pending) {
    console.log(`  ${f}`);
  }

  if (!apply) {
    console.log('');
    console.log('Dry run — pass `--yes` to apply.');
    await pg.end();
    process.exit(0);
  }

  console.log('');
  console.log('Applying in order…');

  // PostgREST schema cache reload statement — same as the
  // apply-migration.ts pattern, but issued ONCE after all files apply
  // (saves redundant work and matches the "atomic batch" intent).
  let failed = false;
  for (const f of pending) {
    const path = resolve(MIGRATIONS_DIR, f);
    const sql = readFileSync(path, 'utf-8');
    process.stdout.write(`  ${f} … `);
    try {
      await pg.query('BEGIN');
      await pg.query(sql);
      await pg.query('COMMIT');
      console.log('✓');
    } catch (e) {
      await pg.query('ROLLBACK').catch(() => {});
      console.log(`✗ ${(e as Error).message}`);
      failed = true;
      break;
    }
  }

  if (!failed) {
    try {
      await pg.query("NOTIFY pgrst, 'reload schema'");
      console.log('✓ NOTIFY pgrst reload schema — PostgREST cache refreshed.');
    } catch (e) {
      console.warn(`! NOTIFY pgrst failed: ${(e as Error).message}`);
    }
  }

  await pg.end();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`✗ Unhandled: ${(e as Error).message}`);
  process.exit(2);
});
