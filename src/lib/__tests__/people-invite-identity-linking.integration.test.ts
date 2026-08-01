import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_MARIA,
  ACCOUNT_WANDA,
  ORG_A,
  PID_A1,
  PID_L1,
  UID_MARIA,
  UID_WANDA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const INVITE_STAFF = 'f4160000-0000-4000-8000-000000000001';
const INVITE_AUTH_USER = 'f4160000-0000-4000-8000-000000000002';
const INVITE_CLAIM = 'f4160000-0000-4000-8000-000000000003';

const LEGACY_TARGET_ACCOUNT = 'f4160000-0000-4000-8000-000000000010';
const LEGACY_TARGET_AUTH_USER = 'f4160000-0000-4000-8000-000000000011';
const LEGACY_TARGET_STAFF = 'f4160000-0000-4000-8000-000000000012';
const NORMALIZED_TARGET_ACCOUNT = 'f4160000-0000-4000-8000-000000000020';
const NORMALIZED_TARGET_AUTH_USER = 'f4160000-0000-4000-8000-000000000021';
const NORMALIZED_TARGET_STAFF = 'f4160000-0000-4000-8000-000000000022';
const ROLE_CONFLICT_ACCOUNT = 'f4160000-0000-4000-8000-000000000030';
const ROLE_CONFLICT_AUTH_USER = 'f4160000-0000-4000-8000-000000000031';

const JOIN_ACCOUNT = 'f4160000-0000-4000-8000-000000000040';
const JOIN_AUTH_USER = 'f4160000-0000-4000-8000-000000000041';
const JOIN_REQUEST = 'f4160000-0000-4000-8000-000000000042';
const JOIN_PHONE_STAFF = 'f4160000-0000-4000-8000-000000000043';
const AMBIGUOUS_ACCOUNT = 'f4160000-0000-4000-8000-000000000050';
const AMBIGUOUS_AUTH_USER = 'f4160000-0000-4000-8000-000000000051';
const AMBIGUOUS_REQUEST = 'f4160000-0000-4000-8000-000000000052';
const AMBIGUOUS_STAFF_A = 'f4160000-0000-4000-8000-000000000053';
const AMBIGUOUS_STAFF_B = 'f4160000-0000-4000-8000-000000000054';

function hash(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

async function asService<T>(
  pg: PGlite,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  await pg.exec('begin');
  try {
    await pg.exec('set local role service_role');
    const result = await pg.query(sql, params) as {
      rows: Array<Record<string, unknown>>;
    };
    await pg.exec('commit');
    return Object.values(result.rows[0] ?? {})[0] as T;
  } catch (error) {
    await pg.exec('rollback').catch(() => undefined);
    throw error;
  }
}

async function insertAccount(
  pg: PGlite,
  input: {
    accountId: string;
    authUserId: string;
    email: string;
    username: string;
    role: string;
    propertyAccess?: string[];
  },
): Promise<void> {
  await pg.query(
    `insert into auth.users(id,email) values ($1,$2)`,
    [input.authUserId, input.email],
  );
  await pg.query(
    `insert into accounts(
       id,username,password_hash,display_name,role,property_access,data_user_id
     ) values ($1,$2,'x',$2,$3,$4::uuid[],$5)`,
    [
      input.accountId,
      input.username,
      input.role,
      input.propertyAccess ?? [],
      input.authUserId,
    ],
  );
}

async function insertStaff(
  pg: PGlite,
  input: {
    staffId: string;
    hotelId: string;
    name: string;
    department: string;
    phone?: string;
    phoneLookup?: string;
  },
): Promise<void> {
  await pg.query(
    `insert into staff(
       id,property_id,name,phone,phone_lookup,language,department,is_active
     ) values ($1,$2,$3,$4,$5,'en',$6,true)`,
    [
      input.staffId,
      input.hotelId,
      input.name,
      input.phone ?? '',
      input.phoneLookup ?? null,
      input.department,
    ],
  );
}

async function grantExisting(
  pg: PGlite,
  input: {
    actorAccountId: string;
    actorAuthUserId: string;
    hotelId: string;
    targetAccountId: string;
    email: string;
    role: string;
    organizationId?: string | null;
    membershipScope?: string | null;
    coveredPropertyIds?: string[] | null;
    targetStaffId?: string | null;
    requestId: string;
  },
): Promise<Record<string, unknown>> {
  return asService<Record<string, unknown>>(
    pg,
    `select public.staxis_grant_existing_account_invite_guarded(
       $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,
       $7::uuid,$8,$9::uuid[],$10::uuid,$11
     ) as value`,
    [
      input.actorAccountId,
      input.actorAuthUserId,
      input.hotelId,
      input.targetAccountId,
      input.email,
      input.role,
      input.organizationId ?? null,
      input.membershipScope ?? null,
      input.coveredPropertyIds ?? null,
      input.targetStaffId ?? null,
      input.requestId,
    ],
  );
}

describe('People invite identity linking migration — real SQL', () => {
  let pg: PGlite;

  before(async () => {
    const migrated = await applyMigrationsToPglite();
    assert.ok(
      migrated.report.applied.some((file) => file.startsWith('0416_')),
      'People invite identity migration must be active in this integration test',
    );
    pg = migrated.pg;
    await seedTwoCompanies(pg);
  });

  after(async () => {
    await pg?.close();
  });

  test('publishes the rolling and targeted signatures with service-only execution', async () => {
    const signatures = await pg.query<{
      create_rolling: boolean;
      create_targeted: boolean;
      accept_invite: boolean;
      grant_existing: boolean;
      decide_join: boolean;
      all_definers: boolean;
    }>(`
      select
        to_regprocedure(
          'public.staxis_create_account_invite_guarded(uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text)'
        ) is not null as create_rolling,
        to_regprocedure(
          'public.staxis_create_account_invite_guarded(uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text,uuid)'
        ) is not null as create_targeted,
        to_regprocedure(
          'public.staxis_accept_account_invite(text,uuid,uuid,text,text)'
        ) is not null as accept_invite,
        to_regprocedure(
          'public.staxis_grant_existing_account_invite_guarded(uuid,uuid,uuid,uuid,text,text,uuid,text,uuid[],uuid,text)'
        ) is not null as grant_existing,
        to_regprocedure(
          'public.staxis_decide_staff_join_request(uuid,uuid,uuid,text)'
        ) is not null as decide_join,
        (
          select bool_and(proc.prosecdef)
          from pg_proc proc
          where proc.oid = any(array[
            to_regprocedure('public.staxis_create_account_invite_guarded(uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text)'),
            to_regprocedure('public.staxis_create_account_invite_guarded(uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text,uuid)'),
            to_regprocedure('public.staxis_accept_account_invite(text,uuid,uuid,text,text)'),
            to_regprocedure('public.staxis_grant_existing_account_invite_guarded(uuid,uuid,uuid,uuid,text,text,uuid,text,uuid[],uuid,text)'),
            to_regprocedure('public.staxis_decide_staff_join_request(uuid,uuid,uuid,text)')
          ]::regprocedure[])
        ) as all_definers
    `);
    assert.deepEqual(signatures.rows[0], {
      create_rolling: true,
      create_targeted: true,
      accept_invite: true,
      grant_existing: true,
      decide_join: true,
      all_definers: true,
    });

    const joinBoundary = await pg.query<{ definition: string }>(`
      select pg_get_functiondef(
        'public.staxis_decide_staff_join_request(uuid,uuid,uuid,text)'::regprocedure
      ) as definition
    `);
    const joinDefinition = joinBoundary.rows[0].definition;
    const authorityFreeze = joinDefinition.indexOf(
      'lock table public.capability_overrides',
    );
    const contextRecheck = joinDefinition.indexOf(
      'v_context := public._staxis_manage_team_context',
    );
    assert.ok(authorityFreeze >= 0, 'join approval must freeze authority tables');
    assert.ok(
      contextRecheck > authorityFreeze,
      'join approval must recompute manage_team after freezing authority',
    );
    assert.match(
      joinDefinition,
      /from public\.accounts actor[\s\S]*for share nowait;/,
    );
    assert.match(
      joinDefinition,
      /from public\.account_authorization_state state[\s\S]*for share nowait;/,
    );

    const existingGrantBoundary = await pg.query<{ definition: string }>(`
      select pg_get_functiondef(
        'public.staxis_grant_existing_account_invite_guarded(uuid,uuid,uuid,uuid,text,text,uuid,text,uuid[],uuid,text)'::regprocedure
      ) as definition
    `);
    assert.match(
      existingGrantBoundary.rows[0].definition,
      /v_now timestamptz := now\(\);/,
      'new membership starts_at must use the transaction-stable projection clock',
    );

    const privileges = await pg.query<{
      anon_create: boolean;
      authenticated_create: boolean;
      service_create: boolean;
      anon_grant: boolean;
      authenticated_grant: boolean;
      service_grant: boolean;
      service_accept: boolean;
      service_decide: boolean;
      service_staff_helper: boolean;
      service_create_impl: boolean;
      service_accept_impl: boolean;
    }>(`
      select
        has_function_privilege(
          'anon',
          'public.staxis_create_account_invite_guarded(uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text,uuid)',
          'execute'
        ) as anon_create,
        has_function_privilege(
          'authenticated',
          'public.staxis_create_account_invite_guarded(uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text,uuid)',
          'execute'
        ) as authenticated_create,
        has_function_privilege(
          'service_role',
          'public.staxis_create_account_invite_guarded(uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text,uuid)',
          'execute'
        ) as service_create,
        has_function_privilege(
          'anon',
          'public.staxis_grant_existing_account_invite_guarded(uuid,uuid,uuid,uuid,text,text,uuid,text,uuid[],uuid,text)',
          'execute'
        ) as anon_grant,
        has_function_privilege(
          'authenticated',
          'public.staxis_grant_existing_account_invite_guarded(uuid,uuid,uuid,uuid,text,text,uuid,text,uuid[],uuid,text)',
          'execute'
        ) as authenticated_grant,
        has_function_privilege(
          'service_role',
          'public.staxis_grant_existing_account_invite_guarded(uuid,uuid,uuid,uuid,text,text,uuid,text,uuid[],uuid,text)',
          'execute'
        ) as service_grant,
        has_function_privilege(
          'service_role',
          'public.staxis_accept_account_invite(text,uuid,uuid,text,text)',
          'execute'
        ) as service_accept,
        has_function_privilege(
          'service_role',
          'public.staxis_decide_staff_join_request(uuid,uuid,uuid,text)',
          'execute'
        ) as service_decide,
        has_function_privilege(
          'service_role',
          'public._staxis_lock_invite_target_staff(uuid,uuid,text,uuid,uuid,uuid)',
          'execute'
        ) as service_staff_helper,
        has_function_privilege(
          'service_role',
          'public._staxis_create_account_invite_guarded_0395_impl(uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text)',
          'execute'
        ) as service_create_impl,
        has_function_privilege(
          'service_role',
          'public._staxis_accept_account_invite_0393_impl(text,uuid,uuid,text,text)',
          'execute'
        ) as service_accept_impl
    `);
    assert.deepEqual(privileges.rows[0], {
      anon_create: false,
      authenticated_create: false,
      service_create: true,
      anon_grant: false,
      authenticated_grant: false,
      service_grant: true,
      service_accept: true,
      service_decide: true,
      service_staff_helper: false,
      service_create_impl: false,
      service_accept_impl: false,
    });
  });

  test('a targeted email invite accepts into the exact unlinked roster profile', async () => {
    await insertStaff(pg, {
      staffId: INVITE_STAFF,
      hotelId: PID_L1,
      name: 'Invited Desk Agent',
      department: 'front_desk',
    });
    const tokenHash = hash('0416-targeted-acceptance');
    const created = await asService<Record<string, unknown>>(
      pg,
      `select public.staxis_create_account_invite_guarded(
         $1::uuid,$2::uuid,$3::uuid,'linked-invite@example.test','front_desk',$4,
         clock_timestamp()+interval '7 days',null::uuid,null::text,null::uuid[],
         '0416-targeted-create',$5::uuid
       ) as value`,
      [ACCOUNT_WANDA, UID_WANDA, PID_L1, tokenHash, INVITE_STAFF],
    );
    assert.equal(created.ok, true);
    assert.equal(created.targetStaffId, INVITE_STAFF);

    const duplicateReservation = await asService<Record<string, unknown>>(
      pg,
      `select public.staxis_create_account_invite_guarded(
         $1::uuid,$2::uuid,$3::uuid,'duplicate-target@example.test','front_desk',$4,
         clock_timestamp()+interval '7 days',null::uuid,null::text,null::uuid[],
         '0416-duplicate-target',$5::uuid
       ) as value`,
      [ACCOUNT_WANDA, UID_WANDA, PID_L1, hash('0416-duplicate-target'), INVITE_STAFF],
    );
    assert.deepEqual(duplicateReservation, { ok: false, reason: 'staff_in_use' });

    const invite = await pg.query<{ id: string; target_staff_id: string }>(
      `select id,target_staff_id from account_invites where token_hash=$1`,
      [tokenHash],
    );
    assert.equal(invite.rows[0].target_staff_id, INVITE_STAFF);

    const claimed = await asService<Record<string, unknown>>(
      pg,
      `select public.staxis_claim_account_invite_acceptance($1,$2::uuid) as value`,
      [tokenHash, INVITE_CLAIM],
    );
    assert.equal(claimed.ok, true);
    await pg.query(
      `insert into auth.users(id,email) values ($1,'linked-invite@example.test')`,
      [INVITE_AUTH_USER],
    );

    const accepted = await asService<Record<string, unknown>>(
      pg,
      `select public.staxis_accept_account_invite(
         $1,$2::uuid,$3::uuid,'linked-invite','Linked Invite'
       ) as value`,
      [tokenHash, INVITE_CLAIM, INVITE_AUTH_USER],
    );
    assert.equal(accepted.ok, true);
    assert.equal(accepted.staffId, INVITE_STAFF);

    const linked = await pg.query<{
      account_id: string;
      staff_id: string;
      active_links: number;
      link_source: string;
    }>(
      `select account.id as account_id,account.staff_id,
          count(staff_link.*)::integer as active_links,
          min(staff_link.source) as link_source
       from accounts account
       join account_property_staff_links staff_link
         on staff_link.account_id=account.id
        and staff_link.property_id=$2
        and staff_link.staff_id=$3
        and staff_link.is_active
       where account.data_user_id=$1
       group by account.id,account.staff_id`,
      [INVITE_AUTH_USER, PID_L1, INVITE_STAFF],
    );
    assert.equal(linked.rows.length, 1);
    assert.equal(linked.rows[0].staff_id, INVITE_STAFF);
    assert.equal(Number(linked.rows[0].active_links), 1);
    assert.equal(linked.rows[0].link_source, 'invitation');
  });

  test('existing-account grants link roster identities in both hotel topologies', async () => {
    await insertAccount(pg, {
      accountId: LEGACY_TARGET_ACCOUNT,
      authUserId: LEGACY_TARGET_AUTH_USER,
      email: 'existing-legacy@example.test',
      username: 'existing-legacy',
      role: 'housekeeping',
    });
    await insertStaff(pg, {
      staffId: LEGACY_TARGET_STAFF,
      hotelId: PID_L1,
      name: 'Existing Legacy Housekeeper',
      department: 'housekeeping',
    });
    const legacyGrant = await grantExisting(pg, {
      actorAccountId: ACCOUNT_WANDA,
      actorAuthUserId: UID_WANDA,
      hotelId: PID_L1,
      targetAccountId: LEGACY_TARGET_ACCOUNT,
      email: 'EXISTING-LEGACY@example.test',
      role: 'housekeeping',
      targetStaffId: LEGACY_TARGET_STAFF,
      requestId: '0416-existing-legacy',
    });
    assert.equal(legacyGrant.ok, true);
    assert.equal(legacyGrant.status, 'granted');
    assert.equal(legacyGrant.normalized, false);
    assert.equal(legacyGrant.staffId, LEGACY_TARGET_STAFF);

    const legacyAccount = await pg.query<{
      staff_id: string;
      property_access: string[];
    }>(
      `select staff_id,property_access from accounts where id=$1`,
      [LEGACY_TARGET_ACCOUNT],
    );
    assert.equal(legacyAccount.rows[0].staff_id, LEGACY_TARGET_STAFF);
    assert.deepEqual(legacyAccount.rows[0].property_access, [PID_L1]);

    await insertAccount(pg, {
      accountId: NORMALIZED_TARGET_ACCOUNT,
      authUserId: NORMALIZED_TARGET_AUTH_USER,
      email: 'existing-company@example.test',
      username: 'existing-company',
      role: 'front_desk',
    });
    await insertStaff(pg, {
      staffId: NORMALIZED_TARGET_STAFF,
      hotelId: PID_A1,
      name: 'Existing Company Desk Agent',
      department: 'front_desk',
    });
    const normalizedPrecondition = await pg.query<{
      can_control: boolean;
      manager_context: Record<string, unknown>;
      staff_status: string;
      target_mode: string;
    }>(
      `select
         public._staxis_can_control_account_invite(
           $1,$2,$3,'property','front_desk',array[$2]::uuid[]
         ) as can_control,
         public._staxis_manage_team_context($1,$2) as manager_context,
         public._staxis_lock_invite_target_staff(
           $1,$2,'front_desk',$4,$5,null
         ) as staff_status,
         (select authority_mode from account_authorization_state where account_id=$5)
           as target_mode`,
      [
        ACCOUNT_MARIA,
        PID_A1,
        ORG_A,
        NORMALIZED_TARGET_STAFF,
        NORMALIZED_TARGET_ACCOUNT,
      ],
    );
    assert.equal(
      normalizedPrecondition.rows[0].can_control,
      true,
      JSON.stringify(normalizedPrecondition.rows[0]),
    );
    assert.equal(
      normalizedPrecondition.rows[0].staff_status,
      'ok',
      JSON.stringify(normalizedPrecondition.rows[0]),
    );
    const normalizedGrant = await grantExisting(pg, {
      actorAccountId: ACCOUNT_MARIA,
      actorAuthUserId: UID_MARIA,
      hotelId: PID_A1,
      targetAccountId: NORMALIZED_TARGET_ACCOUNT,
      email: 'existing-company@example.test',
      role: 'front_desk',
      organizationId: ORG_A,
      membershipScope: 'property',
      coveredPropertyIds: [PID_A1],
      targetStaffId: NORMALIZED_TARGET_STAFF,
      requestId: '0416-existing-company',
    });
    assert.equal(normalizedGrant.ok, true, JSON.stringify(normalizedGrant));
    assert.equal(normalizedGrant.status, 'granted');
    assert.equal(normalizedGrant.normalized, true);
    assert.ok(normalizedGrant.membershipId);
    assert.equal(normalizedGrant.staffId, NORMALIZED_TARGET_STAFF);

    const normalized = await pg.query<{
      staff_id: string;
      property_access: string[];
      active_links: number;
      active_hats: number;
    }>(
      `select target.staff_id,target.property_access,
          (select count(*)::integer
             from account_property_staff_links staff_link
            where staff_link.account_id=target.id
              and staff_link.property_id=$2
              and staff_link.staff_id=$3
              and staff_link.is_active) as active_links,
          (select count(*)::integer
             from organization_memberships membership
            where membership.account_id=target.id
              and membership.organization_id=$4
              and membership.membership_scope='property'
              and membership.staxis_role='front_desk'
              and membership.status='active'
              and membership.ended_at is null
              and membership.covered_property_ids @> array[$2]::uuid[]) as active_hats
       from accounts target where target.id=$1`,
      [NORMALIZED_TARGET_ACCOUNT, PID_A1, NORMALIZED_TARGET_STAFF, ORG_A],
    );
    assert.equal(normalized.rows[0].staff_id, NORMALIZED_TARGET_STAFF);
    assert.deepEqual(normalized.rows[0].property_access, []);
    assert.equal(Number(normalized.rows[0].active_links), 1);
    assert.equal(Number(normalized.rows[0].active_hats), 1);

    await insertAccount(pg, {
      accountId: ROLE_CONFLICT_ACCOUNT,
      authUserId: ROLE_CONFLICT_AUTH_USER,
      email: 'role-conflict@example.test',
      username: 'role-conflict',
      role: 'housekeeping',
      propertyAccess: [PID_A1],
    });
    const roleConflict = await grantExisting(pg, {
      actorAccountId: ACCOUNT_WANDA,
      actorAuthUserId: UID_WANDA,
      hotelId: PID_L1,
      targetAccountId: ROLE_CONFLICT_ACCOUNT,
      email: 'role-conflict@example.test',
      role: 'front_desk',
      requestId: '0416-role-conflict',
    });
    assert.deepEqual(roleConflict, { ok: false, reason: 'role_conflict' });
    const unchanged = await pg.query<{ role: string; property_access: string[] }>(
      `select role,property_access from accounts where id=$1`,
      [ROLE_CONFLICT_ACCOUNT],
    );
    assert.deepEqual(unchanged.rows[0], {
      role: 'housekeeping',
      property_access: [PID_A1],
    });
  });

  test('join approval reuses one phone match but creates for an ambiguous name', async () => {
    await insertAccount(pg, {
      accountId: JOIN_ACCOUNT,
      authUserId: JOIN_AUTH_USER,
      email: 'join-phone@example.test',
      username: 'join-phone',
      role: 'maintenance',
    });
    await insertStaff(pg, {
      staffId: JOIN_PHONE_STAFF,
      hotelId: PID_L1,
      name: 'Roster Name Does Not Match',
      department: 'maintenance',
      phone: '+1 (254) 555-0199',
      phoneLookup: '2545550199',
    });
    await pg.query(
      `insert into join_requests(
         id,property_id,account_id,name,phone,language,department
       ) values ($1,$2,$3,'New Signup Name','254-555-0199','en','maintenance')`,
      [JOIN_REQUEST, PID_L1, JOIN_ACCOUNT],
    );
    const reused = await asService<Record<string, unknown>>(
      pg,
      `select public.staxis_decide_staff_join_request(
         $1::uuid,$2::uuid,$3::uuid,'approve'
       ) as value`,
      [ACCOUNT_WANDA, JOIN_REQUEST, PID_L1],
    );
    assert.equal(reused.ok, true);
    assert.equal(reused.staffReused, true);
    assert.equal(reused.staffId, JOIN_PHONE_STAFF);

    await insertAccount(pg, {
      accountId: AMBIGUOUS_ACCOUNT,
      authUserId: AMBIGUOUS_AUTH_USER,
      email: 'join-ambiguous@example.test',
      username: 'join-ambiguous',
      role: 'front_desk',
    });
    for (const staffId of [AMBIGUOUS_STAFF_A, AMBIGUOUS_STAFF_B]) {
      await insertStaff(pg, {
        staffId,
        hotelId: PID_L1,
        name: staffId === AMBIGUOUS_STAFF_A
          ? 'Ambiguous   Desk Agent'
          : '  ambiguous desk agent  ',
        department: 'front_desk',
      });
    }
    await pg.query(
      `insert into join_requests(
         id,property_id,account_id,name,language,department
       ) values ($1,$2,$3,'Ambiguous Desk Agent','en','front_desk')`,
      [AMBIGUOUS_REQUEST, PID_L1, AMBIGUOUS_ACCOUNT],
    );
    const ambiguous = await asService<Record<string, unknown>>(
      pg,
      `select public.staxis_decide_staff_join_request(
         $1::uuid,$2::uuid,$3::uuid,'approve'
       ) as value`,
      [ACCOUNT_WANDA, AMBIGUOUS_REQUEST, PID_L1],
    );
    assert.equal(ambiguous.ok, true);
    assert.equal(ambiguous.staffReused, false);
    assert.notEqual(ambiguous.staffId, AMBIGUOUS_STAFF_A);
    assert.notEqual(ambiguous.staffId, AMBIGUOUS_STAFF_B);

    const linked = await pg.query<{ staff_id: string; source: string }>(
      `select account.staff_id,staff_link.source
         from accounts account
         join account_property_staff_links staff_link
           on staff_link.account_id=account.id
          and staff_link.property_id=$2
          and staff_link.staff_id=account.staff_id
          and staff_link.is_active
        where account.id=$1`,
      [AMBIGUOUS_ACCOUNT, PID_L1],
    );
    assert.equal(linked.rows[0].staff_id, ambiguous.staffId);
    assert.equal(linked.rows[0].source, 'invitation');
  });
});
