/**
 * Post-login routing contract.
 *
 * These source-level assertions cover the client navigation branches that are
 * difficult to exercise in the Node-only suite. They intentionally lock the
 * product rule and its safety boundaries together:
 *   - one selected hotel + ordinary login -> Home
 *   - multi-hotel/admin -> choose a hotel, then Home
 *   - protected deep links survive, but open only after hotel selection
 *   - incomplete onboarding resumes per property
 *   - signed-out/zero-access users never see a cached or inert Home shell
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const signin = source('src', 'app', 'signin', 'page.tsx');
const verify = source('src', 'app', 'signin', 'verify', 'page.tsx');
const selector = source('src', 'app', 'property-selector', 'page.tsx');
const home = source('src', 'app', 'home', 'page.tsx');
const onboard = source('src', 'app', 'onboard', 'page.tsx');
const authContext = source('src', 'contexts', 'AuthContext.tsx');

describe('ordinary hotel login defaults to Home', () => {
  test('trusted/existing sessions use Home as the safe fallback', () => {
    assert.match(signin, /safeRedirect\(params\.get\('redirect'\), '\/home'\)/);
    assert.match(signin, /router\.replace\(redirectTarget\)/);
  });

  test('multi-property and admin sessions must select a hotel first', () => {
    assert.match(signin, /user\.role === 'admin'/);
    assert.match(signin, /user\.propertyAccess\.includes\('\*'\)/);
    assert.match(signin, /user\.propertyAccess\.length !== 1/);
    assert.match(signin, /\/property-selector/);
  });

  test('OTP keeps a protected redirect and resolves through property selection', () => {
    assert.match(signin, /rawRedirect = params\.get\('redirect'\)/);
    assert.match(signin, /&redirect=\$\{encodeURIComponent\(rawRedirect\)\}/);
    assert.match(verify, /safeRedirect\(params\.get\('redirect'\), '\/home'\)/);
    assert.match(verify, /`\/property-selector\?redirect=\$\{encodeURIComponent\(requestedTarget\)\}`/);
    assert.match(verify, /router\.replace\(data\.session \? redirectTarget : '\/signin'\)/);
    assert.match(verify, /router\.replace\(redirectTarget\)/);
  });

  test('new signups still pass through setup/property selection', () => {
    assert.match(verify, /postSignup \|\| requestedTarget === '\/home'/);
    assert.match(verify, /\? '\/property-selector'/);
  });

  test('selection opens Home by default and only then honors a deep link', () => {
    assert.match(selector, /safeRedirect\(new URLSearchParams\(window\.location\.search\)\.get\('redirect'\), '\/home'\)/);
    assert.match(selector, /router\.replace\(requestedTarget\)/);
  });
});

describe('Home safety boundaries', () => {
  test('signed-out and zero-access sessions are redirected before the shell renders', () => {
    assert.match(home, /if \(!user\) router\.replace\('\/signin'\)/);
    assert.match(home, /else if \(!activeProperty\) router\.replace\('\/property-selector'\)/);
    assert.match(home, /if \(authLoading \|\| propertyLoading \|\| !user \|\| !activeProperty\) return null/);
  });

  test('unfinished onboarding is guarded per property, not globally', () => {
    assert.match(home, /shouldResumeOnboarding\(user\.role, activeProperty\.onboardingCompletedAt, activeProperty\.onboardingState, activeProperty\.onboardingPromptShownAt\)/);
    assert.match(home, /sessionStorage\.getItem\(RESUME_GUARD_KEY\) !== activeProperty\.id/);
    assert.match(home, /sessionStorage\.setItem\(RESUME_GUARD_KEY, activeProperty\.id\)/);
    assert.match(home, /\/api\/onboard\/resume\?propertyId=/);
  });

  test('sign-out clears the onboarding loop breaker', () => {
    assert.match(authContext, /sessionStorage\.removeItem\(RESUME_GUARD_KEY\)/);
    assert.match(authContext, /event === 'SIGNED_OUT'[\s\S]*clearSignedOutBrowserState\(\)/);
  });

  test('completed onboarding exits to Home in both completion branches', () => {
    assert.match(onboard, /if \(data\.completed\)[\s\S]*router\.push\('\/home'\)/);
    assert.match(onboard, /window\.location\.href = '\/home'/);
  });
});
