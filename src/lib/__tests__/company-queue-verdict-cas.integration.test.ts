process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder-test-key-min-20-chars';
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { GET as queueGet, POST as queuePost } from '@/app/api/company/queue/route';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { openCompanyFinding, refreshCompanyFinding } from '@/lib/company/company-findings';
import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';

const ORG_A = 'aa050000-0000-4000-8000-000000000001';
const ORG_B = 'bb050000-0000-4000-8000-000000000001';
const ORG_LARGE = 'cc050000-0000-4000-8000-000000000001';
const P1 = 'a1050000-0000-4000-8000-000000000001';
const P2 = 'a2050000-0000-4000-8000-000000000001';
const PB = 'b1050000-0000-4000-8000-000000000001';

const ACCOUNT_BROAD = 'aa051111-0000-4000-8000-000000000001';
const USER_BROAD = 'aa052222-0000-4000-8000-000000000001';
const ACCOUNT_MIXED = 'aa051111-0000-4000-8000-000000000002';
const USER_MIXED = 'aa052222-0000-4000-8000-000000000002';
const ACCOUNT_REVOKE = 'aa051111-0000-4000-8000-000000000003';
const USER_REVOKE = 'aa052222-0000-4000-8000-000000000003';
const ACCOUNT_FOREIGN = 'bb051111-0000-4000-8000-000000000001';
const USER_FOREIGN = 'bb052222-0000-4000-8000-000000000001';
const ACCOUNT_LARGE = 'cc051111-0000-4000-8000-000000000001';
const USER_LARGE = 'cc052222-0000-4000-8000-000000000001';

const largePropertyId = (index: number) => (
  `c1050000-0000-4000-8000-${String(index).padStart(12, '0')}`
);

let pg: PGlite;
let shim: PglitePostgrest;
let signedInAs: string | null = null;
let revocablePropertyMembershipId = '';

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

function request(body?: unknown): NextRequest {
  return new NextRequest('https://staxis.test/api/company/queue', {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: 'Bearer company-verdict-test',
      'content-type': 'application/json',
      'x-real-ip': '203.0.113.205',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function postAs(
  userId: string,
  body: { organizationId?: string; findingId: string; action: string },
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  signedInAs = userId;
  const response = await queuePost(request(body));
  const parsed = await response.json().catch(() => ({})) as {
    data?: Record<string, unknown>;
  };
  return { status: response.status, data: parsed.data ?? null };
}

async function attachProperty(
  organizationId: string,
  propertyId: string,
  name: string,
  ownerUserId: string,
): Promise<void> {
  await pg.query(
    `insert into public.properties (id, name, owner_id, total_rooms, timezone)
     values ($1, $2, $3, 80, 'America/Chicago')`,
    [propertyId, name, ownerUserId],
  );
  await pg.query(
    `update public.organization_property_relationships
        set is_primary_grouping = false
      where property_id = $1 and ends_at is null and is_primary_grouping`,
    [propertyId],
  );
  await pg.query(
    `insert into public.organization_property_relationships
       (organization_id, property_id, relationship_type, is_primary_grouping)
     values ($1, $2, 'operator', true)`,
    [organizationId, propertyId],
  );
}

async function addAccount(
  accountId: string,
  userId: string,
  name: string,
  role: 'owner' | 'general_manager',
): Promise<void> {
  await pg.query(
    `insert into auth.users (id, email) values ($1, $2)`,
    [userId, `${name.toLowerCase()}@example.test`],
  );
  await pg.query(
    `insert into public.accounts
       (id, username, password_hash, display_name, role, data_user_id)
     values ($1, $2, 'x', $3, $4, $5)`,
    [accountId, name.toLowerCase(), name, role, userId],
  );
}

function propertyIdsForHat(
  scope: 'company' | 'property',
  propertyIds: string[] | undefined,
): string[] {
  if (scope === 'property' && (propertyIds === undefined || propertyIds.length === 0)) {
    throw new Error('addHat: a property hat must name at least one hotel');
  }
  return propertyIds ?? [];
}

async function addHat(input: {
  organizationId: string;
  accountId: string;
  scope: 'company' | 'property';
  role: 'owner' | 'regional_manager' | 'general_manager';
  propertyIds?: string[];
}): Promise<string> {
  const jobCategory = input.role === 'owner'
    ? 'owner_principal'
    : input.role === 'regional_manager'
      ? 'regional_manager'
      : 'general_manager';
  const row = await pg.query<{ id: string }>(
    `insert into public.organization_memberships
       (organization_id, account_id, job_category, job_title, status,
        membership_scope, staxis_role, covered_property_ids)
     values ($1, $2, $3, $4, 'active', $5, $6, $7::uuid[])
     returning id`,
    [
      input.organizationId,
      input.accountId,
      jobCategory,
      input.role,
      input.scope,
      input.role,
      // A property hat must name at least one hotel. This helper INSERTs
      // straight into the table, so it is the one writer in the codebase that
      // no RPC guard and no route stands in front of: an omitted `propertyIds`
      // used to render `'{}'` and seed a hat covering nothing, which is exactly
      // the shape 0468's check forbids. Refuse it here rather than let a future
      // caller plant it silently.
      input.scope === 'property'
        ? `{${propertyIdsForHat(input.scope, input.propertyIds).join(',')}}`
        : null,
    ],
  );
  return row.rows[0]!.id;
}

let findingSequence = 0;
async function plantFinding(
  organizationId: string,
  affectedPropertyIds: readonly string[],
  detectorId = 'portfolio_supply_spend_gap',
  evidence: Record<string, unknown> = {},
): Promise<{ id: string; statusChangedAt: string; revision: number }> {
  findingSequence += 1;
  const row = await pg.query<{
    id: string;
    status_changed_at: string;
    verdict_revision: string | number;
  }>(
    `insert into public.company_findings
       (organization_id, detector_id, dedupe_key, summary, severity, disposition,
        status, receipt_query_id, evidence, magnitude, affected_property_ids)
     values ($1, $2, $3, 'Scoped company action.', 'attention', 'recommend',
       'open', 'probe', $5::jsonb, 42, $4::uuid[])
     returning id, status_changed_at, verdict_revision`,
    [
      organizationId,
      detectorId,
      `0407:${findingSequence}`,
      `{${affectedPropertyIds.join(',')}}`,
      JSON.stringify(evidence),
    ],
  );
  return {
    id: row.rows[0]!.id,
    statusChangedAt: row.rows[0]!.status_changed_at,
    revision: Number(row.rows[0]!.verdict_revision),
  };
}

async function findingState(findingId: string): Promise<{
  status: string;
  revision: number;
}> {
  const row = await pg.query<{ status: string; verdict_revision: string | number }>(
    `select status, verdict_revision from public.company_findings where id = $1`,
    [findingId],
  );
  return {
    status: row.rows[0]!.status,
    revision: Number(row.rows[0]!.verdict_revision),
  };
}

function record(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

async function subsetReceiptId(
  accountId: string,
  organizationId: string,
  propertyIds: readonly string[],
): Promise<string> {
  const result = await pg.query<{ result: unknown }>(
    `select public.staxis_resolve_authorization_scope(
       $1, $2, 'property_subset', null, $3::jsonb, 120
     ) as result`,
    [accountId, organizationId, JSON.stringify(propertyIds)],
  );
  const resolved = record(result.rows[0]!.result);
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  return String(record(resolved.receipt).id);
}

before(async () => {
  const migrated = await applyMigrationsToPglite();
  assert.ok(
    migrated.report.applied.includes('0407_company_finding_verdict_cas.sql'),
    JSON.stringify(migrated.report.failedAtRuntime),
  );
  pg = migrated.pg;

  await pg.query(
    `insert into public.organizations (id, name, organization_type, status)
     values
       ($1, 'Verdict Company A', 'management_company', 'active'),
       ($2, 'Verdict Company B', 'management_company', 'active'),
       ($3, 'Sixty One Hotels', 'management_company', 'active')`,
    [ORG_A, ORG_B, ORG_LARGE],
  );

  await addAccount(ACCOUNT_BROAD, USER_BROAD, 'Broad', 'owner');
  await addAccount(ACCOUNT_MIXED, USER_MIXED, 'Mixed', 'general_manager');
  await addAccount(ACCOUNT_REVOKE, USER_REVOKE, 'Revoke', 'general_manager');
  await addAccount(ACCOUNT_FOREIGN, USER_FOREIGN, 'Foreign', 'owner');
  await addAccount(ACCOUNT_LARGE, USER_LARGE, 'Large', 'owner');

  await attachProperty(ORG_A, P1, 'Action Hotel One', USER_BROAD);
  await attachProperty(ORG_A, P2, 'Action Hotel Two', USER_BROAD);
  await attachProperty(ORG_B, PB, 'Foreign Hotel', USER_FOREIGN);

  await addHat({ organizationId: ORG_A, accountId: ACCOUNT_BROAD, scope: 'company', role: 'owner' });
  await addHat({ organizationId: ORG_A, accountId: ACCOUNT_MIXED, scope: 'company', role: 'regional_manager' });
  await addHat({
    organizationId: ORG_A,
    accountId: ACCOUNT_MIXED,
    scope: 'property',
    role: 'general_manager',
    propertyIds: [P1],
  });
  await addHat({ organizationId: ORG_A, accountId: ACCOUNT_REVOKE, scope: 'company', role: 'regional_manager' });
  revocablePropertyMembershipId = await addHat({
    organizationId: ORG_A,
    accountId: ACCOUNT_REVOKE,
    scope: 'property',
    role: 'general_manager',
    propertyIds: [P1],
  });
  await addHat({ organizationId: ORG_B, accountId: ACCOUNT_FOREIGN, scope: 'company', role: 'owner' });

  for (let index = 1; index <= 61; index += 1) {
    await attachProperty(
      ORG_LARGE,
      largePropertyId(index),
      `Scale Hotel ${index}`,
      USER_LARGE,
    );
  }
  await addHat({
    organizationId: ORG_LARGE,
    accountId: ACCOUNT_LARGE,
    scope: 'company',
    role: 'regional_manager',
  });

  const catalog = await loadCatalog(pg);
  shim = createPglitePostgrest(pg, catalog);
  supabaseAdmin.from = shim.from as unknown as typeof supabaseAdmin.from;
  supabaseAdmin.rpc = shim.rpc as unknown as typeof supabaseAdmin.rpc;
  supabaseAdmin.auth.getUser = async () => (
    signedInAs
      ? {
        data: { user: { id: signedInAs, email: 'verdict@example.test' } },
        error: null,
      }
      : {
        data: { user: null },
        error: { message: 'no session', status: 401, name: 'AuthApiError' },
      }
  ) as Awaited<ReturnType<typeof supabaseAdmin.auth.getUser>>;
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  await pg?.close();
});

describe('company queue verdict CAS — exact per-hotel authority', () => {
  test('legacy writer separates affected hotels from comparators and clears stale scope', async () => {
    await openCompanyFinding({
      organizationId: ORG_A,
      detectorId: 'portfolio_supply_spend_gap',
      dedupeKey: '0407:legacy-writer-scope',
      receiptQueryId: 'portfolio_supply_spend_gap',
      disposition: 'recommend',
      now: new Date('2026-07-29T12:00:00.000Z'),
      draft: {
        key: 'legacy-writer-scope',
        summary: 'Legacy comparison with an explicit hotel set.',
        severity: 'attention',
        magnitude: 10,
        evidence: {
          queryId: 'portfolio_supply_spend_gap',
          params: {
            affected_hotel_ids: [P2],
            hotel_ids: [P2, P1],
            hotels: ['Two', 'One'],
          },
          values: { gap_cents: 10 },
          basis: 'two exact hotels',
        },
        price: null,
      },
    });
    const row = await pg.query<{ affected_property_ids: string[] }>(
      `select affected_property_ids from public.company_findings
       where organization_id = $1 and dedupe_key = '0407:legacy-writer-scope'`,
      [ORG_A],
    );
    assert.deepEqual(row.rows[0]!.affected_property_ids, [P2]);

    const existing = await pg.query<{ id: string }>(
      `select id from public.company_findings
       where organization_id = $1 and dedupe_key = '0407:legacy-writer-scope'`,
      [ORG_A],
    );
    await refreshCompanyFinding({
      organizationId: ORG_A,
      detectorId: 'portfolio_supply_spend_gap',
      dedupeKey: '0407:legacy-writer-scope',
      receiptQueryId: 'portfolio_supply_spend_gap',
      disposition: 'recommend',
      now: new Date('2026-07-29T13:00:00.000Z'),
      draft: {
        key: 'legacy-writer-scope',
        summary: 'Malformed refresh becomes non-actionable.',
        severity: 'attention',
        magnitude: 11,
        evidence: {
          queryId: 'portfolio_supply_spend_gap',
          params: { affected_hotel_ids: [P1, 'not-a-uuid'], hotel_ids: [P1, P2] },
          values: { gap_cents: 11 },
          basis: 'invalid target scope',
        },
        price: null,
      },
    }, existing.rows[0]!.id, 'updated');
    const cleared = await pg.query<{ affected_property_ids: string[] }>(
      `select affected_property_ids from public.company_findings where id = $1`,
      [existing.rows[0]!.id],
    );
    assert.deepEqual(cleared.rows[0]!.affected_property_ids, []);
  });

  test('company Owner/VP reach stays read-only without explicit hotel standing', async () => {
    const finding = await plantFinding(ORG_A, [P1]);
    const omittedOrganization = await postAs(USER_BROAD, {
      findingId: finding.id,
      action: 'known_problem',
    });
    assert.equal(omittedOrganization.status, 400);

    const response = await postAs(USER_BROAD, {
      organizationId: ORG_A,
      findingId: finding.id,
      action: 'known_problem',
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await findingState(finding.id), { status: 'open', revision: 1 });
  });

  test('one-hotel standing authorizes that exact finding and retries idempotently', async () => {
    const finding = await plantFinding(ORG_A, [P1]);
    const first = await postAs(USER_MIXED, {
      organizationId: ORG_A,
      findingId: finding.id,
      action: 'known_problem',
    });
    assert.equal(first.status, 200);
    assert.equal(first.data?.outcome, 'applied');
    assert.deepEqual(await findingState(finding.id), { status: 'known_problem', revision: 2 });

    const retry = await postAs(USER_MIXED, {
      organizationId: ORG_A,
      findingId: finding.id,
      action: 'known_problem',
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.data?.outcome, 'already_applied');
    const events = await pg.query<{ count: string }>(
      `select count(*)::text as count
       from public.company_finding_verdict_events where finding_id = $1`,
      [finding.id],
    );
    assert.equal(Number(events.rows[0]!.count), 1);
    const proof = await pg.query<{
      authorization_hash: string;
      scope_hash: string;
      resolver_version: string;
      account_authorization_version: string | number;
      organization_access_epoch: string | number;
      required_sections: string[];
      detector_id: string;
    }>(
      `select authorization_hash, scope_hash, resolver_version,
              account_authorization_version, organization_access_epoch,
              required_sections, detector_id
         from public.company_finding_verdict_events where finding_id = $1`,
      [finding.id],
    );
    assert.match(proof.rows[0]!.authorization_hash, /^[0-9a-f]{64}$/);
    assert.match(proof.rows[0]!.scope_hash, /^[0-9a-f]{64}$/);
    assert.match(proof.rows[0]!.resolver_version, /portfolio-scope-v1/);
    assert.ok(Number(proof.rows[0]!.account_authorization_version) > 0);
    assert.ok(Number(proof.rows[0]!.organization_access_epoch) > 0);
    assert.deepEqual(proof.rows[0]!.required_sections, ['financials', 'inventory', 'staxis']);
    assert.equal(proof.rows[0]!.detector_id, 'portfolio_supply_spend_gap');
  });

  test('mixed affected scope is all-or-nothing and leaves the row unchanged', async () => {
    const finding = await plantFinding(ORG_A, [P1, P2].sort());
    const response = await postAs(USER_MIXED, {
      organizationId: ORG_A,
      findingId: finding.id,
      action: 'resolved',
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await findingState(finding.id), { status: 'open', revision: 1 });
  });

  test('action/finding capability override is checked inside the final transaction', async () => {
    const finding = await plantFinding(ORG_A, [P1]);
    await pg.query(
      `insert into public.capability_overrides (property_id, capability, role, allowed)
       values ($1, 'view_financials', 'general_manager', false)`,
      [P1],
    );
    try {
      const response = await postAs(USER_MIXED, {
        organizationId: ORG_A,
        findingId: finding.id,
        action: 'muted',
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await findingState(finding.id), { status: 'open', revision: 1 });
    } finally {
      await pg.query(
        `delete from public.capability_overrides
         where property_id = $1 and capability = 'view_financials'`,
        [P1],
      );
    }
  });

  test('disabled source sections deny the verdict and leave the row unchanged', async () => {
    for (const section of ['inventory', 'financials', 'staxis'] as const) {
      const finding = await plantFinding(ORG_A, [P1]);
      await pg.query(
        `update public.properties
            set enabled_sections = jsonb_build_object($2::text, false)
          where id = $1`,
        [P1, section],
      );
      const response = await postAs(USER_MIXED, {
        organizationId: ORG_A,
        findingId: finding.id,
        action: 'resolved',
      });
      assert.equal(response.status, 403, `${section} did not close the commit boundary`);
      assert.deepEqual(await findingState(finding.id), { status: 'open', revision: 1 });
    }
    await pg.query(`update public.properties set enabled_sections = null where id = $1`, [P1]);
  });

  test('capability revocation after route preflight is observed at commit', async () => {
    const finding = await plantFinding(ORG_A, [P1]);
    const previousRpc = supabaseAdmin.rpc;
    const delegate = previousRpc.bind(supabaseAdmin) as (
      functionName: string,
      args?: Record<string, unknown>,
    ) => unknown;
    supabaseAdmin.rpc = (async (functionName: string, args?: Record<string, unknown>) => {
      if (functionName === 'staxis_set_company_finding_verdict_cas') {
        await pg.query(
          `insert into public.capability_overrides (property_id, capability, role, allowed)
           values ($1, 'manage_checklists', 'general_manager', false)
           on conflict (property_id, capability, role) do update set allowed = false`,
          [P1],
        );
      }
      return delegate(functionName, args);
    }) as unknown as typeof supabaseAdmin.rpc;
    try {
      const response = await postAs(USER_MIXED, {
        organizationId: ORG_A,
        findingId: finding.id,
        action: 'resolved',
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await findingState(finding.id), { status: 'open', revision: 1 });
    } finally {
      supabaseAdmin.rpc = previousRpc;
      await pg.query(
        `delete from public.capability_overrides
         where property_id = $1 and capability = 'manage_checklists'`,
        [P1],
      );
    }
  });

  test('resolved and silence actions use distinct closed capability checks', async () => {
    const silence = await plantFinding(ORG_A, [P1]);
    const resolution = await plantFinding(ORG_A, [P1]);
    await pg.query(
      `insert into public.capability_overrides (property_id, capability, role, allowed)
       values ($1, 'manage_checklists', 'general_manager', false)`,
      [P1],
    );
    try {
      const silenceResponse = await postAs(USER_MIXED, {
        organizationId: ORG_A,
        findingId: silence.id,
        action: 'muted',
      });
      assert.equal(silenceResponse.status, 200, 'checklist denial blocked a notification action');

      const resolutionResponse = await postAs(USER_MIXED, {
        organizationId: ORG_A,
        findingId: resolution.id,
        action: 'resolved',
      });
      assert.equal(resolutionResponse.status, 403);
      assert.deepEqual(await findingState(resolution.id), { status: 'open', revision: 1 });
    } finally {
      await pg.query(
        `delete from public.capability_overrides
         where property_id = $1 and capability = 'manage_checklists'`,
        [P1],
      );
    }
  });

  test('activity findings accept either producer stream shape and reject conflicts', async () => {
    const pattern = await plantFinding(
      ORG_A,
      [P1],
      'portfolio_activity_stopped',
      { streamId: 'work_order_flow' },
    );
    const legacy = await plantFinding(
      ORG_A,
      [P1],
      'portfolio_activity_stopped',
      { params: { stream: 'inventory_counts' } },
    );
    const conflicting = await plantFinding(
      ORG_A,
      [P1],
      'portfolio_activity_stopped',
      { streamId: 'work_order_flow', params: { stream: 'inventory_counts' } },
    );

    assert.equal((await postAs(USER_MIXED, {
      organizationId: ORG_A,
      findingId: pattern.id,
      action: 'resolved',
    })).status, 200);
    assert.equal((await postAs(USER_MIXED, {
      organizationId: ORG_A,
      findingId: legacy.id,
      action: 'resolved',
    })).status, 200);
    assert.equal((await postAs(USER_MIXED, {
      organizationId: ORG_A,
      findingId: conflicting.id,
      action: 'resolved',
    })).status, 403);
    assert.deepEqual(await findingState(conflicting.id), { status: 'open', revision: 1 });
  });

  test('a stale row token conflicts after preflight and cannot overwrite producer state', async () => {
    const finding = await plantFinding(ORG_A, [P1]);
    const previousRpc = supabaseAdmin.rpc;
    const delegate = previousRpc.bind(supabaseAdmin) as (
      functionName: string,
      args?: Record<string, unknown>,
    ) => unknown;
    supabaseAdmin.rpc = (async (functionName: string, args?: Record<string, unknown>) => {
      if (functionName === 'staxis_set_company_finding_verdict_cas') {
        await pg.query(
          `update public.company_findings set summary = summary || ' producer refresh'
           where id = $1`,
          [finding.id],
        );
      }
      return delegate(functionName, args);
    }) as unknown as typeof supabaseAdmin.rpc;
    try {
      const response = await postAs(USER_MIXED, {
        organizationId: ORG_A,
        findingId: finding.id,
        action: 'resolved',
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await findingState(finding.id), { status: 'open', revision: 2 });
    } finally {
      supabaseAdmin.rpc = previousRpc;
    }
  });

  test('revocation after preflight is reasserted atomically and leaves the row unchanged', async () => {
    const finding = await plantFinding(ORG_A, [P1]);
    const previousRpc = supabaseAdmin.rpc;
    const delegate = previousRpc.bind(supabaseAdmin) as (
      functionName: string,
      args?: Record<string, unknown>,
    ) => unknown;
    let revoked = false;
    supabaseAdmin.rpc = (async (functionName: string, args?: Record<string, unknown>) => {
      if (functionName === 'staxis_set_company_finding_verdict_cas' && !revoked) {
        revoked = true;
        await pg.query(
          `update public.organization_memberships
             set status = 'revoked', ended_at = clock_timestamp()
           where id = $1`,
          [revocablePropertyMembershipId],
        );
      }
      return delegate(functionName, args);
    }) as unknown as typeof supabaseAdmin.rpc;
    try {
      const response = await postAs(USER_REVOKE, {
        organizationId: ORG_A,
        findingId: finding.id,
        action: 'resolved',
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await findingState(finding.id), { status: 'open', revision: 1 });
    } finally {
      supabaseAdmin.rpc = previousRpc;
    }
  });

  test('hotel transfer after preflight is reasserted atomically', async () => {
    const finding = await plantFinding(ORG_A, [P1]);
    const previousRpc = supabaseAdmin.rpc;
    const delegate = previousRpc.bind(supabaseAdmin) as (
      functionName: string,
      args?: Record<string, unknown>,
    ) => unknown;
    let transferred = false;
    supabaseAdmin.rpc = (async (functionName: string, args?: Record<string, unknown>) => {
      if (functionName === 'staxis_set_company_finding_verdict_cas' && !transferred) {
        transferred = true;
        await pg.query(
          `update public.organization_property_relationships
              set ends_at = clock_timestamp()
            where property_id = $1 and organization_id = $2 and ends_at is null`,
          [P1, ORG_A],
        );
        await pg.query(
          `insert into public.organization_property_relationships
             (organization_id, property_id, relationship_type, is_primary_grouping)
           values ($1, $2, 'operator', true)`,
          [ORG_B, P1],
        );
      }
      return delegate(functionName, args);
    }) as unknown as typeof supabaseAdmin.rpc;
    try {
      const response = await postAs(USER_MIXED, {
        organizationId: ORG_A,
        findingId: finding.id,
        action: 'resolved',
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await findingState(finding.id), { status: 'open', revision: 1 });
    } finally {
      supabaseAdmin.rpc = previousRpc;
      await pg.query(
        `update public.organization_property_relationships
            set ends_at = clock_timestamp()
          where property_id = $1 and organization_id = $2 and ends_at is null`,
        [P1, ORG_B],
      );
      await pg.query(
        `insert into public.organization_property_relationships
           (organization_id, property_id, relationship_type, is_primary_grouping)
         values ($1, $2, 'operator', true)`,
        [ORG_A, P1],
      );
    }
  });

  test('foreign direct-id tampering is indistinguishable from a missing finding', async () => {
    const foreign = await plantFinding(ORG_B, [PB]);
    const response = await postAs(USER_MIXED, {
      organizationId: ORG_A,
      findingId: foreign.id,
      action: 'muted',
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await findingState(foreign.id), { status: 'open', revision: 1 });
  });

  test('unknown and empty finding scopes fail closed without an update', async () => {
    const unknown = await plantFinding(ORG_A, [P1], 'future_unmapped_detector');
    const unknownResponse = await postAs(USER_MIXED, {
      organizationId: ORG_A,
      findingId: unknown.id,
      action: 'resolved',
    });
    assert.equal(unknownResponse.status, 403);

    const empty = await plantFinding(ORG_A, []);
    const emptyResponse = await postAs(USER_MIXED, {
      organizationId: ORG_A,
      findingId: empty.id,
      action: 'resolved',
    });
    assert.equal(emptyResponse.status, 409);
    assert.deepEqual(await findingState(empty.id), { status: 'open', revision: 1 });
  });

  test('the RPC rejects duplicate or receipt-mismatched affected arrays', async () => {
    const finding = await plantFinding(ORG_A, [P1]);
    const receiptId = await subsetReceiptId(ACCOUNT_MIXED, ORG_A, [P1]);
    for (const affected of [[P1, P1], [P2]]) {
      const attempt = await pg.query<{ result: unknown }>(
        `select public.staxis_set_company_finding_verdict_cas(
           $1, $2, $3, $4, 'open', $5, 1, $6::uuid[], 'resolved'
         ) as result`,
        [
          receiptId,
          ACCOUNT_MIXED,
          ORG_A,
          finding.id,
          finding.statusChangedAt,
          `{${affected.join(',')}}`,
        ],
      );
      assert.deepEqual(record(attempt.rows[0]!.result), { ok: false, reason: 'denied' });
      assert.deepEqual(await findingState(finding.id), { status: 'open', revision: 1 });
    }

    const stale = await pg.query<{ result: unknown }>(
      `select public.staxis_set_company_finding_verdict_cas(
         $1, $2, $3, $4, 'open', $5, 2, $6::uuid[], 'resolved'
       ) as result`,
      [receiptId, ACCOUNT_MIXED, ORG_A, finding.id, finding.statusChangedAt, `{${P1}}`],
    );
    assert.deepEqual(record(stale.rows[0]!.result), { ok: false, reason: 'conflict' });
    const events = await pg.query<{ count: string }>(
      `select count(*)::text as count
       from public.company_finding_verdict_events where finding_id = $1`,
      [finding.id],
    );
    assert.equal(Number(events.rows[0]!.count), 0);
    assert.deepEqual(await findingState(finding.id), { status: 'open', revision: 1 });
  });

  test('string-shaped mutation booleans cannot impersonate authoritative standing', async () => {
    const finding = await plantFinding(ORG_A, [P1]);
    const receiptId = await subsetReceiptId(ACCOUNT_MIXED, ORG_A, [P1]);
    const original = await pg.query<{ definition: string }>(
      `select pg_get_functiondef(
         'public.staxis_list_account_authorized_properties(uuid)'::regprocedure
       ) as definition`,
    );
    await pg.exec(`
      create or replace function public.staxis_list_account_authorized_properties(
        p_account_id uuid
      ) returns jsonb
      language sql
      stable
      security definer
      set search_path = pg_catalog, public
      as $$
        select jsonb_build_object(
          'ok', true,
          'all', false,
          'authorityMode', 'normalized',
          'propertyStandings', jsonb_build_array(jsonb_build_object(
            'propertyId', '${P1}',
            'operationalRole', 'general_manager',
            'seesFinancials', true,
            'hotelMutationAllowed', 'true',
            'portfolioIntelligenceRead', true,
            'entitlements', '[]'::jsonb
          ))
        )
      $$;
    `);
    try {
      const attempt = await pg.query<{ result: unknown }>(
        `select public.staxis_set_company_finding_verdict_cas(
           $1, $2, $3, $4, 'open', $5, 1, $6::uuid[], 'resolved'
         ) as result`,
        [
          receiptId,
          ACCOUNT_MIXED,
          ORG_A,
          finding.id,
          finding.statusChangedAt,
          `{${P1}}`,
        ],
      );
      assert.deepEqual(record(attempt.rows[0]!.result), { ok: false, reason: 'denied' });
      assert.deepEqual(await findingState(finding.id), { status: 'open', revision: 1 });
    } finally {
      await pg.exec(original.rows[0]!.definition);
    }
  });

  test('old direct writers and caller-set GUCs cannot forge the private RPC marker', async () => {
    const finding = await plantFinding(ORG_A, [P1]);
    const privileges = await pg.query<{
      marker_insert: boolean;
      event_insert: boolean;
      event_update: boolean;
      event_delete: boolean;
      event_authenticated_select: boolean;
      event_anon_select: boolean;
      rpc_service_execute: boolean;
      rpc_authenticated_execute: boolean;
      rpc_anon_execute: boolean;
    }>(
      `select
         has_table_privilege(
           'service_role', 'public.company_finding_verdict_transaction_markers', 'INSERT'
         ) as marker_insert,
         has_table_privilege(
           'service_role', 'public.company_finding_verdict_events', 'INSERT'
         ) as event_insert,
         has_table_privilege(
           'service_role', 'public.company_finding_verdict_events', 'UPDATE'
         ) as event_update,
         has_table_privilege(
           'service_role', 'public.company_finding_verdict_events', 'DELETE'
         ) as event_delete,
         has_table_privilege(
           'authenticated', 'public.company_finding_verdict_events', 'SELECT'
         ) as event_authenticated_select,
         has_table_privilege(
           'anon', 'public.company_finding_verdict_events', 'SELECT'
         ) as event_anon_select,
         has_function_privilege(
           'service_role',
           'public.staxis_set_company_finding_verdict_cas(uuid,uuid,uuid,uuid,text,timestamptz,bigint,uuid[],text)',
           'EXECUTE'
         ) as rpc_service_execute,
         has_function_privilege(
           'authenticated',
           'public.staxis_set_company_finding_verdict_cas(uuid,uuid,uuid,uuid,text,timestamptz,bigint,uuid[],text)',
           'EXECUTE'
         ) as rpc_authenticated_execute,
         has_function_privilege(
           'anon',
           'public.staxis_set_company_finding_verdict_cas(uuid,uuid,uuid,uuid,text,timestamptz,bigint,uuid[],text)',
           'EXECUTE'
         ) as rpc_anon_execute`,
    );
    assert.deepEqual(privileges.rows[0], {
      marker_insert: false,
      event_insert: false,
      event_update: false,
      event_delete: false,
      event_authenticated_select: false,
      event_anon_select: false,
      rpc_service_execute: true,
      rpc_authenticated_execute: false,
      rpc_anon_execute: false,
    });

    await pg.exec('set role service_role');
    try {
      await pg.query(
        `select set_config('staxis.company_finding_verdict_id', $1, false)`,
        [finding.id],
      );
      await assert.rejects(
        () => pg.query(
          `update public.company_findings
             set status = 'muted', status_changed_at = clock_timestamp(),
                 status_changed_by = $2
           where id = $1`,
          [finding.id, ACCOUNT_MIXED],
        ),
        /authoritative CAS RPC/,
      );
      await assert.rejects(
        () => pg.query(
          `insert into public.company_finding_verdict_transaction_markers
             (transaction_id, finding_id, actor_account_id, authorization_receipt_id)
           values (pg_current_xact_id(), $1, $2, $3)`,
          [finding.id, ACCOUNT_MIXED, finding.id],
        ),
        /permission denied/,
      );
    } finally {
      await pg.exec('reset role');
    }
    assert.deepEqual(await findingState(finding.id), { status: 'open', revision: 1 });
  });

  test('61-hotel aggregate GET remains available while mutation stays read-only', async () => {
    signedInAs = USER_LARGE;
    const response = await queueGet(new NextRequest(
      `https://staxis.test/api/company/queue?organizationId=${ORG_LARGE}`,
      {
        headers: {
          authorization: 'Bearer company-verdict-test',
          'x-real-ip': '203.0.113.206',
        },
      },
    ));
    const body = await response.json() as {
      data?: {
        scope?: { hotelCount?: number };
        coverage?: { attemptedHotelCount?: number; omittedHotelCount?: number };
        canAct?: boolean;
      };
    };
    assert.equal(response.status, 200);
    assert.equal(body.data?.scope?.hotelCount, 61);
    assert.equal(body.data?.coverage?.attemptedHotelCount, 61);
    assert.equal(body.data?.coverage?.omittedHotelCount, 0);
    assert.equal(body.data?.canAct, false);
  });
});
