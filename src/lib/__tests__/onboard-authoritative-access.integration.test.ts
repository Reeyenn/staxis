/**
 * Onboarding is code-addressable but hotel authority is not. These tests run
 * the real route handlers against the real normalized-access SQL and leave a
 * deliberately stale property_access value behind. A transfer/revocation must
 * win over that snapshot both at request admission and at the final write
 * fence.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { GET as wizardGet, PATCH as wizardPatch } from '@/app/api/onboard/wizard/route';
import { GET as resumeGet } from '@/app/api/onboard/resume/route';
import { PUT as decideJoinRequest } from '@/app/api/staff/join-requests/route';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { applyMigrationsToPgliteThrough } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_ADMIN,
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
  UID_GIL,
  UID_MARIA,
  UID_VERA,
  UID_WANDA,
  seedTwoCompanies,
  type TwoCompanySeed,
} from '../../../tests/fixtures/pglite-two-company-seed';

const CODE_A1 = 'A1-STALE-AUTH';
const CODE_B1 = 'B1-REVOKE-RACE';
const CODE_L1 = 'L1-LEGACY-OWNER';
const CODE_STAFF_ACTIVE = 'L1-STAFF-ACTIVE';
const CODE_STAFF_EXHAUSTED = 'L1-STAFF-USED';
const JOIN_ACCOUNT_A1 = 'f1000000-0000-4000-8000-000000000001';
const JOIN_USER_A1 = 'f1000000-0000-4000-8000-000000000002';
const JOIN_REQUEST_A1 = 'f1000000-0000-4000-8000-000000000003';
const JOIN_ACCOUNT_B1 = 'f2000000-0000-4000-8000-000000000001';
const JOIN_USER_B1 = 'f2000000-0000-4000-8000-000000000002';
const JOIN_REQUEST_B1 = 'f2000000-0000-4000-8000-000000000003';
const RACE_MANAGER_ACCOUNT = 'f2000000-0000-4000-8000-000000000004';
const RACE_MANAGER_USER = 'f2000000-0000-4000-8000-000000000005';
const JOIN_ACCOUNT_ADMIN = 'f4000000-0000-4000-8000-000000000001';
const JOIN_USER_ADMIN = 'f4000000-0000-4000-8000-000000000002';
const JOIN_REQUEST_ADMIN = 'f4000000-0000-4000-8000-000000000003';
const TRANSFER_INVITE_ID = 'f3000000-0000-4000-8000-000000000001';
const TRANSFER_INVITE_USER = 'f3000000-0000-4000-8000-000000000002';
const TRANSFER_INVITE_CLAIM = 'f3000000-0000-4000-8000-000000000003';
const TRANSFER_INVITER_ACCOUNT = 'f3000000-0000-4000-8000-000000000004';
const TRANSFER_INVITER_USER = 'f3000000-0000-4000-8000-000000000005';
const TRANSFER_INVITE_HASH = 'a'.repeat(64);

let pg: PGlite;
let shim: PglitePostgrest;
let seed: TwoCompanySeed;
let signedInAs: string | null = null;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

function request(
  url: string,
  init?: { method?: string; body?: Record<string, unknown> },
): NextRequest {
  return new NextRequest(url, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: 'Bearer onboarding-authority-test-token',
      'content-type': 'application/json',
      'x-real-ip': '203.0.113.88',
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function propertyName(propertyId: string): Promise<string> {
  const result = await pg.query<{ name: string }>(
    `select name from properties where id=$1`,
    [propertyId],
  );
  return result.rows[0].name;
}

async function rawPropertyAccess(accountId: string): Promise<string[]> {
  const result = await pg.query<{ property_access: string[] }>(
    `select property_access from accounts where id=$1`,
    [accountId],
  );
  return result.rows[0].property_access;
}

before(async () => {
  const migrated = await applyMigrationsToPgliteThrough('0425');
  assert.ok(
    migrated.report.applied.some((file) => file.startsWith('0391_')),
    'transactional invite/join migration must be active in this integration test',
  );
  pg = migrated.pg;
  const catalog = await loadCatalog(pg);
  shim = createPglitePostgrest(pg, catalog);
  // @ts-expect-error install the PGlite-backed PostgREST facade on the shared client
  supabaseAdmin.from = shim.from;
  // @ts-expect-error install real migration RPCs on the shared client
  supabaseAdmin.rpc = shim.rpc;
  // @ts-expect-error requireSession reads only this subset in the test
  supabaseAdmin.auth.getUser = async () => (
    signedInAs
      ? { data: { user: { id: signedInAs, email: 'manager@example.test' } }, error: null }
      : { data: { user: null }, error: { message: 'no session', status: 401, name: 'AuthApiError' } }
  );

  seed = await seedTwoCompanies(pg);
  const onboardingState = JSON.stringify({
    step: 5,
    accountCreatedAt: '2026-07-01T00:00:00.000Z',
    emailVerifiedAt: '2026-07-01T00:01:00.000Z',
    hotelDetailsAt: '2026-07-01T00:02:00.000Z',
  });
  await pg.query(
    `update properties
        set onboarding_state=$2::jsonb,
            onboarding_completed_at=null,
            onboarding_prompt_shown_at=null
      where id in ($1,$3)`,
    [PID_A1, onboardingState, PID_B1],
  );
  await pg.query(
    `insert into hotel_join_codes
       (hotel_id,code,role,code_kind,expires_at,max_uses,used_count,created_by)
     values ($1,$2,null,'onboarding_resume',clock_timestamp()+interval '1 day',1,1,$3),
            ($4,$5,null,'onboarding_resume',clock_timestamp()+interval '1 day',1,1,$6),
            ($7,$8,null,'onboarding_resume',clock_timestamp()+interval '1 day',1,1,$9),
            ($7,$10,null,'staff_signup',clock_timestamp()+interval '1 day',100,0,$9),
            ($7,$11,null,'staff_signup',clock_timestamp()+interval '1 day',100,100,$9)`,
    [
      PID_A1, CODE_A1, ACCOUNT_MARIA,
      PID_B1, CODE_B1, ACCOUNT_GIL,
      PID_L1, CODE_L1, ACCOUNT_WANDA,
      CODE_STAFF_ACTIVE, CODE_STAFF_EXHAUSTED,
    ],
  );
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  await pg?.close();
});

describe('onboarding uses live normalized authority', () => {
  test('a hotel transfer after invite claim leaves no account or entitlement', async () => {
    await pg.query(
      `insert into auth.users(id,email) values ($1,'transfer-inviter@example.test')`,
      [TRANSFER_INVITER_USER],
    );
    await pg.query(
      `insert into accounts(
         id,username,password_hash,display_name,role,property_access,data_user_id
       ) values ($1,'transfer-inviter','x','Transfer Inviter','general_manager','{}',$2)`,
      [TRANSFER_INVITER_ACCOUNT, TRANSFER_INVITER_USER],
    );
    await pg.query(
      `select public.staxis_set_membership_hat(
         $1,$2,$3,'property','general_manager',jsonb_build_array($4::text),
         'General Manager'
       )`,
      [ACCOUNT_ADMIN, ORG_A, TRANSFER_INVITER_ACCOUNT, PID_A2],
    );
    const before = await pg.query<{
      value: { propertyStandings: Array<{ propertyId: string; hotelMutationAllowed: boolean }> };
    }>(
      `select public.staxis_list_account_authorized_properties($1) as value`,
      [TRANSFER_INVITER_ACCOUNT],
    );
    assert.equal(
      before.rows[0].value.propertyStandings
        .find((standing) => standing.propertyId === PID_A2)?.hotelMutationAllowed,
      true,
      'the invite starts with explicit property-operational authority',
    );
    await pg.query(
      `insert into account_invites(
         id,hotel_id,email,role,token_hash,expires_at,invited_by,
         organization_id,membership_scope,covered_property_ids
       ) values (
         $1,$2,'transfer-invite@example.test','maintenance',$3,
         clock_timestamp()+interval '1 day',$4,$5,'property',array[$2]::uuid[]
       )`,
      [TRANSFER_INVITE_ID, PID_A2, TRANSFER_INVITE_HASH, TRANSFER_INVITER_ACCOUNT, ORG_A],
    );
    const claim = await pg.query<{ value: { ok: boolean; inviteId: string } }>(
      `select public.staxis_claim_account_invite_acceptance($1,$2) as value`,
      [TRANSFER_INVITE_HASH, TRANSFER_INVITE_CLAIM],
    );
    assert.equal(claim.rows[0].value.ok, true);
    assert.equal(claim.rows[0].value.inviteId, TRANSFER_INVITE_ID);
    await pg.query(
      `insert into auth.users(id,email) values ($1,'transfer-invite@example.test')`,
      [TRANSFER_INVITE_USER],
    );

    await pg.query(
      `select public.staxis_set_primary_property_organization($1,$2,$3,'operator')`,
      [ACCOUNT_ADMIN, PID_A2, ORG_B],
    );
    await assert.rejects(
      pg.query(
        `select public.staxis_accept_account_invite($1,$2,$3,'transfer-invite','Transfer Invitee')`,
        [TRANSFER_INVITE_HASH, TRANSFER_INVITE_CLAIM, TRANSFER_INVITE_USER],
      ),
      /topology|changed company|no longer manages/i,
    );
    const accounts = await pg.query<{ count: number }>(
      `select count(*)::integer as count from accounts where data_user_id=$1`,
      [TRANSFER_INVITE_USER],
    );
    assert.equal(Number(accounts.rows[0].count), 0);
    const invitation = await pg.query<{
      accepted_at: string | null;
      acceptance_claim_token: string | null;
    }>(
      `select accepted_at,acceptance_claim_token from account_invites where id=$1`,
      [TRANSFER_INVITE_ID],
    );
    assert.equal(invitation.rows[0].accepted_at, null);
    assert.equal(invitation.rows[0].acceptance_claim_token, TRANSFER_INVITE_CLAIM);
    const released = await pg.query<{ released: boolean }>(
      `select public.staxis_release_account_invite_acceptance($1,$2) as released`,
      [TRANSFER_INVITE_ID, TRANSFER_INVITE_CLAIM],
    );
    assert.equal(released.rows[0].released, true);
    await pg.query(`delete from auth.users where id=$1`, [TRANSFER_INVITE_USER]);
  });

  test('staff approval commits staff, link, normalized authority, decision, and audit together', async () => {
    await pg.query(`insert into auth.users(id,email) values ($1,'join-a1@example.test')`, [JOIN_USER_A1]);
    await pg.query(
      `insert into accounts(
         id,username,password_hash,display_name,role,property_access,data_user_id
       ) values ($1,'join-a1','x','A1 Housekeeper','housekeeping','{}',$2)`,
      [JOIN_ACCOUNT_A1, JOIN_USER_A1],
    );
    await pg.query(
      `insert into join_requests(
         id,property_id,account_id,name,phone,language,department
       ) values ($1,$2,$3,'A1 Housekeeper','+1 409 555 0101','en','housekeeping')`,
      [JOIN_REQUEST_A1, PID_A1, JOIN_ACCOUNT_A1],
    );

    signedInAs = UID_MARIA;
    const response = await decideJoinRequest(request(
      'https://staxis.test/api/staff/join-requests',
      {
        method: 'PUT',
        body: { hotelId: PID_A1, requestId: JOIN_REQUEST_A1, decision: 'approve' },
      },
    ));
    assert.equal(response.status, 200, await response.text());

    const account = await pg.query<{ staff_id: string | null; property_access: string[] }>(
      `select staff_id,property_access from accounts where id=$1`,
      [JOIN_ACCOUNT_A1],
    );
    assert.ok(account.rows[0].staff_id);
    assert.deepEqual(account.rows[0].property_access, [], 'normalized access does not repopulate the legacy snapshot');
    const link = await pg.query<{ count: number }>(
      `select count(*)::integer as count
         from account_property_staff_links
        where account_id=$1 and property_id=$2 and staff_id=$3 and is_active`,
      [JOIN_ACCOUNT_A1, PID_A1, account.rows[0].staff_id],
    );
    assert.equal(Number(link.rows[0].count), 1);
    const projection = await pg.query<{ value: { authorityMode: string; propertyIds: string[] } }>(
      `select public.staxis_list_account_authorized_properties($1) as value`,
      [JOIN_ACCOUNT_A1],
    );
    assert.equal(projection.rows[0].value.authorityMode, 'normalized');
    assert.deepEqual(projection.rows[0].value.propertyIds, [PID_A1]);
    const decision = await pg.query<{ status: string }>(
      `select status from join_requests where id=$1`,
      [JOIN_REQUEST_A1],
    );
    assert.equal(decision.rows[0].status, 'approved');
    const audit = await pg.query<{ count: number }>(
      `select count(*)::integer as count from admin_audit_log
        where action='join_request.approve' and target_id=$1`,
      [JOIN_REQUEST_A1],
    );
    assert.equal(Number(audit.rows[0].count), 1);
  });

  test('staff approval rechecks the manager inside the transaction', async () => {
    await pg.query(`insert into auth.users(id,email) values ($1,'race-manager@example.test')`, [RACE_MANAGER_USER]);
    await pg.query(
      `insert into accounts(
         id,username,password_hash,display_name,role,property_access,data_user_id
       ) values ($1,'race-manager','x','Race Manager','general_manager','{}',$2)`,
      [RACE_MANAGER_ACCOUNT, RACE_MANAGER_USER],
    );
    const raceHatResult = await pg.query<{ membership_id: string }>(
      `select public.staxis_set_membership_hat(
         $1,$2,$3,'property','general_manager',jsonb_build_array($4::text),
         'General Manager'
       ) as membership_id`,
      [ACCOUNT_ADMIN, ORG_B, RACE_MANAGER_ACCOUNT, PID_B1],
    );
    const raceManagerHat = raceHatResult.rows[0].membership_id;
    assert.ok(raceManagerHat);
    await pg.query(`insert into auth.users(id,email) values ($1,'join-b1@example.test')`, [JOIN_USER_B1]);
    await pg.query(
      `insert into accounts(
         id,username,password_hash,display_name,role,property_access,data_user_id
       ) values ($1,'join-b1','x','B1 Maintenance','maintenance','{}',$2)`,
      [JOIN_ACCOUNT_B1, JOIN_USER_B1],
    );
    await pg.query(
      `insert into join_requests(
         id,property_id,account_id,name,language,department
       ) values ($1,$2,$3,'B1 Maintenance','en','maintenance')`,
      [JOIN_REQUEST_B1, PID_B1, JOIN_ACCOUNT_B1],
    );
    let commitRpcCalls = 0;
    // @ts-expect-error narrow test wrapper around the generic Supabase RPC method
    supabaseAdmin.rpc = async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'staxis_decide_staff_join_request') {
        commitRpcCalls++;
        await pg.query(
          `update organization_memberships
              set status='revoked', ended_at=clock_timestamp()
            where id=$1`,
          [raceManagerHat],
        );
      }
      return shim.rpc(fn, args);
    };

    try {
      signedInAs = RACE_MANAGER_USER;
      const response = await decideJoinRequest(request(
        'https://staxis.test/api/staff/join-requests',
        {
          method: 'PUT',
          body: { hotelId: PID_B1, requestId: JOIN_REQUEST_B1, decision: 'approve' },
        },
      ));
      assert.equal(response.status, 403);
      assert.equal(commitRpcCalls, 1);
      const pending = await pg.query<{ status: string }>(
        `select status from join_requests where id=$1`,
        [JOIN_REQUEST_B1],
      );
      assert.equal(pending.rows[0].status, 'pending');
      const account = await pg.query<{ staff_id: string | null; property_access: string[] }>(
        `select staff_id,property_access from accounts where id=$1`,
        [JOIN_ACCOUNT_B1],
      );
      assert.equal(account.rows[0].staff_id, null);
      assert.deepEqual(account.rows[0].property_access, []);
    } finally {
      // @ts-expect-error restore the PGlite-backed generic RPC method
      supabaseAdmin.rpc = shim.rpc;
    }
  });

  test('a platform admin may approve into the current company without customer-org provenance', async () => {
    await pg.query(`insert into auth.users(id,email) values ($1,'join-admin@example.test')`, [JOIN_USER_ADMIN]);
    await pg.query(
      `insert into accounts(
         id,username,password_hash,display_name,role,property_access,data_user_id
       ) values ($1,'join-admin','x','Admin-approved Desk','front_desk','{}',$2)`,
      [JOIN_ACCOUNT_ADMIN, JOIN_USER_ADMIN],
    );
    await pg.query(
      `insert into join_requests(
         id,property_id,account_id,name,language,department
       ) values ($1,$2,$3,'Admin-approved Desk','en','front_desk')`,
      [JOIN_REQUEST_ADMIN, PID_A1, JOIN_ACCOUNT_ADMIN],
    );
    signedInAs = UID_ADMIN;
    const response = await decideJoinRequest(request(
      'https://staxis.test/api/staff/join-requests',
      {
        method: 'PUT',
        body: { hotelId: PID_A1, requestId: JOIN_REQUEST_ADMIN, decision: 'approve' },
      },
    ));
    assert.equal(response.status, 200, await response.text());
    const projection = await pg.query<{ value: { authorityMode: string; propertyIds: string[] } }>(
      `select public.staxis_list_account_authorized_properties($1) as value`,
      [JOIN_ACCOUNT_ADMIN],
    );
    assert.equal(projection.rows[0].value.authorityMode, 'normalized');
    assert.deepEqual(projection.rows[0].value.propertyIds, [PID_A1]);
  });

  test('a company-only oversight hat can read the hotel elsewhere but cannot mutate onboarding', async () => {
    signedInAs = UID_VERA;
    const getResponse = await wizardGet(request(
      `https://staxis.test/api/onboard/wizard?code=${encodeURIComponent(CODE_B1)}`,
    ));
    assert.equal(getResponse.status, 200);
    const getBody = await getResponse.json() as {
      data: { state: Record<string, unknown>; hotelDefaults: unknown };
    };
    assert.deepEqual(getBody.data.state, { step: 5 });
    assert.equal(getBody.data.hotelDefaults, null);

    const nameBefore = await propertyName(PID_B1);
    const patchResponse = await wizardPatch(request(
      'https://staxis.test/api/onboard/wizard',
      {
        method: 'PATCH',
        body: { code: CODE_B1, propertyUpdates: { name: 'Oversight mutation' } },
      },
    ));
    assert.equal(patchResponse.status, 403);
    assert.equal(await propertyName(PID_B1), nameBefore);

    const resume = await resumeGet(request(
      `https://staxis.test/api/onboard/resume?propertyId=${PID_B1}`,
    ));
    assert.equal(resume.status, 307);
    assert.equal(new URL(resume.headers.get('location')!).pathname, '/property-selector');
  });

  test('active and exhausted ordinary staff bearers never open the onboarding wizard', async () => {
    signedInAs = null;
    for (const code of [CODE_STAFF_ACTIVE, CODE_STAFF_EXHAUSTED]) {
      const response = await wizardGet(request(
        `https://staxis.test/api/onboard/wizard?code=${encodeURIComponent(code)}`,
      ));
      assert.equal(response.status, 404);
    }
  });

  test('code-only writes are minimal; an authorized legacy owner can continue normally', async () => {
    signedInAs = null;
    const welcome = await wizardPatch(request(
      'https://staxis.test/api/onboard/wizard',
      { method: 'PATCH', body: { code: CODE_L1, partialState: { step: 2 } } },
    ));
    assert.equal(welcome.status, 200);
    const welcomeBody = await welcome.json() as { data: { state: Record<string, unknown> } };
    assert.deepEqual(welcomeBody.data.state, { step: 2 });

    const arbitrary = await wizardPatch(request(
      'https://staxis.test/api/onboard/wizard',
      {
        method: 'PATCH',
        body: {
          code: CODE_L1,
          partialState: { emailVerifiedAt: '2026-07-01T00:01:00.000Z' },
        },
      },
    ));
    assert.equal(arbitrary.status, 401, 'a valid code is not authorization for later progress');

    signedInAs = UID_WANDA;
    const accountCreated = await wizardPatch(request(
      'https://staxis.test/api/onboard/wizard',
      {
        method: 'PATCH',
        body: {
          code: CODE_L1,
          partialState: { accountCreatedAt: '2026-07-01T00:00:00.000Z' },
        },
      },
    ));
    assert.equal(accountCreated.status, 200);
    const createdBody = await accountCreated.json() as {
      data: { state: Record<string, unknown> };
    };
    assert.equal(createdBody.data.state.accountCreatedAt, '2026-07-01T00:00:00.000Z');

    const fullGet = await wizardGet(request(
      `https://staxis.test/api/onboard/wizard?code=${encodeURIComponent(CODE_L1)}`,
    ));
    assert.equal(fullGet.status, 200);
    const fullBody = await fullGet.json() as {
      data: { state: Record<string, unknown>; hotelDefaults: Record<string, unknown> | null };
    };
    assert.equal(typeof fullBody.data.state.accountCreatedAt, 'string');
    assert.equal(typeof fullBody.data.state.emailVerifiedAt, 'string');
    assert.ok(fullBody.data.hotelDefaults);

    const resume = await resumeGet(request(
      `https://staxis.test/api/onboard/resume?propertyId=${PID_L1}`,
    ));
    assert.equal(resume.status, 307);
    const location = new URL(resume.headers.get('location')!);
    assert.equal(location.pathname, '/onboard');
    assert.equal(location.searchParams.get('code'), CODE_L1);
    const prompt = await pg.query<{ onboarding_prompt_shown_at: string | null }>(
      `select onboarding_prompt_shown_at from properties where id=$1`,
      [PID_L1],
    );
    assert.ok(prompt.rows[0].onboarding_prompt_shown_at);
  });

  test('the exact bound first person can resume setup independently of team-management capability', async () => {
    await pg.query(
      `update properties set onboarding_prompt_shown_at=null where id=$1`,
      [PID_L1],
    );
    await pg.query(
      `insert into capability_overrides(
         property_id,capability,role,allowed,updated_by
       ) values ($1,'manage_team','owner',false,$2)`,
      [PID_L1, ACCOUNT_ADMIN],
    );
    try {
      signedInAs = UID_WANDA;
      const response = await resumeGet(request(
        `https://staxis.test/api/onboard/resume?propertyId=${PID_L1}`,
      ));
      assert.equal(response.status, 307);
      assert.equal(new URL(response.headers.get('location')!).pathname, '/onboard');
      const prompt = await pg.query<{ onboarding_prompt_shown_at: string | null }>(
        `select onboarding_prompt_shown_at from properties where id=$1`,
        [PID_L1],
      );
      assert.ok(prompt.rows[0].onboarding_prompt_shown_at);
    } finally {
      await pg.query(
        `delete from capability_overrides
          where property_id=$1 and capability='manage_team' and role='owner'`,
        [PID_L1],
      );
    }
  });

  test('a transferred hotel is neither disclosed nor mutated through stale property_access', async () => {
    // Simulate a pre-cutover snapshot that still names the hotel, then move the
    // hotel to Company B. Maria remains normalized and the old array must not
    // resurrect Company A access.
    await pg.query(
      `update accounts set property_access=array[$2]::uuid[] where id=$1`,
      [ACCOUNT_MARIA, PID_A1],
    );
    await pg.query(
      `select public.staxis_set_primary_property_organization($1,$2,$3,'operator')`,
      [ACCOUNT_ADMIN, PID_A1, ORG_B],
    );
    assert.deepEqual(await rawPropertyAccess(ACCOUNT_MARIA), [PID_A1]);

    signedInAs = UID_MARIA;
    const getResponse = await wizardGet(request(
      `https://staxis.test/api/onboard/wizard?code=${encodeURIComponent(CODE_A1)}`,
    ));
    assert.equal(getResponse.status, 404);

    const nameBefore = await propertyName(PID_A1);
    const patchResponse = await wizardPatch(request(
      'https://staxis.test/api/onboard/wizard',
      {
        method: 'PATCH',
        body: { code: CODE_A1, propertyUpdates: { name: 'Cross-tenant overwrite' } },
      },
    ));
    assert.equal(patchResponse.status, 404);
    assert.equal(await propertyName(PID_A1), nameBefore);

    const resumeResponse = await resumeGet(request(
      `https://staxis.test/api/onboard/resume?propertyId=${PID_A1}`,
    ));
    assert.equal(resumeResponse.status, 307);
    assert.equal(new URL(resumeResponse.headers.get('location')!).pathname, '/property-selector');
    const prompt = await pg.query<{ onboarding_prompt_shown_at: string | null }>(
      `select onboarding_prompt_shown_at from properties where id=$1`,
      [PID_A1],
    );
    assert.equal(prompt.rows[0].onboarding_prompt_shown_at, null);
  });

  test('revocation between admission and the prewrite recheck prevents the write', async () => {
    await pg.query(
      `update accounts set property_access=array[$2]::uuid[] where id=$1`,
      [ACCOUNT_GIL, PID_B1],
    );
    assert.deepEqual(await rawPropertyAccess(ACCOUNT_GIL), [PID_B1]);

    const gilHat = seed.hats.get(`${ACCOUNT_GIL}:property:general_manager`);
    assert.ok(gilHat);
    let projectionReads = 0;
    // Revoke immediately before the second live authority projection. The
    // first admits the request; the second is the commit-proximity fence.
    // @ts-expect-error narrow test wrapper around the generic Supabase RPC method
    supabaseAdmin.rpc = async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'staxis_list_account_authorized_properties'
          && args?.p_account_id === ACCOUNT_GIL
          && ++projectionReads === 2) {
        await pg.query(
          `update organization_memberships
              set status='revoked', ended_at=clock_timestamp()
            where id=$1`,
          [gilHat],
        );
      }
      return shim.rpc(fn, args);
    };

    try {
      signedInAs = UID_GIL;
      const nameBefore = await propertyName(PID_B1);
      const response = await wizardPatch(request(
        'https://staxis.test/api/onboard/wizard',
        {
          method: 'PATCH',
          body: { code: CODE_B1, propertyUpdates: { name: 'Revoked write' } },
        },
      ));
      assert.equal(response.status, 403);
      assert.equal(projectionReads, 2);
      assert.equal(await propertyName(PID_B1), nameBefore);
      assert.deepEqual(await rawPropertyAccess(ACCOUNT_GIL), [PID_B1]);
    } finally {
      // @ts-expect-error restore the PGlite-backed generic RPC method
      supabaseAdmin.rpc = shim.rpc;
    }
  });
});
