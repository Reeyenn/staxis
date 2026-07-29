import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_ANA,
  ACCOUNT_BO,
  ACCOUNT_GIL,
  ACCOUNT_MARIA,
  ACCOUNT_WANDA,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_A2,
  PID_B1,
  PID_L1,
  UID_ADMIN,
  UID_ANA,
  UID_BO,
  UID_GIL,
  UID_MARIA,
  UID_WANDA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const MISSING_INVITE = 'f9999999-9999-4999-8999-999999999999';
const ROLLING_AUTH_USER = 'f8888888-8888-4888-8888-888888888881';
const ROLLING_CLAIM = 'f8888888-8888-4888-8888-888888888882';
const HAT_SET_AUDIT = 'f7777777-7777-4777-8777-777777777771';
const HAT_SET_FAIL_AUDIT = 'f7777777-7777-4777-8777-777777777772';
const HAT_END_FAIL_AUDIT = 'f7777777-7777-4777-8777-777777777773';
const HAT_END_AUDIT = 'f7777777-7777-4777-8777-777777777774';

interface JsonRow { value: Record<string, unknown> }

interface CreateInput {
  actorAccountId: string;
  actorAuthUserId: string;
  hotelId: string;
  email: string;
  role: string;
  organizationId?: string | null;
  membershipScope?: 'company' | 'property' | null;
  propertyIds?: string[] | null;
  requestId: string;
}

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

async function createGuarded(
  pg: PGlite,
  input: CreateInput,
): Promise<Record<string, unknown>> {
  return asService<Record<string, unknown>>(
    pg,
    `select public.staxis_create_account_invite_guarded(
       $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,
       clock_timestamp() + interval '7 days',$7::uuid,$8,$9::uuid[],$10
     ) as value`,
    [
      input.actorAccountId,
      input.actorAuthUserId,
      input.hotelId,
      input.email,
      input.role,
      hash(input.requestId),
      input.organizationId ?? null,
      input.membershipScope ?? null,
      input.propertyIds ?? null,
      input.requestId,
    ],
  );
}

async function revokeGuarded(
  pg: PGlite,
  actorAccountId: string,
  actorAuthUserId: string,
  inviteId: string,
  requestId: string,
): Promise<Record<string, unknown>> {
  return asService<Record<string, unknown>>(
    pg,
    `select public.staxis_revoke_account_invite_guarded(
       $1::uuid,$2::uuid,$3::uuid,$4
     ) as value`,
    [actorAccountId, actorAuthUserId, inviteId, requestId],
  );
}

async function setHatGuarded(
  pg: PGlite,
  input: {
    actorAccountId: string;
    actorAuthUserId: string;
    organizationId: string;
    accountId: string;
    role: string;
    propertyIds: string[];
    jobTitle: string;
    auditRequestId: string;
  },
): Promise<Record<string, unknown>> {
  return asService<Record<string, unknown>>(
    pg,
    `select public.staxis_set_membership_hat_guarded(
       $1::uuid,$2::uuid,$3::uuid,$4::uuid,'property',$5,$6::jsonb,$7,$8::uuid
     ) as value`,
    [
      input.actorAccountId,
      input.actorAuthUserId,
      input.organizationId,
      input.accountId,
      input.role,
      JSON.stringify(input.propertyIds),
      input.jobTitle,
      input.auditRequestId,
    ],
  );
}

async function endHatGuarded(
  pg: PGlite,
  actorAccountId: string,
  actorAuthUserId: string,
  membershipId: string,
  auditRequestId: string,
): Promise<Record<string, unknown>> {
  return asService<Record<string, unknown>>(
    pg,
    `select public.staxis_end_membership_hat_guarded(
       $1::uuid,$2::uuid,$3::uuid,$4::uuid
     ) as value`,
    [actorAccountId, actorAuthUserId, membershipId, auditRequestId],
  );
}

describe('actor-bound account invitation lifecycle — real SQL', () => {
  let pg: PGlite;
  let mariaVpMembership: string;

  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    const seeded = await seedTwoCompanies(pg);
    mariaVpMembership = seeded.hats.get(`${ACCOUNT_MARIA}:company:vp`)!;
  });

  after(async () => {
    await pg?.close();
  });

  test('independent-hotel owner creates and revokes with atomic audits', async () => {
    const created = await createGuarded(pg, {
      actorAccountId: ACCOUNT_WANDA,
      actorAuthUserId: UID_WANDA,
      hotelId: PID_L1,
      email: 'waco.frontdesk@example.test',
      role: 'front_desk',
      requestId: 'legacy-create',
    });
    assert.equal(created.ok, true);
    assert.equal(created.hotelId, PID_L1);
    assert.equal(created.hotelName, 'Waco Inn');
    const inviteId = String(created.inviteId);
    const stored = await pg.query<{
      organization_id: string | null;
      membership_scope: string | null;
      create_audits: number;
    }>(
      `select invitation.organization_id, invitation.membership_scope,
        (select count(*)::integer from admin_audit_log audit
         where audit.target_id=invitation.id::text
           and audit.action='invite.create'
           and audit.metadata->>'request_id'='legacy-create') as create_audits
       from account_invites invitation where invitation.id=$1`,
      [inviteId],
    );
    assert.deepEqual(stored.rows[0], {
      organization_id: null,
      membership_scope: null,
      create_audits: 1,
    });

    const revoked = await revokeGuarded(
      pg, ACCOUNT_WANDA, UID_WANDA, inviteId, 'legacy-revoke',
    );
    assert.equal(revoked.ok, true);
    const terminal = await pg.query<{ rows: number; audits: number }>(
      `select
         (select count(*)::integer from account_invites where id=$1) as rows,
         (select count(*)::integer from admin_audit_log
          where target_id=$1::text and action='invite.revoke'
            and metadata->>'request_id'='legacy-revoke') as audits`,
      [inviteId],
    );
    assert.deepEqual(terminal.rows[0], { rows: 0, audits: 1 });
  });

  test('rolling DB-first compatibility accepts and revokes legacy direct rows', async () => {
    const acceptanceHash = hash('rolling-direct-accept');
    const acceptedInvite = await pg.query<{ id: string }>(
      `insert into account_invites(
         hotel_id,email,role,token_hash,expires_at,invited_by
       ) values (
         $1,'rolling-accept@example.test','front_desk',$2,
         clock_timestamp()+interval '7 days',$3
       ) returning id`,
      [PID_L1, acceptanceHash, ACCOUNT_WANDA],
    );
    const claimed = await asService<Record<string, unknown>>(
      pg,
      `select public.staxis_claim_account_invite_acceptance($1,$2::uuid) as value`,
      [acceptanceHash, ROLLING_CLAIM],
    );
    assert.equal(claimed.ok, true);
    await pg.query(
      `insert into auth.users(id,email)
       values ($1,'rolling-accept@example.test')`,
      [ROLLING_AUTH_USER],
    );
    const accepted = await asService<Record<string, unknown>>(
      pg,
      `select public.staxis_accept_account_invite(
         $1,$2::uuid,$3::uuid,'rolling.user','Rolling User'
       ) as value`,
      [acceptanceHash, ROLLING_CLAIM, ROLLING_AUTH_USER],
    );
    assert.equal(accepted.ok, true);
    assert.equal(accepted.normalized, false);
    const account = await pg.query<{ role: string; property_access: string[] }>(
      `select role,property_access from accounts where data_user_id=$1`,
      [ROLLING_AUTH_USER],
    );
    assert.deepEqual(account.rows[0], {
      role: 'front_desk', property_access: [PID_L1],
    });
    const acceptedRow = await pg.query<{ accepted_at: string | null }>(
      `select accepted_at::text from account_invites where id=$1`,
      [acceptedInvite.rows[0].id],
    );
    assert.ok(acceptedRow.rows[0].accepted_at);

    const revocable = await pg.query<{ id: string }>(
      `insert into account_invites(
         hotel_id,email,role,token_hash,expires_at,invited_by
       ) values (
         $1,'rolling-revoke@example.test','housekeeping',$2,
         clock_timestamp()+interval '7 days',$3
       ) returning id`,
      [PID_L1, hash('rolling-direct-revoke'), ACCOUNT_WANDA],
    );
    const revoked = await revokeGuarded(
      pg,
      ACCOUNT_WANDA,
      UID_WANDA,
      revocable.rows[0].id,
      'rolling-direct-revoke',
    );
    assert.equal(revoked.ok, true);
  });

  test('guarded RPC ACLs are service-only and the shared helper is internal', async () => {
    const privileges = await pg.query<{
      anon_create: boolean;
      authenticated_create: boolean;
      service_create: boolean;
      anon_revoke: boolean;
      authenticated_revoke: boolean;
      service_revoke: boolean;
      anon_set_hat: boolean;
      authenticated_set_hat: boolean;
      service_set_hat: boolean;
      anon_end_hat: boolean;
      authenticated_end_hat: boolean;
      service_end_hat: boolean;
      service_helper: boolean;
    }>(`
      select
        has_function_privilege(
          'anon',
          'public.staxis_create_account_invite_guarded(uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text)',
          'execute'
        ) as anon_create,
        has_function_privilege(
          'authenticated',
          'public.staxis_create_account_invite_guarded(uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text)',
          'execute'
        ) as authenticated_create,
        has_function_privilege(
          'service_role',
          'public.staxis_create_account_invite_guarded(uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text)',
          'execute'
        ) as service_create,
        has_function_privilege(
          'anon',
          'public.staxis_revoke_account_invite_guarded(uuid,uuid,uuid,text)',
          'execute'
        ) as anon_revoke,
        has_function_privilege(
          'authenticated',
          'public.staxis_revoke_account_invite_guarded(uuid,uuid,uuid,text)',
          'execute'
        ) as authenticated_revoke,
        has_function_privilege(
          'service_role',
          'public.staxis_revoke_account_invite_guarded(uuid,uuid,uuid,text)',
          'execute'
        ) as service_revoke,
        has_function_privilege(
          'anon',
          'public.staxis_set_membership_hat_guarded(uuid,uuid,uuid,uuid,text,text,jsonb,text,uuid)',
          'execute'
        ) as anon_set_hat,
        has_function_privilege(
          'authenticated',
          'public.staxis_set_membership_hat_guarded(uuid,uuid,uuid,uuid,text,text,jsonb,text,uuid)',
          'execute'
        ) as authenticated_set_hat,
        has_function_privilege(
          'service_role',
          'public.staxis_set_membership_hat_guarded(uuid,uuid,uuid,uuid,text,text,jsonb,text,uuid)',
          'execute'
        ) as service_set_hat,
        has_function_privilege(
          'anon',
          'public.staxis_end_membership_hat_guarded(uuid,uuid,uuid,uuid)',
          'execute'
        ) as anon_end_hat,
        has_function_privilege(
          'authenticated',
          'public.staxis_end_membership_hat_guarded(uuid,uuid,uuid,uuid)',
          'execute'
        ) as authenticated_end_hat,
        has_function_privilege(
          'service_role',
          'public.staxis_end_membership_hat_guarded(uuid,uuid,uuid,uuid)',
          'execute'
        ) as service_end_hat,
        has_function_privilege(
          'service_role',
          'public._staxis_can_control_account_invite(uuid,uuid,uuid,text,text,uuid[])',
          'execute'
        ) as service_helper
    `);
    assert.deepEqual(privileges.rows[0], {
      anon_create: false,
      authenticated_create: false,
      service_create: true,
      anon_revoke: false,
      authenticated_revoke: false,
      service_revoke: true,
      anon_set_hat: false,
      authenticated_set_hat: false,
      service_set_hat: true,
      anon_end_hat: false,
      authenticated_end_hat: false,
      service_end_hat: true,
      service_helper: false,
    });
  });

  test('legacy GM hierarchy and normalized property hierarchy fail closed', async () => {
    await pg.query(`update accounts set role='general_manager' where id=$1`, [ACCOUNT_WANDA]);
    const legacyPeer = await createGuarded(pg, {
      actorAccountId: ACCOUNT_WANDA,
      actorAuthUserId: UID_WANDA,
      hotelId: PID_L1,
      email: 'waco.owner@example.test',
      role: 'owner',
      requestId: 'legacy-hierarchy-denied',
    });
    assert.deepEqual(legacyPeer, { ok: false, reason: 'denied' });
    await pg.query(`update accounts set role='owner' where id=$1`, [ACCOUNT_WANDA]);

    const line = await createGuarded(pg, {
      actorAccountId: ACCOUNT_GIL,
      actorAuthUserId: UID_GIL,
      hotelId: PID_B1,
      email: 'tyler.housekeeping@example.test',
      role: 'housekeeping',
      organizationId: ORG_B,
      membershipScope: 'property',
      propertyIds: [PID_B1],
      requestId: 'gm-line-allowed',
    });
    assert.equal(line.ok, true);
    const peerGm = await createGuarded(pg, {
      actorAccountId: ACCOUNT_GIL,
      actorAuthUserId: UID_GIL,
      hotelId: PID_B1,
      email: 'tyler.gm@example.test',
      role: 'general_manager',
      organizationId: ORG_B,
      membershipScope: 'property',
      propertyIds: [PID_B1],
      requestId: 'gm-peer-denied',
    });
    assert.deepEqual(peerGm, { ok: false, reason: 'denied' });
    const sisterTamper = await createGuarded(pg, {
      actorAccountId: ACCOUNT_GIL,
      actorAuthUserId: UID_GIL,
      hotelId: PID_B1,
      email: 'beaumont.tamper@example.test',
      role: 'front_desk',
      organizationId: ORG_B,
      membershipScope: 'property',
      propertyIds: [PID_A1],
      requestId: 'gm-cross-company-denied',
    });
    assert.deepEqual(sisterTamper, { ok: false, reason: 'denied' });
  });

  test('company owner and VP obey exact company/property delegation', async () => {
    const finance = await createGuarded(pg, {
      actorAccountId: ACCOUNT_MARIA,
      actorAuthUserId: UID_MARIA,
      hotelId: PID_A1,
      email: 'controller@example.test',
      role: 'finance',
      organizationId: ORG_A,
      membershipScope: 'company',
      requestId: 'vp-finance',
    });
    assert.equal(finance.ok, true);
    const ownerDenied = await createGuarded(pg, {
      actorAccountId: ACCOUNT_MARIA,
      actorAuthUserId: UID_MARIA,
      hotelId: PID_A1,
      email: 'owner-by-vp@example.test',
      role: 'owner',
      organizationId: ORG_A,
      membershipScope: 'company',
      requestId: 'vp-owner-denied',
    });
    assert.deepEqual(ownerDenied, { ok: false, reason: 'denied' });

    const poisonedAnchor = await createGuarded(pg, {
      actorAccountId: ACCOUNT_ANA,
      actorAuthUserId: UID_ANA,
      hotelId: PID_A1,
      email: 'mismatched-anchor@example.test',
      role: 'general_manager',
      organizationId: ORG_A,
      membershipScope: 'property',
      propertyIds: [PID_A2],
      requestId: 'owner-property-anchor-mismatch',
    });
    assert.deepEqual(poisonedAnchor, { ok: false, reason: 'denied' });
    const ownerCreatesGm = await createGuarded(pg, {
      actorAccountId: ACCOUNT_ANA,
      actorAuthUserId: UID_ANA,
      hotelId: PID_A2,
      email: 'lufkin.gm@example.test',
      role: 'general_manager',
      organizationId: ORG_A,
      membershipScope: 'property',
      propertyIds: [PID_A2],
      requestId: 'owner-property-gm',
    });
    assert.equal(ownerCreatesGm.ok, true);
    const duplicateCoverage = await createGuarded(pg, {
      actorAccountId: ACCOUNT_ANA,
      actorAuthUserId: UID_ANA,
      hotelId: PID_A1,
      email: 'duplicate@example.test',
      role: 'front_desk',
      organizationId: ORG_A,
      membershipScope: 'property',
      propertyIds: [PID_A1, PID_A1],
      requestId: 'duplicate-coverage',
    });
    assert.deepEqual(duplicateCoverage, { ok: false, reason: 'denied' });
    const duplicateRows = await pg.query<{ count: number }>(
      `select count(*)::integer as count from account_invites
       where token_hash=$1`,
      [hash('duplicate-coverage')],
    );
    assert.equal(Number(duplicateRows.rows[0].count), 0);
  });

  test('audit failure rolls the invitation row back with the transaction', async () => {
    await pg.exec(`
      create or replace function public.test_reject_invite_create_audit()
      returns trigger language plpgsql as $$
      begin
        if new.action='invite.create'
           and new.metadata->>'request_id'='atomic-audit-failure'
        then
          raise exception 'forced audit failure';
        end if;
        return new;
      end;
      $$;
      create trigger test_reject_invite_create_audit
      before insert on public.admin_audit_log
      for each row execute function public.test_reject_invite_create_audit();
    `);
    try {
      await assert.rejects(
        createGuarded(pg, {
          actorAccountId: ACCOUNT_ANA,
          actorAuthUserId: UID_ANA,
          hotelId: PID_A1,
          email: 'no-audit-no-invite@example.test',
          role: 'front_desk',
          organizationId: ORG_A,
          membershipScope: 'property',
          propertyIds: [PID_A1],
          requestId: 'atomic-audit-failure',
        }),
        /forced audit failure/i,
      );
    } finally {
      await pg.exec(`
        drop trigger if exists test_reject_invite_create_audit
          on public.admin_audit_log;
        drop function if exists public.test_reject_invite_create_audit();
      `);
    }
    const rows = await pg.query<{ count: number }>(
      `select count(*)::integer as count from account_invites
       where token_hash=$1`,
      [hash('atomic-audit-failure')],
    );
    assert.equal(Number(rows.rows[0].count), 0);
  });

  test('hat writes bind the Auth actor and audit atomically with rollback', async () => {
    const mismatched = await setHatGuarded(pg, {
      actorAccountId: ACCOUNT_ANA,
      actorAuthUserId: UID_GIL,
      organizationId: ORG_A,
      accountId: ACCOUNT_MARIA,
      role: 'maintenance',
      propertyIds: [PID_A2],
      jobTitle: 'Sister engineer',
      auditRequestId: HAT_SET_AUDIT,
    });
    assert.deepEqual(mismatched, { ok: false, reason: 'denied' });

    const created = await setHatGuarded(pg, {
      actorAccountId: ACCOUNT_ANA,
      actorAuthUserId: UID_ANA,
      organizationId: ORG_A,
      accountId: ACCOUNT_MARIA,
      role: 'maintenance',
      propertyIds: [PID_A2],
      jobTitle: 'Sister engineer',
      auditRequestId: HAT_SET_AUDIT,
    });
    assert.equal(created.ok, true);
    const membershipId = String(created.membershipId);
    const createAudit = await pg.query<{
      actor_account_id: string;
      request_id: string;
      event_type: string;
    }>(
      `select actor_account_id, request_id, event_type
       from organization_access_events
       where target_id=$1 and request_id=$2::uuid`,
      [membershipId, HAT_SET_AUDIT],
    );
    assert.deepEqual(createAudit.rows, [{
      actor_account_id: ACCOUNT_ANA,
      request_id: HAT_SET_AUDIT,
      event_type: 'organization_memberships.insert',
    }]);

    await pg.exec(`
      create or replace function public.test_reject_hat_audit()
      returns trigger language plpgsql as $$
      begin
        if new.request_id in (
          '${HAT_SET_FAIL_AUDIT}'::uuid,
          '${HAT_END_FAIL_AUDIT}'::uuid
        ) then
          raise exception 'forced hat audit failure';
        end if;
        return new;
      end;
      $$;
      create trigger test_reject_hat_audit
        before insert on public.organization_access_events
        for each row execute function public.test_reject_hat_audit();
    `);
    try {
      await assert.rejects(
        setHatGuarded(pg, {
          actorAccountId: ACCOUNT_ANA,
          actorAuthUserId: UID_ANA,
          organizationId: ORG_A,
          accountId: ACCOUNT_MARIA,
          role: 'housekeeping',
          propertyIds: [PID_A2],
          jobTitle: 'Audit must commit',
          auditRequestId: HAT_SET_FAIL_AUDIT,
        }),
        /forced hat audit failure/i,
      );
      const absent = await pg.query<{ count: number }>(
        `select count(*)::integer as count
         from organization_memberships
         where organization_id=$1 and account_id=$2
           and staxis_role='housekeeping' and ended_at is null`,
        [ORG_A, ACCOUNT_MARIA],
      );
      assert.equal(Number(absent.rows[0].count), 0);

      await assert.rejects(
        endHatGuarded(
          pg, ACCOUNT_ANA, UID_ANA, membershipId, HAT_END_FAIL_AUDIT,
        ),
        /forced hat audit failure/i,
      );
      const stillActive = await pg.query<{ ended_at: string | null }>(
        `select ended_at::text from organization_memberships where id=$1`,
        [membershipId],
      );
      assert.equal(stillActive.rows[0].ended_at, null);
    } finally {
      await pg.exec(`
        drop trigger if exists test_reject_hat_audit
          on public.organization_access_events;
        drop function if exists public.test_reject_hat_audit();
      `);
    }

    const ended = await endHatGuarded(
      pg, ACCOUNT_ANA, UID_ANA, membershipId, HAT_END_AUDIT,
    );
    assert.equal(ended.ok, true);
    const endAudit = await pg.query<{
      actor_account_id: string;
      request_id: string;
      event_type: string;
    }>(
      `select actor_account_id, request_id, event_type
       from organization_access_events
       where target_id=$1 and request_id=$2::uuid`,
      [membershipId, HAT_END_AUDIT],
    );
    assert.deepEqual(endAudit.rows, [{
      actor_account_id: ACCOUNT_ANA,
      request_id: HAT_END_AUDIT,
      event_type: 'organization_memberships.update',
    }]);
  });

  test('revoked company authority cannot create or revoke a persisted promise', async () => {
    const created = await createGuarded(pg, {
      actorAccountId: ACCOUNT_MARIA,
      actorAuthUserId: UID_MARIA,
      hotelId: PID_A1,
      email: 'finance-before-revoke@example.test',
      role: 'finance',
      organizationId: ORG_A,
      membershipScope: 'company',
      requestId: 'before-vp-revoke',
    });
    assert.equal(created.ok, true);
    await asService(
      pg,
      `select public.staxis_end_membership_hat($1::uuid,$2::uuid)`,
      [ACCOUNT_ADMIN, mariaVpMembership],
    );
    const deniedCreate = await createGuarded(pg, {
      actorAccountId: ACCOUNT_MARIA,
      actorAuthUserId: UID_MARIA,
      hotelId: PID_A1,
      email: 'finance-after-revoke@example.test',
      role: 'finance',
      organizationId: ORG_A,
      membershipScope: 'company',
      requestId: 'after-vp-revoke',
    });
    assert.deepEqual(deniedCreate, { ok: false, reason: 'denied' });
    const deniedRevoke = await revokeGuarded(
      pg, ACCOUNT_MARIA, UID_MARIA, String(created.inviteId), 'stale-vp-revoke',
    );
    assert.deepEqual(deniedRevoke, { ok: false, reason: 'denied' });
    const stillPending = await pg.query<{ count: number }>(
      `select count(*)::integer as count from account_invites
       where id=$1 and accepted_at is null`,
      [created.inviteId],
    );
    assert.equal(Number(stillPending.rows[0].count), 1);
  });

  test('accepted cross-tenant ids do not disclose terminal state before authority', async () => {
    const created = await createGuarded(pg, {
      actorAccountId: ACCOUNT_ANA,
      actorAuthUserId: UID_ANA,
      hotelId: PID_A1,
      email: 'accepted-probe@example.test',
      role: 'front_desk',
      organizationId: ORG_A,
      membershipScope: 'property',
      propertyIds: [PID_A1],
      requestId: 'accepted-probe',
    });
    assert.equal(created.ok, true);
    await pg.query(
      `update account_invites set accepted_at=clock_timestamp() where id=$1`,
      [created.inviteId],
    );
    const crossTenant = await revokeGuarded(
      pg, ACCOUNT_BO, UID_BO, String(created.inviteId), 'cross-tenant-probe',
    );
    const missing = await revokeGuarded(
      pg, ACCOUNT_BO, UID_BO, MISSING_INVITE, 'missing-probe',
    );
    assert.deepEqual(crossTenant, { ok: false, reason: 'denied' });
    assert.deepEqual(missing, { ok: false, reason: 'not_found' });
    const ownerTerminal = await revokeGuarded(
      pg, ACCOUNT_ANA, UID_ANA, String(created.inviteId), 'owner-terminal',
    );
    assert.deepEqual(ownerTerminal, { ok: false, reason: 'not_pending' });
  });

  test('hotel transfer invalidates the old company and platform admin can clean up', async () => {
    const created = await createGuarded(pg, {
      actorAccountId: ACCOUNT_ANA,
      actorAuthUserId: UID_ANA,
      hotelId: PID_A2,
      email: 'transfer-stale@example.test',
      role: 'front_desk',
      organizationId: ORG_A,
      membershipScope: 'property',
      propertyIds: [PID_A2],
      requestId: 'before-transfer',
    });
    assert.equal(created.ok, true);
    await asService(
      pg,
      `select public.staxis_set_primary_property_organization(
         $1::uuid,$2::uuid,$3::uuid,'operator'
       )`,
      [ACCOUNT_ADMIN, PID_A2, ORG_B],
    );
    const staleCreate = await createGuarded(pg, {
      actorAccountId: ACCOUNT_ANA,
      actorAuthUserId: UID_ANA,
      hotelId: PID_A2,
      email: 'after-transfer@example.test',
      role: 'front_desk',
      organizationId: ORG_A,
      membershipScope: 'property',
      propertyIds: [PID_A2],
      requestId: 'after-transfer',
    });
    assert.deepEqual(staleCreate, { ok: false, reason: 'denied' });
    const staleOwnerRevoke = await revokeGuarded(
      pg, ACCOUNT_ANA, UID_ANA, String(created.inviteId), 'old-company-revoke',
    );
    assert.deepEqual(staleOwnerRevoke, { ok: false, reason: 'denied' });
    const adminCleanup = await revokeGuarded(
      pg, ACCOUNT_ADMIN, UID_ADMIN, String(created.inviteId), 'admin-cleanup',
    );
    assert.equal(adminCleanup.ok, true);
  });
});
