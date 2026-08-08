/**
 * The onboarding-authority cases whose SUBJECT is a company hat.
 *
 * Its sibling, `onboard-authoritative-access.integration.test.ts`, is pinned to
 * the 0425 boundary on purpose: the thing it is about is a deliberately stale
 * `property_access` snapshot, which only exists as a distinct state on that
 * schema. That pin is correct for the eight cases that live there.
 *
 * These two are not about the stale snapshot. They ask what a COMPANY hat can
 * and cannot do during onboarding — Maria approving a join request at the hotel
 * she runs, and a company-only oversight hat that may read a hotel but must not
 * mutate its setup. A company hat's authority projection is only complete once
 * the Stage C final contract (0426) has landed, so asking those questions at
 * the 0425 pin asks them of a half-built projection: the account resolves to no
 * authority at all, and the routes answer 403/503 for a reason that has nothing
 * to do with what the test is checking. Pinned there they would pass or fail on
 * an artifact of the boundary rather than on the rule.
 *
 * So they run on the full migration set, where a company hat means what it
 * means in production. Everything else — the seed, the shim, the routes — is
 * identical to the sibling file.
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
import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_GIL,
  ACCOUNT_MARIA,
  PID_A1,
  PID_B1,
  UID_MARIA,
  UID_VERA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

const CODE_A1 = 'A1-COMPANY-HAT';
const CODE_B1 = 'B1-OVERSIGHT';
const JOIN_ACCOUNT_A1 = 'f1000000-0000-4000-8000-000000000001';
const JOIN_USER_A1 = 'f1000000-0000-4000-8000-000000000002';
const JOIN_REQUEST_A1 = 'f1000000-0000-4000-8000-000000000003';

let pg: PGlite;
let shim: PglitePostgrest;
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

before(async () => {
  const migrated = await applyMigrationsToPglite();
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

  await seedTwoCompanies(pg);
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
            ($4,$5,null,'onboarding_resume',clock_timestamp()+interval '1 day',1,1,$6)`,
    [PID_A1, CODE_A1, ACCOUNT_MARIA, PID_B1, CODE_B1, ACCOUNT_GIL],
  );
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  await pg?.close();
});

describe('onboarding authority for a company hat', () => {
  test('staff approval commits staff, link, normalized authority, decision, and audit together', async () => {
    await pg.query(`insert into auth.users(id,email) values ($1,'join-a1@example.test')`, [JOIN_USER_A1]);
    // `property_access` is deliberately NOT written here. On the full migration
    // set the Stage C final contract refuses every write to that column — it is
    // the legacy snapshot the normalized projection replaced — so the pinned
    // sibling's `'{}'` literal is exactly the thing this schema exists to stop.
    // The column still defaults to empty, which is what the assertion below
    // reads back.
    await pg.query(
      `insert into accounts(
         id,username,password_hash,display_name,role,data_user_id
       ) values ($1,'join-a1','x','A1 Housekeeper','housekeeping',$2)`,
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
    // The pinned sibling asserts `[]` because on its schema the column is
    // `not null default '{}'`. 0426 drops both, so on the final contract the
    // legacy snapshot is NULL and every write to it raises 42501. Asserting
    // null is the same claim — approval granted authority without touching the
    // legacy array — stated in the vocabulary this schema actually uses. If
    // anything repopulated it, this is non-null and fails.
    assert.equal(
      account.rows[0].property_access,
      null,
      'normalized access does not repopulate the legacy snapshot',
    );
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
});
