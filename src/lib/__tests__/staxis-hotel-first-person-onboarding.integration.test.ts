import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_ANA,
  ORG_A,
  UID_ADMIN,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const INDEPENDENT_HOTEL = '41100000-0000-4000-8000-000000000001';
const ORGANIZATION_HOTEL = '41100000-0000-4000-8000-000000000002';
const ORGANIZATION_OWNER_HOTEL = '41100000-0000-4000-8000-000000000003';
const DIRECT_ACCOUNT_HOTEL = '41100000-0000-4000-8000-000000000004';
const BOUND_HOTEL = '41100000-0000-4000-8000-000000000005';

const WRONG_EMAIL_USER = '41110000-0000-4000-8000-000000000001';
const OWNER_USER = '41110000-0000-4000-8000-000000000002';
const GM_USER = '41110000-0000-4000-8000-000000000003';
const LATER_USER = '41110000-0000-4000-8000-000000000004';
const DIRECT_ACCOUNT_USER = '41110000-0000-4000-8000-000000000005';
const LATER_CLAIM = '41120000-0000-4000-8000-000000000001';
const DIRECT_ACCOUNT = '41120000-0000-4000-8000-000000000002';

const OWNER_EMAIL = 'first.owner@example.test';
const GM_EMAIL = 'first.gm@example.test';
const LATER_EMAIL = 'later.person@example.test';
const OWNER_CODE = 'OWNR-BCDFGHJKM2';
const GM_CODE = 'GMGR-NPQRSTVWXY';
const ORGANIZATION_OWNER_CODE = 'ORGO-BCDFGHJKM6';

interface JsonRow {
  value: Record<string, unknown>;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function jsonRpc(
  pg: PGlite,
  sql: string,
  params: unknown[],
): Promise<Record<string, unknown>> {
  const result = await pg.query<JsonRow>(sql, params);
  return result.rows[0].value;
}

async function mintFirstPerson(
  pg: PGlite,
  input: {
    hotelId: string;
    code: string;
    role: 'owner' | 'general_manager';
    email: string;
    requestId: string;
  },
): Promise<Record<string, unknown>> {
  return jsonRpc(
    pg,
    `select public.staxis_mint_first_person_onboarding_invite(
       $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7
     ) as value`,
    [
      ACCOUNT_ADMIN,
      UID_ADMIN,
      input.hotelId,
      input.code,
      input.role,
      input.email,
      input.requestId,
    ],
  );
}

async function finalizeFirstPerson(
  pg: PGlite,
  input: {
    codeId: string;
    code: string;
    hotelId: string;
    authUserId: string;
    username: string;
    displayName: string;
    requestedRole: 'owner' | 'general_manager';
    requestId: string;
  },
): Promise<Record<string, unknown>> {
  return jsonRpc(
    pg,
    `select public.staxis_finalize_join_code_signup(
       $1::uuid,$2,$3::uuid,0,$4::uuid,$5,$6,$7,null,'en',$8
     ) as value`,
    [
      input.codeId,
      input.code,
      input.hotelId,
      input.authUserId,
      input.username,
      input.displayName,
      input.requestedRole,
      input.requestId,
    ],
  );
}

async function structuralAccountCount(pg: PGlite, hotelId: string): Promise<number> {
  const result = await pg.query<{ count: number }>(
    `select count(*)::integer as count
       from public.accounts account
      where account.active is true
        and account.role <> 'admin'
        and $1::uuid = any(
          public._staxis_structural_account_property_ids(account.id)
        )`,
    [hotelId],
  );
  return Number(result.rows[0].count);
}

describe('hotel shell to first-person onboarding — real SQL vertical slice', () => {
  let pg: PGlite;
  let ownerAccountId: string;

  before(async () => {
    const migrated = await applyMigrationsToPglite();
    assert.ok(
      migrated.report.applied.includes('0411_first_person_onboarding.sql'),
      `0411 must apply to PGlite; failures: ${JSON.stringify(migrated.report.failedAtRuntime)}`,
    );
    pg = migrated.pg;
    await seedTwoCompanies(pg);

    await pg.query(
      `insert into public.properties(
         id,owner_id,name,total_rooms,timezone,onboarding_state
       ) values
         ($1,$6,'Independent Shell',24,'America/Chicago','{"step":1}'::jsonb),
         ($2,$6,'Organization GM Shell',36,'America/Chicago','{"step":1}'::jsonb),
         ($3,$6,'Organization Owner Shell',42,'America/Chicago','{"step":1}'::jsonb),
         ($4,$6,'Direct Account Shell',30,'America/Chicago','{"step":1}'::jsonb),
         ($5,$6,'Bound Shell',18,'America/Chicago',
          jsonb_build_object('step',2,'firstPersonAccountId',$7::text))`,
      [
        INDEPENDENT_HOTEL,
        ORGANIZATION_HOTEL,
        ORGANIZATION_OWNER_HOTEL,
        DIRECT_ACCOUNT_HOTEL,
        BOUND_HOTEL,
        UID_ADMIN,
        DIRECT_ACCOUNT,
      ],
    );
    for (const hotelId of [ORGANIZATION_HOTEL, ORGANIZATION_OWNER_HOTEL]) {
      await pg.query(
        `select public.staxis_set_primary_property_organization(
           $1::uuid,$2::uuid,$3::uuid,'operator'
         )`,
        [ACCOUNT_ADMIN, hotelId, ORG_A],
      );
    }
    await pg.query(
      `insert into auth.users(id,email) values ($1,'direct.person@example.test')`,
      [DIRECT_ACCOUNT_USER],
    );
    await pg.query(
      `insert into public.accounts(
         id,username,password_hash,display_name,role,property_access,data_user_id
       ) values ($1,'direct.person','x','Direct Person','front_desk',array[$2::uuid],$3)`,
      [DIRECT_ACCOUNT, DIRECT_ACCOUNT_HOTEL, DIRECT_ACCOUNT_USER],
    );
  });

  after(async () => {
    await pg?.close();
  });

  test('shells bind immutable Owner and GM invitations without treating inherited organization members as hotel people', async () => {
    assert.equal(await structuralAccountCount(pg, INDEPENDENT_HOTEL), 0);
    assert.equal(await structuralAccountCount(pg, ORGANIZATION_HOTEL), 3);
    assert.equal(await structuralAccountCount(pg, ORGANIZATION_OWNER_HOTEL), 3);
    assert.equal(await structuralAccountCount(pg, DIRECT_ACCOUNT_HOTEL), 1);

    const inheritedReach = await pg.query<{
      property_id: string;
      entitlement_kind: string;
      scope_type: string;
      staxis_role: string;
    }>(
      `select authz.property_id,
              authz.entitlement_kind,
              authz.scope_type,
              authz.staxis_role
         from public._staxis_account_property_authorizations($1::uuid) authz
        where authz.property_id in ($2::uuid,$3::uuid)
          and authz.entitlement_kind='membership_hat'
          and authz.scope_type='company'
        order by authz.property_id`,
      [ACCOUNT_ANA, ORGANIZATION_HOTEL, ORGANIZATION_OWNER_HOTEL],
    );
    assert.deepEqual(inheritedReach.rows, [
      {
        property_id: ORGANIZATION_HOTEL,
        entitlement_kind: 'membership_hat',
        scope_type: 'company',
        staxis_role: 'owner',
      },
      {
        property_id: ORGANIZATION_OWNER_HOTEL,
        entitlement_kind: 'membership_hat',
        scope_type: 'company',
        staxis_role: 'owner',
      },
    ]);

    assert.deepEqual(
      await mintFirstPerson(pg, {
        hotelId: DIRECT_ACCOUNT_HOTEL,
        code: 'DRCT-BCDFGHJKM7',
        role: 'owner',
        email: 'blocked.direct@example.test',
        requestId: 'blocked-direct-account',
      }),
      { ok: false, reason: 'hotel_not_unclaimed' },
    );
    assert.deepEqual(
      await mintFirstPerson(pg, {
        hotelId: BOUND_HOTEL,
        code: 'BIND-BCDFGHJKM8',
        role: 'general_manager',
        email: 'blocked.binding@example.test',
        requestId: 'blocked-first-person-binding',
      }),
      { ok: false, reason: 'hotel_not_unclaimed' },
    );

    const topology = await pg.query<{
      property_id: string;
      organization_id: string;
      organization_type: string;
    }>(
      `select relationship.property_id,
              relationship.organization_id,
              organization.organization_type
         from public._staxis_current_primary_property_relationships() relationship
         join public.organizations organization
           on organization.id=relationship.organization_id
        where relationship.property_id in ($1,$2)
          and relationship.active_primary_count=1
        order by relationship.property_id`,
      [INDEPENDENT_HOTEL, ORGANIZATION_HOTEL],
    );
    const byHotel = new Map(topology.rows.map((row) => [row.property_id, row]));
    assert.equal(byHotel.get(INDEPENDENT_HOTEL)?.organization_type, 'single_hotel');
    assert.deepEqual(byHotel.get(ORGANIZATION_HOTEL), {
      property_id: ORGANIZATION_HOTEL,
      organization_id: ORG_A,
      organization_type: 'management_company',
    });

    const inheritedOwner = await mintFirstPerson(pg, {
      hotelId: ORGANIZATION_OWNER_HOTEL,
      code: ORGANIZATION_OWNER_CODE,
      role: 'owner',
      email: 'organization.owner@example.test',
      requestId: 'organization-first-owner',
    });
    assert.equal(inheritedOwner.ok, true);
    assert.equal(inheritedOwner.role, 'owner');

    const owner = await mintFirstPerson(pg, {
      hotelId: INDEPENDENT_HOTEL,
      code: OWNER_CODE,
      role: 'owner',
      email: `  ${OWNER_EMAIL.toUpperCase()}  `,
      requestId: 'first-owner',
    });
    assert.equal(owner.ok, true);
    assert.equal(owner.schemaVersion, 'first-person-onboarding-invite-v1');
    assert.equal(owner.status, 'created');
    assert.equal(owner.role, 'owner');
    assert.equal(owner.invitedEmail, OWNER_EMAIL);

    const ownerReplay = await mintFirstPerson(pg, {
      hotelId: INDEPENDENT_HOTEL,
      code: 'RTRY-BCDFGHJKM3',
      role: 'owner',
      email: OWNER_EMAIL,
      requestId: 'first-owner-retry',
    });
    assert.equal(ownerReplay.status, 'existing');
    assert.equal(ownerReplay.codeId, owner.codeId);
    assert.equal(ownerReplay.code, OWNER_CODE);
    assert.deepEqual(
      await mintFirstPerson(pg, {
        hotelId: INDEPENDENT_HOTEL,
        code: 'ROLE-BCDFGHJKM4',
        role: 'general_manager',
        email: OWNER_EMAIL,
        requestId: 'first-owner-role-conflict',
      }),
      { ok: false, reason: 'role_conflict' },
    );
    assert.deepEqual(
      await mintFirstPerson(pg, {
        hotelId: INDEPENDENT_HOTEL,
        code: 'MAIL-BCDFGHJKM5',
        role: 'owner',
        email: 'different@example.test',
        requestId: 'first-owner-email-conflict',
      }),
      { ok: false, reason: 'email_conflict' },
    );

    const gm = await mintFirstPerson(pg, {
      hotelId: ORGANIZATION_HOTEL,
      code: GM_CODE,
      role: 'general_manager',
      email: GM_EMAIL,
      requestId: 'first-gm',
    });
    assert.equal(gm.ok, true);
    assert.equal(gm.role, 'general_manager');
    assert.equal(gm.invitedEmail, GM_EMAIL);

    const bindings = await pg.query<{
      hotel_id: string;
      role: string;
      invited_email: string;
      step: number;
      used_count: number;
    }>(
      `select code.hotel_id,
              code.role,
              property.onboarding_state->>'invitedEmail' as invited_email,
              (property.onboarding_state->>'step')::integer as step,
              code.used_count
         from public.hotel_join_codes code
         join public.properties property on property.id=code.hotel_id
        where code.id in ($1::uuid,$2::uuid)
        order by code.hotel_id`,
      [String(owner.codeId), String(gm.codeId)],
    );
    assert.deepEqual(bindings.rows, [
      {
        hotel_id: INDEPENDENT_HOTEL,
        role: 'owner',
        invited_email: OWNER_EMAIL,
        step: 1,
        used_count: 0,
      },
      {
        hotel_id: ORGANIZATION_HOTEL,
        role: 'general_manager',
        invited_email: GM_EMAIL,
        step: 1,
        used_count: 0,
      },
    ]);
    assert.equal(await structuralAccountCount(pg, INDEPENDENT_HOTEL), 0);
    assert.equal(await structuralAccountCount(pg, ORGANIZATION_HOTEL), 3);

    await pg.query(
      `insert into auth.users(id,email) values
         ($1,'wrong@example.test'),
         ($2,$5),
         ($3,$6),
         ($4,$7)`,
      [WRONG_EMAIL_USER, OWNER_USER, GM_USER, LATER_USER, OWNER_EMAIL, GM_EMAIL, LATER_EMAIL],
    );

    const wrongEmail = await finalizeFirstPerson(pg, {
      codeId: String(owner.codeId),
      code: OWNER_CODE,
      hotelId: INDEPENDENT_HOTEL,
      authUserId: WRONG_EMAIL_USER,
      username: 'wrong.email',
      displayName: 'Wrong Email',
      requestedRole: 'owner',
      requestId: 'wrong-email',
    });
    assert.deepEqual(wrongEmail, { ok: false, status: 'denied' });

    const selfElevated = await finalizeFirstPerson(pg, {
      codeId: String(owner.codeId),
      code: OWNER_CODE,
      hotelId: INDEPENDENT_HOTEL,
      authUserId: OWNER_USER,
      username: 'first.owner',
      displayName: 'First Owner',
      requestedRole: 'general_manager',
      requestId: 'wrong-role',
    });
    assert.deepEqual(selfElevated, { ok: false, status: 'denied' });
    assert.equal(await structuralAccountCount(pg, INDEPENDENT_HOTEL), 0);

    const ownerFinalized = await finalizeFirstPerson(pg, {
      codeId: String(owner.codeId),
      code: OWNER_CODE,
      hotelId: INDEPENDENT_HOTEL,
      authUserId: OWNER_USER,
      username: 'first.owner',
      displayName: 'First Owner',
      requestedRole: 'owner',
      requestId: 'owner-finalize',
    });
    assert.equal(ownerFinalized.ok, true);
    assert.equal(ownerFinalized.status, 'finalized');
    assert.equal(ownerFinalized.finalRole, 'owner');
    ownerAccountId = String(ownerFinalized.accountId);

    const gmFinalized = await finalizeFirstPerson(pg, {
      codeId: String(gm.codeId),
      code: GM_CODE,
      hotelId: ORGANIZATION_HOTEL,
      authUserId: GM_USER,
      username: 'first.gm',
      displayName: 'First GM',
      requestedRole: 'general_manager',
      requestId: 'gm-finalize',
    });
    assert.equal(gmFinalized.ok, true);
    assert.equal(gmFinalized.status, 'finalized');
    assert.equal(gmFinalized.finalRole, 'general_manager');

    const finalized = await pg.query<{
      hotel_id: string;
      owner_id: string;
      first_person_account_id: string;
      invited_email: string;
      account_created_at: string;
      step: number;
      account_role: string;
    }>(
      `select property.id as hotel_id,
              property.owner_id,
              property.onboarding_state->>'firstPersonAccountId' as first_person_account_id,
              property.onboarding_state->>'invitedEmail' as invited_email,
              property.onboarding_state->>'accountCreatedAt' as account_created_at,
              (property.onboarding_state->>'step')::integer as step,
              account.role as account_role
         from public.properties property
         join public.accounts account
           on account.id=(property.onboarding_state->>'firstPersonAccountId')::uuid
        where property.id in ($1,$2)
        order by property.id`,
      [INDEPENDENT_HOTEL, ORGANIZATION_HOTEL],
    );
    assert.deepEqual(
      finalized.rows.map((row) => ({
        hotelId: row.hotel_id,
        ownerId: row.owner_id,
        firstPersonAccountId: row.first_person_account_id,
        invitedEmail: row.invited_email,
        hasAccountCreatedAt: Boolean(row.account_created_at),
        step: row.step,
        accountRole: row.account_role,
      })),
      [
        {
          hotelId: INDEPENDENT_HOTEL,
          ownerId: OWNER_USER,
          firstPersonAccountId: ownerAccountId,
          invitedEmail: OWNER_EMAIL,
          hasAccountCreatedAt: true,
          step: 3,
          accountRole: 'owner',
        },
        {
          hotelId: ORGANIZATION_HOTEL,
          ownerId: UID_ADMIN,
          firstPersonAccountId: String(gmFinalized.accountId),
          invitedEmail: GM_EMAIL,
          hasAccountCreatedAt: true,
          step: 3,
          accountRole: 'general_manager',
        },
      ],
    );
    assert.equal(await structuralAccountCount(pg, INDEPENDENT_HOTEL), 1);
    assert.equal(await structuralAccountCount(pg, ORGANIZATION_HOTEL), 4);

    const organizationRoster = await jsonRpc(
      pg,
      `select public.staxis_list_authoritative_hotel_accounts(
         $1::uuid,false
       ) as value`,
      [ORGANIZATION_HOTEL],
    );
    const rosterAccounts = organizationRoster.accounts as Array<{
      accountId: string;
      managementSurface: string;
    }>;
    assert.equal(
      rosterAccounts.find((account) => account.accountId === ACCOUNT_ANA)
        ?.managementSurface,
      'company_access',
    );
    assert.equal(
      rosterAccounts.find(
        (account) => account.accountId === String(gmFinalized.accountId),
      )?.managementSurface,
      'legacy_hotel',
    );

    const stateBeforeLaterInvite = await pg.query<{
      onboarding_state: Record<string, unknown>;
      onboarding_completed_at: string | null;
      onboarding_prompt_shown_at: string | null;
    }>(
      `select onboarding_state,onboarding_completed_at,onboarding_prompt_shown_at
         from public.properties where id=$1`,
      [INDEPENDENT_HOTEL],
    );
    const laterHash = hash('later-person-invite');
    const laterInvite = await jsonRpc(
      pg,
      `select public.staxis_create_account_invite_guarded(
         $1::uuid,$2::uuid,$3::uuid,$4,'front_desk',$5,
         clock_timestamp()+interval '7 days',null::uuid,null::text,null::uuid[],$6
       ) as value`,
      [
        ownerAccountId,
        OWNER_USER,
        INDEPENDENT_HOTEL,
        LATER_EMAIL,
        laterHash,
        'later-invite',
      ],
    );
    assert.equal(laterInvite.ok, true);

    const claimed = await jsonRpc(
      pg,
      `select public.staxis_claim_account_invite_acceptance($1,$2::uuid) as value`,
      [laterHash, LATER_CLAIM],
    );
    assert.equal(claimed.ok, true);
    const accepted = await jsonRpc(
      pg,
      `select public.staxis_accept_account_invite(
         $1,$2::uuid,$3::uuid,'later.person','Later Person'
       ) as value`,
      [laterHash, LATER_CLAIM, LATER_USER],
    );
    assert.equal(accepted.ok, true);
    assert.equal(accepted.normalized, false);
    assert.notEqual(accepted.accountId, ownerAccountId);

    const laterAccount = await pg.query<{
      id: string;
      role: string;
      property_access: string[];
    }>(
      `select id,role,property_access
         from public.accounts where data_user_id=$1`,
      [LATER_USER],
    );
    assert.deepEqual(laterAccount.rows[0], {
      id: String(accepted.accountId),
      role: 'front_desk',
      property_access: [INDEPENDENT_HOTEL],
    });

    const stateAfterLaterInvite = await pg.query<{
      onboarding_state: Record<string, unknown>;
      onboarding_completed_at: string | null;
      onboarding_prompt_shown_at: string | null;
    }>(
      `select onboarding_state,onboarding_completed_at,onboarding_prompt_shown_at
         from public.properties where id=$1`,
      [INDEPENDENT_HOTEL],
    );
    assert.deepEqual(stateAfterLaterInvite.rows[0], stateBeforeLaterInvite.rows[0]);
    assert.equal(
      stateAfterLaterInvite.rows[0].onboarding_state.firstPersonAccountId,
      ownerAccountId,
    );
    assert.equal(await structuralAccountCount(pg, INDEPENDENT_HOTEL), 2);
  });
});
