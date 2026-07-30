import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveCurrentStep,
  isValidPartialState,
  isOnboardingInProgress,
  isOnboardingForAccount,
  shouldResumeOnboarding,
  resolveOnboardingDisplayStep,
  type OnboardingState,
} from '@/lib/onboarding/state';

const accountCreatedAt = '2026-07-30T12:00:00Z';
const emailVerifiedAt = '2026-07-30T12:01:00Z';
const hotelDetailsAt = '2026-07-30T12:02:00Z';
const hotelContextAt = '2026-07-30T12:03:00Z';

describe('resolveOnboardingDisplayStep — safe early-step review', () => {
  test('Welcome and Account can be reviewed without rewinding progress', () => {
    assert.equal(resolveOnboardingDisplayStep(3, 2), 2);
    assert.equal(resolveOnboardingDisplayStep(3, 1), 1);
    assert.equal(resolveOnboardingDisplayStep(3, null), 3);
  });

  test('review never advances past durable progress', () => {
    assert.equal(resolveOnboardingDisplayStep(1, 2), 1);
    assert.equal(resolveOnboardingDisplayStep(2, 2), 2);
  });
});

describe('deriveCurrentStep — exact six-stage flow', () => {
  test('Welcome is step 1 and its explicit Begin hop is step 2', () => {
    assert.equal(deriveCurrentStep({ step: 1 }), 1);
    assert.equal(deriveCurrentStep({ step: 2 }), 2);
    assert.equal(deriveCurrentStep({ step: 6 }), 1);
  });

  test('account creation advances to Verify email', () => {
    assert.equal(deriveCurrentStep({ step: 2, accountCreatedAt }), 3);
  });

  test('verification advances to About your hotel', () => {
    assert.equal(deriveCurrentStep({ step: 3, accountCreatedAt, emailVerifiedAt }), 4);
  });

  test('hotel details advance directly to Your hotel', () => {
    assert.equal(deriveCurrentStep({
      step: 4,
      accountCreatedAt,
      emailVerifiedAt,
      hotelDetailsAt,
    }), 5);
  });

  test('optional hotel context advances to All set', () => {
    assert.equal(deriveCurrentStep({
      step: 5,
      accountCreatedAt,
      emailVerifiedAt,
      hotelDetailsAt,
      hotelContextAt,
    }), 6);
  });

  test('legacy PMS, mapping, and team markers are inert', () => {
    const state: OnboardingState = {
      step: 6,
      accountCreatedAt,
      emailVerifiedAt,
      hotelDetailsAt,
      pmsCredentialsAt: 'legacy',
      pmsJobId: 'legacy',
      mappingCompletedAt: 'legacy',
      pmsSkippedAt: 'legacy',
      staffAt: 'legacy',
      servicesAt: 'legacy',
      pmsOtherName: 'legacy',
    };
    assert.equal(deriveCurrentStep(state), 5);
    assert.equal(deriveCurrentStep({ ...state, hotelContextAt }), 6);
  });
});

describe('isValidPartialState — client-owned markers only', () => {
  test('accepts the six-stage client markers', () => {
    assert.equal(isValidPartialState({}), true);
    assert.equal(isValidPartialState({ step: 2 }), true);
    assert.equal(isValidPartialState({ accountCreatedAt }), true);
    assert.equal(isValidPartialState({ emailVerifiedAt }), true);
    assert.equal(isValidPartialState({ hotelDetailsAt }), true);
    assert.equal(isValidPartialState({ hotelContextAt }), true);
  });

  test('rejects steps outside 1..6', () => {
    assert.equal(isValidPartialState({ step: 0 }), false);
    assert.equal(isValidPartialState({ step: 7 }), false);
    assert.equal(isValidPartialState({ step: 9 }), false);
  });

  test('rejects database-owned invite identity', () => {
    assert.equal(isValidPartialState({ invitedEmail: 'owner@example.com' }), false);
    assert.equal(isValidPartialState({ firstPersonAccountId: 'account-id' }), false);
  });

  test('rejects obsolete onboarding PMS/mapping/team writes', () => {
    assert.equal(isValidPartialState({ pmsCredentialsAt: 'legacy' }), false);
    assert.equal(isValidPartialState({ pmsJobId: 'legacy' }), false);
    assert.equal(isValidPartialState({ mappingCompletedAt: 'legacy' }), false);
    assert.equal(isValidPartialState({ pmsSkippedAt: 'legacy' }), false);
    assert.equal(isValidPartialState({ staffAt: 'legacy' }), false);
    assert.equal(isValidPartialState({ servicesAt: 'legacy' }), false);
    assert.equal(isValidPartialState({ pmsOtherName: 'legacy' }), false);
  });

  test('rejects malformed and unbounded values', () => {
    assert.equal(isValidPartialState({ accountCreatedAt: 123 }), false);
    assert.equal(isValidPartialState({ hotelContextAt: 'a'.repeat(201) }), false);
    assert.equal(isValidPartialState({ sneaky: 'value' }), false);
    assert.equal(isValidPartialState(null), false);
    assert.equal(isValidPartialState([]), false);
  });
});

describe('first-person resume identity', () => {
  const firstPersonAccountId = '00000000-0000-4000-8000-000000000001';
  const laterManagerAccountId = '00000000-0000-4000-8000-000000000002';
  const bound: OnboardingState = {
    step: 4,
    invitedEmail: 'gm@example.com',
    firstPersonAccountId,
    accountCreatedAt,
    emailVerifiedAt,
  };

  test('an incomplete started hotel is in progress', () => {
    assert.equal(isOnboardingInProgress(null, bound), true);
    assert.equal(isOnboardingInProgress('2026-07-30T13:00:00Z', bound), false);
    assert.equal(isOnboardingInProgress(null, { step: 1 }), false);
  });

  test('only the bound account owns new-flow setup', () => {
    assert.equal(isOnboardingForAccount(firstPersonAccountId, null, bound), true);
    assert.equal(isOnboardingForAccount(laterManagerAccountId, null, bound), false);
  });

  test('retained unbound records preserve manager resume compatibility', () => {
    const legacy: OnboardingState = { step: 4, accountCreatedAt, emailVerifiedAt };
    assert.equal(isOnboardingForAccount(firstPersonAccountId, null, legacy), true);
  });

  test('Owner and GM first people resume, later people and staff do not', () => {
    assert.equal(
      shouldResumeOnboarding(firstPersonAccountId, 'owner', null, bound, null),
      true,
    );
    assert.equal(
      shouldResumeOnboarding(firstPersonAccountId, 'general_manager', null, bound, null),
      true,
    );
    assert.equal(
      shouldResumeOnboarding(laterManagerAccountId, 'general_manager', null, bound, null),
      false,
    );
    assert.equal(
      shouldResumeOnboarding(firstPersonAccountId, 'front_desk', null, bound, null),
      false,
    );
  });

  test('completion and one-shot prompt suppress resume', () => {
    assert.equal(
      shouldResumeOnboarding(
        firstPersonAccountId,
        'owner',
        '2026-07-30T13:00:00Z',
        bound,
        null,
      ),
      false,
    );
    assert.equal(
      shouldResumeOnboarding(
        firstPersonAccountId,
        'owner',
        null,
        bound,
        '2026-07-30T12:30:00Z',
      ),
      false,
    );
  });
});
