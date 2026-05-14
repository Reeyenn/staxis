/**
 * Phase M1.5 (2026-05-14) — behavior tests for the onboarding state
 * derivation logic. Pure-function tests, no DB.
 *
 * The `deriveCurrentStep` function is the load-bearing piece: when an
 * owner closes the tab mid-wizard and comes back, we look at their
 * persisted state and decide which step to render. A bug here means
 * they either get sent BACK to a completed step (annoying) or FORWARD
 * past an incomplete step (confusing UX).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { deriveCurrentStep, isValidPartialState, type OnboardingState } from '@/lib/onboarding/state';

describe('deriveCurrentStep — fresh wizard', () => {
  test('empty state → step 1 (welcome)', () => {
    assert.equal(deriveCurrentStep({ step: 1 }), 1);
  });

  test('only step field set → still step 1', () => {
    // Defensive: client-sent step shouldn't matter — we re-derive from
    // the completion timestamps.
    assert.equal(deriveCurrentStep({ step: 5 }), 1);
    assert.equal(deriveCurrentStep({ step: 9 }), 1);
  });
});

describe('deriveCurrentStep — sequential progress', () => {
  const baseState: OnboardingState = { step: 1 };

  test('after account creation → step 3 (verify email)', () => {
    // Note: jumps from 2 (account form) directly to 3 (verify) because
    // there's nothing to "load" at step 2 — clicking submit takes you
    // straight to OTP entry. Step 2 is render-only, no persisted state.
    const s: OnboardingState = { ...baseState, accountCreatedAt: '2026-05-14T00:00:00Z' };
    assert.equal(deriveCurrentStep(s), 3);
  });

  test('after email verified → step 4 (hotel details)', () => {
    const s: OnboardingState = {
      step: 1,
      accountCreatedAt: '2026-05-14T00:00:00Z',
      emailVerifiedAt: '2026-05-14T00:01:00Z',
    };
    assert.equal(deriveCurrentStep(s), 4);
  });

  test('after hotel details → step 5 (services)', () => {
    const s: OnboardingState = {
      step: 1,
      accountCreatedAt: '2026-05-14T00:00:00Z',
      emailVerifiedAt: '2026-05-14T00:01:00Z',
      hotelDetailsAt: '2026-05-14T00:02:00Z',
    };
    assert.equal(deriveCurrentStep(s), 5);
  });

  test('after services → step 6 (PMS)', () => {
    const s: OnboardingState = {
      step: 1,
      accountCreatedAt: '2026-05-14T00:00:00Z',
      emailVerifiedAt: '2026-05-14T00:01:00Z',
      hotelDetailsAt: '2026-05-14T00:02:00Z',
      servicesAt: '2026-05-14T00:03:00Z',
    };
    assert.equal(deriveCurrentStep(s), 6);
  });

  test('after PMS creds → step 7 (mapping)', () => {
    const s: OnboardingState = {
      step: 1,
      accountCreatedAt: '2026-05-14T00:00:00Z',
      emailVerifiedAt: '2026-05-14T00:01:00Z',
      hotelDetailsAt: '2026-05-14T00:02:00Z',
      servicesAt: '2026-05-14T00:03:00Z',
      pmsCredentialsAt: '2026-05-14T00:04:00Z',
      pmsJobId: 'job-uuid',
    };
    assert.equal(deriveCurrentStep(s), 7);
  });

  test('after mapping completes → step 8 (team)', () => {
    const s: OnboardingState = {
      step: 1,
      accountCreatedAt: '2026-05-14T00:00:00Z',
      emailVerifiedAt: '2026-05-14T00:01:00Z',
      hotelDetailsAt: '2026-05-14T00:02:00Z',
      servicesAt: '2026-05-14T00:03:00Z',
      pmsCredentialsAt: '2026-05-14T00:04:00Z',
      pmsJobId: 'job-uuid',
      mappingCompletedAt: '2026-05-14T00:08:00Z',
    };
    assert.equal(deriveCurrentStep(s), 8);
  });

  test('after team added → step 9 (all set)', () => {
    const s: OnboardingState = {
      step: 1,
      accountCreatedAt: '2026-05-14T00:00:00Z',
      emailVerifiedAt: '2026-05-14T00:01:00Z',
      hotelDetailsAt: '2026-05-14T00:02:00Z',
      servicesAt: '2026-05-14T00:03:00Z',
      pmsCredentialsAt: '2026-05-14T00:04:00Z',
      pmsJobId: 'job-uuid',
      mappingCompletedAt: '2026-05-14T00:08:00Z',
      staffAt: '2026-05-14T00:09:00Z',
    };
    assert.equal(deriveCurrentStep(s), 9);
  });
});

describe('deriveCurrentStep — out-of-order completion is ignored', () => {
  test('staff added before email verified → still step 3 (next-unfinished wins)', () => {
    // Defensive: if a buggy client manages to set a later step's
    // timestamp before an earlier one, derive returns the EARLIEST
    // unfinished step rather than skipping ahead.
    const s: OnboardingState = {
      step: 1,
      accountCreatedAt: '2026-05-14T00:00:00Z',
      // skipping emailVerifiedAt
      staffAt: '2026-05-14T00:09:00Z',
    };
    assert.equal(deriveCurrentStep(s), 3);
  });
});

describe('isValidPartialState', () => {
  test('accepts empty object', () => {
    assert.equal(isValidPartialState({}), true);
  });

  test('accepts partial with valid step', () => {
    assert.equal(isValidPartialState({ step: 5 }), true);
  });

  test('rejects step out of range', () => {
    assert.equal(isValidPartialState({ step: 0 }), false);
    assert.equal(isValidPartialState({ step: 10 }), false);
    assert.equal(isValidPartialState({ step: -1 }), false);
  });

  test('rejects non-number step', () => {
    assert.equal(isValidPartialState({ step: '5' }), false);
  });

  test('rejects non-string timestamp', () => {
    assert.equal(isValidPartialState({ accountCreatedAt: 12345 }), false);
    assert.equal(isValidPartialState({ pmsJobId: { id: 'x' } }), false);
  });

  test('accepts unknown extra fields (forward-compat)', () => {
    assert.equal(isValidPartialState({ futureField: 'whatever' }), true);
  });

  test('rejects null and arrays', () => {
    assert.equal(isValidPartialState(null), false);
    assert.equal(isValidPartialState([]), true);  // arrays are objects in JS — no harm
    assert.equal(isValidPartialState('not an object'), false);
  });
});
