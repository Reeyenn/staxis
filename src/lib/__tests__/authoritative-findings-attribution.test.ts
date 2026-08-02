/** Findings and memory attribution must keep their old role boundaries while
 * both resolve the property through canonical authority. */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.OPENAI_API_KEY ??= 'sk-placeholder-test-key-min-20-chars';

import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  findAuthoritativeManagerAccount,
  findAuthoritativeRepresentativeAccount,
} from '@/lib/authorization/server';

const PROPERTY_ID = 'a4240000-0000-4000-8000-000000000001';
const STAFF_ACCOUNT = 'a4241000-0000-4000-8000-000000000001';
const MANAGER_ACCOUNT = 'a4241000-0000-4000-8000-000000000002';
const INACTIVE_MANAGER_ACCOUNT = 'a4241000-0000-4000-8000-000000000003';
const STAFF_ENTITLEMENT = 'a4243000-0000-4000-8000-000000000001';
const MANAGER_ENTITLEMENT = 'a4243000-0000-4000-8000-000000000002';

type AccountRow = { id: string; active: boolean; role: string };
type FromFn = typeof supabaseAdmin.from;
type RpcFn = typeof supabaseAdmin.rpc;

const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);

let accounts: AccountRow[] = [];
let accessByAccount = new Map<string, Record<string, unknown>>();

function authorityFor(
  accountId: string,
  propertyIds: string[],
  entitlementId: string,
  role: 'owner' | 'staff',
): Record<string, unknown> {
  return {
    ok: true,
    all: false,
    authorityMode: 'normalized',
    authorityVersion: 1,
    effectiveAccessHash: 'a'.repeat(64),
    propertyIds,
    legacyPropertyIds: [],
    membershipPropertyIds: [],
    propertyStandings: propertyIds.map((propertyId) => ({
      propertyId,
      operationalRole: role,
      seesFinancials: role === 'owner',
      hotelMutationAllowed: role === 'owner',
      portfolioIntelligenceRead: false,
      entitlements: [{
        kind: 'legacy_bridge',
        entitlementId,
        organizationId: null,
        membershipId: null,
        accessProfile: null,
        staxisRole: null,
        scopeType: null,
        portfolioId: null,
      }],
    })),
  };
}

function installStore(): void {
  supabaseAdmin.from = ((table: string) => {
    if (table !== 'accounts') throw new Error(`unexpected table: ${table}`);
    let filtered = [...accounts];
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filtered = filtered.filter((row) => row[column as keyof AccountRow] === value);
        return chain;
      },
      in: (column: string, values: unknown[]) => {
        filtered = filtered.filter((row) => values.includes(row[column as keyof AccountRow]));
        return chain;
      },
      order: () => chain,
      limit: async (count: number) => ({ data: filtered.slice(0, count), error: null }),
    };
    return chain;
  }) as unknown as FromFn;
  supabaseAdmin.rpc = (async (_functionName: string, args: Record<string, unknown>) => ({
    data: accessByAccount.get(String(args.p_account_id)) ?? null,
    error: null,
  })) as unknown as RpcFn;
}

beforeEach(() => {
  accounts = [
    { id: STAFF_ACCOUNT, active: true, role: 'staff' },
    { id: MANAGER_ACCOUNT, active: true, role: 'owner' },
    { id: INACTIVE_MANAGER_ACCOUNT, active: false, role: 'owner' },
  ];
  accessByAccount = new Map([
    [STAFF_ACCOUNT, authorityFor(STAFF_ACCOUNT, [PROPERTY_ID], STAFF_ENTITLEMENT, 'staff')],
    [MANAGER_ACCOUNT, authorityFor(MANAGER_ACCOUNT, [], MANAGER_ENTITLEMENT, 'owner')],
    [INACTIVE_MANAGER_ACCOUNT, authorityFor(INACTIVE_MANAGER_ACCOUNT, [PROPERTY_ID], MANAGER_ENTITLEMENT, 'owner')],
  ]);
  installStore();
});

after(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
});

describe('canonical findings attribution boundaries', () => {
  test('findings return null without an active manager while memory keeps its any-active fallback', async () => {
    assert.equal(
      await findAuthoritativeManagerAccount(PROPERTY_ID),
      null,
      'staff-only canonical access must not receive findings spend attribution',
    );
    assert.equal(
      await findAuthoritativeRepresentativeAccount(PROPERTY_ID),
      STAFF_ACCOUNT,
      'memory consolidation lost its established active-account fallback',
    );
  });

  test('findings choose an active manager only when canonical scope covers the property', async () => {
    accessByAccount.set(
      MANAGER_ACCOUNT,
      authorityFor(MANAGER_ACCOUNT, [PROPERTY_ID], MANAGER_ENTITLEMENT, 'owner'),
    );
    assert.equal(await findAuthoritativeManagerAccount(PROPERTY_ID), MANAGER_ACCOUNT);
    assert.equal(await findAuthoritativeRepresentativeAccount(PROPERTY_ID), MANAGER_ACCOUNT);
  });

  test('inactive manager authority is ignored rather than widening attribution', async () => {
    accessByAccount.set(
      MANAGER_ACCOUNT,
      authorityFor(MANAGER_ACCOUNT, [], MANAGER_ENTITLEMENT, 'owner'),
    );
    assert.equal(await findAuthoritativeManagerAccount(PROPERTY_ID), null);
    assert.equal(
      await findAuthoritativeRepresentativeAccount(PROPERTY_ID),
      STAFF_ACCOUNT,
      'memory fallback should use the active canonical account, never an inactive manager',
    );
  });
});
