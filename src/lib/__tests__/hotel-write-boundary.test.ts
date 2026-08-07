/**
 * Portfolio reach is intentionally broader than local hotel authority. These
 * regressions pin the strict mutation resolver and the service-role routes
 * most likely to be reached after a leader drills into a hotel's existing UI.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder-test-key-min-20-chars';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import path from 'node:path';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { hotelWriteDecisionForUserId } from '@/lib/team-auth';

const REPO_ROOT = process.cwd();
const USER_ID = '81000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '81000000-0000-4000-8000-000000000002';
const ORGANIZATION_ID = '81000000-0000-4000-8000-000000000003';
const ENTITLEMENT_ID = '81000000-0000-4000-8000-000000000004';

interface StubResponse {
  data: unknown;
  error: { message: string } | null;
}

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
let responses: Record<string, StubResponse>;
let authorityResponse: StubResponse;

function propertyId(n: number): string {
  return `81000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function ok(data: unknown): StubResponse {
  return { data, error: null };
}

function outage(message: string): StubResponse {
  return { data: null, error: { message } };
}

function queryFor(table: string): Record<string, unknown> {
  const result = () => Promise.resolve(responses[table] ?? ok([]));
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'in', 'order', 'limit']) {
    query[method] = () => query;
  }
  query.maybeSingle = result;
  query.then = (
    onFulfilled: (value: StubResponse) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => result().then(onFulfilled, onRejected);
  return query;
}

function configureStanding(options: {
  propertyId: string;
  operationalRole: 'general_manager' | 'front_desk' | 'housekeeping' | 'maintenance';
  hotelMutationAllowed: boolean;
  source: 'legacy' | 'company' | 'property';
  staxisRole?: 'owner' | 'regional_manager' | 'general_manager' | 'front_desk' | 'housekeeping' | 'maintenance';
}): void {
  const normalized = options.source !== 'legacy';
  authorityResponse = ok({
    ok: true,
    all: false,
    authorityMode: normalized ? 'normalized' : 'legacy',
    authorityVersion: 1,
    effectiveAccessHash: 'a'.repeat(64),
    propertyIds: [options.propertyId],
    legacyPropertyIds: normalized ? [] : [options.propertyId],
    membershipPropertyIds: normalized ? [options.propertyId] : [],
    propertyStandings: [{
      propertyId: options.propertyId,
      operationalRole: options.operationalRole,
      seesFinancials: options.staxisRole === 'finance'
        || options.operationalRole === 'general_manager',
      hotelMutationAllowed: options.hotelMutationAllowed,
      portfolioIntelligenceRead: options.source === 'company',
      entitlements: normalized ? [{
        kind: 'membership_hat',
        entitlementId: ENTITLEMENT_ID,
        organizationId: ORGANIZATION_ID,
        membershipId: ENTITLEMENT_ID,
        accessProfile: null,
        staxisRole: options.staxisRole ?? options.operationalRole,
        scopeType: options.source,
        portfolioId: null,
      }] : [{
        kind: 'legacy',
        entitlementId: ACCOUNT_ID,
        organizationId: null,
        membershipId: null,
        accessProfile: null,
        staxisRole: null,
        scopeType: null,
        portfolioId: null,
      }],
    }],
  });
}

beforeEach(() => {
  responses = {
    accounts: ok({ id: ACCOUNT_ID, active: true }),
    capability_overrides: ok([]),
  };
  authorityResponse = outage('authority unavailable');
  supabaseAdmin.from = ((table: string) => queryFor(table)) as unknown as typeof supabaseAdmin.from;
  supabaseAdmin.rpc = (async (name: string) => (
    name === 'staxis_list_account_authorized_properties'
      ? authorityResponse
      : outage(`unexpected RPC: ${name}`)
  )) as unknown as typeof supabaseAdmin.rpc;
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
});

describe('strict hotel write decision', () => {
  test('keeps legitimate legacy and property-scoped hotel staff writes working', async () => {
    const legacy = propertyId(11);
    configureStanding({
      propertyId: legacy,
      operationalRole: 'front_desk',
      hotelMutationAllowed: true,
      source: 'legacy',
    });
    assert.equal(await hotelWriteDecisionForUserId(USER_ID, legacy, 'use_complaints'), 'allowed');

    const propertyHat = propertyId(12);
    configureStanding({
      propertyId: propertyHat,
      operationalRole: 'housekeeping',
      hotelMutationAllowed: true,
      source: 'property',
      staxisRole: 'housekeeping',
    });
    assert.equal(
      await hotelWriteDecisionForUserId(USER_ID, propertyHat, 'use_complaints'),
      'allowed',
    );
  });

  test('company owner, VP, and finance reach stays read-only at the hotel', async () => {
    for (const [index, role] of [[13, 'owner'], [14, 'vp'], [15, 'finance']] as const) {
      const pid = propertyId(index);
      configureStanding({
        propertyId: pid,
        operationalRole: 'front_desk',
        hotelMutationAllowed: false,
        source: 'company',
        staxisRole: role,
      });
      assert.equal(await hotelWriteDecisionForUserId(USER_ID, pid, 'use_complaints'), 'denied');
      assert.equal(await hotelWriteDecisionForUserId(USER_ID, pid), 'denied');
    }
  });

  test('a property hat preserves deliberate demotion from a legacy manager role', async () => {
    const pid = propertyId(16);
    configureStanding({
      propertyId: pid,
      operationalRole: 'housekeeping',
      hotelMutationAllowed: true,
      source: 'property',
      staxisRole: 'housekeeping',
    });
    assert.equal(await hotelWriteDecisionForUserId(USER_ID, pid, 'view_wages'), 'denied');
  });

  // A platform administrator is `all: true` from the authorization resolver:
  // no per-hotel standings at all, and full power at every hotel anyway. These
  // pin both halves of the ruling at the strict server write boundary.
  test('a platform admin may write at a hotel they hold no standing at', async () => {
    authorityResponse = ok({
      ok: true,
      all: true,
      authorityMode: 'normalized',
      authorityVersion: 1,
      effectiveAccessHash: 'a'.repeat(64),
      propertyIds: [],
      legacyPropertyIds: [],
      membershipPropertyIds: [],
      propertyStandings: [],
    });
    for (const index of [19, 20]) {
      const pid = propertyId(index);
      assert.equal(await hotelWriteDecisionForUserId(USER_ID, pid), 'allowed');
      assert.equal(await hotelWriteDecisionForUserId(USER_ID, pid, 'manage_team'), 'allowed');
      // Manager-floor capabilities are included: an admin is above the floor.
      assert.equal(await hotelWriteDecisionForUserId(USER_ID, pid, 'view_wages'), 'allowed');
    }
  });

  test('a hotel GM still gets nothing at a sibling hotel they hold no standing at', async () => {
    const mine = propertyId(21);
    const sibling = propertyId(22);
    configureStanding({
      propertyId: mine,
      operationalRole: 'general_manager',
      hotelMutationAllowed: true,
      source: 'property',
      staxisRole: 'general_manager',
    });
    assert.equal(await hotelWriteDecisionForUserId(USER_ID, mine, 'manage_team'), 'allowed');
    // The wall. A standing at one hotel is never authority at another, and
    // nothing about the admin rule above may soften that.
    assert.equal(await hotelWriteDecisionForUserId(USER_ID, sibling, 'manage_team'), 'denied');
    assert.equal(await hotelWriteDecisionForUserId(USER_ID, sibling), 'denied');
  });

  test('authority and capability-store failures are unavailable, never grants', async () => {
    assert.equal(
      await hotelWriteDecisionForUserId(USER_ID, propertyId(17), 'use_complaints'),
      'unavailable',
    );

    const pid = propertyId(18);
    configureStanding({
      propertyId: pid,
      operationalRole: 'front_desk',
      hotelMutationAllowed: true,
      source: 'legacy',
    });
    responses.capability_overrides = outage('override store down');
    assert.equal(await hotelWriteDecisionForUserId(USER_ID, pid, 'use_complaints'), 'unavailable');
  });
});

function source(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

describe('hotel drill-down mutation route contract', () => {
  test('priority service-role mutations use the strict hotel boundary', () => {
    for (const route of [
      'src/app/api/complaints/draft/route.ts',
      'src/app/api/complaints/log/route.ts',
      'src/app/api/complaints/update/route.ts',
      'src/app/api/housekeeping/auto-assign/route.ts',
      'src/app/api/housekeeping/reassign/route.ts',
      'src/app/api/housekeeping/reset-assignments/route.ts',
      'src/app/api/housekeeping/staff-priority/route.ts',
      'src/app/api/housekeeping/inspections/start/route.ts',
      'src/app/api/housekeeping/inspections/[id]/complete/route.ts',
      'src/app/api/housekeeping/inspections/[id]/cancel/route.ts',
      'src/app/api/housekeeping/inspections/upload-photo/route.ts',
      'src/app/api/inventory/photo-count/route.ts',
      'src/app/api/inventory/post-count-process/route.ts',
      'src/app/api/walkthrough/start/route.ts',
      'src/app/api/walkthrough/step/route.ts',
    ]) {
      assert.match(source(route), /hotelWriteDecisionForUserId/, route);
    }
  });

  test('private hotel Communications proves local standing before staff identity resolution', () => {
    const helper = source('src/lib/comms/route-helpers.ts');
    const strictGate = helper.indexOf('const standing = authoritativeStandingForProperty(');
    const identityResolution = helper.indexOf('resolveStaffIdForAccount(pid, hotelAccount!)');
    assert.ok(strictGate >= 0, 'Communications is missing the authoritative standing gate');
    assert.ok(identityResolution > strictGate, 'local staff identity resolves before strict standing');
    assert.match(helper, /resolvePrivateHotelCommsStaffId\([\s\S]{0,180}?standing/);
    assert.match(helper, /role: standing\.operationalRole/);
    assert.match(helper, /isManager: isManagerRole\(standing\.operationalRole\)/);
    assert.match(helper, /hotelMutationAllowed: standing\.hotelMutationAllowed/);
  });

  test('equipment writes use strict standing while GET keeps its explicit read gate', () => {
    for (const route of [
      'src/app/api/maintenance/equipment/route.ts',
      'src/app/api/maintenance/equipment/[id]/route.ts',
    ]) {
      const text = source(route);
      assert.match(text, /hotelWriteDecisionForUserId/);
      assert.match(text, /userHasPropertyAccess/);
    }
  });
});
