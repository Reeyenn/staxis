import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPgliteThrough } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_ANA,
  UID_ADMIN,
  UID_ANA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const P1 = 'c1000000-0000-4000-8000-000000000001';
const P2 = 'c1000000-0000-4000-8000-000000000002';
const P3 = 'c1000000-0000-4000-8000-000000000003';
const P4 = 'c1000000-0000-4000-8000-000000000004';
const GM_ACCOUNT = 'c2000000-0000-4000-8000-000000000001';
const GM_USER = 'c2000000-0000-4000-8000-000000000002';

interface JsonRow { value: Record<string, unknown> }

async function mint(
  pg: PGlite,
  propertyId: string,
  code: string,
  role: 'owner' | 'general_manager' = 'owner',
  actorId = ACCOUNT_ADMIN,
  actorUserId = UID_ADMIN,
): Promise<Record<string, unknown>> {
  const result = await pg.query<JsonRow>(
    `select public.staxis_mint_privileged_onboarding_join_code(
       $1,$2,$3,$4,$5,'join-code-integration'
     ) as value`,
    [actorId, actorUserId, propertyId, code, role],
  );
  return result.rows[0].value;
}

async function claim(
  pg: PGlite,
  codeId: string,
  expectedUsedCount: number,
): Promise<Record<string, unknown>> {
  const result = await pg.query<JsonRow>(
    `select public.staxis_claim_join_code_slot($1,$2) as value`,
    [codeId, expectedUsedCount],
  );
  return result.rows[0].value;
}

describe('privileged onboarding join-code boundary — real SQL', () => {
  let pg: PGlite;

  before(async () => {
    const migrated = await applyMigrationsToPgliteThrough('0425');
    assert.ok(
      migrated.report.applied.some((file) => file.startsWith('0396_')),
      'privileged onboarding join-code migration must apply',
    );
    pg = migrated.pg;
    await seedTwoCompanies(pg);
    await pg.query(
      `insert into properties(id,owner_id,name,total_rooms,timezone)
       values ($1,$5,'Fresh Owner Hotel',1,'America/Chicago'),
              ($2,$5,'Race Hotel',1,'America/Chicago'),
              ($3,$5,'Already Operated Hotel',1,'America/Chicago'),
              ($4,$5,'Fresh GM Hotel',1,'America/Chicago')`,
      [P1, P2, P3, P4, UID_ADMIN],
    );
  });

  after(async () => {
    await pg?.close();
  });

  test('direct privileged inserts stay closed and structural bounds cannot be bypassed', async () => {
    await assert.rejects(
      pg.query(
        `insert into hotel_join_codes(
           hotel_id,code,role,code_kind,expires_at,max_uses,created_by
         ) values (
           $1,'DIRX-ABCDEFGHJK','owner','privileged_onboarding',
           now()+interval '1 day',1,$2
         )`,
        [P1, ACCOUNT_ADMIN],
      ),
      /guarded RPC/i,
    );

    await assert.rejects(
      pg.query(
        `with context as (
           select set_config('staxis.privileged_join_code_write','mint',true)
         )
         insert into hotel_join_codes(
           hotel_id,code,role,code_kind,expires_at,max_uses,created_by
         )
         select $1,'MULT-ABCDEFGHJK','owner','privileged_onboarding',
                now()+interval '1 day',2,$2
         from context`,
        [P1, ACCOUNT_ADMIN],
      ),
      /hotel_join_codes_kind_shape_check|check constraint/i,
    );
  });

  test('only the exact live platform admin mints one bounded code for an unclaimed hotel', async () => {
    await assert.rejects(
      mint(pg, P1, 'NOPE-ABCDEFGHJK', 'owner', ACCOUNT_ANA, UID_ANA),
      /platform administrator/i,
    );
    await assert.rejects(
      mint(pg, P1, 'MISM-ABCDEFGHJK', 'owner', ACCOUNT_ADMIN, UID_ANA),
      /identity changed/i,
    );

    const created = await mint(pg, P1, 'OWNR-ABCDEFGHJK');
    assert.equal(created.ok, true);
    assert.equal(created.status, 'created');
    assert.equal(created.created, true);
    const codeId = String(created.codeId);

    const row = await pg.query<{
      code_kind: string;
      role: string;
      max_uses: number;
      used_count: number;
      ttl_seconds: number;
    }>(
      `select code_kind,role,max_uses,used_count,
              extract(epoch from (expires_at-created_at))::integer as ttl_seconds
       from hotel_join_codes where id=$1`,
      [codeId],
    );
    assert.deepEqual(row.rows[0], {
      code_kind: 'privileged_onboarding',
      role: 'owner',
      max_uses: 1,
      used_count: 0,
      ttl_seconds: 604800,
    });

    const retried = await mint(pg, P1, 'DIFF-ABCDEFGHJK');
    assert.equal(retried.ok, true);
    assert.equal(retried.status, 'existing');
    assert.equal(retried.codeId, codeId);
    assert.equal(retried.code, 'OWNR-ABCDEFGHJK');
    const roleConflict = await mint(pg, P1, 'DIFF-BCDEFGHJKM', 'general_manager');
    assert.deepEqual(roleConflict, { ok: false, status: 'role_conflict' });

    const audit = await pg.query<{ count: number }>(
      `select count(*)::integer as count
       from admin_audit_log
       where action='join_code.privileged_onboarding_mint'
         and target_id=$1
         and metadata->>'hotel_id'=$2`,
      [codeId, P1],
    );
    assert.equal(Number(audit.rows[0].count), 1);
  });

  test('claim is serialized, single-use, and cannot be released after hotel claim state appears', async () => {
    const code = await pg.query<{ id: string }>(
      `select id from hotel_join_codes where hotel_id=$1`, [P1],
    );
    const codeId = code.rows[0].id;
    const claimed = await claim(pg, codeId, 0);
    assert.deepEqual(claimed, {
      status: 'claimed', usedCount: 1, privileged: true,
    });
    const replay = await claim(pg, codeId, 0);
    assert.deepEqual(replay, { status: 'used_up' });

    await assert.rejects(
      pg.query(`update hotel_join_codes set used_count=0 where id=$1`, [codeId]),
      /claim\/release RPCs/i,
    );
    await pg.query(
      `update properties
          set onboarding_state=jsonb_build_object('accountCreatedAt',now()::text)
        where id=$1`,
      [P1],
    );
    const release = await pg.query<{ released: number }>(
      `select public.staxis_release_join_code_slot($1) as released`, [codeId],
    );
    assert.equal(release.rows[0].released, -2);
    const count = await pg.query<{ used_count: number }>(
      `select used_count from hotel_join_codes where id=$1`, [codeId],
    );
    assert.equal(count.rows[0].used_count, 1);
  });

  test('completion or placeholder-owner change between mint and claim is rejected transactionally', async () => {
    const minted = await mint(pg, P2, 'RACE-ABCDEFGHJK');
    assert.equal(minted.ok, true);
    await pg.query(
      `update properties set onboarding_completed_at=now() where id=$1`, [P2],
    );
    const completed = await claim(pg, String(minted.codeId), 0);
    assert.deepEqual(completed, { status: 'not_claimable', privileged: true });

    await pg.query(
      `update properties
          set onboarding_completed_at=null,
              owner_id=$2
        where id=$1`,
      [P2, UID_ANA],
    );
    const ownerChanged = await claim(pg, String(minted.codeId), 0);
    assert.deepEqual(ownerChanged, {
      status: 'not_claimable', privileged: true,
    });
  });

  test('an existing hotel operator blocks mint while a fresh GM bootstrap remains valid', async () => {
    await pg.query(
      `insert into auth.users(id,email) values ($1,'existing-gm@example.test')`,
      [GM_USER],
    );
    await pg.query(
      `insert into accounts(
         id,username,display_name,role,property_access,data_user_id
       ) values (
         $1,'existing-gm','Existing GM','general_manager',array[$2]::uuid[],$3
       )`,
      [GM_ACCOUNT, P3, GM_USER],
    );
    const occupied = await mint(pg, P3, 'FULL-ABCDEFGHJK');
    assert.deepEqual(occupied, { ok: false, status: 'hotel_not_unclaimed' });

    const gm = await mint(pg, P4, 'GMXX-ABCDEFGHJK', 'general_manager');
    assert.equal(gm.ok, true);
    assert.equal(gm.role, 'general_manager');
    await pg.query(`update accounts set active=false where id=$1`, [ACCOUNT_ADMIN]);
    const revokedAdmin = await claim(pg, String(gm.codeId), 0);
    assert.deepEqual(revokedAdmin, {
      status: 'not_claimable', privileged: true,
    });
    await pg.query(`update accounts set active=true where id=$1`, [ACCOUNT_ADMIN]);
  });
});
