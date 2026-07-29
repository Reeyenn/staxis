import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_ADMIN,
  ORG_A,
  ORG_B,
  UID_ADMIN,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const PRIVILEGED_SUCCESS = 'd1000000-0000-4000-8000-000000000001';
const PRIVILEGED_TRANSFER = 'd1000000-0000-4000-8000-000000000002';
const STAFF_SUCCESS = 'd1000000-0000-4000-8000-000000000003';
const STAFF_TRANSFER = 'd1000000-0000-4000-8000-000000000004';
const ROLLBACK_PROPERTY = 'd1000000-0000-4000-8000-000000000005';
const STAFF_RELATIONSHIP_END = 'd1000000-0000-4000-8000-000000000006';
const LOCAL_GM_ACCOUNT = 'd2000000-0000-4000-8000-000000000001';
const LOCAL_GM_USER = 'd2000000-0000-4000-8000-000000000002';
const OWNER_SUCCESS_USER = 'd3000000-0000-4000-8000-000000000001';
const OWNER_TRANSFER_USER = 'd3000000-0000-4000-8000-000000000002';
const STAFF_SUCCESS_USER = 'd3000000-0000-4000-8000-000000000003';
const STAFF_TRANSFER_USER = 'd3000000-0000-4000-8000-000000000004';
const ROLLBACK_USER = 'd3000000-0000-4000-8000-000000000005';
const STAFF_RELATIONSHIP_END_USER = 'd3000000-0000-4000-8000-000000000006';

interface JsonRow { value: Record<string, unknown> }

async function mintPrivileged(
  pg: PGlite,
  propertyId: string,
  code: string,
): Promise<Record<string, unknown>> {
  const result = await pg.query<JsonRow>(
    `select public.staxis_mint_privileged_onboarding_join_code(
       $1,$2,$3,$4,'owner','signup-finalization-test'
     ) as value`,
    [ACCOUNT_ADMIN, UID_ADMIN, propertyId, code],
  );
  return result.rows[0].value;
}

async function mintStaff(
  pg: PGlite,
  propertyId: string,
  code: string,
): Promise<Record<string, unknown>> {
  const result = await pg.query<JsonRow>(
    `select public.staxis_get_or_create_staff_join_code_guarded(
       $1,$2,$3,$4,'signup-finalization-test'
     ) as value`,
    [LOCAL_GM_ACCOUNT, LOCAL_GM_USER, propertyId, code],
  );
  return result.rows[0].value;
}

async function resolve(
  pg: PGlite,
  code: string,
): Promise<Record<string, unknown>> {
  const result = await pg.query<JsonRow>(
    `select public.staxis_resolve_join_code_capability($1) as value`,
    [code],
  );
  return result.rows[0].value;
}

async function finalize(
  pg: PGlite,
  input: {
    codeId: string;
    code: string;
    propertyId: string;
    authUserId: string;
    username: string;
    role: string;
  },
): Promise<Record<string, unknown>> {
  const result = await pg.query<JsonRow>(
    `select public.staxis_finalize_join_code_signup(
       $1,$2,$3,0,$4,$5,$6,$7,null,'en','signup-finalization-test'
     ) as value`,
    [
      input.codeId,
      input.code,
      input.propertyId,
      input.authUserId,
      input.username,
      `Display ${input.username}`,
      input.role,
    ],
  );
  return result.rows[0].value;
}

async function transfer(
  pg: PGlite,
  propertyId: string,
  organizationId: string,
): Promise<void> {
  await pg.query(
    `select public.staxis_set_primary_property_organization($1,$2,$3,'operator')`,
    [ACCOUNT_ADMIN, propertyId, organizationId],
  );
}

async function assertNoRelationalSignup(
  pg: PGlite,
  propertyId: string,
  authUserId: string,
): Promise<void> {
  const rows = await pg.query<{
    accounts: number;
    requests: number;
    audits: number;
  }>(
    `select
       (select count(*)::integer from accounts where data_user_id=$2) as accounts,
       (select count(*)::integer from join_requests where property_id=$1) as requests,
       (select count(*)::integer from admin_audit_log
         where action='join_code.use' and actor_user_id=$2) as audits`,
    [propertyId, authUserId],
  );
  assert.deepEqual(rows.rows[0], { accounts: 0, requests: 0, audits: 0 });
}

describe('join-code signup finalization — real transactional boundary', () => {
  let pg: PGlite;

  before(async () => {
    const migrated = await applyMigrationsToPglite();
    assert.ok(migrated.report.applied.includes('0396_privileged_onboarding_join_codes.sql'));
    pg = migrated.pg;
    await seedTwoCompanies(pg);

    for (const [propertyId, name] of [
      [PRIVILEGED_SUCCESS, 'Privileged Success'],
      [PRIVILEGED_TRANSFER, 'Privileged Transfer'],
      [STAFF_SUCCESS, 'Staff Success'],
      [STAFF_TRANSFER, 'Staff Transfer'],
      [ROLLBACK_PROPERTY, 'Rollback Hotel'],
      [STAFF_RELATIONSHIP_END, 'Relationship End Hotel'],
    ] as const) {
      await pg.query(
        `insert into properties(id,owner_id,name,total_rooms,timezone)
         values ($1,$2,$3,10,'America/Chicago')`,
        [propertyId, UID_ADMIN, name],
      );
    }
    await pg.query(
      `insert into auth.users(id,email) values
         ($1,'local-gm@example.test'),
         ($2,'owner-success@example.test'),
         ($3,'owner-transfer@example.test'),
         ($4,'staff-success@example.test'),
         ($5,'staff-transfer@example.test'),
         ($6,'rollback@example.test'),
         ($7,'relationship-end@example.test')`,
      [
        LOCAL_GM_USER,
        OWNER_SUCCESS_USER,
        OWNER_TRANSFER_USER,
        STAFF_SUCCESS_USER,
        STAFF_TRANSFER_USER,
        ROLLBACK_USER,
        STAFF_RELATIONSHIP_END_USER,
      ],
    );
    await pg.query(
      `insert into accounts(
         id,username,password_hash,display_name,role,property_access,data_user_id
       ) values (
         $1,'finalizer-local-gm','x','Local GM','general_manager',
         array[$2,$3,$4,$5]::uuid[],$6
       )`,
      [
        LOCAL_GM_ACCOUNT,
        STAFF_SUCCESS,
        STAFF_TRANSFER,
        ROLLBACK_PROPERTY,
        STAFF_RELATIONSHIP_END,
        LOCAL_GM_USER,
      ],
    );
  });

  after(async () => {
    await pg?.close();
  });

  test('atomically finalizes privileged ownership and is idempotent after commit', async () => {
    const minted = await mintPrivileged(pg, PRIVILEGED_SUCCESS, 'FINL-ABCDEFGHJK');
    assert.equal(minted.ok, true);
    const capability = await resolve(pg, 'FINL-ABCDEFGHJK');
    assert.equal(capability.status, 'active');

    const input = {
      codeId: String(capability.codeId),
      code: 'FINL-ABCDEFGHJK',
      propertyId: PRIVILEGED_SUCCESS,
      authUserId: OWNER_SUCCESS_USER,
      username: 'owner-success',
      role: 'owner',
    };
    const wrongBearer = await finalize(pg, { ...input, code: 'NOPE-ABCDEFGHJK' });
    assert.deepEqual(wrongBearer, { ok: false, status: 'not_found' });
    await assertNoRelationalSignup(pg, PRIVILEGED_SUCCESS, OWNER_SUCCESS_USER);
    const committed = await finalize(pg, input);
    assert.equal(committed.ok, true);
    assert.equal(committed.status, 'finalized');
    assert.equal(committed.pendingApproval, false);
    assert.equal(committed.usedCount, 1);

    const state = await pg.query<{
      owner_id: string;
      step: number;
      account_created: string | null;
      used_count: number;
      account_access: string[];
      audit_count: number;
    }>(
      `select property.owner_id,
              (property.onboarding_state->>'step')::integer as step,
              property.onboarding_state->>'accountCreatedAt' as account_created,
              code.used_count,
              account.property_access as account_access,
              (select count(*)::integer from admin_audit_log audit
                where audit.action='join_code.use'
                  and audit.target_id=code.id::text) as audit_count
       from properties property
       join hotel_join_codes code on code.hotel_id=property.id
       join accounts account on account.data_user_id=$2
       where property.id=$1`,
      [PRIVILEGED_SUCCESS, OWNER_SUCCESS_USER],
    );
    assert.equal(state.rows[0].owner_id, OWNER_SUCCESS_USER);
    assert.equal(state.rows[0].step, 3);
    assert.ok(state.rows[0].account_created);
    assert.equal(state.rows[0].used_count, 1);
    assert.deepEqual(state.rows[0].account_access, [PRIVILEGED_SUCCESS]);
    assert.equal(state.rows[0].audit_count, 1);

    const replay = await finalize(pg, input);
    assert.equal(replay.ok, true);
    assert.equal(replay.status, 'existing');
    assert.equal(replay.accountId, committed.accountId);
    const counts = await pg.query<{ accounts: number; audits: number }>(
      `select
         (select count(*)::integer from accounts where data_user_id=$1) as accounts,
         (select count(*)::integer from admin_audit_log
           where action='join_code.use' and actor_user_id=$1) as audits`,
      [OWNER_SUCCESS_USER],
    );
    assert.deepEqual(counts.rows[0], { accounts: 1, audits: 1 });
  });

  test('a hotel transfer between capability resolution and privileged finalization denies without partial rows', async () => {
    const minted = await mintPrivileged(pg, PRIVILEGED_TRANSFER, 'XFER-ABCDEFGHJK');
    const capability = await resolve(pg, 'XFER-ABCDEFGHJK');
    assert.equal(capability.status, 'active');

    await transfer(pg, PRIVILEGED_TRANSFER, ORG_A);
    const refused = await finalize(pg, {
      codeId: String(minted.codeId),
      code: 'XFER-ABCDEFGHJK',
      propertyId: PRIVILEGED_TRANSFER,
      authUserId: OWNER_TRANSFER_USER,
      username: 'owner-transfer',
      role: 'owner',
    });
    assert.deepEqual(refused, { ok: false, status: 'revoked' });
    await assertNoRelationalSignup(pg, PRIVILEGED_TRANSFER, OWNER_TRANSFER_USER);
    const state = await pg.query<{ owner_id: string; used_count: number; revoked: boolean }>(
      `select property.owner_id,code.used_count,(code.revoked_at is not null) as revoked
       from properties property join hotel_join_codes code on code.hotel_id=property.id
       where property.id=$1`,
      [PRIVILEGED_TRANSFER],
    );
    assert.deepEqual(state.rows[0], { owner_id: UID_ADMIN, used_count: 0, revoked: true });
  });

  test('ordinary staff finalization creates only a pending request and no hotel reach', async () => {
    const minted = await mintStaff(pg, STAFF_SUCCESS, 'STAF-ABCDEFGHJK');
    assert.equal(minted.ok, true);
    const capability = await resolve(pg, 'STAF-ABCDEFGHJK');
    assert.equal(capability.status, 'active');

    const committed = await finalize(pg, {
      codeId: String(capability.codeId),
      code: 'STAF-ABCDEFGHJK',
      propertyId: STAFF_SUCCESS,
      authUserId: STAFF_SUCCESS_USER,
      username: 'staff-success',
      role: 'housekeeping',
    });
    assert.equal(committed.ok, true);
    assert.equal(committed.pendingApproval, true);
    const rows = await pg.query<{
      role: string;
      property_access: string[];
      request_status: string;
      department: string;
      used_count: number;
    }>(
      `select account.role,account.property_access,
              request.status as request_status,request.department,code.used_count
       from accounts account
       join join_requests request on request.account_id=account.id
       join hotel_join_codes code on code.id=$2
       where account.data_user_id=$1`,
      [STAFF_SUCCESS_USER, String(capability.codeId)],
    );
    assert.deepEqual(rows.rows[0], {
      role: 'housekeeping',
      property_access: [],
      request_status: 'pending',
      department: 'housekeeping',
      used_count: 1,
    });
  });

  test('a hotel transfer between capability resolution and staff finalization denies and creates no pending account', async () => {
    const minted = await mintStaff(pg, STAFF_TRANSFER, 'MOVE-ABCDEFGHJK');
    const capability = await resolve(pg, 'MOVE-ABCDEFGHJK');
    assert.equal(capability.status, 'active');

    await transfer(pg, STAFF_TRANSFER, ORG_B);
    const refused = await finalize(pg, {
      codeId: String(minted.codeId),
      code: 'MOVE-ABCDEFGHJK',
      propertyId: STAFF_TRANSFER,
      authUserId: STAFF_TRANSFER_USER,
      username: 'staff-transfer',
      role: 'front_desk',
    });
    assert.deepEqual(refused, { ok: false, status: 'revoked' });
    await assertNoRelationalSignup(pg, STAFF_TRANSFER, STAFF_TRANSFER_USER);
  });

  test('an active relationship ending between resolution and finalization revokes the bearer immediately', async () => {
    const minted = await mintStaff(pg, STAFF_RELATIONSHIP_END, 'ENDS-ABCDEFGHJK');
    assert.equal((await resolve(pg, 'ENDS-ABCDEFGHJK')).status, 'active');
    await pg.query(
      `update organization_property_relationships
          set ends_at=clock_timestamp()
        where property_id=$1 and is_primary_grouping is true
          and starts_at <= clock_timestamp()
          and (ends_at is null or ends_at > clock_timestamp())`,
      [STAFF_RELATIONSHIP_END],
    );

    const refused = await finalize(pg, {
      codeId: String(minted.codeId),
      code: 'ENDS-ABCDEFGHJK',
      propertyId: STAFF_RELATIONSHIP_END,
      authUserId: STAFF_RELATIONSHIP_END_USER,
      username: 'relationship-end',
      role: 'maintenance',
    });
    assert.deepEqual(refused, { ok: false, status: 'revoked' });
    await assertNoRelationalSignup(
      pg, STAFF_RELATIONSHIP_END, STAFF_RELATIONSHIP_END_USER,
    );
  });

  test('mandatory audit failure rolls back code use, account, request, and property state', async () => {
    const minted = await mintStaff(pg, ROLLBACK_PROPERTY, 'BACK-ABCDEFGHJK');
    await pg.exec(`
      create or replace function public._test_reject_join_code_use_audit()
      returns trigger language plpgsql as $$
      begin
        if new.action = 'join_code.use' then
          raise exception 'forced join-code use audit failure';
        end if;
        return new;
      end;
      $$;
      create trigger trg_test_reject_join_code_use_audit
        before insert on public.admin_audit_log
        for each row execute function public._test_reject_join_code_use_audit();
    `);
    try {
      await assert.rejects(
        finalize(pg, {
          codeId: String(minted.codeId),
          code: 'BACK-ABCDEFGHJK',
          propertyId: ROLLBACK_PROPERTY,
          authUserId: ROLLBACK_USER,
          username: 'rollback-user',
          role: 'maintenance',
        }),
        /forced join-code use audit failure/i,
      );
      await assertNoRelationalSignup(pg, ROLLBACK_PROPERTY, ROLLBACK_USER);
      const code = await pg.query<{ used_count: number }>(
        `select used_count from hotel_join_codes where id=$1`,
        [String(minted.codeId)],
      );
      assert.equal(code.rows[0].used_count, 0);
    } finally {
      await pg.exec(`
        drop trigger if exists trg_test_reject_join_code_use_audit
          on public.admin_audit_log;
        drop function if exists public._test_reject_join_code_use_audit();
      `);
    }
  });
});
