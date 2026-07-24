/**
 * agent_messages.property_id — real-Postgres (pglite) integration test for
 * migration 0336 / INV-28.
 *
 * The point of 0336 is that the hotel on a message is DERIVED from its parent
 * conversation by a BEFORE trigger, not supplied by the writer. That is the
 * one guarantee in this workstream the database itself performs, so it is
 * tested against real Postgres rather than a fake:
 *
 *   • a writer that names the WRONG hotel is overwritten, not honoured;
 *   • a writer that names NO hotel still gets one;
 *   • moving a conversation to another hotel and touching the message
 *     re-derives it (the column cannot drift);
 *   • a message with no resolvable conversation is rejected outright.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupRlsFixture, type PgliteFixture } from '../../../tests/fixtures/pglite-bootstrap';

const UID = 'b0000000-0000-0000-0000-0000000000c3';
const PID_A = 'b0000000-0000-0000-0000-0000000000a1';
const PID_B = 'b0000000-0000-0000-0000-0000000000b2';
const CONV = 'b0000000-0000-0000-0000-0000000000e1';
const GHOST_CONV = 'b0000000-0000-0000-0000-0000000000e9';

describe('agent_messages.property_id is derived from its conversation (0336)', () => {
  let fx: PgliteFixture;

  before(async () => {
    fx = await setupRlsFixture();
    await fx.pg.query(`insert into auth.users (id, email) values ($1, 'am@test') on conflict do nothing`, [UID]);
    await fx.pg.exec(`insert into properties (id, name, owner_id, total_rooms) values
      ('${PID_A}', 'Hotel A', '${UID}', 50), ('${PID_B}', 'Hotel B', '${UID}', 50) on conflict do nothing;`);
    await fx.pg.query(
      `insert into accounts (id, username, password_hash, display_name, data_user_id, role, property_access)
       values ($1, 'am', 'x', 'AM', $2, 'general_manager', $3) on conflict do nothing`,
      [UID, UID, [PID_A, PID_B]],
    );
    await fx.pg.query(
      `insert into agent_conversations (id, user_id, property_id, role)
       values ($1, $2, $3, 'general_manager') on conflict do nothing`,
      [CONV, UID, PID_A],
    );
  });

  after(async () => {
    await fx.pg.close().catch(() => undefined);
  });

  test('the migration actually applied (column + trigger exist)', async () => {
    const col = await fx.pg.query(
      `select is_nullable from information_schema.columns
        where table_schema='public' and table_name='agent_messages' and column_name='property_id'`,
    );
    assert.equal(col.rows.length, 1, 'agent_messages.property_id must exist');
    assert.equal((col.rows[0] as { is_nullable: string }).is_nullable, 'NO', 'property_id must be NOT NULL');

    const trg = await fx.pg.query(
      `select tgname from pg_trigger where tgrelid = 'public.agent_messages'::regclass and not tgisinternal`,
    );
    const names = trg.rows.map((r) => (r as { tgname: string }).tgname);
    assert.ok(names.includes('agent_messages_set_property'), `derive trigger missing; found ${names.join(', ')}`);
  });

  test('a writer that names the WRONG hotel is overwritten with the conversation\'s', async () => {
    await fx.pg.exec('begin');
    try {
      const ins = await fx.pg.query(
        `insert into agent_messages (conversation_id, role, content, property_id)
         values ($1, 'user', 'hello', $2) returning property_id`,
        [CONV, PID_B],
      );
      assert.equal(
        (ins.rows[0] as { property_id: string }).property_id,
        PID_A,
        'the parent conversation wins over whatever the writer supplied',
      );
    } finally {
      await fx.pg.exec('rollback');
    }
  });

  test('a writer that supplies no hotel at all still gets one', async () => {
    await fx.pg.exec('begin');
    try {
      const ins = await fx.pg.query(
        `insert into agent_messages (conversation_id, role, content)
         values ($1, 'assistant', 'hi back') returning property_id`,
        [CONV],
      );
      assert.equal((ins.rows[0] as { property_id: string }).property_id, PID_A);
    } finally {
      await fx.pg.exec('rollback');
    }
  });

  test('the column cannot be pushed to another hotel by an UPDATE', async () => {
    await fx.pg.exec('begin');
    try {
      const ins = await fx.pg.query(
        `insert into agent_messages (conversation_id, role, content) values ($1, 'user', 'x') returning id`,
        [CONV],
      );
      const id = (ins.rows[0] as { id: string }).id;
      const upd = await fx.pg.query(
        `update agent_messages set property_id = $1 where id = $2 returning property_id`,
        [PID_B, id],
      );
      assert.equal((upd.rows[0] as { property_id: string }).property_id, PID_A);
    } finally {
      await fx.pg.exec('rollback');
    }
  });

  test('moving the conversation re-derives the message on its next write', async () => {
    await fx.pg.exec('begin');
    try {
      const ins = await fx.pg.query(
        `insert into agent_messages (conversation_id, role, content) values ($1, 'user', 'y') returning id`,
        [CONV],
      );
      const id = (ins.rows[0] as { id: string }).id;
      await fx.pg.query(`update agent_conversations set property_id = $1 where id = $2`, [PID_B, CONV]);
      const upd = await fx.pg.query(
        `update agent_messages set content = 'y2' where id = $1 returning property_id`,
        [id],
      );
      assert.equal(
        (upd.rows[0] as { property_id: string }).property_id,
        PID_B,
        'the message follows its conversation instead of drifting',
      );
    } finally {
      await fx.pg.exec('rollback');
    }
  });

  test('a message whose conversation does not exist is rejected', async () => {
    await fx.pg.exec('begin');
    try {
      await assert.rejects(
        fx.pg.query(
          `insert into agent_messages (conversation_id, role, content) values ($1, 'user', 'orphan')`,
          [GHOST_CONV],
        ),
        'an unresolvable conversation must not produce a hotel-less message',
      );
    } finally {
      await fx.pg.exec('rollback');
    }
  });

  test('messages of one hotel never appear under the other', async () => {
    await fx.pg.exec('begin');
    try {
      await fx.pg.query(
        `insert into agent_messages (conversation_id, role, content) values ($1, 'user', 'scoped')`,
        [CONV],
      );
      const a = await fx.pg.query(`select count(*)::int n from agent_messages where property_id = $1`, [PID_A]);
      const b = await fx.pg.query(`select count(*)::int n from agent_messages where property_id = $1`, [PID_B]);
      assert.equal((a.rows[0] as { n: number }).n, 1);
      assert.equal((b.rows[0] as { n: number }).n, 0);
    } finally {
      await fx.pg.exec('rollback');
    }
  });
});
