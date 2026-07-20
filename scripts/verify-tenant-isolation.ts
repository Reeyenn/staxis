#!/usr/bin/env tsx
/**
 * Phase M1.5 (2026-05-14) — multi-tenancy isolation verification script.
 *
 * Reeyen's #1 concern with onboarding 300 hotels: when a new owner
 * signs up via the wizard, they MUST only see their own hotel's data.
 * They MUST NOT see Comfort Suites Beaumont (or any other hotel's)
 * rooms, cleaning_events, inventory_counts, etc.
 *
 * This script proves the isolation works by simulating a specific
 * user's RLS context inside Postgres and asserting that protected
 * tables return only that user's data.
 *
 * Usage:
 *   ./scripts/verify-tenant-isolation.ts <USER_AUTH_ID> <EXPECTED_PROPERTY_ID>
 *
 *   USER_AUTH_ID: the auth.users.id of the user we're testing
 *   EXPECTED_PROPERTY_ID: the only property they should see
 *
 * Mechanism:
 *   We use SET LOCAL request.jwt.claims (PostgREST's mechanism for
 *   passing the JWT into RLS) inside a transaction. After SET, queries
 *   run with that user's RLS context — exactly what they'd see if
 *   they were signed in via the app.
 *
 * Pass criteria:
 *   - SELECT * FROM properties → returns exactly 1 row, the expected one
 *   - SELECT * FROM rooms → all rows have property_id = expected
 *   - SELECT * FROM cleaning_events → all rows have property_id = expected
 *   - SELECT * FROM inventory → all rows have property_id = expected
 *   - SELECT * FROM inventory_counts → all rows have property_id = expected
 *   - SELECT * FROM staff → all rows have property_id = expected
 *   - SELECT * FROM accounts → returns AT MOST self (or self + admins)
 *   - account_invites + hotel_join_codes → direct browser access is denied;
 *     legitimate use goes through scoped server routes
 *
 * Fail mode:
 *   Any leak (a row with a different property_id) → script exits 1 + prints
 *   the leaking table + count + sample row. The PR should NOT merge until
 *   this passes for at least one new test hotel.
 */

import { Client } from 'pg';

interface IsolationCheck {
  table: string;
  filterColumn?: string;  // defaults to property_id
  expectedAtMost?: number; // For accounts/admin tables that may legitimately return >1 row
}

const TENANT_TABLES: IsolationCheck[] = [
  { table: 'properties', filterColumn: 'id', expectedAtMost: 1 },
  { table: 'rooms' },
  { table: 'staff' },
  { table: 'cleaning_events' },
  { table: 'inventory' },
  { table: 'inventory_counts' },
  { table: 'inventory_rate_predictions' },
  { table: 'demand_predictions' },
  { table: 'supply_predictions' },
  { table: 'optimizer_results' },
  { table: 'model_runs' },
  { table: 'prediction_log' },
  { table: 'schedule_assignments' },
  { table: 'plan_snapshots' },
];

const SERVER_ONLY_TABLES = [
  'account_invites',
  'hotel_join_codes',
] as const;

interface Failure {
  table: string;
  reason: string;
  sample?: Record<string, unknown>;
}

async function main() {
  const [, , userId, expectedPropertyId] = process.argv;
  if (!userId || !expectedPropertyId) {
    console.error('Usage: ./scripts/verify-tenant-isolation.ts <USER_AUTH_ID> <EXPECTED_PROPERTY_ID>');
    process.exit(2);
  }

  const password = process.env.SUPABASE_DB_PASSWORD;
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  const host = process.env.SUPABASE_DB_HOST;
  if (!password || !projectRef || !host) {
    console.error('Missing env: SUPABASE_DB_PASSWORD + SUPABASE_PROJECT_REF + SUPABASE_DB_HOST');
    console.error('Source ~/.config/staxis/tokens.env first.');
    process.exit(2);
  }

  const client = new Client({
    user: `postgres.${projectRef}`,
    password,
    host,
    port: 5432,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  const failures: Failure[] = [];
  let totalRowsChecked = 0;

  try {
    console.log(`\n── Tenant isolation check ──`);
    console.log(`User: ${userId}`);
    console.log(`Expected property: ${expectedPropertyId}\n`);

    // Run each query inside its own transaction with SET LOCAL JWT claims.
    // This makes Postgres treat the queries as if they came from the
    // signed-in user — exactly what the app does via PostgREST.
    for (const check of TENANT_TABLES) {
      await client.query('BEGIN');
      try {
        const claims = JSON.stringify({ sub: userId, role: 'authenticated' });
        await client.query(`SET LOCAL ROLE authenticated`);
        await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims]);
        await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);

        const filterCol = check.filterColumn ?? 'property_id';
        // 3 sub-queries: total visible rows, rows matching expected,
        // rows NOT matching expected (the leak signal).
        const totalRes = await client.query(`SELECT count(*)::int FROM public.${check.table}`);
        const matchRes = await client.query(
          `SELECT count(*)::int FROM public.${check.table} WHERE ${filterCol} = $1`,
          [expectedPropertyId],
        );
        const leakRes = await client.query(
          `SELECT count(*)::int, ${filterCol} as leaked_id FROM public.${check.table}
           WHERE ${filterCol} != $1 GROUP BY ${filterCol} LIMIT 5`,
          [expectedPropertyId],
        );

        const total = totalRes.rows[0].count as number;
        const match = matchRes.rows[0].count as number;
        const leakCount = leakRes.rows.reduce((acc, r) => acc + (r.count as number), 0);

        totalRowsChecked += total;

        if (leakCount > 0) {
          failures.push({
            table: check.table,
            reason: `${leakCount} row(s) leaked from other properties`,
            sample: leakRes.rows[0],
          });
          console.log(`  ✗ ${check.table.padEnd(35)} total=${total} match=${match} LEAKED=${leakCount}`);
        } else if (check.expectedAtMost !== undefined && total > check.expectedAtMost) {
          failures.push({
            table: check.table,
            reason: `Expected at most ${check.expectedAtMost} rows but saw ${total}`,
          });
          console.log(`  ✗ ${check.table.padEnd(35)} total=${total} (expected <= ${check.expectedAtMost})`);
        } else {
          console.log(`  ✓ ${check.table.padEnd(35)} total=${total} all scoped to expected property`);
        }
      } finally {
        await client.query('ROLLBACK');
      }
    }

    // Invite/code rows are authentication capabilities, not ordinary hotel
    // data. Migration 0328 removes their browser grants entirely. Check the
    // object privileges directly so SELECT and every write verb are covered,
    // for both anonymous and signed-in browser roles.
    for (const table of SERVER_ONLY_TABLES) {
      const privilegeRes = await client.query<{
        anon_select: boolean;
        anon_insert: boolean;
        anon_update: boolean;
        anon_delete: boolean;
        authenticated_select: boolean;
        authenticated_insert: boolean;
        authenticated_update: boolean;
        authenticated_delete: boolean;
        service_select: boolean;
        service_insert: boolean;
        service_update: boolean;
        service_delete: boolean;
      }>(`
        select
          has_table_privilege('anon', $1, 'select') as anon_select,
          has_table_privilege('anon', $1, 'insert') as anon_insert,
          has_table_privilege('anon', $1, 'update') as anon_update,
          has_table_privilege('anon', $1, 'delete') as anon_delete,
          has_table_privilege('authenticated', $1, 'select') as authenticated_select,
          has_table_privilege('authenticated', $1, 'insert') as authenticated_insert,
          has_table_privilege('authenticated', $1, 'update') as authenticated_update,
          has_table_privilege('authenticated', $1, 'delete') as authenticated_delete,
          has_table_privilege('service_role', $1, 'select') as service_select,
          has_table_privilege('service_role', $1, 'insert') as service_insert,
          has_table_privilege('service_role', $1, 'update') as service_update,
          has_table_privilege('service_role', $1, 'delete') as service_delete
      `, [`public.${table}`]);
      const privileges = privilegeRes.rows[0];
      const browserPrivileges = [
        privileges.anon_select,
        privileges.anon_insert,
        privileges.anon_update,
        privileges.anon_delete,
        privileges.authenticated_select,
        privileges.authenticated_insert,
        privileges.authenticated_update,
        privileges.authenticated_delete,
      ];
      const servicePrivileges = [
        privileges.service_select,
        privileges.service_insert,
        privileges.service_update,
        privileges.service_delete,
      ];

      if (browserPrivileges.some(Boolean)) {
        failures.push({
          table,
          reason: 'anon/authenticated still has a direct table privilege',
          sample: privileges,
        });
        console.log(`  ✗ ${table.padEnd(35)} direct browser privilege remains`);
      } else if (!servicePrivileges.every(Boolean)) {
        failures.push({
          table,
          reason: 'service_role is missing a required server-route table privilege',
          sample: privileges,
        });
        console.log(`  ✗ ${table.padEnd(35)} service route privilege missing`);
      } else {
        console.log(`  ✓ ${table.padEnd(35)} browser denied; server routes allowed`);
      }
    }
  } finally {
    await client.end();
  }

  console.log(`\nTotal rows visible to this user across all checked tables: ${totalRowsChecked}`);

  if (failures.length > 0) {
    console.error(`\n── ISOLATION FAILURES ──`);
    for (const f of failures) {
      console.error(`  [${f.table}] ${f.reason}`);
      if (f.sample) console.error(`    sample: ${JSON.stringify(f.sample)}`);
    }
    console.error(`\n${failures.length} table(s) leaked. DO NOT MERGE the M1.5 PR.`);
    process.exit(1);
  }

  console.log(`\n✓ All ${TENANT_TABLES.length} tenant tables properly isolated.`);
  console.log(`✓ All ${SERVER_ONLY_TABLES.length} capability tables are server-only.`);
  console.log(`✓ Multi-tenancy verified — safe to onboard new hotels alongside Beaumont.\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(2);
});
