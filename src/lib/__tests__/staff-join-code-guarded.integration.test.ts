import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPgliteThrough } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_ANA,
  ACCOUNT_FIONA,
  ACCOUNT_GIL,
  ACCOUNT_MARIA,
  ACCOUNT_WANDA,
  PID_A1,
  PID_A2,
  PID_B1,
  PID_L1,
  UID_ADMIN,
  UID_ANA,
  UID_FIONA,
  UID_GIL,
  UID_MARIA,
  UID_WANDA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const ROLLBACK_PROPERTY = 'cc000000-0000-4000-8000-000000000001';
const ROLLBACK_ACCOUNT = 'cc000000-0000-4000-8000-000000000002';
const ROLLBACK_USER = 'cc000000-0000-4000-8000-000000000003';

interface JsonRow { value: Record<string, unknown> }

async function runAsServiceRole(pg: PGlite, sql: string): Promise<void> {
  await pg.exec('begin');
  try {
    await pg.exec('set local role service_role');
    await pg.exec(sql);
    await pg.exec('commit');
  } catch (error) {
    await pg.exec('rollback').catch(() => undefined);
    throw error;
  }
}

async function readCode(
  pg: PGlite,
  actorAccountId: string,
  actorAuthUserId: string,
  propertyId: string,
): Promise<Record<string, unknown>> {
  const result = await pg.query<JsonRow>(
    `select public.staxis_read_staff_join_code_guarded($1,$2,$3) as value`,
    [actorAccountId, actorAuthUserId, propertyId],
  );
  return result.rows[0].value;
}

async function getOrCreateCode(
  pg: PGlite,
  actorAccountId: string,
  actorAuthUserId: string,
  propertyId: string,
  code: string,
  requestId = 'staff-code-integration',
): Promise<Record<string, unknown>> {
  const result = await pg.query<JsonRow>(
    `select public.staxis_get_or_create_staff_join_code_guarded(
       $1,$2,$3,$4,$5
     ) as value`,
    [actorAccountId, actorAuthUserId, propertyId, code, requestId],
  );
  return result.rows[0].value;
}

async function revokeCode(
  pg: PGlite,
  actorAccountId: string,
  actorAuthUserId: string,
  codeId: string,
  requestId = 'staff-code-integration',
): Promise<Record<string, unknown>> {
  const result = await pg.query<JsonRow>(
    `select public.staxis_revoke_staff_join_code_guarded(
       $1,$2,$3,$4
     ) as value`,
    [actorAccountId, actorAuthUserId, codeId, requestId],
  );
  return result.rows[0].value;
}

describe('ordinary staff join-code guarded boundary — real SQL', () => {
  let pg: PGlite;

  before(async () => {
    const migrated = await applyMigrationsToPgliteThrough('0425');
    assert.ok(
      migrated.report.applied.some((file) => file.startsWith('0396_')),
      'guarded staff join-code migration must apply',
    );
    pg = migrated.pg;
    await seedTwoCompanies(pg);

    await pg.query(
      `insert into properties(id,owner_id,name,total_rooms,timezone)
       values ($1,$2,'Rollback Hotel',10,'America/Chicago')`,
      [ROLLBACK_PROPERTY, UID_ADMIN],
    );
    await pg.query(
      `insert into auth.users(id,email) values ($1,'rollback-gm@example.test')`,
      [ROLLBACK_USER],
    );
    await pg.query(
      `insert into accounts(
         id,username,password_hash,display_name,role,property_access,data_user_id
       ) values (
         $1,'rollback-gm','x','Rollback GM','general_manager',array[$2]::uuid[],$3
       )`,
      [ROLLBACK_ACCOUNT, ROLLBACK_PROPERTY, ROLLBACK_USER],
    );
  });

  after(async () => {
    await pg?.close();
  });

  test('admits only an exact local hotel manager or current platform admin', async () => {
    const created = await getOrCreateCode(
      pg, ACCOUNT_MARIA, UID_MARIA, PID_A1, 'BEAU-ABCDEFGHJK', 'local-manager-create',
    );
    assert.equal(created.ok, true);
    assert.equal(created.status, 'created');
    assert.equal(created.created, true);
    assert.equal(created.hotelId, PID_A1);
    assert.equal(created.code, 'BEAU-ABCDEFGHJK');
    assert.equal(created.role, null);
    assert.equal(created.maxUses, 100);
    assert.equal(created.usedCount, 0);

    const localRead = await readCode(pg, ACCOUNT_MARIA, UID_MARIA, PID_A1);
    assert.equal(localRead.ok, true);
    assert.equal(localRead.status, 'found');
    assert.equal(localRead.codeId, created.codeId);

    // Company owner/finance titles provide portfolio/People reach, never the
    // selected hotel's private bearer credential or mutation bit.
    for (const [accountId, userId] of [
      [ACCOUNT_ANA, UID_ANA],
      [ACCOUNT_FIONA, UID_FIONA],
    ] as const) {
      const denied = await readCode(pg, accountId, userId, PID_A1);
      assert.deepEqual(denied, { ok: false, reason: 'denied' });
      assert.equal('code' in denied, false);
    }

    // Maria's company-wide VP job reaches A2 for portfolio reads, but only her
    // explicit A1 GM hat grants private hotel mutation.
    assert.deepEqual(
      await readCode(pg, ACCOUNT_MARIA, UID_MARIA, PID_A2),
      { ok: false, reason: 'denied' },
    );
    assert.deepEqual(
      await readCode(pg, ACCOUNT_MARIA, UID_GIL, PID_A1),
      { ok: false, reason: 'denied' },
      'an account id cannot be paired with another authenticated user id',
    );

    const adminRead = await readCode(pg, ACCOUNT_ADMIN, UID_ADMIN, PID_A1);
    assert.equal(adminRead.ok, true);
    assert.equal(adminRead.codeId, created.codeId);
  });

  test('denies every direct service writer without side effects; owner-only fixture repair remains deterministic', async () => {
    const before = await pg.query<{ codes: number; audits: number }>(
      `select
         (select count(*)::integer from hotel_join_codes where hotel_id=$1) as codes,
         (select count(*)::integer from admin_audit_log
           where action like 'join_code.%' and metadata->>'hotel_id'=$1::text) as audits`,
      [PID_L1],
    );
    for (const sql of [
      `select * from public.hotel_join_codes where hotel_id='${PID_L1}'`,
      `insert into public.hotel_join_codes(
         hotel_id,code,role,expires_at,max_uses,created_by
       ) values (
         '${PID_L1}','DENY-ABCDEFGHJK',null,now()+interval '1 day',100,
         '${ACCOUNT_WANDA}'
       )`,
      `update public.hotel_join_codes set revoked_at=now() where hotel_id='${PID_L1}'`,
      `delete from public.hotel_join_codes where hotel_id='${PID_L1}'`,
    ]) {
      await assert.rejects(runAsServiceRole(pg, sql), /permission denied/i);
    }
    const after = await pg.query<{ codes: number; audits: number }>(
      `select
         (select count(*)::integer from hotel_join_codes where hotel_id=$1) as codes,
         (select count(*)::integer from admin_audit_log
           where action like 'join_code.%' and metadata->>'hotel_id'=$1::text) as audits`,
      [PID_L1],
    );
    assert.deepEqual(after.rows[0], before.rows[0]);

    // Test setup runs as the database owner and can deliberately inject the
    // duplicated state that the guarded RPC must repair. This is not a
    // supported application writer or rolling-deploy compatibility path.
    const legacyInsert = await pg.query<{ id: string }>(
      `insert into hotel_join_codes(
         hotel_id,code,role,expires_at,max_uses,created_by,created_at
       ) values (
         $1,'WACO-BCDEFGHJKM',null,now()+interval '1 day',100,$2,
         now()-interval '1 minute'
       ) returning id`,
      [PID_L1, ACCOUNT_WANDA],
    );
    const oldWriterCodeId = legacyInsert.rows[0].id;
    const oldWriterRead = await readCode(pg, ACCOUNT_WANDA, UID_WANDA, PID_L1);
    assert.equal(oldWriterRead.status, 'found');
    assert.equal(oldWriterRead.codeId, oldWriterCodeId);

    await pg.query(
      `insert into hotel_join_codes(
         hotel_id,code,role,expires_at,max_uses,created_by
       ) values ($1,'WACO-CDEFGHJKMN',null,now()+interval '1 day',100,$2)`,
      [PID_L1, ACCOUNT_WANDA],
    );
    const reconciled = await getOrCreateCode(
      pg, ACCOUNT_WANDA, UID_WANDA, PID_L1, 'WACO-DEFGHJKMNP', 'old-writer-reconcile',
    );
    assert.equal(reconciled.status, 'existing');
    assert.equal(reconciled.created, false);
    assert.equal(reconciled.codeId, oldWriterCodeId);

    const usable = await pg.query<{ id: string }>(
      `select id from hotel_join_codes
       where hotel_id=$1 and code_kind='staff_signup'
         and revoked_at is null and expires_at > now() and used_count < max_uses`,
      [PID_L1],
    );
    assert.deepEqual(usable.rows.map((row) => row.id), [oldWriterCodeId]);
    const reconcileAudit = await pg.query<{ metadata: Record<string, unknown> }>(
      `select metadata from admin_audit_log
       where action='join_code.staff_signup_reconcile'
         and target_id=$1`,
      [oldWriterCodeId],
    );
    assert.equal(reconcileAudit.rows.length, 1);
    assert.equal('code' in reconcileAudit.rows[0].metadata, false);
  });

  test('rechecks capability and tenant authority at the mutation boundary', async () => {
    const existing = await readCode(pg, ACCOUNT_MARIA, UID_MARIA, PID_A1);
    const codeId = String(existing.codeId);

    const foreign = await revokeCode(pg, ACCOUNT_GIL, UID_GIL, codeId, 'foreign-id-probe');
    assert.deepEqual(foreign, { ok: false, reason: 'denied' });
    const companyOnly = await revokeCode(pg, ACCOUNT_ANA, UID_ANA, codeId, 'company-only-probe');
    assert.deepEqual(companyOnly, { ok: false, reason: 'denied' });

    await pg.query(
      `insert into capability_overrides(
         property_id,capability,role,allowed,updated_by
       ) values ($1,'manage_team','general_manager',false,$2)`,
      [PID_A1, ACCOUNT_ADMIN],
    );
    assert.deepEqual(
      await readCode(pg, ACCOUNT_MARIA, UID_MARIA, PID_A1),
      { ok: false, reason: 'denied' },
    );
    assert.deepEqual(
      await revokeCode(pg, ACCOUNT_MARIA, UID_MARIA, codeId, 'revoked-capability'),
      { ok: false, reason: 'denied' },
    );
    const stillLive = await pg.query<{ revoked_at: string | null }>(
      `select revoked_at from hotel_join_codes where id=$1`, [codeId],
    );
    assert.equal(stillLive.rows[0].revoked_at, null);
    assert.equal((await pg.query<{ count: number }>(
      `select count(*)::integer as count from admin_audit_log
       where action='join_code.revoke' and target_id=$1`, [codeId],
    )).rows[0].count, 0);

    await pg.query(
      `delete from capability_overrides
       where property_id=$1 and capability='manage_team' and role='general_manager'`,
      [PID_A1],
    );
    const revoked = await revokeCode(pg, ACCOUNT_MARIA, UID_MARIA, codeId, 'authorized-revoke');
    assert.deepEqual(revoked, {
      ok: true, status: 'revoked', codeId, hotelId: PID_A1,
    });
    assert.deepEqual(
      await revokeCode(pg, ACCOUNT_MARIA, UID_MARIA, codeId, 'revoke-replay'),
      { ok: false, reason: 'not_found' },
    );
  });

  test('serializes retrying creators to one canonical code and one create audit', async () => {
    const [first, second] = await Promise.all([
      getOrCreateCode(pg, ACCOUNT_GIL, UID_GIL, PID_B1, 'TYLE-EFGHJKMNPQ', 'race-a'),
      getOrCreateCode(pg, ACCOUNT_GIL, UID_GIL, PID_B1, 'TYLE-FGHJKMNPQR', 'race-b'),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.codeId, second.codeId);
    assert.equal([first.created, second.created].filter(Boolean).length, 1);

    const rows = await pg.query<{ count: number }>(
      `select count(*)::integer as count from hotel_join_codes
       where hotel_id=$1 and code_kind='staff_signup' and revoked_at is null`,
      [PID_B1],
    );
    assert.equal(Number(rows.rows[0].count), 1);
    const audits = await pg.query<{ count: number }>(
      `select count(*)::integer as count from admin_audit_log
       where action='join_code.create' and target_id=$1`,
      [String(first.codeId)],
    );
    assert.equal(Number(audits.rows[0].count), 1);
  });

  test('rolls the code mutation back when its mandatory audit cannot commit', async () => {
    await pg.exec(`
      create or replace function public._test_reject_staff_code_audit()
      returns trigger language plpgsql as $$
      begin
        if new.action = 'join_code.create'
           and new.metadata->>'request_id' = 'force-audit-failure'
        then
          raise exception 'forced staff-code audit failure';
        end if;
        return new;
      end;
      $$;
      create trigger trg_test_reject_staff_code_audit
        before insert on public.admin_audit_log
        for each row execute function public._test_reject_staff_code_audit();
    `);
    try {
      await assert.rejects(
        getOrCreateCode(
          pg,
          ROLLBACK_ACCOUNT,
          ROLLBACK_USER,
          ROLLBACK_PROPERTY,
          'ROLL-GHJKMNPQRS',
          'force-audit-failure',
        ),
        /forced staff-code audit failure/i,
      );
      const rows = await pg.query<{ count: number }>(
        `select count(*)::integer as count from hotel_join_codes
         where hotel_id=$1 and code_kind='staff_signup'`,
        [ROLLBACK_PROPERTY],
      );
      assert.equal(Number(rows.rows[0].count), 0);
    } finally {
      await pg.exec(`
        drop trigger if exists trg_test_reject_staff_code_audit
          on public.admin_audit_log;
        drop function if exists public._test_reject_staff_code_audit();
      `);
    }
  });

  test('exposes only the three guarded entry points to service_role', async () => {
    for (const signature of [
      'public.staxis_read_staff_join_code_guarded(uuid,uuid,uuid)',
      'public.staxis_get_or_create_staff_join_code_guarded(uuid,uuid,uuid,text,text)',
      'public.staxis_revoke_staff_join_code_guarded(uuid,uuid,uuid,text)',
    ]) {
      const acl = await pg.query<{
        service_execute: boolean;
        authenticated_execute: boolean;
        anon_execute: boolean;
      }>(
        `select
           has_function_privilege('service_role',$1,'execute') as service_execute,
           has_function_privilege('authenticated',$1,'execute') as authenticated_execute,
           has_function_privilege('anon',$1,'execute') as anon_execute`,
        [signature],
      );
      assert.deepEqual(acl.rows[0], {
        service_execute: true,
        authenticated_execute: false,
        anon_execute: false,
      });
    }
  });
});
