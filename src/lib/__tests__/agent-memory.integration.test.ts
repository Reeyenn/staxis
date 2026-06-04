/**
 * agent_memory — real-Postgres (pglite) integration test.
 *
 * agent_memory is service-role-only / deny-all, so it is NOT auto-discovered by
 * rls-tenant-isolation.integration.test.ts (that test only finds tables whose
 * policy references user_owns_property). This file therefore exercises the
 * migration + RPCs directly and pins the guarantees that matter:
 *   • cross-property isolation (property A's memory never appears for B);
 *   • per-user isolation of user-scope memory;
 *   • atomic upsert-by-topic (dedup) + forget soft-delete;
 *   • the row-cap + scope/subject + length DB invariants;
 *   • deny-all to the anon browser role.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupRlsFixture, type PgliteFixture } from '../../../tests/fixtures/pglite-bootstrap';

const UID = 'a0000000-0000-0000-0000-0000000000c3';
const PID_A = 'a0000000-0000-0000-0000-0000000000a1';
const PID_B = 'a0000000-0000-0000-0000-0000000000b2';
const ACC_A = 'a0000000-0000-0000-0000-0000000000d4';
const ACC_B = 'a0000000-0000-0000-0000-0000000000d5';

const STORE = (extra = '') =>
  `select * from staxis_store_memory(p_property_id:=$1, p_scope:=$2, p_subject_account_id:=$3, p_topic:=$4, p_content:=$5 ${extra})`;

describe('agent_memory — RPCs + tenant isolation (pglite)', () => {
  let fx: PgliteFixture;

  before(async () => {
    fx = await setupRlsFixture();
    await fx.pg.query(`insert into auth.users (id, email) values ($1, 'm@test') on conflict do nothing`, [UID]);
    await fx.pg.exec(`insert into properties (id, name, owner_id, total_rooms) values
      ('${PID_A}', 'MA', '${UID}', 50), ('${PID_B}', 'MB', '${UID}', 50) on conflict do nothing;`);
  });

  after(async () => {
    await fx.pg.close().catch(() => undefined);
  });

  test('stores a property memory, isolated to its own property', async () => {
    await fx.pg.exec('begin');
    try {
      const ins = await fx.pg.query(STORE(), [PID_A, 'property', null, 'room_305_ac', 'room 305 AC fails']);
      assert.equal((ins.rows[0] as { action: string }).action, 'inserted');
      const a = await fx.pg.query(`select count(*)::int n from agent_memory where property_id=$1 and is_active`, [PID_A]);
      const b = await fx.pg.query(`select count(*)::int n from agent_memory where property_id=$1 and is_active`, [PID_B]);
      assert.equal((a.rows[0] as { n: number }).n, 1);
      assert.equal((b.rows[0] as { n: number }).n, 0, 'property B must NOT see property A memory');
    } finally {
      await fx.pg.exec('rollback');
    }
  });

  test('restating the same topic updates in place (dedup)', async () => {
    await fx.pg.exec('begin');
    try {
      const a = await fx.pg.query(STORE(), [PID_A, 'property', null, 'dup', 'v1']);
      assert.equal((a.rows[0] as { action: string }).action, 'inserted');
      const b = await fx.pg.query(STORE(), [PID_A, 'property', null, 'dup', 'v2']);
      assert.equal((b.rows[0] as { action: string }).action, 'updated');
      const r = await fx.pg.query(`select count(*)::int n, max(content) c from agent_memory where property_id=$1 and topic='dup' and is_active`, [PID_A]);
      assert.equal((r.rows[0] as { n: number }).n, 1);
      assert.equal((r.rows[0] as { c: string }).c, 'v2');
    } finally {
      await fx.pg.exec('rollback');
    }
  });

  test('user-scope memory is private to its subject account', async () => {
    await fx.pg.exec('begin');
    try {
      await fx.pg.query(STORE(), [PID_A, 'user', ACC_A, 'reply_language', 'prefers Spanish']);
      const mine = await fx.pg.query(`select count(*)::int n from agent_memory where property_id=$1 and scope='user' and subject_account_id=$2 and is_active`, [PID_A, ACC_A]);
      const other = await fx.pg.query(`select count(*)::int n from agent_memory where property_id=$1 and scope='user' and subject_account_id=$2 and is_active`, [PID_A, ACC_B]);
      assert.equal((mine.rows[0] as { n: number }).n, 1);
      assert.equal((other.rows[0] as { n: number }).n, 0, 'another user must NOT see this user-scope memory');
    } finally {
      await fx.pg.exec('rollback');
    }
  });

  test('forget soft-deletes (retained for audit)', async () => {
    await fx.pg.exec('begin');
    try {
      await fx.pg.query(STORE(), [PID_A, 'property', null, 'forget_me', 'x']);
      const n = await fx.pg.query(`select staxis_forget_memory($1,'property',null,'forget_me') as d`, [PID_A]);
      assert.equal((n.rows[0] as { d: number }).d, 1);
      const active = await fx.pg.query(`select count(*)::int n from agent_memory where property_id=$1 and topic='forget_me' and is_active`, [PID_A]);
      const total = await fx.pg.query(`select count(*)::int n from agent_memory where property_id=$1 and topic='forget_me'`, [PID_A]);
      assert.equal((active.rows[0] as { n: number }).n, 0);
      assert.equal((total.rows[0] as { n: number }).n, 1, 'row retained for audit');
    } finally {
      await fx.pg.exec('rollback');
    }
  });

  test('enforces the per-property active-row cap', async () => {
    await fx.pg.exec('begin');
    try {
      for (const t of ['cap_a', 'cap_b']) {
        const r = await fx.pg.query(STORE(', p_property_cap:=2'), [PID_A, 'property', null, t, 'c']);
        assert.equal((r.rows[0] as { action: string }).action, 'inserted');
      }
      const full = await fx.pg.query(STORE(', p_property_cap:=2'), [PID_A, 'property', null, 'cap_c', 'c']);
      assert.equal((full.rows[0] as { action: string }).action, 'property_full');
    } finally {
      await fx.pg.exec('rollback');
    }
  });

  test('DB rejects scope/subject invariant violations', async () => {
    await assert.rejects(
      fx.pg.query(`insert into agent_memory (property_id, scope, subject_account_id, topic, content) values ($1,'property',$2,'t','c')`, [PID_A, ACC_A]),
      'property scope with a subject must be rejected',
    );
    await assert.rejects(
      fx.pg.query(`insert into agent_memory (property_id, scope, subject_account_id, topic, content) values ($1,'user',null,'t','c')`, [PID_A]),
      'user scope without a subject must be rejected',
    );
  });

  test('DB rejects content over 500 chars', async () => {
    await assert.rejects(
      fx.pg.query(`insert into agent_memory (property_id, scope, subject_account_id, topic, content) values ($1,'property',null,'t',$2)`, [PID_A, 'x'.repeat(501)]),
    );
  });

  test('anon browser role is denied (service-role-only / deny-all)', async () => {
    await fx.pg.exec('begin');
    try {
      await fx.pg.exec('set local role anon');
      await assert.rejects(
        fx.pg.query(`select 1 from agent_memory limit 1`),
        'anon must not be able to read agent_memory',
      );
    } finally {
      await fx.pg.exec('rollback');
    }
  });
});
