import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import {
  applyMigrationsToPglite,
  type MigrationReport,
} from '../../../tests/fixtures/pglite-migrate';

type BrowserRole = 'anon' | 'authenticated';
type CapabilityTable = 'account_invites' | 'hotel_join_codes';

async function runAsRole(pg: PGlite, role: BrowserRole | 'service_role', sql: string): Promise<void> {
  await pg.exec('begin');
  try {
    await pg.exec(`set local role ${role}`);
    await pg.exec(sql);
    await pg.exec('commit');
  } catch (error) {
    await pg.exec('rollback').catch(() => undefined);
    throw error;
  }
}

describe('invite capability storage — real migration integration', () => {
  let pg: PGlite;
  let report: MigrationReport;

  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    report = migrated.report;
  });

  after(async () => {
    await pg.close().catch(() => undefined);
  });

  test('migration 0328 applies and leaves only explicit browser-deny policies', async () => {
    assert.ok(
      report.applied.includes('0328_invite_storage_service_role_only.sql'),
      `0328 failed to apply: ${JSON.stringify(
        report.failedAtRuntime.filter((entry) => entry.file.startsWith('0328')),
      )}`,
    );

    const tables = await pg.query<{
      table_name: CapabilityTable;
      rls_enabled: boolean;
      policy_names: string[];
    }>(`
      select
        c.relname::text as table_name,
        c.relrowsecurity as rls_enabled,
        coalesce(array_agg(p.policyname order by p.policyname)
          filter (where p.policyname is not null), '{}'::text[]) as policy_names
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      left join pg_catalog.pg_policies p
        on p.schemaname = n.nspname and p.tablename = c.relname
      where n.nspname = 'public'
        and c.relname in ('account_invites', 'hotel_join_codes')
      group by c.relname, c.relrowsecurity
      order by c.relname
    `);

    assert.deepEqual(tables.rows, [
      {
        table_name: 'account_invites',
        rls_enabled: true,
        policy_names: ['account_invites_deny_browser'],
      },
      {
        table_name: 'hotel_join_codes',
        rls_enabled: true,
        policy_names: ['hotel_join_codes_deny_browser'],
      },
    ]);
  });

  test('anon and authenticated have no direct read or write privileges', async () => {
    const privileges = ['select', 'insert', 'update', 'delete'] as const;
    for (const role of ['anon', 'authenticated'] as const) {
      for (const table of ['account_invites', 'hotel_join_codes'] as const) {
        for (const privilege of privileges) {
          const result = await pg.query<{ allowed: boolean }>(
            `select has_table_privilege($1, $2, $3) as allowed`,
            [role, `public.${table}`, privilege],
          );
          assert.equal(
            result.rows[0].allowed,
            false,
            `${role} must not have ${privilege} on ${table}`,
          );
        }
      }
    }
  });

  test('direct browser SQL is rejected for every DML verb', async () => {
    const probes: Record<CapabilityTable, string[]> = {
      account_invites: [
        'select * from public.account_invites limit 1',
        'insert into public.account_invites default values',
        'update public.account_invites set accepted_at = accepted_at where false',
        'delete from public.account_invites where false',
      ],
      hotel_join_codes: [
        'select * from public.hotel_join_codes limit 1',
        'insert into public.hotel_join_codes default values',
        'update public.hotel_join_codes set revoked_at = revoked_at where false',
        'delete from public.hotel_join_codes where false',
      ],
    };

    for (const role of ['anon', 'authenticated'] as const) {
      for (const [table, statements] of Object.entries(probes)) {
        for (const sql of statements) {
          await assert.rejects(
            runAsRole(pg, role, sql),
            /permission denied/i,
            `${role} direct access must fail for ${table}: ${sql}`,
          );
        }
      }
    }
  });

  test('service_role keeps the DML required by the server routes', async () => {
    for (const table of ['account_invites', 'hotel_join_codes'] as const) {
      for (const privilege of ['select', 'insert', 'update', 'delete'] as const) {
        const result = await pg.query<{ allowed: boolean }>(
          `select has_table_privilege('service_role', $1, $2) as allowed`,
          [`public.${table}`, privilege],
        );
        assert.equal(
          result.rows[0].allowed,
          true,
          `service_role needs ${privilege} on ${table}`,
        );
      }
      await runAsRole(pg, 'service_role', `select * from public.${table} limit 1`);
    }
  });

  test('is safe to re-run without restoring or duplicating browser policies', async () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '0328_invite_storage_service_role_only.sql'),
      'utf8',
    );
    await pg.exec(sql);

    const policies = await pg.query<{ tablename: string; policyname: string }>(`
      select tablename, policyname
      from pg_catalog.pg_policies
      where schemaname = 'public'
        and tablename in ('account_invites', 'hotel_join_codes')
      order by tablename, policyname
    `);
    assert.deepEqual(policies.rows, [
      { tablename: 'account_invites', policyname: 'account_invites_deny_browser' },
      { tablename: 'hotel_join_codes', policyname: 'hotel_join_codes_deny_browser' },
    ]);
  });

  test('0329 atomically rejects a stale hotel-team removal snapshot', async () => {
    assert.ok(
      report.applied.includes('0329_guard_hotel_team_detach_snapshot.sql'),
      `0329 failed to apply: ${JSON.stringify(
        report.failedAtRuntime.filter((entry) => entry.file.startsWith('0329')),
      )}`,
    );

    const authId = '91000000-0000-0000-0000-000000000001';
    const hotelId = '92000000-0000-0000-0000-000000000001';
    const accountId = '93000000-0000-0000-0000-000000000001';
    await pg.query(
      `insert into auth.users (id, email) values ($1, 'team-cas@example.test')`,
      [authId],
    );
    await pg.query(
      `insert into public.properties (id, owner_id, name, total_rooms) values ($1, $2, 'CAS Hotel', 1)`,
      [hotelId, authId],
    );
    await pg.query(
      `insert into public.accounts (
         id, username, password_hash, display_name, role, property_access, data_user_id
       ) values ($1, 'team-cas-user', 'not-used', 'CAS User', 'housekeeping', array[$2]::uuid[], $3)`,
      [accountId, hotelId, authId],
    );

    const snapshot = await pg.query<{ updated_at: string }>(
      'select updated_at::text from public.accounts where id = $1',
      [accountId],
    );
    const success = await pg.query<{ result: { status: string; remaining_hotels: number } }>(
      `select public.staxis_remove_property_access_guarded($1, $2, $3, $4::timestamptz) as result`,
      [accountId, hotelId, 'housekeeping', snapshot.rows[0].updated_at],
    );
    assert.deepEqual(success.rows[0].result, { status: 'ok', remaining_hotels: 0 });

    const detachedSnapshot = await pg.query<{ updated_at: string }>(
      'select updated_at::text from public.accounts where id = $1',
      [accountId],
    );
    const alreadyDetached = await pg.query<{ result: { status: string } }>(
      `select public.staxis_remove_property_access_guarded($1, $2, $3, $4::timestamptz) as result`,
      [accountId, hotelId, 'housekeeping', detachedSnapshot.rows[0].updated_at],
    );
    assert.deepEqual(alreadyDetached.rows[0].result, { status: 'not_attached' });

    await pg.query(
      'update public.accounts set property_access = array[$2]::uuid[] where id = $1',
      [accountId, hotelId],
    );
    const conflict = await pg.query<{ result: { status: string } }>(
      `select public.staxis_remove_property_access_guarded($1, $2, $3, $4::timestamptz) as result`,
      [accountId, hotelId, 'housekeeping', '2000-01-01T00:00:00Z'],
    );
    assert.deepEqual(conflict.rows[0].result, { status: 'conflict' });

    const access = await pg.query<{ property_access: string[] }>(
      'select property_access from public.accounts where id = $1',
      [accountId],
    );
    assert.deepEqual(access.rows[0].property_access, [hotelId]);
  });

  test('0329 guarded removal is callable only by the server role', async () => {
    const signature = 'public.staxis_remove_property_access_guarded(uuid,uuid,text,timestamp with time zone)';
    const privileges = await pg.query<{ browser_allowed: boolean; server_allowed: boolean }>(
      `select
         has_function_privilege('authenticated', $1, 'execute') as browser_allowed,
         has_function_privilege('service_role', $1, 'execute') as server_allowed`,
      [signature],
    );
    assert.equal(privileges.rows[0].browser_allowed, false);
    assert.equal(privileges.rows[0].server_allowed, true);
  });
});
