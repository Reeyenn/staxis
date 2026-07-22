import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';

const PROPERTY_A = 'a1000000-0000-4000-8000-000000000001';
const PROPERTY_B = 'a1000000-0000-4000-8000-000000000002';

const ADMIN = 'a2000000-0000-4000-8000-000000000001';
const GM = 'a2000000-0000-4000-8000-000000000002';
const TARGET = 'a2000000-0000-4000-8000-000000000003';
const ROLE_TARGET = 'a2000000-0000-4000-8000-000000000004';
const ROLLBACK_TARGET = 'a2000000-0000-4000-8000-000000000005';
const OWNER = 'a2000000-0000-4000-8000-000000000006';
const LINE_STAFF = 'a2000000-0000-4000-8000-000000000007';
const NORMALIZED_OWNER = 'a2000000-0000-4000-8000-000000000008';
const TRANSFER_OLD_OWNER = 'a2000000-0000-4000-8000-000000000009';
const TRANSFER_NEW_OWNER = 'a2000000-0000-4000-8000-000000000010';
const ROLLBACK_OLD_OWNER = 'a2000000-0000-4000-8000-000000000011';
const ROLLBACK_NEW_OWNER = 'a2000000-0000-4000-8000-000000000012';

const ADMIN_AUTH = 'a3000000-0000-4000-8000-000000000001';
const GM_AUTH = 'a3000000-0000-4000-8000-000000000002';
const TARGET_AUTH = 'a3000000-0000-4000-8000-000000000003';
const ROLE_TARGET_AUTH = 'a3000000-0000-4000-8000-000000000004';
const ROLLBACK_TARGET_AUTH = 'a3000000-0000-4000-8000-000000000005';
const OWNER_AUTH = 'a3000000-0000-4000-8000-000000000006';
const LINE_STAFF_AUTH = 'a3000000-0000-4000-8000-000000000007';
const NORMALIZED_OWNER_AUTH = 'a3000000-0000-4000-8000-000000000008';
const TRANSFER_OLD_OWNER_AUTH = 'a3000000-0000-4000-8000-000000000009';
const TRANSFER_NEW_OWNER_AUTH = 'a3000000-0000-4000-8000-000000000010';
const ROLLBACK_OLD_OWNER_AUTH = 'a3000000-0000-4000-8000-000000000011';
const ROLLBACK_NEW_OWNER_AUTH = 'a3000000-0000-4000-8000-000000000012';

const OWNER_ORGANIZATION = 'a6000000-0000-4000-8000-000000000002';
const OWNER_MEMBERSHIP = 'a7000000-0000-4000-8000-000000000002';

const TARGET_OPERATION = 'a4000000-0000-4000-8000-000000000001';
const CONFLICTING_OPERATION = 'a4000000-0000-4000-8000-000000000002';
const GM_OPERATION = 'a4000000-0000-4000-8000-000000000003';
const ROLLBACK_TARGET_OPERATION = 'a4000000-0000-4000-8000-000000000004';
const TRANSFER_OPERATION = 'a4000000-0000-4000-8000-000000000005';
const TRANSFER_ROLLBACK_OPERATION = 'a4000000-0000-4000-8000-000000000006';
const PROCESSOR = 'a5000000-0000-4000-8000-000000000001';
const GLOBAL_TRANSFER_OPERATION = 'a4000000-0000-4000-8000-000000000008';
const TRANSFER_REPLAY_PENDING_OPERATION = 'a4000000-0000-4000-8000-000000000009';
const NORMALIZED_TARGET = 'a2000000-0000-4000-8000-000000000013';
const NORMALIZED_TARGET_AUTH = 'a3000000-0000-4000-8000-000000000013';

let pg: PGlite;

async function asRole<T>(
  role: 'anon' | 'authenticated' | 'service_role',
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  await pg.exec('begin');
  try {
    await pg.exec(`set local role ${role}`);
    await pg.query(`select set_config('request.jwt.claim.role', $1, true)`, [role]);
    const result = await pg.query(sql, params) as { rows: Array<Record<string, unknown>> };
    await pg.exec('commit');
    return Object.values(result.rows[0] ?? {})[0] as T;
  } catch (error) {
    await pg.exec('rollback').catch(() => undefined);
    throw error;
  }
}

function serviceJson(sql: string, params: unknown[] = []): Promise<Record<string, unknown>> {
  return asRole<Record<string, unknown>>('service_role', sql, params);
}

function registerIntent(args: {
  operationId: string;
  actor?: string;
  actorAuth?: string;
  target?: string;
  targetAuth?: string;
  desiredActive?: boolean;
  expectedRole?: string;
  expectedProperties?: string[];
}): Promise<Record<string, unknown>> {
  const properties = args.expectedProperties ?? [PROPERTY_A, PROPERTY_B];
  return serviceJson(
    `select public.staxis_register_account_lifecycle_intent(
       $1,$2,$3,'actor@example.test',$4,$5,$6,true,$7,$8,$9::uuid[],0
     )`,
    [
      args.operationId,
      args.actor ?? ADMIN,
      args.actorAuth ?? ADMIN_AUTH,
      PROPERTY_A,
      args.target ?? TARGET,
      args.desiredActive ?? false,
      args.expectedRole ?? 'housekeeping',
      args.targetAuth ?? TARGET_AUTH,
      properties,
    ],
  );
}

async function guardedRole(args: {
  actor?: string;
  actorAuth?: string;
  target: string;
  targetAuth: string;
  expectedRole: string;
  properties?: string[];
  newRole?: string;
  expectedDisplayName: string;
  expectedUpdatedAt?: string;
}): Promise<Record<string, unknown>> {
  const properties = args.properties ?? [PROPERTY_A, PROPERTY_B];
  const expectedUpdatedAt = args.expectedUpdatedAt ?? (
    await pg.query<{ updated_at: string }>(
      'select updated_at::text as updated_at from public.accounts where id=$1',
      [args.target],
    )
  ).rows[0]?.updated_at;
  assert.ok(expectedUpdatedAt, `missing updated_at for role target ${args.target}`);
  return serviceJson(
    `select public.staxis_change_hotel_team_role_guarded(
       $1,$2,'manager@example.test',$3,$4,$5,null,true,$6,$7,$8::uuid[],$9,$10::timestamptz,0,'role-request'
     )`,
    [
      args.actor ?? GM,
      args.actorAuth ?? GM_AUTH,
      PROPERTY_A,
      args.target,
      args.newRole ?? 'maintenance',
      args.expectedRole,
      args.targetAuth,
      properties,
      args.expectedDisplayName,
      expectedUpdatedAt,
    ],
  );
}

async function guardedTransferCurrentSnapshots(
  operationId: string,
  oldOwnerId: string,
  newOwnerId: string,
  actorId = oldOwnerId,
  actorAuthId = OWNER_AUTH,
): Promise<Record<string, unknown>> {
  const snapshots = await pg.query<{
    id: string;
    active: boolean;
    role: string;
    data_user_id: string;
    property_access: string[];
    lifecycle_intent_version: number;
  }>(
    `select id,active,role::text,data_user_id,property_access,lifecycle_intent_version
       from public.accounts where id=any($1::uuid[])`,
    [[oldOwnerId, newOwnerId]],
  );
  const byId = new Map(snapshots.rows.map((row) => [row.id, row]));
  const oldOwner = byId.get(oldOwnerId);
  const newOwner = byId.get(newOwnerId);
  assert.ok(oldOwner && newOwner);
  return serviceJson(
    `select public.staxis_transfer_ownership_guarded(
       $1,$2,$3,'owner@example.test',$4,$5,$6,
       $7,$8,$9,$10::uuid[],$11,
       $12,$13,$14,$15::uuid[],$16,$17,$18
     )`,
    [
      operationId, actorId, actorAuthId, PROPERTY_A, oldOwnerId, newOwnerId,
      oldOwner.active, oldOwner.role, oldOwner.data_user_id,
      oldOwner.property_access, oldOwner.lifecycle_intent_version,
      newOwner.active, newOwner.role, newOwner.data_user_id,
      newOwner.property_access, newOwner.lifecycle_intent_version,
      'ownership handoff', `request-${operationId}`,
    ],
  );
}

function guardedTransfer(args: {
  operationId: string;
  oldOwner: string;
  oldOwnerAuth: string;
  oldProperties: string[];
  newOwner: string;
  newOwnerAuth: string;
  newOwnerRole: string;
  newProperties: string[];
  requestId: string;
}): Promise<Record<string, unknown>> {
  return serviceJson(
    `select public.staxis_transfer_ownership_guarded(
       $1::uuid,$2::uuid,$3::uuid,'admin@example.test'::text,
       $4::uuid,$5::uuid,$6::uuid,
       true,'owner'::text,$7::uuid,$8::uuid[],0::bigint,
       true,$9::text,$10::uuid,$11::uuid[],0::bigint,
       'Planned handoff'::text,$12::text
     )`,
    [
      args.operationId,
      ADMIN,
      ADMIN_AUTH,
      PROPERTY_A,
      args.oldOwner,
      args.newOwner,
      args.oldOwnerAuth,
      args.oldProperties,
      args.newOwnerRole,
      args.newOwnerAuth,
      args.newProperties,
      args.requestId,
    ],
  );
}

describe('account lifecycle migration 0335 — real SQL via PGlite', () => {
  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    assert.ok(
      migrated.report.applied.includes('0335_account_lifecycle_intents.sql'),
      `0335 must apply in PGlite: ${JSON.stringify(
        migrated.report.failedAtRuntime.filter((entry) => entry.file.startsWith('0335')),
      )}`,
    );

    await pg.query(
      `insert into auth.users(id,email) values
         ($1,'admin-lifecycle@example.test'),
         ($2,'gm-lifecycle@example.test'),
         ($3,'target-lifecycle@example.test'),
         ($4,'role-target-lifecycle@example.test'),
         ($5,'rollback-target-lifecycle@example.test'),
         ($6,'owner-lifecycle@example.test'),
         ($7,'line-staff-lifecycle@example.test'),
         ($8,'normalized-owner-lifecycle@example.test'),
         ($9,'transfer-old-owner@example.test'),
         ($10,'transfer-new-owner@example.test'),
         ($11,'rollback-old-owner@example.test'),
         ($12,'rollback-new-owner@example.test')`,
      [
        ADMIN_AUTH, GM_AUTH, TARGET_AUTH, ROLE_TARGET_AUTH,
        ROLLBACK_TARGET_AUTH, OWNER_AUTH, LINE_STAFF_AUTH, NORMALIZED_OWNER_AUTH,
        TRANSFER_OLD_OWNER_AUTH, TRANSFER_NEW_OWNER_AUTH,
        ROLLBACK_OLD_OWNER_AUTH, ROLLBACK_NEW_OWNER_AUTH,
      ],
    );
    await pg.query(
      `insert into public.properties(id,owner_id,name,total_rooms,timezone) values
         ($1,$3,'Lifecycle Hotel A',40,'UTC'),
         ($2,$3,'Lifecycle Hotel B',30,'UTC')`,
      [PROPERTY_A, PROPERTY_B, OWNER_AUTH],
    );
    await pg.query(
      `insert into public.accounts(
         id,username,display_name,role,property_access,data_user_id
       ) values
         ($1,'lifecycle-admin','Lifecycle Admin','admin','{}'::uuid[],$2),
         ($3,'lifecycle-gm','Lifecycle GM','general_manager',array[$4,$5]::uuid[],$6),
         ($7,'lifecycle-target','Lifecycle Target','housekeeping',array[$4,$5]::uuid[],$8),
         ($9,'lifecycle-role-target','Role Target','front_desk',array[$4,$5]::uuid[],$10),
         ($11,'lifecycle-rollback-target','Rollback Target','front_desk',array[$4]::uuid[],$12),
         ($13,'lifecycle-owner','Lifecycle Owner','owner',array[$4]::uuid[],$14),
         ($15,'lifecycle-line-staff','Lifecycle Line Staff','housekeeping',array[$4]::uuid[],$16),
         ($17,'lifecycle-normalized-owner','Normalized Owner','general_manager',array[$4]::uuid[],$18)`,
      [
        ADMIN, ADMIN_AUTH, GM, PROPERTY_A, PROPERTY_B, GM_AUTH,
        TARGET, TARGET_AUTH, ROLE_TARGET, ROLE_TARGET_AUTH,
        ROLLBACK_TARGET, ROLLBACK_TARGET_AUTH, OWNER, OWNER_AUTH,
        LINE_STAFF, LINE_STAFF_AUTH, NORMALIZED_OWNER, NORMALIZED_OWNER_AUTH,
      ],
    );
    await pg.query(
      `insert into public.accounts(
         id,username,display_name,role,property_access,data_user_id
       ) values
         ($1,'lifecycle-transfer-old','Transfer Old Owner','owner',array[$9,$10]::uuid[],$2),
         ($3,'lifecycle-transfer-new','Transfer New Owner','housekeeping',array[$9,$10]::uuid[],$4),
         ($5,'lifecycle-rollback-old','Rollback Old Owner','owner',array[$9]::uuid[],$6),
         ($7,'lifecycle-rollback-new','Rollback New Owner','front_desk',array[$9]::uuid[],$8)`,
      [
        TRANSFER_OLD_OWNER, TRANSFER_OLD_OWNER_AUTH,
        TRANSFER_NEW_OWNER, TRANSFER_NEW_OWNER_AUTH,
        ROLLBACK_OLD_OWNER, ROLLBACK_OLD_OWNER_AUTH,
        ROLLBACK_NEW_OWNER, ROLLBACK_NEW_OWNER_AUTH,
        PROPERTY_A, PROPERTY_B,
      ],
    );
    await pg.query(
      `insert into public.organizations(id,name,organization_type,status)
       values ($1,'Real Lifecycle Ownership Group','ownership_group','active')`,
      [OWNER_ORGANIZATION],
    );
    await pg.query(
      `insert into public.organization_memberships(
         id,organization_id,account_id,job_category,status
       ) values ($1,$2,$3,'owner_principal','active')`,
      [OWNER_MEMBERSHIP, OWNER_ORGANIZATION, NORMALIZED_OWNER],
    );
    await pg.query(
      `insert into public.organization_access_grants(
         organization_id,membership_id,access_profile,scope_type,status,source
       ) values ($1,$2,'organization_owner','organization','active','manual')`,
      [OWNER_ORGANIZATION, OWNER_MEMBERSHIP],
    );
  });

  after(async () => {
    await pg.close();
  });

  test('browser roles cannot inspect intents or execute lifecycle functions', async () => {
    const privileges = await pg.query<{
      anon_table: boolean;
      browser_table: boolean;
      service_table: boolean;
      browser_has_any_rpc: boolean;
      service_has_every_rpc: boolean;
    }>(`
      select
        has_table_privilege('anon','public.account_lifecycle_intents','SELECT') as anon_table,
        has_table_privilege('authenticated','public.account_lifecycle_intents','SELECT') as browser_table,
        has_table_privilege('service_role','public.account_lifecycle_intents','SELECT') as service_table,
        exists (
          select 1 from pg_proc function_row
          join pg_namespace namespace on namespace.oid=function_row.pronamespace
          where namespace.nspname='public'
            and (function_row.proname like 'staxis%account_lifecycle%'
              or function_row.proname in (
                'staxis_change_hotel_team_role_guarded',
                'staxis_transfer_ownership_guarded',
                'staxis_list_normalized_organization_owner_account_ids'
              ))
            and (has_function_privilege('anon',function_row.oid,'EXECUTE')
              or has_function_privilege('authenticated',function_row.oid,'EXECUTE'))
        ) as browser_has_any_rpc,
        (select bool_and(has_function_privilege('service_role',function_row.oid,'EXECUTE'))
          from pg_proc function_row
          join pg_namespace namespace on namespace.oid=function_row.pronamespace
          where namespace.nspname='public'
            and (function_row.proname like 'staxis%account_lifecycle%'
              or function_row.proname in (
                'staxis_change_hotel_team_role_guarded',
                'staxis_transfer_ownership_guarded',
                'staxis_list_normalized_organization_owner_account_ids'
              ))
        ) as service_has_every_rpc
    `);
    assert.deepEqual(privileges.rows[0], {
      anon_table: false,
      browser_table: false,
      service_table: true,
      browser_has_any_rpc: false,
      service_has_every_rpc: true,
    });

    await assert.rejects(
      asRole('authenticated', 'select * from public.account_lifecycle_intents'),
      /permission denied/i,
    );
    await assert.rejects(
      asRole(
        'authenticated',
        `select public.staxis_get_account_lifecycle_intent($1)`,
        [TARGET_OPERATION],
      ),
      /permission denied/i,
    );
    assert.equal(
      (await serviceJson(
        `select public.staxis_get_account_lifecycle_intent($1)`,
        [TARGET_OPERATION],
      )).status,
      'not_found',
    );
  });

  test('projects only effective normalized organization owners for server UI decisions', async () => {
    const protectedIds = await asRole<string[]>(
      'service_role',
      `select public.staxis_list_normalized_organization_owner_account_ids(
         array[$1,$2]::uuid[]
       )`,
      [NORMALIZED_OWNER, ROLE_TARGET],
    );
    assert.deepEqual(protectedIds, [NORMALIZED_OWNER]);
  });

  test('registration authorizes, compares snapshots, and leaves active inert', async () => {
    const denied = await registerIntent({
      operationId: CONFLICTING_OPERATION,
      actor: LINE_STAFF,
      actorAuth: LINE_STAFF_AUTH,
    });
    assert.deepEqual(denied, { status: 'forbidden', reason: 'caller_role' });

    const stale = await registerIntent({
      operationId: CONFLICTING_OPERATION,
      expectedRole: 'maintenance',
    });
    assert.equal(stale.status, 'conflict');

    const registered = await registerIntent({ operationId: TARGET_OPERATION });
    assert.equal(registered.status, 'pending');
    assert.equal(registered.intent_version, 1);
    assert.equal(registered.active, true);

    const account = await pg.query<{
      active: boolean;
      lifecycle_desired_active: boolean;
      lifecycle_intent_version: number;
      lifecycle_committed_version: number;
    }>(
      `select active,lifecycle_desired_active,lifecycle_intent_version,lifecycle_committed_version
         from public.accounts where id=$1`,
      [TARGET],
    );
    assert.deepEqual(account.rows[0], {
      active: true,
      lifecycle_desired_active: false,
      lifecycle_intent_version: 1,
      lifecycle_committed_version: 0,
    });

    const conflict = await registerIntent({ operationId: CONFLICTING_OPERATION });
    assert.equal(conflict.status, 'pending_conflict');
    await assert.rejects(
      pg.query(`update public.accounts set display_name='Changed' where id=$1`, [TARGET]),
      /account lifecycle change pending/i,
    );

    const targetPending = await guardedRole({
      target: TARGET,
      targetAuth: TARGET_AUTH,
      expectedRole: 'housekeeping',
      expectedDisplayName: 'Lifecycle Target',
    });
    assert.equal(targetPending.status, 'pending_conflict');

    const ownerRejected = await registerIntent({
      operationId: CONFLICTING_OPERATION,
      target: OWNER,
      targetAuth: OWNER_AUTH,
      expectedRole: 'owner',
      expectedProperties: [PROPERTY_A],
    });
    assert.deepEqual(ownerRejected, { status: 'forbidden', reason: 'target_role' });
  });

  test('guarded role changes write all audit rows and roll back on audit failure', async () => {
    const changed = await guardedRole({
      target: ROLE_TARGET,
      targetAuth: ROLE_TARGET_AUTH,
      expectedRole: 'front_desk',
      expectedDisplayName: 'Role Target',
    });
    assert.equal(changed.status, 'ok');

    const changedState = await pg.query<{ role: string; role_rows: string; audit_rows: string }>(
      `select account.role,
          (select count(*) from public.role_changes where account_id=account.id)::text as role_rows,
          (select count(*) from public.admin_audit_log
            where action='account.team_update' and target_id=account.id::text)::text as audit_rows
       from public.accounts account where account.id=$1`,
      [ROLE_TARGET],
    );
    assert.deepEqual(changedState.rows[0], {
      role: 'maintenance',
      role_rows: '2',
      audit_rows: '1',
    });

    const dialogSnapshot = await pg.query<{ updated_at: string }>(
      'select updated_at::text as updated_at from public.accounts where id=$1',
      [ROLE_TARGET],
    );
    await pg.query(
      `update public.accounts set display_name='Role Target Concurrent' where id=$1`,
      [ROLE_TARGET],
    );
    const staleDialog = await guardedRole({
      target: ROLE_TARGET,
      targetAuth: ROLE_TARGET_AUTH,
      expectedRole: 'maintenance',
      expectedDisplayName: 'Role Target',
      expectedUpdatedAt: dialogSnapshot.rows[0]?.updated_at,
      newRole: 'front_desk',
    });
    assert.equal(staleDialog.status, 'conflict');
    const staleState = await pg.query<{ role: string; display_name: string }>(
      'select role,display_name from public.accounts where id=$1',
      [ROLE_TARGET],
    );
    assert.deepEqual(staleState.rows[0], {
      role: 'maintenance',
      display_name: 'Role Target Concurrent',
    });

    await pg.exec(`
      create function public.test_reject_lifecycle_role_audit()
      returns trigger language plpgsql as $$
      begin
        if new.action = 'account.team_update' and new.target_id = '${ROLLBACK_TARGET}' then
          raise exception 'test audit failure';
        end if;
        return new;
      end;
      $$;
      create trigger test_reject_lifecycle_role_audit
      before insert on public.admin_audit_log
      for each row execute function public.test_reject_lifecycle_role_audit();
    `);
    try {
      await assert.rejects(
        guardedRole({
          target: ROLLBACK_TARGET,
          targetAuth: ROLLBACK_TARGET_AUTH,
          expectedRole: 'front_desk',
          expectedDisplayName: 'Rollback Target',
          properties: [PROPERTY_A],
        }),
        /test audit failure/i,
      );
    } finally {
      await pg.exec(`
        drop trigger test_reject_lifecycle_role_audit on public.admin_audit_log;
        drop function public.test_reject_lifecycle_role_audit();
      `);
    }
    const rolledBack = await pg.query<{ role: string; role_rows: string }>(
      `select account.role,
          (select count(*) from public.role_changes where account_id=account.id)::text as role_rows
       from public.accounts account where account.id=$1`,
      [ROLLBACK_TARGET],
    );
    assert.deepEqual(rolledBack.rows[0], { role: 'front_desk', role_rows: '0' });

    const gmPending = await registerIntent({
      operationId: GM_OPERATION,
      target: GM,
      targetAuth: GM_AUTH,
      expectedRole: 'general_manager',
    });
    assert.equal(gmPending.status, 'pending');
    const actorPending = await guardedRole({
      actor: GM,
      actorAuth: GM_AUTH,
      target: ROLLBACK_TARGET,
      targetAuth: ROLLBACK_TARGET_AUTH,
      expectedRole: 'front_desk',
      expectedDisplayName: 'Rollback Target',
      properties: [PROPERTY_A],
    });
    assert.equal(actorPending.status, 'pending_conflict');

    const ownerTarget = await guardedRole({
      actor: ADMIN,
      actorAuth: ADMIN_AUTH,
      target: OWNER,
      targetAuth: OWNER_AUTH,
      expectedRole: 'owner',
      expectedDisplayName: 'Lifecycle Owner',
      properties: [PROPERTY_A],
    });
    assert.deepEqual(ownerTarget, { status: 'forbidden', reason: 'target' });

    const normalizedOwnerTarget = await guardedRole({
      actor: ADMIN,
      actorAuth: ADMIN_AUTH,
      target: NORMALIZED_OWNER,
      targetAuth: NORMALIZED_OWNER_AUTH,
      expectedRole: 'general_manager',
      expectedDisplayName: 'Normalized Owner',
      properties: [PROPERTY_A],
    });
    assert.deepEqual(normalizedOwnerTarget, {
      status: 'forbidden',
      reason: 'organization_owner',
    });
    const normalizedOwnerState = await pg.query<{ role: string; role_rows: string }>(
      `select account.role,
          (select count(*) from public.role_changes where account_id=account.id)::text as role_rows
       from public.accounts account where account.id=$1`,
      [NORMALIZED_OWNER],
    );
    assert.deepEqual(normalizedOwnerState.rows[0], {
      role: 'general_manager',
      role_rows: '0',
    });
  });

  test('pending lifecycle state fences ownership transfer', async () => {
    const transfer = await asRole<string>(
      'service_role',
      `select public.staxis_transfer_ownership($1,$2,$3)`,
      [PROPERTY_A, OWNER, TARGET],
    );
    assert.match(transfer, /account lifecycle change pending/);

    const roles = await pg.query<{ id: string; role: string }>(
      `select id,role from public.accounts where id=any($1::uuid[]) order by id`,
      [[OWNER, TARGET]],
    );
    assert.deepEqual(roles.rows, [
      { id: TARGET, role: 'housekeeping' },
      { id: OWNER, role: 'owner' },
    ]);
  });

  test('guarded ownership transfer is atomic and operation-id idempotent', async () => {
    const transferArgs = {
      operationId: TRANSFER_OPERATION,
      oldOwner: TRANSFER_OLD_OWNER,
      oldOwnerAuth: TRANSFER_OLD_OWNER_AUTH,
      oldProperties: [PROPERTY_A, PROPERTY_B],
      newOwner: TRANSFER_NEW_OWNER,
      newOwnerAuth: TRANSFER_NEW_OWNER_AUTH,
      newOwnerRole: 'housekeeping',
      newProperties: [PROPERTY_A, PROPERTY_B],
      requestId: 'ownership-success-request',
    };
    const transferred = await guardedTransfer(transferArgs);
    assert.deepEqual(transferred, {
      status: 'ok',
      operation_id: TRANSFER_OPERATION,
      old_owner_account_id: TRANSFER_OLD_OWNER,
      new_owner_account_id: TRANSFER_NEW_OWNER,
    });

    const state = await pg.query<{
      old_role: string;
      new_role: string;
      old_role_rows: string;
      new_role_rows: string;
      audit_rows: string;
      reason: string;
    }>(
      `select
        (select role from public.accounts where id=$1) as old_role,
        (select role from public.accounts where id=$2) as new_role,
        (select count(*) from public.role_changes
          where account_id=$1 and change_kind='transfer_ownership')::text as old_role_rows,
        (select count(*) from public.role_changes
          where account_id=$2 and change_kind='transfer_ownership')::text as new_role_rows,
        (select count(*) from public.admin_audit_log
          where action='account.transfer_ownership'
            and target_id=$2::text
            and metadata->>'request_id'=$3)::text as audit_rows,
        (select metadata->>'reason' from public.admin_audit_log
          where action='account.transfer_ownership'
            and target_id=$2::text
            and metadata->>'request_id'=$3) as reason`,
      [TRANSFER_OLD_OWNER, TRANSFER_NEW_OWNER, transferArgs.requestId],
    );
    assert.deepEqual(state.rows[0], {
      old_role: 'general_manager',
      new_role: 'owner',
      old_role_rows: '2',
      new_role_rows: '2',
      audit_rows: '1',
      reason: 'Planned handoff',
    });

    const replay = await guardedTransfer({
      ...transferArgs,
      requestId: 'ownership-success-retry-request',
    });
    assert.deepEqual(replay, {
      status: 'already_applied',
      operation_id: TRANSFER_OPERATION,
      old_owner_account_id: TRANSFER_OLD_OWNER,
      new_owner_account_id: TRANSFER_NEW_OWNER,
    });
    const replayCounts = await pg.query<{ role_rows: string; audit_rows: string }>(
      `select
        (select count(*) from public.role_changes
          where account_id=any($1::uuid[]) and change_kind='transfer_ownership')::text as role_rows,
        (select count(*) from public.admin_audit_log
          where action='account.transfer_ownership'
            and metadata->>'request_id'=$2)::text as audit_rows`,
      [[TRANSFER_OLD_OWNER, TRANSFER_NEW_OWNER], transferArgs.requestId],
    );
    assert.deepEqual(replayCounts.rows[0], { role_rows: '4', audit_rows: '1' });

    await pg.exec(`
      create function public.test_reject_guarded_ownership_audit()
      returns trigger language plpgsql as $$
      begin
        if new.action = 'account.transfer_ownership'
           and new.target_id = '${ROLLBACK_NEW_OWNER}' then
          raise exception 'test ownership audit failure';
        end if;
        return new;
      end;
      $$;
      create trigger test_reject_guarded_ownership_audit
      before insert on public.admin_audit_log
      for each row execute function public.test_reject_guarded_ownership_audit();
    `);
    try {
      await assert.rejects(
        guardedTransfer({
          operationId: TRANSFER_ROLLBACK_OPERATION,
          oldOwner: ROLLBACK_OLD_OWNER,
          oldOwnerAuth: ROLLBACK_OLD_OWNER_AUTH,
          oldProperties: [PROPERTY_A],
          newOwner: ROLLBACK_NEW_OWNER,
          newOwnerAuth: ROLLBACK_NEW_OWNER_AUTH,
          newOwnerRole: 'front_desk',
          newProperties: [PROPERTY_A],
          requestId: 'ownership-rollback-request',
        }),
        /test ownership audit failure/i,
      );
    } finally {
      await pg.exec(`
        drop trigger test_reject_guarded_ownership_audit on public.admin_audit_log;
        drop function public.test_reject_guarded_ownership_audit();
      `);
    }
    const rolledBack = await pg.query<{
      old_role: string;
      new_role: string;
      role_rows: string;
      audit_rows: string;
    }>(
      `select
        (select role from public.accounts where id=$1) as old_role,
        (select role from public.accounts where id=$2) as new_role,
        (select count(*) from public.role_changes
          where account_id=any($3::uuid[]) and change_kind='transfer_ownership')::text as role_rows,
        (select count(*) from public.admin_audit_log
          where action='account.transfer_ownership'
            and metadata->>'request_id'='ownership-rollback-request')::text as audit_rows`,
      [
        ROLLBACK_OLD_OWNER,
        ROLLBACK_NEW_OWNER,
        [ROLLBACK_OLD_OWNER, ROLLBACK_NEW_OWNER],
      ],
    );
    assert.deepEqual(rolledBack.rows[0], {
      old_role: 'owner',
      new_role: 'front_desk',
      role_rows: '0',
      audit_rows: '0',
    });
  });

  test('verified commit atomically changes active and writes per-hotel and admin audits', async () => {
    const claimed = await serviceJson(
      `select public.staxis_claim_account_lifecycle_intent($1,$2,120)`,
      [TARGET_OPERATION, PROCESSOR],
    );
    assert.equal(claimed.status, 'claimed');

    const snapshotted = await serviceJson(
      `select public.staxis_record_account_lifecycle_auth_snapshot($1,'infinity',$2)`,
      [TARGET_OPERATION, PROCESSOR],
    );
    assert.equal(snapshotted.status, 'pending');

    const committed = await serviceJson(
      `select public.staxis_commit_account_lifecycle_intent($1,'lifecycle-request',$2)`,
      [TARGET_OPERATION, PROCESSOR],
    );
    assert.equal(committed.status, 'committed');
    assert.equal(committed.active, false);
    assert.equal(committed.noop, false);

    const state = await pg.query<{
      active: boolean;
      lifecycle_committed_version: number;
      status: string;
      processor_token: string | null;
      role_rows: string;
      hotels: string[];
      audit_rows: string;
      request_id: string;
    }>(
      `select account.active, account.lifecycle_committed_version,
          intent.status, intent.processor_token,
          (select count(*) from public.role_changes
            where account_id=account.id and change_kind='deactivate')::text as role_rows,
          (select array_agg(property_id::text order by property_id)
             from public.role_changes
            where account_id=account.id and change_kind='deactivate') as hotels,
          (select count(*) from public.admin_audit_log
            where action='account.deactivate' and target_id=account.id::text)::text as audit_rows,
          (select metadata->>'request_id' from public.admin_audit_log
            where action='account.deactivate' and target_id=account.id::text) as request_id
       from public.accounts account
       join public.account_lifecycle_intents intent on intent.account_id=account.id
       where account.id=$1 and intent.operation_id=$2`,
      [TARGET, TARGET_OPERATION],
    );
    assert.deepEqual(state.rows[0], {
      active: false,
      lifecycle_committed_version: 1,
      status: 'committed',
      processor_token: null,
      role_rows: '2',
      hotels: [PROPERTY_A, PROPERTY_B],
      audit_rows: '1',
      request_id: 'lifecycle-request',
    });

    const retry = await serviceJson(
      `select public.staxis_commit_account_lifecycle_intent($1,'ignored',$2)`,
      [TARGET_OPERATION, PROCESSOR],
    );
    assert.equal(retry.status, 'committed');
    const counts = await pg.query<{ role_rows: string; audit_rows: string }>(
      `select
        (select count(*) from public.role_changes
          where account_id=$1 and change_kind='deactivate')::text as role_rows,
        (select count(*) from public.admin_audit_log
          where action='account.deactivate' and target_id=$1::text)::text as audit_rows`,
      [TARGET],
    );
    assert.deepEqual(counts.rows[0], { role_rows: '2', audit_rows: '1' });
  });

  test('a pending lifecycle target cannot be promoted through an owner grant', async () => {
    const pending = await registerIntent({
      operationId: ROLLBACK_TARGET_OPERATION,
      target: ROLLBACK_TARGET,
      targetAuth: ROLLBACK_TARGET_AUTH,
      expectedRole: 'front_desk',
      expectedProperties: [PROPERTY_A],
    });
    assert.equal(pending.status, 'pending');

    const organization = 'a6000000-0000-4000-8000-000000000001';
    const membership = 'a7000000-0000-4000-8000-000000000001';
    await pg.query(
      `insert into public.organizations(id,name,organization_type,status)
       values ($1,'Lifecycle Ownership Group','ownership_group','active')`,
      [organization],
    );
    await pg.query(
      `insert into public.organization_memberships(
         id,organization_id,account_id,job_category,status
       ) values ($1,$2,$3,'owner_principal','active')`,
      [membership, organization, ROLLBACK_TARGET],
    );
    await assert.rejects(
      pg.query(
        `insert into public.organization_access_grants(
           organization_id,membership_id,access_profile,scope_type,status,source
         ) values ($1,$2,'organization_owner','organization','active','manual')`,
        [organization, membership],
      ),
      /account lifecycle change pending/i,
    );
    const grants = await pg.query<{ count: string }>(
      `select count(*)::text as count from public.organization_access_grants
       where membership_id=$1`,
      [membership],
    );
    assert.equal(grants.rows[0].count, '0');
  });

  test('ownership transfer is global, normalized-owner safe, atomic, and replayable after later pending work', async () => {
    const mismatchedLegacy = await asRole<string>(
      'service_role',
      `select public.staxis_transfer_ownership($1,$2,$3)`,
      [PROPERTY_A, OWNER, ROLE_TARGET],
    );
    assert.match(mismatchedLegacy, /same hotel access/i);

    await pg.query(
      `insert into auth.users(id,email) values ($1,'normalized-owner@example.test')`,
      [NORMALIZED_TARGET_AUTH],
    );
    await pg.query(
      `insert into public.accounts(
         id,username,display_name,role,property_access,data_user_id
       ) values ($1,'normalized-owner','Normalized Owner','front_desk',array[$2]::uuid[],$3)`,
      [NORMALIZED_TARGET, PROPERTY_A, NORMALIZED_TARGET_AUTH],
    );
    const organization = 'a6000000-0000-4000-8000-000000000003';
    const membership = 'a7000000-0000-4000-8000-000000000003';
    await pg.query(
      `insert into public.organizations(id,name,organization_type,status)
       values ($1,'Real Ownership Group','ownership_group','active')`,
      [organization],
    );
    await pg.query(
      `insert into public.organization_memberships(
         id,organization_id,account_id,job_category,status
       ) values ($1,$2,$3,'owner_principal','active')`,
      [membership, organization, NORMALIZED_TARGET],
    );
    await pg.query(
      `insert into public.organization_access_grants(
         organization_id,membership_id,access_profile,scope_type,status,source
       ) values ($1,$2,'organization_owner','organization','active','manual')`,
      [organization, membership],
    );

    const normalizedRejected = await guardedTransferCurrentSnapshots(
      'a4000000-0000-4000-8000-000000000007',
      OWNER,
      NORMALIZED_TARGET,
    );
    assert.deepEqual(normalizedRejected, {
      status: 'forbidden',
      reason: 'normalized_organization_owner',
    });
    const normalizedLegacy = await asRole<string>(
      'service_role',
      `select public.staxis_transfer_ownership($1,$2,$3)`,
      [PROPERTY_A, OWNER, NORMALIZED_TARGET],
    );
    assert.match(normalizedLegacy, /organization ownership.*separately/i);

    const transferred = await guardedTransferCurrentSnapshots(
      GLOBAL_TRANSFER_OPERATION,
      OWNER,
      LINE_STAFF,
    );
    assert.equal(transferred.status, 'ok');
    const afterTransfer = await pg.query<{
      old_role: string;
      new_role: string;
      role_rows: string;
      audit_rows: string;
    }>(
      `select
         (select role::text from public.accounts where id=$1) as old_role,
         (select role::text from public.accounts where id=$2) as new_role,
         (select count(*)::text from public.role_changes
           where account_id=any($3::uuid[]) and change_kind='transfer_ownership') as role_rows,
         (select count(*)::text from public.admin_audit_log
           where action='account.transfer_ownership'
             and metadata->>'operation_id'=$4) as audit_rows`,
      [OWNER, LINE_STAFF, [OWNER, LINE_STAFF], GLOBAL_TRANSFER_OPERATION],
    );
    assert.deepEqual(afterTransfer.rows[0], {
      old_role: 'general_manager',
      new_role: 'owner',
      role_rows: '2',
      audit_rows: '1',
    });

    const laterPending = await registerIntent({
      operationId: TRANSFER_REPLAY_PENDING_OPERATION,
      target: OWNER,
      targetAuth: OWNER_AUTH,
      expectedRole: 'general_manager',
      expectedProperties: [PROPERTY_A],
    });
    assert.equal(laterPending.status, 'pending');

    const replay = await guardedTransferCurrentSnapshots(
      GLOBAL_TRANSFER_OPERATION,
      OWNER,
      LINE_STAFF,
    );
    assert.equal(replay.status, 'already_applied');
    const replayCounts = await pg.query<{ role_rows: string; audit_rows: string }>(
      `select
         (select count(*)::text from public.role_changes
           where account_id=any($1::uuid[]) and change_kind='transfer_ownership') as role_rows,
         (select count(*)::text from public.admin_audit_log
           where action='account.transfer_ownership'
             and metadata->>'operation_id'=$2) as audit_rows`,
      [[OWNER, LINE_STAFF], GLOBAL_TRANSFER_OPERATION],
    );
    assert.deepEqual(replayCounts.rows[0], { role_rows: '2', audit_rows: '1' });
  });
});
