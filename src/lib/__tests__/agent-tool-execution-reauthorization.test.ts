process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder-test-key-min-20-chars';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import {
  AGENT_TOOL_CAPABILITY_KEYS,
  executeTool,
  getToolsForRole,
  listAllTools,
  registerTool,
  type ToolContext,
  type ToolHandlerContext,
} from '@/lib/agent/tools';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AppRole } from '@/lib/roles';

const ACCOUNT = '10000000-0000-4000-8000-000000000001';
const AUTH_USER = '10000000-0000-4000-8000-000000000002';
const PROPERTY_A = '10000000-0000-4000-8000-000000000003';
const PROPERTY_B = '10000000-0000-4000-8000-000000000004';
const ENTITLEMENT = '10000000-0000-4000-8000-000000000005';
const READ_TOOL = '__test_fresh_authorization_read';
const MUTATION_TOOL = '__test_fresh_authorization_mutation';
const FINANCE_TOOL = '__test_fresh_authorization_finance';
const WAGE_TOOL = '__test_fresh_authorization_wages';
const SECTION_TOOL = '__test_fresh_authorization_section';

let active = true;
let accountRole: AppRole = 'general_manager';
let authorizedPropertyId: string | null = PROPERTY_A;
let operationalRole: AppRole = 'general_manager';
let hotelMutationAllowed = true;
let seesFinancials = true;
let resolverOutage = false;
let capabilityAllowed = true;
let capabilityOutage = false;
let freshSectionEnabled: boolean | null = true;
let sectionOutage = false;
let readHandlerCalls = 0;
let mutationHandlerCalls = 0;
let financeHandlerCalls = 0;
let wageHandlerCalls = 0;
let sectionHandlerCalls = 0;
let lastHandlerContext: ToolHandlerContext | null = null;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);

function accountRow() {
  return active
    ? {
      id: ACCOUNT,
      data_user_id: AUTH_USER,
      username: 'current-user',
      display_name: 'Current User',
      role: accountRole,
      active: true,
    }
    : null;
}

function authorityDto() {
  const propertyIds = authorizedPropertyId ? [authorizedPropertyId] : [];
  return {
    ok: true,
    all: false,
    authorityMode: 'legacy',
    authorityVersion: 1,
    effectiveAccessHash: 'a'.repeat(64),
    propertyIds,
    legacyPropertyIds: propertyIds,
    membershipPropertyIds: [],
    propertyStandings: authorizedPropertyId
      ? [{
        propertyId: authorizedPropertyId,
        operationalRole,
        seesFinancials,
        hotelMutationAllowed,
        portfolioIntelligenceRead: false,
        entitlements: [{
          kind: 'legacy',
          entitlementId: ENTITLEMENT,
          organizationId: null,
          membershipId: null,
          accessProfile: null,
          staxisRole: null,
          scopeType: null,
          portfolioId: null,
        }],
      }]
      : [],
  };
}

function installStoreStub() {
  // @ts-expect-error narrow PostgREST test double
  supabaseAdmin.from = (table: string) => {
    const filters = new Map<string, unknown>();
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (column: string, value: unknown) => {
        filters.set(column, value);
        return api;
      },
      maybeSingle: async () => ({
        data: table === 'properties'
          ? sectionOutage
            ? null
            : {
              enabled_sections: freshSectionEnabled === null
                ? null
                : { inventory: freshSectionEnabled },
            }
          : table === 'accounts' && accountRow()
          && [...filters].every(([column, value]) => (
            accountRow()?.[column as keyof NonNullable<ReturnType<typeof accountRow>>] === value
          ))
          ? accountRow()
          : null,
        error: table === 'properties' && sectionOutage
          ? { message: 'section store unavailable' }
          : null,
      }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({
        data: table === 'capability_overrides' && capabilityOutage
          ? null
          : table === 'capability_overrides' && !capabilityAllowed
            ? [{ capability: 'view_financials', role: 'general_manager', allowed: false }]
            : [],
        error: table === 'capability_overrides' && capabilityOutage
          ? { message: 'capability store unavailable' }
          : null,
      }).then(resolve),
    };
    return api;
  };
  // @ts-expect-error narrow RPC test double
  supabaseAdmin.rpc = async (name: string) => {
    assert.equal(name, 'staxis_list_account_authorized_properties');
    return resolverOutage
      ? { data: null, error: { message: 'store unavailable' } }
      : { data: authorityDto(), error: null };
  };
}

function context(): ToolContext {
  return {
    user: {
      uid: AUTH_USER,
      accountId: ACCOUNT,
      username: 'stale-user',
      displayName: 'Stale User',
      role: 'general_manager',
      propertyAccess: [PROPERTY_A],
      hotelMutationAllowed: true,
      seesFinancials: true,
      capabilitySnapshot: {
        view_financials: true,
        view_wages: true,
        manage_inventory_orders: true,
      },
    },
    propertyId: PROPERTY_A,
    staffId: null,
    requestId: 'fresh-authorization-unit',
    surface: 'chat',
  };
}

function financeHatContext(): ToolContext {
  const ctx = context();
  return {
    ...ctx,
    user: {
      ...ctx.user,
      role: 'front_desk',
      hotelMutationAllowed: false,
      seesFinancials: true,
    },
  };
}

registerTool({
  name: READ_TOOL,
  description: 'fresh authorization read fixture',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['owner', 'general_manager'],
  handler: async (_args, ctx) => {
    readHandlerCalls += 1;
    lastHandlerContext = ctx;
    return { ok: true, data: 'read' };
  },
});

registerTool({
  name: SECTION_TOOL,
  description: 'fresh section authorization fixture',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['owner', 'general_manager'],
  section: 'inventory',
  handler: async () => {
    sectionHandlerCalls += 1;
    return { ok: true, data: 'section read' };
  },
});

registerTool({
  name: WAGE_TOOL,
  description: 'fresh authorization wage fixture',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['owner', 'general_manager'],
  requiresCapability: 'view_wages',
  handler: async () => {
    wageHandlerCalls += 1;
    return { ok: true, data: 'wages' };
  },
});

registerTool({
  name: MUTATION_TOOL,
  description: 'fresh authorization mutation fixture',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['owner', 'general_manager'],
  mutates: true,
  approval: 'quick',
  handler: async (_args, ctx) => {
    mutationHandlerCalls += 1;
    lastHandlerContext = ctx;
    return { ok: true, data: 'mutated' };
  },
});

registerTool({
  name: FINANCE_TOOL,
  description: 'fresh authorization capability fixture',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['owner', 'general_manager'],
  requiresCapability: 'view_financials',
  handler: async () => {
    financeHandlerCalls += 1;
    return { ok: true, data: 'finance' };
  },
});

before(() => installStoreStub());

beforeEach(() => {
  active = true;
  accountRole = 'general_manager';
  authorizedPropertyId = PROPERTY_A;
  operationalRole = 'general_manager';
  hotelMutationAllowed = true;
  seesFinancials = true;
  resolverOutage = false;
  capabilityAllowed = true;
  capabilityOutage = false;
  freshSectionEnabled = true;
  sectionOutage = false;
  readHandlerCalls = 0;
  mutationHandlerCalls = 0;
  financeHandlerCalls = 0;
  wageHandlerCalls = 0;
  sectionHandlerCalls = 0;
  lastHandlerContext = null;
});

after(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
});

describe('executeTool fresh authorization boundary', () => {
  test('runs a read with the fresh identity and standing, not stale context fields', async () => {
    operationalRole = 'owner';
    accountRole = 'owner';
    const result = await executeTool(READ_TOOL, {}, context());

    assert.equal(result.ok, true, result.error);
    assert.equal(readHandlerCalls, 1);
    assert.equal(lastHandlerContext?.user.role, 'owner');
    assert.equal(lastHandlerContext?.user.displayName, 'Current User');
    assert.deepEqual(lastHandlerContext?.user.propertyAccess, [PROPERTY_A]);
  });

  test('revocation after context creation refuses a read before its handler', async () => {
    const stale = context();
    authorizedPropertyId = null;

    const result = await executeTool(READ_TOOL, {}, stale);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /access changed/i);
    assert.equal(readHandlerCalls, 0);
  });

  test('a valid but forged account id cannot be paired with the signed-in uid', async () => {
    const tampered = context();
    tampered.user.accountId = PROPERTY_B;

    const result = await executeTool(READ_TOOL, {}, tampered);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /access changed/i);
    assert.equal(readHandlerCalls, 0);
  });

  test('a forged auth uid cannot reuse a valid account id or standing', async () => {
    const tampered = context();
    tampered.user.uid = PROPERTY_B;

    const result = await executeTool(READ_TOOL, {}, tampered);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /could not be verified/i);
    assert.equal(readHandlerCalls, 0);
  });

  test('hotel transfer after context creation refuses both reads and writes', async () => {
    const stale = context();
    authorizedPropertyId = PROPERTY_B;

    const read = await executeTool(READ_TOOL, {}, stale);
    const write = await executeTool(MUTATION_TOOL, {}, stale);
    assert.equal(read.ok, false);
    assert.equal(write.ok, false);
    assert.equal(readHandlerCalls, 0);
    assert.equal(mutationHandlerCalls, 0);
  });

  test('account deactivation after context creation is immediate for reads and writes', async () => {
    const stale = context();
    active = false;

    const read = await executeTool(READ_TOOL, {}, stale);
    const write = await executeTool(MUTATION_TOOL, {}, stale);
    assert.equal(read.ok, false);
    assert.equal(write.ok, false);
    assert.equal(readHandlerCalls, 0);
    assert.equal(mutationHandlerCalls, 0);
  });

  test('resolver outage fails closed and never reaches a handler', async () => {
    resolverOutage = true;

    const result = await executeTool(READ_TOOL, {}, context());
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /could not be verified/i);
    assert.equal(readHandlerCalls, 0);
  });

  test('section state is an old-and-current intersection on every tool call', async () => {
    const staleOn = context();
    staleOn.enabledSections = { inventory: true };

    freshSectionEnabled = false;
    const revoked = await executeTool(SECTION_TOOL, {}, staleOn);
    assert.equal(revoked.ok, false, 'same-turn section disablement reached a handler');
    assert.match(revoked.error ?? '', /turned off/i);
    assert.equal(sectionHandlerCalls, 0);

    freshSectionEnabled = true;
    sectionOutage = true;
    const unavailable = await executeTool(SECTION_TOOL, {}, staleOn);
    assert.equal(unavailable.ok, false);
    assert.match(unavailable.error ?? '', /could not be verified/i);
    assert.equal(sectionHandlerCalls, 0);

    sectionOutage = false;
    const staleOff = context();
    staleOff.enabledSections = { inventory: false };
    const newlyEnabled = await executeTool(SECTION_TOOL, {}, staleOff);
    assert.equal(newlyEnabled.ok, false, 'an in-flight turn acquired a newly enabled section');
    assert.equal(sectionHandlerCalls, 0);

    const legacyDefaultOn = context();
    legacyDefaultOn.enabledSections = null;
    freshSectionEnabled = null;
    const nullMap = await executeTool(SECTION_TOOL, {}, legacyDefaultOn);
    assert.equal(nullMap.ok, true, nullMap.error);
    assert.equal(sectionHandlerCalls, 1, 'a valid database NULL stopped default-on behavior');
  });

  test('omitted route proofs fail closed for mutation, capability and section tools', async () => {
    const noMutationProof = context();
    delete noMutationProof.user.hotelMutationAllowed;
    const mutation = await executeTool(MUTATION_TOOL, {}, noMutationProof);
    assert.equal(mutation.ok, false);
    assert.equal(mutationHandlerCalls, 0);

    const noCapabilityProof = context();
    delete noCapabilityProof.user.capabilitySnapshot;
    const capability = await executeTool(FINANCE_TOOL, {}, noCapabilityProof);
    assert.equal(capability.ok, false);
    assert.equal(financeHandlerCalls, 0);

    const noSectionProof = context();
    const section = await executeTool(SECTION_TOOL, {}, noSectionProof);
    assert.equal(section.ok, false);
    assert.match(section.error ?? '', /could not be verified/i);
    assert.equal(sectionHandlerCalls, 0);
  });

  test('current role and mutation standing are enforced independently', async () => {
    operationalRole = 'front_desk';
    hotelMutationAllowed = false;

    const read = await executeTool(READ_TOOL, {}, context());
    const write = await executeTool(MUTATION_TOOL, {}, context());
    assert.equal(read.ok, false, 'current role loss must refuse the manager read');
    assert.equal(write.ok, false, 'current read-only standing must refuse mutation');
    assert.equal(readHandlerCalls, 0);
    assert.equal(mutationHandlerCalls, 0);
  });

  test('current financial standing and per-hotel override both fail closed', async () => {
    seesFinancials = false;
    const standingDenied = await executeTool(FINANCE_TOOL, {}, context());
    assert.equal(standingDenied.ok, false);
    assert.equal(financeHandlerCalls, 0);

    seesFinancials = true;
    capabilityAllowed = false;
    const overrideDenied = await executeTool(FINANCE_TOOL, {}, context());
    assert.equal(overrideDenied.ok, false);
    assert.equal(financeHandlerCalls, 0);

    capabilityAllowed = true;
    capabilityOutage = true;
    const outageDenied = await executeTool(FINANCE_TOOL, {}, context());
    assert.equal(outageDenied.ok, false);
    assert.match(outageDenied.error ?? '', /could not be verified/i);
    assert.equal(financeHandlerCalls, 0);
  });

  test('capability overrides are an old-and-current intersection across one turn', async () => {
    const staleAllowed = context();
    const first = await executeTool(FINANCE_TOOL, {}, staleAllowed);
    assert.equal(first.ok, true, first.error);
    assert.equal(financeHandlerCalls, 1);

    capabilityAllowed = false;
    const revoked = await executeTool(FINANCE_TOOL, {}, staleAllowed);
    assert.equal(revoked.ok, false, 'same-turn override revocation reused a cached allow');
    assert.equal(financeHandlerCalls, 1);

    capabilityAllowed = true;
    const staleDenied = context();
    staleDenied.user.capabilitySnapshot = {
      ...staleDenied.user.capabilitySnapshot,
      view_financials: false,
    };
    const newlyGranted = await executeTool(FINANCE_TOOL, {}, staleDenied);
    assert.equal(newlyGranted.ok, false, 'an in-flight turn acquired a newly granted override');
    assert.equal(financeHandlerCalls, 1);

    const staleAfterOutage = context();
    capabilityOutage = true;
    const unavailable = await executeTool(FINANCE_TOOL, {}, staleAfterOutage);
    assert.equal(unavailable.ok, false);
    assert.match(unavailable.error ?? '', /could not be verified/i);
    assert.equal(financeHandlerCalls, 1);
  });

  test('a finance hat gets only read-only Financials, without becoming a manager', async () => {
    operationalRole = 'front_desk';
    hotelMutationAllowed = false;
    seesFinancials = true;
    const stale = financeHatContext();

    const catalog = getToolsForRole('front_desk', 'chat', undefined, undefined, {
      seesFinancials: true,
      hotelMutationAllowed: false,
      capabilitySnapshot: {
        view_financials: true,
        view_wages: false,
        manage_inventory_orders: false,
      },
    });
    const names = catalog.map((tool) => tool.name);
    assert.ok(names.includes(FINANCE_TOOL), 'explicit Financials read was not offered');
    assert.equal(names.includes(WAGE_TOOL), false, 'Financials silently widened into payroll');
    assert.equal(names.includes(READ_TOOL), false, 'Financials silently widened into a manager read');
    assert.equal(names.includes(MUTATION_TOOL), false, 'a read-only standing was offered a mutation');
    assert.ok(catalog.every((tool) => tool.mutates !== true));

    const finance = await executeTool(FINANCE_TOOL, {}, stale);
    const wages = await executeTool(WAGE_TOOL, {}, stale);
    const managerRead = await executeTool(READ_TOOL, {}, stale);
    const mutation = await executeTool(MUTATION_TOOL, {}, stale);
    assert.equal(finance.ok, true, finance.error);
    assert.equal(wages.ok, false);
    assert.equal(managerRead.ok, false);
    assert.equal(mutation.ok, false);
    assert.equal(financeHandlerCalls, 1);
    assert.equal(wageHandlerCalls, 0);
    assert.equal(readHandlerCalls, 0);
    assert.equal(mutationHandlerCalls, 0);
  });

  test('finance access is an old-and-current intersection on each execution', async () => {
    operationalRole = 'front_desk';
    hotelMutationAllowed = false;
    seesFinancials = true;

    const staleWithoutFinance = financeHatContext();
    staleWithoutFinance.user.seesFinancials = false;
    const newlyGranted = await executeTool(FINANCE_TOOL, {}, staleWithoutFinance);
    assert.equal(newlyGranted.ok, false, 'an in-flight catalog acquired a new finance grant');
    assert.equal(financeHandlerCalls, 0);

    const staleWithFinance = financeHatContext();
    seesFinancials = false;
    const revoked = await executeTool(FINANCE_TOOL, {}, staleWithFinance);
    assert.equal(revoked.ok, false, 'a revoked finance grant reached its handler');
    assert.match(revoked.error ?? '', /access changed/i);
    assert.equal(financeHandlerCalls, 0);
  });

  test('the route snapshot key set covers every capability-gated agent tool', () => {
    const captured = new Set<string>(AGENT_TOOL_CAPABILITY_KEYS);
    const missing = listAllTools()
      .filter((tool) => tool.requiresCapability && !captured.has(tool.requiresCapability))
      .map((tool) => `${tool.name}:${tool.requiresCapability}`);
    assert.deepEqual(missing, []);
  });
});
