import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  shouldAutoRedirectExistingSession,
  signInRedirectTarget,
} from '@/lib/auth/signin-navigation-policy';

describe('Sign In navigation ownership', () => {
  test('an existing session may leave Sign In before an explicit submit starts', () => {
    assert.equal(shouldAutoRedirectExistingSession({
      handoffResolved: true,
      explicitAttemptStarted: false,
      freshRetry: false,
      loading: false,
      hasUser: true,
      signing: false,
    }), true);
  });

  test('a newer auth event cannot redirect after the submitted attempt fails', () => {
    // Attempt A has finished with an error (`signing:false`). Meanwhile an
    // auth event for Session B committed a user. The explicit-attempt latch is
    // intentionally permanent for this page lifetime, so B cannot bypass the
    // trust/OTP decision belonging to A.
    assert.equal(shouldAutoRedirectExistingSession({
      handoffResolved: true,
      explicitAttemptStarted: true,
      freshRetry: false,
      loading: false,
      hasUser: true,
      signing: false,
    }), false);
  });

  test('loading and active submission both remain non-terminal', () => {
    assert.equal(shouldAutoRedirectExistingSession({
      handoffResolved: true,
      explicitAttemptStarted: false,
      freshRetry: false,
      loading: true,
      hasUser: true,
      signing: false,
    }), false);
    assert.equal(shouldAutoRedirectExistingSession({
      handoffResolved: true,
      explicitAttemptStarted: false,
      freshRetry: false,
      loading: false,
      hasUser: true,
      signing: true,
    }), false);
  });

  test('an auth-retry document never auto-enters a late existing session', () => {
    assert.equal(shouldAutoRedirectExistingSession({
      handoffResolved: true,
      explicitAttemptStarted: false,
      freshRetry: true,
      loading: false,
      hasUser: true,
      signing: false,
    }), false);
  });

  test('a cold trusted admin or multi-hotel result selects a hotel using the returned user', () => {
    assert.equal(signInRedirectTarget({
      user: { role: 'admin', propertyAccess: ['*'] },
      requestedTarget: '/home',
      propertyIndependent: false,
    }), '/property-selector');
    assert.equal(signInRedirectTarget({
      user: { role: 'owner', propertyAccess: ['hotel-A', 'hotel-B'] },
      requestedTarget: '/inventory',
      propertyIndependent: false,
    }), '/property-selector?redirect=%2Finventory');
  });

  test('single-hotel and property-independent Company targets remain direct', () => {
    assert.equal(signInRedirectTarget({
      user: { role: 'manager', propertyAccess: ['hotel-A'] },
      requestedTarget: '/staff',
      propertyIndependent: false,
    }), '/staff');
    assert.equal(signInRedirectTarget({
      user: { role: 'admin', propertyAccess: ['*'] },
      requestedTarget: '/company',
      propertyIndependent: true,
    }), '/company');
  });
});
