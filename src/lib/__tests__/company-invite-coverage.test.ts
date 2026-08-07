// Coverage is the security boundary this feature exists for.
//
// A management company runs hotels for DIFFERENT ownership groups. An Owner of
// 3 of 20 hotels must never reach the other 17, and must never be able to hand
// somebody else a hat that does. Every test below is written so it would FAIL
// on a plausible mistake rather than on a rename: they call the real resolver
// with real-shaped entitlements and assert on which hotels come back.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canGrantHat,
  coverageContains,
  coverageIncludesProperty,
  COMPANY_SCOPE_ROLES,
  HAT_ROLE_LABELS,
  accessProfileForHat,
  hatCanManageTeam,
  legacyRoleForHat,
} from '@/lib/company/roles';
import {
  projectStoredInviteForCompanyContext,
  resolveAuthoritativeInviteScope,
  type CompanyInviteAuthorityContext,
} from '@/lib/company/account-invite-authority';
import type { AuthorizationScopeEntitlement } from '@/lib/authorization';

const HOTEL_A = '11111111-1111-4111-8111-111111111111';
const HOTEL_B = '22222222-2222-4222-8222-222222222222';
const HOTEL_C = '33333333-3333-4333-8333-333333333333';
const ORG = '99999999-9999-4999-8999-999999999999';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';

function companyHatAt(propertyId: string, role: 'owner' | 'regional_manager'): AuthorizationScopeEntitlement {
  return {
    propertyId,
    entitlementKind: 'membership_hat',
    entitlementId: `ent-${propertyId}`,
    membershipId: `mem-${role}`,
    accessProfile: null,
    staxisRole: role,
    scopeType: 'company',
    portfolioId: null,
  };
}

function contextFor(input: {
  operated: string[];
  authorized: string[];
  entitlements: AuthorizationScopeEntitlement[];
  coversFuture: boolean;
}): CompanyInviteAuthorityContext {
  return {
    accountId: ACCOUNT,
    isPlatformAdmin: false,
    organizationId: ORG,
    anchorPropertyId: input.authorized[0] ?? HOTEL_A,
    operatedPropertyIds: input.operated,
    authorizedPropertyIds: input.authorized,
    authorizationEntitlements: input.entitlements,
    authorizationReceipt: null,
    coversFutureProperties: input.coversFuture,
  };
}

/** An Owner covering only hotels A and B, by an explicit list. */
function ownerOfAandB(): CompanyInviteAuthorityContext {
  return contextFor({
    operated: [HOTEL_A, HOTEL_B, HOTEL_C],
    authorized: [HOTEL_A, HOTEL_B],
    entitlements: [companyHatAt(HOTEL_A, 'owner'), companyHatAt(HOTEL_B, 'owner')],
    coversFuture: false,
  });
}

/** An Owner whose authority follows the company forward. */
function ownerOfEverything(): CompanyInviteAuthorityContext {
  return contextFor({
    operated: [HOTEL_A, HOTEL_B, HOTEL_C],
    authorized: [HOTEL_A, HOTEL_B, HOTEL_C],
    entitlements: [
      companyHatAt(HOTEL_A, 'owner'),
      companyHatAt(HOTEL_B, 'owner'),
      companyHatAt(HOTEL_C, 'owner'),
    ],
    coversFuture: true,
  });
}

// ─── The vocabulary ────────────────────────────────────────────────────────

test('company jobs are exactly Owner and Regional Manager', () => {
  assert.deepEqual([...COMPANY_SCOPE_ROLES], ['owner', 'regional_manager']);
  assert.equal(HAT_ROLE_LABELS.regional_manager.en, 'Regional Manager');
  // The retired word must not resolve to anything at all.
  assert.equal((HAT_ROLE_LABELS as Record<string, unknown>).finance, undefined);
  assert.equal((HAT_ROLE_LABELS as Record<string, unknown>).vp, undefined);
});

test('a regional manager is oversight, never hotel authority', () => {
  assert.equal(legacyRoleForHat('regional_manager'), 'front_desk');
  assert.equal(accessProfileForHat('company', 'regional_manager'), 'portfolio_manager');
  assert.equal(accessProfileForHat('company', 'owner'), 'organization_owner');
  assert.equal(hatCanManageTeam('company', 'regional_manager'), true);
});

// ─── coverageContains: nobody grants past their own edge ───────────────────

test('all-including-future covers a hotel bought after the grant', () => {
  // null is the whole point: it is not a snapshot of today's hotels.
  assert.equal(coverageIncludesProperty(null, HOTEL_C), true);
  assert.equal(coverageIncludesProperty([HOTEL_A], HOTEL_C), false);
});

test('an explicit list may not mint all-including-future', () => {
  // Even when the list covers every hotel that exists today: hotel 21 is not
  // theirs to give. This is the asymmetry the whole feature turns on.
  assert.equal(coverageContains([HOTEL_A, HOTEL_B, HOTEL_C], null), false);
  assert.equal(coverageContains(null, null), true);
  assert.equal(coverageContains(null, [HOTEL_C]), true);
});

test('coverage never widens through a subset', () => {
  assert.equal(coverageContains([HOTEL_A, HOTEL_B], [HOTEL_A]), true);
  assert.equal(coverageContains([HOTEL_A, HOTEL_B], [HOTEL_A, HOTEL_C]), false);
  assert.equal(coverageContains([HOTEL_A], []), false);
});

// ─── canGrantHat: the delegation ladder ────────────────────────────────────

test('an owner of three hotels cannot mint an owner of all twenty', () => {
  const inviter = { scope: 'company' as const, role: 'owner' as const, coveredPropertyIds: [HOTEL_A, HOTEL_B] };
  assert.equal(canGrantHat(inviter, {
    scope: 'company', role: 'owner', propertyIds: [HOTEL_A],
  }), true);
  assert.equal(canGrantHat(inviter, {
    scope: 'company', role: 'owner', propertyIds: [HOTEL_C],
  }), false);
  assert.equal(canGrantHat(inviter, {
    scope: 'company', role: 'owner', propertyIds: null,
  }), false);
});

test('a regional manager hires hotel jobs, never a company job', () => {
  const inviter = {
    scope: 'company' as const,
    role: 'regional_manager' as const,
    coveredPropertyIds: [HOTEL_A, HOTEL_B],
  };
  assert.equal(canGrantHat(inviter, {
    scope: 'property', role: 'general_manager', propertyIds: [HOTEL_A],
  }), true);
  // Never a peer, and never an owner. `finance` used to be their one company
  // hire; retiring it left them with none.
  assert.equal(canGrantHat(inviter, {
    scope: 'company', role: 'regional_manager', propertyIds: [HOTEL_A],
  }), false);
  assert.equal(canGrantHat(inviter, {
    scope: 'company', role: 'owner', propertyIds: [HOTEL_A],
  }), false);
  // And still bounded by their own hotels.
  assert.equal(canGrantHat(inviter, {
    scope: 'property', role: 'front_desk', propertyIds: [HOTEL_C],
  }), false);
});

test('a GM hires line staff at their own hotels only', () => {
  const gm = {
    scope: 'property' as const,
    role: 'general_manager' as const,
    coveredPropertyIds: [HOTEL_A],
  };
  assert.equal(canGrantHat(gm, { scope: 'property', role: 'housekeeping', propertyIds: [HOTEL_A] }), true);
  assert.equal(canGrantHat(gm, { scope: 'property', role: 'general_manager', propertyIds: [HOTEL_A] }), false);
  assert.equal(canGrantHat(gm, { scope: 'property', role: 'housekeeping', propertyIds: [HOTEL_B] }), false);
  assert.equal(canGrantHat(gm, { scope: 'company', role: 'owner', propertyIds: [HOTEL_A] }), false);
});

// ─── resolveAuthoritativeInviteScope: what actually gets stored ────────────

test('a company invite with an explicit list grants exactly that list', () => {
  const resolved = resolveAuthoritativeInviteScope(
    ownerOfAandB(), 'regional_manager', 'company', [HOTEL_A],
  );
  assert.equal(resolved.kind, 'allowed');
  if (resolved.kind !== 'allowed') return;
  assert.deepEqual(resolved.value.coveredPropertyIds, [HOTEL_A]);
  assert.deepEqual(resolved.value.propertyIds, [HOTEL_A]);
});

test('a company invite cannot name a hotel the inviter does not reach', () => {
  // HOTEL_C is operated by the company but not covered by this owner.
  const resolved = resolveAuthoritativeInviteScope(
    ownerOfAandB(), 'regional_manager', 'company', [HOTEL_C],
  );
  assert.equal(resolved.kind, 'denied');
  const mixed = resolveAuthoritativeInviteScope(
    ownerOfAandB(), 'regional_manager', 'company', [HOTEL_A, HOTEL_C],
  );
  assert.equal(mixed.kind, 'denied', 'one unreachable hotel must deny the whole grant');
});

test('only an inviter who covers the future may promise the future', () => {
  // Absent list means all-including-future. The owner on an explicit list is
  // refused it even though they are an owner.
  assert.equal(
    resolveAuthoritativeInviteScope(ownerOfAandB(), 'regional_manager', 'company', null).kind,
    'denied',
  );
  const allowed = resolveAuthoritativeInviteScope(
    ownerOfEverything(), 'regional_manager', 'company', null,
  );
  assert.equal(allowed.kind, 'allowed');
  if (allowed.kind !== 'allowed') return;
  // NULL coverage is what makes it follow the company into new hotels.
  assert.equal(allowed.value.coveredPropertyIds, null);
  assert.deepEqual(allowed.value.propertyIds, [HOTEL_A, HOTEL_B, HOTEL_C]);
});

test('an empty list still means all-including-future, as it always did', () => {
  // Every caller written before 0464 sends `scope:'company'` with no list and
  // means the whole company. Changing that silently would re-scope live hats.
  const resolved = resolveAuthoritativeInviteScope(
    ownerOfEverything(), 'owner', 'company', [],
  );
  assert.equal(resolved.kind, 'allowed');
  if (resolved.kind !== 'allowed') return;
  assert.equal(resolved.value.coveredPropertyIds, null);
});

test('a regional manager cannot mint any company hat through the resolver', () => {
  const regional = contextFor({
    operated: [HOTEL_A, HOTEL_B],
    authorized: [HOTEL_A, HOTEL_B],
    entitlements: [
      companyHatAt(HOTEL_A, 'regional_manager'),
      companyHatAt(HOTEL_B, 'regional_manager'),
    ],
    coversFuture: true,
  });
  assert.equal(
    resolveAuthoritativeInviteScope(regional, 'owner', 'company', [HOTEL_A]).kind,
    'denied',
  );
  assert.equal(
    resolveAuthoritativeInviteScope(regional, 'regional_manager', 'company', null).kind,
    'denied',
  );
  // Hotel jobs remain theirs to hand out.
  assert.equal(
    resolveAuthoritativeInviteScope(regional, 'front_desk', 'property', [HOTEL_A]).kind,
    'allowed',
  );
});

// ─── Reading back a stored invitation ──────────────────────────────────────

test('a stored company invite with a list is projected as that list', () => {
  const projected = projectStoredInviteForCompanyContext(
    ownerOfAandB(),
    {
      hotelId: HOTEL_A,
      organizationId: ORG,
      membershipScope: 'company',
      role: 'regional_manager',
      coveredPropertyIds: [HOTEL_A, HOTEL_B],
    },
    HOTEL_A,
  );
  assert.ok(projected, 'the invitation should be visible to an owner who covers it');
  assert.equal(projected.scope, 'company');
  assert.deepEqual(projected.propertyIds, [HOTEL_A, HOTEL_B]);
  assert.equal(projected.canRevoke, true);
});

test('a stored all-including-future invite is not revocable by a listed owner', () => {
  // They can SEE it (it affects their hotels) but they could not have created
  // it, so they may not undo it either. Visibility and mutation are separate.
  const projected = projectStoredInviteForCompanyContext(
    ownerOfAandB(),
    {
      hotelId: HOTEL_A,
      organizationId: ORG,
      membershipScope: 'company',
      role: 'regional_manager',
      coveredPropertyIds: null,
    },
    HOTEL_A,
  );
  assert.ok(projected);
  assert.equal(projected.canRevoke, false);
  // And it never discloses the sister hotel this owner cannot reach.
  assert.ok(!projected.propertyIds.includes(HOTEL_C));
});
