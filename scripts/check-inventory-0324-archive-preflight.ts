/**
 * Production gate for migration 0324's archived-inventory evidence rules.
 *
 * Run after applying 0324 and before releasing the matching application code:
 *   npx tsx scripts/check-inventory-0324-archive-preflight.ts
 *
 * Exit codes:
 *   0 — no legacy archived items need intervention
 *   1 — release must stop for verification or stock reconciliation
 *   2 — configuration/connection/query failure
 */

import { Client } from 'pg';

interface PreflightRow {
  blocked_stock_balance: number | string;
  needs_physical_zero_verification: number | string;
  total_affected: number | string;
}

async function main() {
  const host = process.env.SUPABASE_DB_HOST;
  const password = process.env.SUPABASE_DB_PASSWORD;
  const projectRef = process.env.SUPABASE_PROJECT_REF;

  if (!host || !password || !projectRef) {
    console.error('✗ Missing SUPABASE_DB_HOST / SUPABASE_DB_PASSWORD / SUPABASE_PROJECT_REF.');
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
  } catch (error) {
    console.error(`✗ Could not connect to prod DB: ${(error as Error).message}`);
    process.exit(2);
  }

  try {
    const result = await pg.query<PreflightRow>(`
      with affected as (
        select
          i.current_stock <> 0 or coalesce(i.set_aside, 0) <> 0 as has_stock_balance
        from public.inventory i
        where i.archived_at is not null
          and (
            i.current_stock <> 0
            or coalesce(i.set_aside, 0) <> 0
            or (
              public.staxis_inventory_has_stock_evidence(i.property_id, i.id)
              and not exists (
                select 1
                from public.staxis_inventory_archive_zero_evidence(i.property_id, i.id)
              )
            )
          )
      )
      select
        count(*) filter (where has_stock_balance)::int as blocked_stock_balance,
        count(*) filter (where not has_stock_balance)::int as needs_physical_zero_verification,
        count(*)::int as total_affected
      from affected
    `);
    const row = result.rows[0];
    if (!row) throw new Error('Archive preflight returned no aggregate row.');

    const blocked = Number(row.blocked_stock_balance);
    const verify = Number(row.needs_physical_zero_verification);
    const total = Number(row.total_affected);
    if (![blocked, verify, total].every(Number.isSafeInteger)) {
      throw new Error('Archive preflight returned invalid counts.');
    }

    if (total === 0) {
      console.log('✓ Inventory 0324 archive preflight passed: zero affected legacy rows.');
      process.exitCode = 0;
      return;
    }

    console.error('✗ Inventory 0324 archive preflight failed. Do not release the application code.');
    console.error(`  Stock reconciliation required: ${blocked}`);
    console.error(`  Physical zero verification required: ${verify}`);
    console.error('  Follow docs/inventory-0324-deployment-runbook.md, then rerun this gate.');
    process.exitCode = 1;
  } catch (error) {
    console.error(`✗ Inventory 0324 archive preflight query failed: ${(error as Error).message}`);
    process.exitCode = 2;
  } finally {
    await pg.end();
  }
}

void main();
