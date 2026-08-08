import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { NextRequest, NextResponse } from 'next/server';

import {
  createRequestAuthorizationWithDependencies,
  type RequestAuthorizationDependencies,
} from '@/lib/authorization/request';
import type {
  AuthoritativePropertyAccess,
  AuthoritativePropertyStanding,
} from '@/lib/authorization/server';

const USER_ID = '10000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '10000000-0000-4000-8000-000000000002';
const HOTEL_A = '10000000-0000-4000-8000-000000000003';
const HOTEL_B = '10000000-0000-4000-8000-000000000004';
const REQUEST_ID = 'request-authorization-test';

function standing(
  propertyId: string,
  overrides: Partial<AuthoritativePropertyStanding> = {},
): AuthoritativePropertyStanding {
  return {
    propertyId,
    operationalRole: 'general_manager',
    seesFinancials: true,
    hotelMutationAllowed: true,
    portfolioIntelligenceRead: false,
    entitlements: [],
    ...overrides,
  };
}

function authority(
  hotelStanding: AuthoritativePropertyStanding = standing(HOTEL_A),
): AuthoritativePropertyAccess {
  return {
    all: false,
    authorityMode: 'normalized',
    authorityVersion: 9,
    effectiveAccessHash: 'a'.repeat(64),
    propertyIds: [hotelStanding.propertyId],
    legacyPropertyIds: [],
    membershipPropertyIds: [hotelStanding.propertyId],
    propertyStandings: [hotelStanding],
  };
}

function request(): NextRequest {
  return new NextRequest(`https://staxis.test/api/pilot?propertyId=${HOTEL_A}`);
}

function dependencies(
  overrides: Partial<RequestAuthorizationDependencies> = {},
): RequestAuthorizationDependencies {
  return {
    requireSession: async () => ({ ok: true, userId: USER_ID, email: 'manager@staxis.test' }),
    loadAccount: async () => ({ kind: 'active', accountId: ACCOUNT_ID }),
    loadAuthority: async () => authority(),
    capabilityDecision: async () => 'allowed',
    sectionDecision: async () => ({
      ok: true,
      userId: USER_ID,
      requestId: REQUEST_ID,
      enabledSections: { inventory: true },
    }),
    ...overrides,
  };
}

async function authenticatedFacade(deps: RequestAuthorizationDependencies) {
  const facade = createRequestAuthorizationWithDependencies(
    request(),
    { requestId: REQUEST_ID },
    deps,
  );
  const session = await facade.requireSession();
  assert.equal(session.ok, true);
  if (!session.ok) throw new Error('expected an authenticated test session');
  return session;
}

describe('request authorization facade', () => {
  test('does not expose the session gate MFA-bypass option', async () => {
    let receivedArgumentCount = -1;
    const facade = createRequestAuthorizationWithDependencies(
      request(),
      { requestId: REQUEST_ID },
      dependencies({
        requireSession: async (...args) => {
          receivedArgumentCount = args.length;
          return { ok: true, userId: USER_ID, email: 'manager@staxis.test' };
        },
      }),
    );

    const session = await facade.requireSession();
    assert.equal(session.ok, true);
    assert.equal(receivedArgumentCount, 1);
  });

  test('tenant audit rejects the injected test seam before DB-client filtering', () => {
    const audit = readFileSync(join(
      process.cwd(),
      'scripts/audit-api-route-tenant-scope.mjs',
    ), 'utf8');
    const seamCheck = audit.indexOf('createRequestAuthorizationWithDependencies');
    const dbClientEarlyReturn = audit.indexOf('if (!usesAdmin && !usesServer) return');
    assert.ok(seamCheck >= 0);
    assert.ok(dbClientEarlyReturn > seamCheck);
  });

  test('composes the existing session, standing, capability, and section decisions in order', async () => {
    const calls: string[] = [];
    const session = await authenticatedFacade(dependencies({
      requireSession: async () => {
        calls.push('session');
        return { ok: true, userId: USER_ID, email: 'manager@staxis.test' };
      },
      loadAccount: async (userId) => {
        calls.push(`account:${userId}`);
        return { kind: 'active', accountId: ACCOUNT_ID };
      },
      loadAuthority: async (accountId) => {
        calls.push(`authority:${accountId}`);
        return authority();
      },
      capabilityDecision: async (_standing, capability, propertyId, freshness) => {
        calls.push(`capability:${capability}:${propertyId}:${freshness}`);
        return 'allowed';
      },
      sectionDecision: async (_req, propertyId, section) => {
        calls.push(`section:${section}:${propertyId}`);
        return {
          ok: true,
          userId: USER_ID,
          requestId: REQUEST_ID,
          enabledSections: { inventory: true },
        };
      },
    }));

    const result = await session.authorizeHotel({
      propertyId: HOTEL_A,
      intent: 'mutation',
      checks: [
        { kind: 'capability', capability: 'manage_inventory_orders', freshness: 'fresh' },
        { kind: 'mutation-standing' },
        { kind: 'section', section: 'inventory' },
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.principal.authUserId, USER_ID);
    assert.equal(result.principal.accountId, ACCOUNT_ID);
    assert.equal(result.standing.propertyId, HOTEL_A);
    assert.deepEqual(result.allowedCapabilities, ['manage_inventory_orders']);
    assert.deepEqual(result.enabledSections, { inventory: true });
    assert.deepEqual(calls, [
      'session',
      `account:${USER_ID}`,
      `authority:${ACCOUNT_ID}`,
      `capability:manage_inventory_orders:${HOTEL_A}:fresh`,
      `section:inventory:${HOTEL_A}`,
    ]);
  });

  test('denies a cross-hotel request before reading that hotel capability or section state', async () => {
    let capabilityReads = 0;
    let sectionReads = 0;
    const session = await authenticatedFacade(dependencies({
      capabilityDecision: async () => {
        capabilityReads += 1;
        return 'allowed';
      },
      sectionDecision: async () => {
        sectionReads += 1;
        return {
          ok: true,
          userId: USER_ID,
          requestId: REQUEST_ID,
          enabledSections: null,
        };
      },
    }));

    const result = await session.authorizeHotel({
      propertyId: HOTEL_B,
      intent: 'read',
      checks: [
        { kind: 'capability', capability: 'manage_inventory_orders' },
        { kind: 'section', section: 'inventory' },
      ],
    });

    assert.deepEqual(result, { ok: false, reason: 'property_denied' });
    assert.equal(capabilityReads, 0);
    assert.equal(sectionReads, 0);
  });

  test('a read-only standing cannot reach a mutation capability check', async () => {
    let capabilityReads = 0;
    const session = await authenticatedFacade(dependencies({
      loadAuthority: async () => authority(standing(HOTEL_A, { hotelMutationAllowed: false })),
      capabilityDecision: async () => {
        capabilityReads += 1;
        return 'allowed';
      },
    }));

    const result = await session.authorizeHotel({
      propertyId: HOTEL_A,
      intent: 'mutation',
      checks: [
        { kind: 'mutation-standing' },
        { kind: 'capability', capability: 'manage_inventory_orders' },
      ],
    });

    assert.deepEqual(result, { ok: false, reason: 'mutation_denied' });
    assert.equal(capabilityReads, 0);
  });

  test('preserves a mutation route\'s explicit check ordering', async () => {
    const retry = NextResponse.json({ error: 'section unavailable' }, { status: 503 });
    let sectionReads = 0;
    const session = await authenticatedFacade(dependencies({
      loadAuthority: async () => authority(standing(HOTEL_A, { hotelMutationAllowed: false })),
      sectionDecision: async () => {
        sectionReads += 1;
        return { ok: false, response: retry };
      },
    }));

    const sectionFirst = await session.authorizeHotel({
      propertyId: HOTEL_A,
      intent: 'mutation',
      checks: [
        { kind: 'section', section: 'inventory' },
        { kind: 'mutation-standing' },
      ],
    });
    assert.equal(sectionFirst.ok, false);
    if (sectionFirst.ok) throw new Error('expected the section refusal to win');
    assert.equal(sectionFirst.reason, 'section_denied');
    if (sectionFirst.reason === 'section_denied') assert.equal(sectionFirst.response, retry);

    const mutationFirst = await session.authorizeHotel({
      propertyId: HOTEL_A,
      intent: 'mutation',
      checks: [
        { kind: 'mutation-standing' },
        { kind: 'section', section: 'inventory' },
      ],
    });
    assert.deepEqual(mutationFirst, { ok: false, reason: 'mutation_denied' });
    assert.equal(sectionReads, 1);
  });

  test('fails closed when mutation intent omits its ordered standing check', async () => {
    const session = await authenticatedFacade(dependencies());
    await assert.rejects(
      session.authorizeHotel({
        propertyId: HOTEL_A,
        intent: 'mutation',
        checks: [],
      }),
      /requires exactly one ordered mutation-standing check/,
    );
  });

  test('preserves distinct retryable capability and section failures', async () => {
    const capabilitySession = await authenticatedFacade(dependencies({
      capabilityDecision: async () => 'unavailable',
    }));
    assert.deepEqual(await capabilitySession.authorizeHotel({
      propertyId: HOTEL_A,
      intent: 'read',
      checks: [{ kind: 'capability', capability: 'manage_inventory_orders' }],
    }), {
      ok: false,
      reason: 'capability_unavailable',
      capability: 'manage_inventory_orders',
    });

    const retry = NextResponse.json({ error: 'try later' }, { status: 503 });
    const sectionSession = await authenticatedFacade(dependencies({
      sectionDecision: async () => ({ ok: false, response: retry }),
    }));
    const sectionResult = await sectionSession.authorizeHotel({
      propertyId: HOTEL_A,
      intent: 'read',
      checks: [{ kind: 'section', section: 'inventory' }],
    });
    assert.equal(sectionResult.ok, false);
    if (sectionResult.ok) throw new Error('expected a section refusal');
    assert.equal(sectionResult.reason, 'section_denied');
    if (sectionResult.reason === 'section_denied') {
      assert.equal(sectionResult.response, retry, 'the existing section response must pass through');
    }
  });

  test('the inventory pilot preserves validation and response ordering around the facade', () => {
    const route = readFileSync(join(
      process.cwd(),
      'src/app/api/inventory/history/route.ts',
    ), 'utf8');
    const propertyValidation = route.indexOf('if (!isUuid(propertyId))');
    const limitValidation = route.indexOf('limit = parseInventoryAuditLimit');
    const session = route.indexOf('authorization.requireSession()');
    const hotel = route.indexOf('session.authorizeHotel({');
    const finance = route.indexOf('capabilityDecisionForProperty(');
    const dataRead = route.indexOf('listInventoryAuditHistory(');
    assert.ok(propertyValidation >= 0);
    assert.ok(limitValidation > propertyValidation);
    assert.ok(session > limitValidation);
    assert.ok(hotel > session);
    assert.ok(finance > hotel);
    assert.ok(dataRead > finance);
    assert.match(route, /checks: \[\{ kind: 'section', section: 'inventory' \}\]/);
    assert.match(route, /intent: 'read'/);
    assert.match(route, /account not found for session/);
    assert.match(route, /authorization_unavailable/);
    assert.match(route, /forbidden_property/);
    assert.doesNotMatch(route, /property_access/);
  });

  test('inventory AI status keeps its wire contract while using the facade', () => {
    const route = readFileSync(join(
      process.cwd(),
      'src/app/api/inventory/ai-status/route.ts',
    ), 'utf8');
    const requestId = route.indexOf('const requestId = getOrMintRequestId(req);');
    const authorization = route.indexOf('const authorization = createRequestAuthorization(req, { requestId });');
    const session = route.indexOf('const session = await authorization.requireSession();');
    const property = route.indexOf('const propertyId = new URL(req.url).searchParams.get(\'propertyId\');');
    const validation = route.indexOf('if (!isUuid(propertyId))');
    const hotel = route.indexOf('const hotel = await session.authorizeHotel({');
    const section = route.indexOf("checks: [{ kind: 'section', section: 'inventory' }]");
    const dataRead = route.indexOf('const sevenDaysAgoIso =');

    assert.ok(requestId >= 0);
    assert.ok(authorization > requestId);
    assert.ok(session > authorization);
    assert.ok(property > session);
    assert.ok(validation > property);
    assert.ok(hotel > validation);
    assert.ok(section > hotel);
    assert.ok(dataRead > section);
    assert.match(route, /createRequestAuthorization/);
    assert.doesNotMatch(route, /\buserHasPropertyAccess\b/);
    assert.doesNotMatch(route, /requireSectionEnabled/);
    assert.match(route, /if \(refusal\.reason === 'section_denied'\) return refusal\.response;/);
    assert.match(route, /return err\('forbidden', \{[\s\S]*?status: 403,[\s\S]*?code: ApiErrorCode\.Forbidden/);
    assert.match(route, /inventoryAiUnavailableResponse\(requestId\)/);
    for (const field of [
      'aiMode',
      'daysSinceFirstCount',
      'itemsTotal',
      'itemsWithModel',
      'itemsGraduated',
      'itemsExpectedToGraduate',
      'overfitRatio',
      'currentMaeRatioVsMean',
      'currentMaeRatio: overfitRatio',
      'lastInferenceAt',
      'lastInferenceStale',
      'predictionsLast7Days',
    ]) {
      assert.match(route, new RegExp(`\\b${field.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`));
    }
  });
});
