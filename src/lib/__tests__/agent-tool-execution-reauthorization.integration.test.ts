process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder-test-key-min-20-chars';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import {
  executeTool,
  registerTool,
  type ToolContext,
} from '@/lib/agent/tools';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { applyMigrationsToPgliteThrough } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_MARIA,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_A2,
  UID_MARIA,
  seedTwoCompanies,
  type TwoCompanySeed,
} from '../../../tests/fixtures/pglite-two-company-seed';

const READ_TOOL = '__test_sql_fresh_authorization_read';
const MUTATION_TOOL = '__test_sql_fresh_authorization_mutation';

let pg: PGlite;
let shim: PglitePostgrest;
let seed: TwoCompanySeed;
let readHandlerCalls = 0;
let mutationHandlerCalls = 0;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);

registerTool({
  name: READ_TOOL,
  description: 'real-SQL fresh authorization read fixture',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['general_manager', 'front_desk'],
  surfaces: ['walkthrough'],
  handler: async (_args, ctx) => {
    readHandlerCalls += 1;
    return {
      ok: true,
      data: {
        propertyId: ctx.propertyId,
        role: ctx.user.role,
        mutationAllowed: ctx.user.hotelMutationAllowed,
      },
    };
  },
});

registerTool({
  name: MUTATION_TOOL,
  description: 'real-SQL fresh authorization mutation fixture',
  inputSchema: { type: 'object', properties: {} },
  allowedRoles: ['general_manager', 'front_desk'],
  surfaces: ['walkthrough'],
  mutates: true,
  approval: 'quick',
  handler: async () => {
    mutationHandlerCalls += 1;
    return { ok: true, data: 'mutated' };
  },
});

function staleContext(): ToolContext {
  return {
    user: {
      uid: UID_MARIA,
      accountId: ACCOUNT_MARIA,
      username: 'maria',
      displayName: 'Maria',
      role: 'general_manager',
      propertyAccess: [PID_A1, PID_A2],
      hotelMutationAllowed: true,
    },
    propertyId: PID_A1,
    staffId: null,
    requestId: 'fresh-authorization-real-sql',
    surface: 'walkthrough',
  };
}

async function callBoth(ctx: ToolContext) {
  return {
    read: await executeTool(READ_TOOL, {}, ctx),
    mutation: await executeTool(MUTATION_TOOL, {}, ctx),
  };
}

before(async () => {
  const migrated = await applyMigrationsToPgliteThrough('0425');
  assert.equal(
    migrated.report.failedAtRuntime.some((failure) => failure.file.startsWith('0376_')),
    false,
    `authoritative resolver migration must apply: ${JSON.stringify(migrated.report.failedAtRuntime)}`,
  );
  pg = migrated.pg;
  seed = await seedTwoCompanies(pg);
  const catalog = await loadCatalog(pg);
  shim = createPglitePostgrest(pg, catalog);
  // @ts-expect-error PGlite-backed PostgREST test adapter
  supabaseAdmin.from = shim.from;
  // @ts-expect-error PGlite-backed PostgREST test adapter
  supabaseAdmin.rpc = shim.rpc;
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  await pg?.close();
});

describe('executeTool reauthorization against the production SQL resolver', () => {
  test('revocation, transfer and deactivation take effect after context creation', async () => {
    const stale = staleContext();
    const propertyHat = seed.hats.get(`${ACCOUNT_MARIA}:property:general_manager`);
    const companyHat = seed.hats.get(`${ACCOUNT_MARIA}:company:vp`);
    assert.ok(propertyHat);
    assert.ok(companyHat);

    readHandlerCalls = 0;
    mutationHandlerCalls = 0;
    const baseline = await callBoth(stale);
    assert.equal(baseline.read.ok, true, baseline.read.error);
    assert.equal(baseline.mutation.ok, true, baseline.mutation.error);
    assert.equal(readHandlerCalls, 1);
    assert.equal(mutationHandlerCalls, 1);

    // Removing the property GM job leaves Maria's company VP reach in place.
    // That standing is deliberately read-only at a hotel: the read survives,
    // while the mutation is stopped before its handler.
    await pg.query(
      `update public.organization_memberships set status = 'suspended' where id = $1`,
      [propertyHat],
    );
    const afterRoleRemoval = await callBoth(stale);
    assert.equal(afterRoleRemoval.read.ok, true, afterRoleRemoval.read.error);
    assert.deepEqual(afterRoleRemoval.read.data, {
      propertyId: PID_A1,
      role: 'front_desk',
      mutationAllowed: false,
    });
    assert.equal(afterRoleRemoval.mutation.ok, false);
    assert.equal(readHandlerCalls, 2);
    assert.equal(mutationHandlerCalls, 1, 'write handler ran after hotel mutation authority was revoked');
    await pg.query(
      `update public.organization_memberships set status = 'active' where id = $1`,
      [propertyHat],
    );

    // Move the hotel to another company through the production transfer RPC.
    // The already-created context still names A1, but Maria's A-company hats
    // must no longer resolve there.
    await pg.query(
      `select public.staxis_set_primary_property_organization($1, $2, $3, 'operator')`,
      [ACCOUNT_ADMIN, PID_A1, ORG_B],
    );
    const afterTransfer = await callBoth(stale);
    assert.equal(afterTransfer.read.ok, false);
    assert.equal(afterTransfer.mutation.ok, false);
    assert.equal(readHandlerCalls, 2, 'read handler ran after hotel transfer');
    assert.equal(mutationHandlerCalls, 1, 'write handler ran after hotel transfer');
    await pg.query(
      `select public.staxis_set_primary_property_organization($1, $2, $3, 'operator')`,
      [ACCOUNT_ADMIN, PID_A1, ORG_A],
    );

    // A still-open session cannot outlive accounts.active.
    await pg.query('update public.accounts set active = false where id = $1', [ACCOUNT_MARIA]);
    const afterDeactivation = await callBoth(stale);
    assert.equal(afterDeactivation.read.ok, false);
    assert.equal(afterDeactivation.mutation.ok, false);
    assert.equal(readHandlerCalls, 2, 'read handler ran for an inactive account');
    assert.equal(mutationHandlerCalls, 1, 'write handler ran for an inactive account');
    await pg.query('update public.accounts set active = true where id = $1', [ACCOUNT_MARIA]);

    // Finally remove every A-company job. This is a complete scope revocation,
    // not just a role downgrade, and both grains must stop.
    await pg.query(
      `update public.organization_memberships set status = 'suspended'
        where id = any($1::uuid[])`,
      [`{${propertyHat},${companyHat}}`],
    );
    const afterRevocation = await callBoth(stale);
    assert.equal(afterRevocation.read.ok, false);
    assert.equal(afterRevocation.mutation.ok, false);
    assert.equal(readHandlerCalls, 2, 'read handler ran after complete scope revocation');
    assert.equal(mutationHandlerCalls, 1, 'write handler ran after complete scope revocation');
  });
});
