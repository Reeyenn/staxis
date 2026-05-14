/**
 * Apply a single Supabase migration file via a direct pg connection.
 *
 * Usage:
 *   tsx scripts/apply-migration.ts supabase/migrations/0116_voice_surface.sql
 *
 * Needs (loaded from ~/.config/staxis/tokens.env):
 *   SUPABASE_DB_HOST, SUPABASE_DB_PASSWORD, SUPABASE_PROJECT_REF
 *
 * Runs the file as a single transaction. Idempotent migrations (use IF NOT
 * EXISTS / IF EXISTS) can be re-run safely; non-idempotent ones will fail
 * cleanly with the original error.
 */

import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: tsx scripts/apply-migration.ts <path-to-sql-file>');
    process.exit(1);
  }

  const sql = readFileSync(resolve(filePath), 'utf-8');
  const host = process.env.SUPABASE_DB_HOST ?? 'aws-1-us-east-1.pooler.supabase.com';
  const password = process.env.SUPABASE_DB_PASSWORD;
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  if (!password || !projectRef) {
    console.error('SUPABASE_DB_PASSWORD + SUPABASE_PROJECT_REF required (~/.config/staxis/tokens.env).');
    process.exit(1);
  }

  const pg = new Client({
    host,
    port: 5432,
    database: 'postgres',
    user: `postgres.${projectRef}`,
    password,
    ssl: { rejectUnauthorized: false },
  });

  await pg.connect();
  try {
    await pg.query('BEGIN');
    await pg.query(sql);
    await pg.query('COMMIT');
    console.log(`✓ Applied ${filePath}`);
  } catch (e) {
    await pg.query('ROLLBACK').catch(() => {});
    console.error(`✗ Failed to apply ${filePath}`);
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await pg.end();
  }
}

void main();
