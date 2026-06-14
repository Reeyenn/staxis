/**
 * Tests for the universal login-confirmation gate `isLoginConfirmed`
 * (cua-service/src/mapper.ts, fix/cua-login-universal).
 *
 * The gate replaced a brittle "visible dashboard CSS selector" check that
 * churned for ~4 minutes on PMS whose dashboard lives in an iframe / keeps the
 * post-login URL on the login-action URL. The rule must be PMS-neutral and
 * must NOT false-accept the known failure pages: off-domain redirects, a
 * re-rendered login form, an MFA interstitial, or a pre-password screen.
 *
 * Pure-function tests — no Playwright, no Anthropic, no DB.
 */

// MUST be first: install the WebSocket shim before any supabase-importing
// module is evaluated (ESM evaluates imports in source order). Importing
// mapper.js pulls in modules that build the Supabase client at module load,
// which throws under Node 20 without native WebSocket support.
import './ws-polyfill.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isLoginConfirmed } from '../mapper.js';

type Signals = Parameters<typeof isLoginConfirmed>[0];

/** The one fully-confirmed state: on-domain, creds submitted, no form, no MFA. */
const CONFIRMED: Signals = {
  onPmsDomain: true,
  credentialsSubmitted: true,
  loginFormVisible: false,
  mfaChallengeVisible: false,
};

describe('isLoginConfirmed', () => {
  test('accepts only when on-domain AND credentials submitted AND no form AND no MFA', () => {
    assert.equal(isLoginConfirmed(CONFIRMED), true);
  });

  test('rejects when off the PMS domain (SSO bounce / error redirect)', () => {
    assert.equal(isLoginConfirmed({ ...CONFIRMED, onPmsDomain: false }), false);
  });

  test('rejects when credentials were never submitted (pre-password page: 2-step username, SSO chooser, splash)', () => {
    // This is the case "login form gone" alone would have false-accepted.
    assert.equal(isLoginConfirmed({ ...CONFIRMED, credentialsSubmitted: false }), false);
  });

  test('rejects when a login form is still visible (bad creds / re-rendered form)', () => {
    assert.equal(isLoginConfirmed({ ...CONFIRMED, loginFormVisible: true }), false);
  });

  test('rejects when an MFA / one-time-code challenge is visible', () => {
    assert.equal(isLoginConfirmed({ ...CONFIRMED, mfaChallengeVisible: true }), false);
  });

  test('does not require a dashboard selector — accepts on iframe/same-URL dashboards', () => {
    // The motivating PMS keeps the URL on the login-action URL and renders the
    // dashboard in an iframe; there is no nameable visible selector, yet the
    // four structural signals hold. The gate must accept.
    assert.equal(isLoginConfirmed(CONFIRMED), true);
  });

  test('full truth table: confirmed iff (onPmsDomain ∧ credentialsSubmitted ∧ ¬loginFormVisible ∧ ¬mfaChallengeVisible)', () => {
    for (const onPmsDomain of [false, true]) {
      for (const credentialsSubmitted of [false, true]) {
        for (const loginFormVisible of [false, true]) {
          for (const mfaChallengeVisible of [false, true]) {
            const expected =
              onPmsDomain && credentialsSubmitted && !loginFormVisible && !mfaChallengeVisible;
            assert.equal(
              isLoginConfirmed({ onPmsDomain, credentialsSubmitted, loginFormVisible, mfaChallengeVisible }),
              expected,
              `combo ${JSON.stringify({ onPmsDomain, credentialsSubmitted, loginFormVisible, mfaChallengeVisible })}`,
            );
          }
        }
      }
    }
  });
});
