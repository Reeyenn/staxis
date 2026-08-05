import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  authoritativeHotelLeadershipRole,
  authoritativeStandingHasDirectHotelAccount,
  type AuthoritativePropertyEntitlement,
  type AuthoritativePropertyStanding,
} from '@/lib/authorization/server';
import {
  deriveHotelTeamSetupState,
  hotelTeamSetupDescription,
  hotelTeamSetupDialogTitle,
  hotelTeamSetupInvitationError,
  hotelTeamSetupLabel,
  hotelTeamSetupLinkLabel,
  type HotelTeamSetupMember,
  type HotelTeamSetupStateInput,
} from '@/app/(hotel)/company/_components/hotel-team-setup';
import { projectFirstPersonOnboardingState } from '@/lib/first-person-onboarding-state';

const HOTEL_ID = '11111111-1111-1111-1111-111111111111';

function entitlement(
  overrides: Partial<AuthoritativePropertyEntitlement> = {},
): AuthoritativePropertyEntitlement {
  return {
    kind: 'access_grant',
    entitlementId: '22222222-2222-2222-2222-222222222222',
    organizationId: '33333333-3333-3333-3333-333333333333',
    membershipId: '44444444-4444-4444-4444-444444444444',
    accessProfile: 'viewer',
    staxisRole: null,
    scopeType: 'property',
    portfolioId: null,
    ...overrides,
  };
}

function standing(entitlements: AuthoritativePropertyEntitlement[]): AuthoritativePropertyStanding {
  return {
    propertyId: HOTEL_ID,
    operationalRole: 'staff',
    seesFinancials: false,
    hotelMutationAllowed: false,
    portfolioIntelligenceRead: false,
    entitlements,
  };
}

function member(
  overrides: Partial<HotelTeamSetupMember> = {},
): HotelTeamSetupMember {
  return {
    accountId: '55555555-5555-5555-5555-555555555555',
    active: true,
    directHotelAccount: false,
    hotelLeadershipRole: null,
    ...overrides,
  };
}

function setup(overrides: Partial<HotelTeamSetupStateInput> = {}) {
  return deriveHotelTeamSetupState({
    adminPreview: true,
    teamLoading: false,
    teamError: false,
    peopleCount: 0,
    team: [],
    rosterUnavailable: false,
    onboardingStatus: 'none',
    ...overrides,
  });
}

describe('Company Hub hotel setup state', () => {
  test('uses the canonical standing contract, not managementSurface, for directness', () => {
    assert.equal(authoritativeStandingHasDirectHotelAccount(standing([
      entitlement({ kind: 'legacy' }),
    ])), true);
    assert.equal(authoritativeStandingHasDirectHotelAccount(standing([
      entitlement({ kind: 'legacy_bridge' }),
    ])), true);
    assert.equal(authoritativeStandingHasDirectHotelAccount(standing([
      entitlement({ kind: 'membership_hat', scopeType: 'property', staxisRole: 'general_manager' }),
    ])), true);
    assert.equal(authoritativeStandingHasDirectHotelAccount(standing([
      entitlement({ kind: 'membership_hat', scopeType: 'property', staxisRole: 'front_desk' }),
    ])), true);
    assert.equal(authoritativeStandingHasDirectHotelAccount(standing([
      entitlement({ kind: 'access_grant', scopeType: 'property', accessProfile: 'viewer' }),
    ])), true);

    assert.equal(authoritativeStandingHasDirectHotelAccount(standing([
      entitlement({ kind: 'membership_hat', scopeType: 'company', staxisRole: 'owner' }),
    ])), false);
    assert.equal(authoritativeStandingHasDirectHotelAccount(standing([
      entitlement({ kind: 'membership_hat', scopeType: 'property', staxisRole: 'finance' }),
    ])), false);
    assert.equal(authoritativeStandingHasDirectHotelAccount(standing([])), false);

    assert.equal(authoritativeHotelLeadershipRole(standing([
      entitlement({ kind: 'membership_hat', scopeType: 'property', staxisRole: 'general_manager' }),
    ]), 'staff'), 'general_manager');
    assert.equal(authoritativeHotelLeadershipRole(standing([
      entitlement({ kind: 'access_grant', scopeType: 'property', accessProfile: 'property_manager' }),
    ]), 'staff'), 'general_manager');
    assert.equal(authoritativeHotelLeadershipRole(standing([
      entitlement({ kind: 'access_grant', scopeType: 'property', accessProfile: 'organization_owner' }),
    ]), 'staff'), 'owner');
    assert.equal(authoritativeHotelLeadershipRole(standing([
      entitlement({ kind: 'membership_hat', scopeType: 'company', staxisRole: 'owner' }),
    ]), 'owner'), null);
  });

  test('keeps the setup action truthful across the stable roster matrix', () => {
    const cases = [
      {
        name: 'truly empty unclaimed hotel',
        input: { peopleCount: 0, team: [] },
        mode: 'first-person',
        label: 'Add first person',
      },
      {
        name: 'company-scope inherited people',
        input: {
          peopleCount: 1,
          team: [member()],
        },
        mode: 'hotel-owner-or-gm',
        label: 'Add hotel owner or GM',
      },
      {
        name: 'schedule-only staff',
        input: { peopleCount: 1, team: [] },
        mode: 'hotel-owner-or-gm',
        label: 'Add hotel owner or GM',
      },
      {
        name: 'normalized property-scoped direct GM',
        input: {
          peopleCount: 1,
          team: [member({ hotelLeadershipRole: 'general_manager', directHotelAccount: true })],
        },
        mode: null,
        label: null,
      },
      {
        name: 'inactive legacy direct account',
        input: {
          peopleCount: 1,
          team: [member({ active: false, directHotelAccount: true })],
        },
        mode: null,
        label: null,
      },
    ] as const;

    for (const scenario of cases) {
      const state = setup(scenario.input);
      assert.equal(state.setupMode, scenario.mode, scenario.name);
      assert.equal(hotelTeamSetupLabel(state.setupMode), scenario.label, scenario.name);
      assert.equal(
        scenario.mode ? hotelTeamSetupDialogTitle(scenario.mode) : null,
        scenario.label,
        `${scenario.name} dialog title`,
      );
    }
  });

  test('suppresses definitive claims while onboarding, roster, or authority state is indeterminate', () => {
    assert.equal(setup({ onboardingStatus: 'pending' }).setupMode, null);
    assert.equal(setup({ onboardingStatus: 'created' }).setupMode, null);
    assert.equal(setup({ rosterUnavailable: true }).setupMode, null);
    assert.equal(setup({ approvalSettled: false }).setupMode, null);
    assert.equal(setup({ teamLoading: true }).setupMode, null);
    assert.equal(setup({ teamError: true }).setupMode, null);
    assert.equal(setup({
      team: [member({ directHotelAccount: null })],
      peopleCount: 1,
    }).setupMode, null);
  });

  test('projects the existing first-person marker through pending and signup completion', () => {
    assert.deepEqual(projectFirstPersonOnboardingState({ invitedEmail: '  OWNER@Example.com ' }, null), {
      status: 'pending',
      invitedEmail: 'owner@example.com',
      accountId: null,
    });
    assert.deepEqual(projectFirstPersonOnboardingState({
      invitedEmail: 'owner@example.com',
      accountCreatedAt: '2026-08-03T00:00:00.000Z',
    }, null), {
      status: 'created',
      invitedEmail: 'owner@example.com',
      accountId: null,
    });
    assert.deepEqual(projectFirstPersonOnboardingState({
      firstPersonAccountId: '55555555-5555-4555-8555-555555555555',
    }, null), {
      status: 'created',
      invitedEmail: null,
      accountId: '55555555-5555-4555-8555-555555555555',
    });
    assert.equal(projectFirstPersonOnboardingState({ invitedEmail: 'owner@example.com' }, '2026-08-03T00:00:00.000Z').status, 'created');
  });

  test('does not leak the previous hotel setup mode when the selected hotel changes', () => {
    const hotelA = setup({ peopleCount: 0, team: [] });
    const hotelB = setup({ peopleCount: 1, team: [member()] });
    assert.equal(hotelA.setupMode, 'first-person');
    assert.equal(hotelB.setupMode, 'hotel-owner-or-gm');
    assert.notEqual(hotelA.setupMode, hotelB.setupMode);
    assert.equal(hotelTeamSetupLabel(hotelB.setupMode), 'Add hotel owner or GM');
  });

  test('keeps every first-person entry point aligned with contextual wording', () => {
    assert.equal(hotelTeamSetupLabel('first-person'), 'Add first person');
    assert.equal(hotelTeamSetupDialogTitle('first-person'), 'Add first person');
    assert.equal(hotelTeamSetupLinkLabel('first-person'), 'First-person onboarding link');
    assert.match(hotelTeamSetupDescription('first-person'), /Assign the role/);

    assert.equal(hotelTeamSetupLabel('hotel-owner-or-gm'), 'Add hotel owner or GM');
    assert.equal(hotelTeamSetupDialogTitle('hotel-owner-or-gm'), 'Add hotel owner or GM');
    assert.equal(hotelTeamSetupLinkLabel('hotel-owner-or-gm'), 'Hotel setup link');
    assert.match(hotelTeamSetupDescription('hotel-owner-or-gm'), /existing People roster unchanged/);
    assert.doesNotMatch(hotelTeamSetupDescription('hotel-owner-or-gm'), /first-person/i);
    assert.equal(
      hotelTeamSetupInvitationError('hotel-owner-or-gm'),
      "Couldn't create the hotel Owner or General Manager invitation.",
    );
    assert.doesNotMatch(hotelTeamSetupInvitationError('hotel-owner-or-gm'), /first-person/i);
  });
});
