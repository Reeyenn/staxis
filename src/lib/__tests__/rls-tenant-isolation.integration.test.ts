/**
 * Real-Postgres tenant-isolation integration test.
 *
 * This is the headline test of the supabase-rls audit. Every other test in
 * the suite checks SHAPE — that policies exist, that routes import the
 * right client, that lint patterns are satisfied. This test checks
 * BEHAVIOR — it spins up a real Postgres (via @electric-sql/pglite), seeds
 * two tenants, switches the connection to act as each user via the
 * `authenticated` role, and asserts that:
 *
 *   1. User A cannot SELECT any of property B's rooms.
 *   2. User A cannot UPDATE any of property B's rooms.
 *   3. User A cannot DELETE any of property B's rooms.
 *   4. User A cannot INSERT a new row claiming property B as its property_id.
 *   5. The accounts table self-row-only policy correctly hides user B's
 *      account from user A.
 *   6. An admin role on accounts grants cross-property access (per the
 *      canonical user_owns_property function — `role = 'admin' OR p_id =
 *      ANY(property_access)`).
 *   7. The same RLS protections apply to a second per-property table
 *      (work_orders), confirming the pattern is correct (not just rooms-
 *      specific).
 *
 * This is the test that would have caught the three "silent empty state"
 * incidents documented in CLAUDE.md — because it actually exercises the
 * Postgres response under simulated anon/authenticated/service-role
 * sessions, instead of mocking the supabase-js client.
 *
 * Why not apply the full 148 production migrations? Many depend on
 * Supabase-specific schemas (auth.users table, realtime extension, etc.)
 * that pglite doesn't ship. The minimal fixture (canonical user_owns_property
 * + RLS pattern on two tables) is sufficient to prove the mechanic. A
 * broader integration harness is recommended follow-up work.
 *
 * Performance note: pglite cold-start is ~200ms; the schema+policy setup
 * is ~30ms; each query is <1ms. The full test takes ~1s.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupRlsFixture, type PgliteFixture } from '../../../tests/fixtures/pglite-bootstrap.js';

const UID_A = '11111111-1111-1111-1111-111111111111';
const UID_B = '22222222-2222-2222-2222-222222222222';
const UID_ADMIN = '33333333-3333-3333-3333-333333333333';
const PID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('RLS tenant isolation — real Postgres via pglite', () => {
  let fx: PgliteFixture;

  before(async () => {
    fx = await setupRlsFixture();

    // Seed: two non-admin users (each on their own property) + one admin.
    await fx.pg.query(
      `insert into accounts (data_user_id, role, property_access) values
         ($1, 'general_manager', $2),
         ($3, 'general_manager', $4),
         ($5, 'admin', $6)`,
      [UID_A, [PID_A], UID_B, [PID_B], UID_ADMIN, []],
    );

    // Two rooms — one per property.
    await fx.pg.query(
      `insert into rooms (property_id, number) values
         ($1, '101'),
         ($2, '202')`,
      [PID_A, PID_B],
    );

    // One work order per property.
    await fx.pg.query(
      `insert into work_orders (property_id, title) values
         ($1, 'Fix leaky faucet — A'),
         ($2, 'Replace AC filter — B')`,
      [PID_A, PID_B],
    );
  });

  after(async () => {
    await fx.pg.close().catch(() => undefined);
  });

  describe('rooms — canonical per-property scoping', () => {
    test('user A sees only property A\'s rooms (cross-tenant SELECT denied)', async () => {
      const r = await fx.runAsUser(UID_A, `select number, property_id from rooms order by number`);
      assert.equal(r.rows.length, 1, 'expected exactly one row visible to user A');
      assert.equal(r.rows[0].number, '101');
      assert.equal(r.rows[0].property_id, PID_A);
    });

    test('user B sees only property B\'s rooms', async () => {
      const r = await fx.runAsUser(UID_B, `select number, property_id from rooms order by number`);
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0].number, '202');
      assert.equal(r.rows[0].property_id, PID_B);
    });

    test('user A cannot INSERT a row claiming property B', async () => {
      await assert.rejects(
        () =>
          fx.runAsUser(
            UID_A,
            `insert into rooms (property_id, number) values ('${PID_B}', 'EVIL')`,
          ),
        /row-level security/i,
        'RLS must reject cross-tenant INSERT',
      );
    });

    test('user A cannot UPDATE property B\'s rooms (the UPDATE matches 0 rows)', async () => {
      // UPDATE/DELETE on RLS-restricted rows that the caller can't see is
      // reported as "affected 0 rows" rather than an error. The important
      // thing is: the row stays unchanged.
      await fx.runAsUser(UID_A, `update rooms set number = 'HIJACKED' where property_id = '${PID_B}'`);
      const verify = await fx.runAsService(`select number from rooms where property_id = $1`, [PID_B]);
      const r = verify as { rows: { number: string }[] };
      assert.equal(r.rows[0].number, '202', 'property B\'s room must still have its original number');
    });

    test('user A cannot DELETE property B\'s rooms', async () => {
      await fx.runAsUser(UID_A, `delete from rooms where property_id = '${PID_B}'`);
      const verify = await fx.runAsService(`select count(*)::int as n from rooms where property_id = $1`, [PID_B]);
      const r = verify as { rows: { n: number }[] };
      assert.equal(r.rows[0].n, 1, 'property B\'s room must still exist');
    });
  });

  describe('work_orders — same RLS pattern applies to a second table', () => {
    test('user A sees only property A\'s work orders', async () => {
      const r = await fx.runAsUser(UID_A, `select title, property_id from work_orders order by title`);
      assert.equal(r.rows.length, 1);
      assert.equal((r.rows[0].title as string).includes('— A'), true);
    });

    test('user B sees only property B\'s work orders', async () => {
      const r = await fx.runAsUser(UID_B, `select title, property_id from work_orders order by title`);
      assert.equal(r.rows.length, 1);
      assert.equal((r.rows[0].title as string).includes('— B'), true);
    });

    test('user A cannot INSERT a work order against property B', async () => {
      await assert.rejects(
        () =>
          fx.runAsUser(
            UID_A,
            `insert into work_orders (property_id, title) values ('${PID_B}', 'CROSS-TENANT WO')`,
          ),
        /row-level security/i,
      );
    });
  });

  describe('accounts — self-row-only SELECT', () => {
    test('user A sees their own account but not user B\'s', async () => {
      const r = await fx.runAsUser(UID_A, `select data_user_id from accounts`);
      assert.equal(r.rows.length, 1, 'user A must see exactly their own account row');
      assert.equal(r.rows[0].data_user_id, UID_A);
    });

    test('user A cannot UPDATE their accounts row (deny-all writes)', async () => {
      // accounts_deny_writes is a USING (false) policy → UPDATE matches 0
      // rows even for the caller's own account. Mutations must go through
      // /api/auth/accounts (service-role).
      await fx.runAsUser(UID_A, `update accounts set role = 'admin' where data_user_id = '${UID_A}'`);
      const verify = await fx.runAsService(`select role from accounts where data_user_id = $1`, [UID_A]);
      const r = verify as { rows: { role: string }[] };
      assert.equal(r.rows[0].role, 'general_manager', 'role must remain unchanged (privilege escalation blocked)');
    });

    test('user A cannot INSERT a new accounts row (deny-all writes WITH CHECK)', async () => {
      // The deny policy has `with check (false)` — INSERT is rejected
      // outright rather than silent-no-op.
      await assert.rejects(
        () =>
          fx.runAsUser(
            UID_A,
            `insert into accounts (data_user_id, role, property_access) values
               ('44444444-4444-4444-4444-444444444444', 'admin', '{"${PID_B}"}')`,
          ),
        /row-level security/i,
      );
    });
  });

  describe('admin role — cross-property access', () => {
    test('admin sees rooms from BOTH properties', async () => {
      const r = await fx.runAsUser(UID_ADMIN, `select number, property_id from rooms order by number`);
      assert.equal(r.rows.length, 2, 'admin must see both properties\' rooms');
    });

    test('admin can mutate any property\'s room', async () => {
      await fx.runAsUser(UID_ADMIN, `update rooms set number = 'ADMIN-EDIT' where property_id = '${PID_A}'`);
      const verify = await fx.runAsService(`select number from rooms where property_id = $1`, [PID_A]);
      const r = verify as { rows: { number: string }[] };
      assert.equal(r.rows[0].number, 'ADMIN-EDIT');
      // Restore for cleanliness.
      await fx.runAsService(`update rooms set number = '101' where property_id = $1`, [PID_A]);
    });
  });

  describe('anon role — fully denied', () => {
    test('an unauthenticated query (no JWT claim) sees no rooms', async () => {
      // No `set local request.jwt.claim.sub`, so auth.uid() returns null
      // and user_owns_property() returns false for every row.
      await fx.pg.exec('begin');
      try {
        await fx.pg.exec(`set local role authenticated`);
        const r = await fx.pg.query<{ n: number }>(`select count(*)::int as n from rooms`);
        assert.equal(r.rows[0].n, 0, 'anon-like session must see zero rooms');
      } finally {
        await fx.pg.exec('rollback');
      }
    });
  });
});
