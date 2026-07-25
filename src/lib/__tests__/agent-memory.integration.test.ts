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
 *   • "delete means gone" — an auto-learned writer can never re-learn a topic a
 *     human deleted, permanently and with no time window (0357);
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

  test('consolidation never downgrades a human-authored fact (0260 guard)', async () => {
    await fx.pg.exec('begin');
    try {
      // A manager states a fact explicitly.
      const h = await fx.pg.query(STORE(), [PID_A, 'property', null, 'guard_t', 'human says X']);
      assert.equal((h.rows[0] as { action: string }).action, 'inserted');
      // The nightly consolidator tries to re-learn the SAME topic.
      const c = await fx.pg.query(STORE(", p_source:='consolidation', p_confidence:='low'"), [PID_A, 'property', null, 'guard_t', 'auto guess Y']);
      assert.equal((c.rows[0] as { action: string }).action, 'skipped', 'consolidation must defer to a human fact');
      const r = await fx.pg.query(`select content, source from agent_memory where property_id=$1 and topic='guard_t' and is_active`, [PID_A]);
      assert.equal((r.rows[0] as { content: string }).content, 'human says X', 'human content untouched');
      assert.equal((r.rows[0] as { source: string }).source, 'explicit_user', 'human source untouched');
    } finally {
      await fx.pg.exec('rollback');
    }
  });

  test('a human write still upgrades a prior consolidation fact (0260 guard)', async () => {
    await fx.pg.exec('begin');
    try {
      await fx.pg.query(STORE(", p_source:='consolidation', p_confidence:='low'"), [PID_A, 'property', null, 'up_t', 'auto']);
      const u = await fx.pg.query(STORE(), [PID_A, 'property', null, 'up_t', 'manager truth']);
      assert.equal((u.rows[0] as { action: string }).action, 'updated', 'a human write upgrades an auto-learned row');
      const r = await fx.pg.query(`select content, source from agent_memory where property_id=$1 and topic='up_t' and is_active`, [PID_A]);
      assert.equal((r.rows[0] as { content: string }).content, 'manager truth');
      assert.equal((r.rows[0] as { source: string }).source, 'explicit_user');
    } finally {
      await fx.pg.exec('rollback');
    }
  });

  test('operational write defers to a human-authored fact (0261 guard)', async () => {
    await fx.pg.exec('begin');
    try {
      const h = await fx.pg.query(STORE(), [PID_A, 'property', null, 'op_guard_t', 'human says X']);
      assert.equal((h.rows[0] as { action: string }).action, 'inserted');
      // The operational learner tries to overwrite the SAME topic.
      const o = await fx.pg.query(STORE(", p_source:='operational', p_confidence:='low'"), [PID_A, 'property', null, 'op_guard_t', 'auto observed Y']);
      assert.equal((o.rows[0] as { action: string }).action, 'skipped', 'operational must defer to a human fact');
      const r = await fx.pg.query(`select content, source from agent_memory where property_id=$1 and topic='op_guard_t' and is_active`, [PID_A]);
      assert.equal((r.rows[0] as { content: string }).content, 'human says X', 'human content untouched');
      assert.equal((r.rows[0] as { source: string }).source, 'explicit_user', 'human source untouched');
    } finally {
      await fx.pg.exec('rollback');
    }
  });

  test('a human write upgrades a prior operational fact (0261 guard)', async () => {
    await fx.pg.exec('begin');
    try {
      await fx.pg.query(STORE(", p_source:='operational', p_confidence:='low'"), [PID_A, 'property', null, 'op_up_t', 'auto observed']);
      const u = await fx.pg.query(STORE(", p_source:='correction', p_confidence:='high'"), [PID_A, 'property', null, 'op_up_t', 'manager truth']);
      assert.equal((u.rows[0] as { action: string }).action, 'updated', 'a human write upgrades an operational row');
      const r = await fx.pg.query(`select content, source from agent_memory where property_id=$1 and topic='op_up_t' and is_active`, [PID_A]);
      assert.equal((r.rows[0] as { content: string }).content, 'manager truth');
      assert.equal((r.rows[0] as { source: string }).source, 'correction');
    } finally {
      await fx.pg.exec('rollback');
    }
  });

  test('operational co-updates a prior auto-learned (consolidation) row — no human to defer to', async () => {
    await fx.pg.exec('begin');
    try {
      await fx.pg.query(STORE(", p_source:='consolidation', p_confidence:='low'"), [PID_A, 'property', null, 'op_mix_t', 'from chat']);
      const o = await fx.pg.query(STORE(", p_source:='operational', p_confidence:='low'"), [PID_A, 'property', null, 'op_mix_t', 'from operations']);
      assert.equal((o.rows[0] as { action: string }).action, 'updated', 'auto sources co-update when no human fact exists');
      const r = await fx.pg.query(`select content, source from agent_memory where property_id=$1 and topic='op_mix_t' and is_active`, [PID_A]);
      assert.equal((r.rows[0] as { source: string }).source, 'operational');
      assert.equal((r.rows[0] as { content: string }).content, 'from operations');
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

  // ── "delete means gone" — permanent forget (0357) ─────────────────────────
  // Only two paths ever set is_active=false and both are human-initiated
  // (staxis_forget_memory + the dashboard Remove button); expiry is a read-time
  // filter and never deactivates. So a deactivated row means "a human deleted
  // this topic", and no automatic writer may bring it back — ever.

  const AUTO = ", p_source:='consolidation', p_confidence:='low'";
  const OPERATIONAL = ", p_source:='operational', p_confidence:='low'";

  /** Backdate a tombstone's updated_at, bypassing the updated_at trigger, to
   *  simulate a deletion that happened long ago. */
  const ageTombstone = async (pid: string, topic: string, days: number) => {
    await fx.pg.exec('alter table agent_memory disable trigger set_updated_at');
    await fx.pg.query(
      `update agent_memory set updated_at = now() - ($3 || ' days')::interval
         where property_id=$1 and topic=$2 and not is_active`,
      [pid, topic, String(days)],
    );
    await fx.pg.exec('alter table agent_memory enable trigger set_updated_at');
  };

  test('an auto-learned write can never re-learn a topic a human deleted — no time window', async () => {
    await fx.pg.exec('begin');
    try {
      await fx.pg.query(STORE(), [PID_A, 'property', null, 'gone_t', 'the bistro opens at 6']);
      const f = await fx.pg.query(`select staxis_forget_memory($1,'property',null,'gone_t') as d`, [PID_A]);
      assert.equal((f.rows[0] as { d: number }).d, 1);

      // Tonight's consolidator re-proposes it.
      const now = await fx.pg.query(STORE(AUTO), [PID_A, 'property', null, 'gone_t', 'the bistro opens at 6']);
      assert.equal((now.rows[0] as { action: string }).action, 'refused_forgotten');
      const tomb = await fx.pg.query(`select id from agent_memory where property_id=$1 and topic='gone_t'`, [PID_A]);
      assert.equal(
        (now.rows[0] as { memory_id: string }).memory_id,
        (tomb.rows[0] as { id: string }).id,
        'the refusal reports the tombstone row it matched',
      );

      // …and still refuses it 400 days later. (This is the regression: the old
      // 30-day prompt hint would have let it back in on day 31.)
      await ageTombstone(PID_A, 'gone_t', 400);
      const later = await fx.pg.query(STORE(AUTO), [PID_A, 'property', null, 'gone_t', 'the bistro opens at 6']);
      assert.equal((later.rows[0] as { action: string }).action, 'refused_forgotten', 'forget does not expire');

      // The operational learner is refused on the same terms.
      const op = await fx.pg.query(STORE(OPERATIONAL), [PID_A, 'property', null, 'gone_t', 'observed pattern']);
      assert.equal((op.rows[0] as { action: string }).action, 'refused_forgotten');

      const active = await fx.pg.query(
        `select count(*)::int n from agent_memory where property_id=$1 and topic='gone_t' and is_active`,
        [PID_A],
      );
      assert.equal((active.rows[0] as { n: number }).n, 0, 'the deleted fact never came back');
    } finally {
      await fx.pg.exec('rollback');
    }
  });

  test('a human can deliberately re-add a topic they deleted; auto writes then defer to it', async () => {
    await fx.pg.exec('begin');
    try {
      await fx.pg.query(STORE(), [PID_A, 'property', null, 'readd_t', 'v1']);
      await fx.pg.query(`select staxis_forget_memory($1,'property',null,'readd_t') as d`, [PID_A]);
      await ageTombstone(PID_A, 'readd_t', 400);

      const back = await fx.pg.query(STORE(), [PID_A, 'property', null, 'readd_t', 'v2 — manager put it back']);
      assert.equal((back.rows[0] as { action: string }).action, 'inserted', 'a human write is never refused');

      // Now it is an active human fact, so an auto write hits the 0260/0261
      // guard — 'skipped', not 'refused_forgotten'.
      const auto = await fx.pg.query(STORE(AUTO), [PID_A, 'property', null, 'readd_t', 'auto guess']);
      assert.equal((auto.rows[0] as { action: string }).action, 'skipped');
      const r = await fx.pg.query(
        `select content from agent_memory where property_id=$1 and topic='readd_t' and is_active`,
        [PID_A],
      );
      assert.equal((r.rows[0] as { content: string }).content, 'v2 — manager put it back');
    } finally {
      await fx.pg.exec('rollback');
    }
  });

  test("an 'inferred' write is not refused for a forgotten topic", async () => {
    await fx.pg.exec('begin');
    try {
      await fx.pg.query(STORE(), [PID_A, 'property', null, 'inf_t', 'v1']);
      await fx.pg.query(`select staxis_forget_memory($1,'property',null,'inf_t') as d`, [PID_A]);
      const r = await fx.pg.query(STORE(", p_source:='inferred'"), [PID_A, 'property', null, 'inf_t', 'v2']);
      assert.equal((r.rows[0] as { action: string }).action, 'inserted', 'only auto-learned sources are refused');
    } finally {
      await fx.pg.exec('rollback');
    }
  });

  test('a forgotten topic does not bleed across properties or across user accounts', async () => {
    await fx.pg.exec('begin');
    try {
      // Property A deleted it; property B never did.
      await fx.pg.query(STORE(), [PID_A, 'property', null, 'shared_t', 'x']);
      await fx.pg.query(`select staxis_forget_memory($1,'property',null,'shared_t') as d`, [PID_A]);
      const a = await fx.pg.query(STORE(AUTO), [PID_A, 'property', null, 'shared_t', 'auto']);
      const b = await fx.pg.query(STORE(AUTO), [PID_B, 'property', null, 'shared_t', 'auto']);
      assert.equal((a.rows[0] as { action: string }).action, 'refused_forgotten');
      assert.equal((b.rows[0] as { action: string }).action, 'inserted', 'another hotel is unaffected');

      // User scope: ACC_A deleted their personal note; ACC_B never did.
      await fx.pg.query(STORE(), [PID_A, 'user', ACC_A, 'pref_t', 'prefers Spanish']);
      const uf = await fx.pg.query(`select staxis_forget_memory($1,'user',$2,'pref_t') as d`, [PID_A, ACC_A]);
      assert.equal((uf.rows[0] as { d: number }).d, 1);
      const ua = await fx.pg.query(STORE(AUTO), [PID_A, 'user', ACC_A, 'pref_t', 'auto']);
      const ub = await fx.pg.query(STORE(AUTO), [PID_A, 'user', ACC_B, 'pref_t', 'auto']);
      assert.equal((ua.rows[0] as { action: string }).action, 'refused_forgotten', 'user scope is covered too');
      assert.equal((ub.rows[0] as { action: string }).action, 'inserted', 'another account is unaffected');
    } finally {
      await fx.pg.exec('rollback');
    }
  });

  test('a forgotten topic is refused for being forgotten, never mislabelled as a full memory', async () => {
    await fx.pg.exec('begin');
    try {
      await fx.pg.query(STORE(), [PID_A, 'property', null, 'capgone_t', 'x']);
      await fx.pg.query(`select staxis_forget_memory($1,'property',null,'capgone_t') as d`, [PID_A]);
      // Fill the hotel's memory to its cap with live facts.
      for (const t of ['capfill_a', 'capfill_b']) {
        const r = await fx.pg.query(STORE(', p_property_cap:=2'), [PID_A, 'property', null, t, 'c']);
        assert.equal((r.rows[0] as { action: string }).action, 'inserted');
      }
      // The forgotten topic is refused BEFORE the cap is consulted…
      const gone = await fx.pg.query(STORE(`${AUTO}, p_property_cap:=2`), [PID_A, 'property', null, 'capgone_t', 'auto']);
      assert.equal((gone.rows[0] as { action: string }).action, 'refused_forgotten');
      // …while a genuinely new topic does hit the cap, proving it was armed.
      const fresh = await fx.pg.query(STORE(`${AUTO}, p_property_cap:=2`), [PID_A, 'property', null, 'capnew_t', 'auto']);
      assert.equal((fresh.rows[0] as { action: string }).action, 'property_full');
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
