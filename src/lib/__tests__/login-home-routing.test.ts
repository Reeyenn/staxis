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

const signin = source('src', 'app', '(public)', 'signin', 'page.tsx');
const verify = source('src', 'app', '(public)', 'signin', 'verify', 'page.tsx');
const selector = source('src', 'app', '(hotel)', 'property-selector', 'page.tsx');
const home = source('src', 'app', '(hotel)', 'home', 'page.tsx');
const onboard = source('src', 'app', '(public)', 'onboard', 'page.tsx');
const authContext = source('src', 'contexts', 'AuthContext.tsx');
const rootLayout = source('src', 'app', 'layout.tsx');
const reliableNavigation = source('src', 'lib', 'hooks', 'use-reliable-navigation.ts');
const signinNavigationPolicy = source('src', 'lib', 'auth', 'signin-navigation-policy.ts');

describe('ordinary hotel login defaults to Home', () => {
  test('trusted/existing sessions use Home as the safe fallback', () => {
    assert.match(signin, /ordinaryRequestedTarget = safeRedirect\(rawRedirect, '\/home'\)/);
    assert.match(signin, /const replaceNavigation = navigation\.replace/);
    assert.match(signin, /replaceNavigation\(redirectTarget\)/);
  });

  test('multi-property and admin sessions must select a hotel first', () => {
    assert.match(signinNavigationPolicy, /input\.user\.role === 'admin'/);
    assert.match(signinNavigationPolicy, /input\.user\.propertyAccess\.includes\('\*'\)/);
    assert.match(signinNavigationPolicy, /input\.user\.propertyAccess\.length !== 1/);
    assert.match(signinNavigationPolicy, /\/property-selector/);
    assert.match(signin, /user: result\.user[\s\S]*?authenticatedRedirectTarget/);
  });

  test('OTP keeps protected redirects, selecting a hotel except for Company targets', () => {
    assert.match(signin, /rawRedirect = params\.get\('redirect'\)/);
    assert.match(signin, /&redirect=\$\{encodeURIComponent\(rawRedirect\)\}/);
    assert.match(verify, /ordinaryRequestedTarget = safeRedirect\(rawRedirect, '\/home'\)/);
    assert.match(verify, /isPropertyIndependentCompanyTarget\s*\? requestedTarget/);
    assert.match(verify, /`\/property-selector\?redirect=\$\{encodeURIComponent\(requestedTarget\)\}`/);
    assert.match(verify, /data\.session\s*\? redirectTarget/);
    assert.match(verify, /const replaceNavigation = navigation\.replace/);
    assert.match(verify, /replaceNavigation\(redirectTarget\)/);
  });

  test('new signups still pass through setup/property selection', () => {
    assert.match(verify, /postSignup \|\| requestedTarget === '\/home'/);
    assert.match(verify, /\? '\/property-selector'/);
  });

  test('selection opens Home by default and only then honors a deep link', () => {
    assert.match(selector, /safeRedirect\(new URLSearchParams\(window\.location\.search\)\.get\('redirect'\), '\/home'\)/);
    assert.match(selector, /const replaceNavigation = navigation\.replace/);
    assert.match(selector, /replaceNavigation\(requestedTarget\)/);
  });
});

describe('auth funnel navigation reliability', () => {
  test('trusted, OTP, and hotel-selection transitions arm the persistent watchdog', () => {
    assert.match(signin, /useReliableNavigation\(\)/);
    assert.match(signin, /replaceNavigation\(verifyUrl\)/);
    assert.doesNotMatch(signin, /router\.(?:push|replace)\(/);

    assert.match(verify, /useNavigationReady\(\)/);
    assert.match(verify, /useReliableNavigation\(\)/);
    assert.match(verify, /replaceNavigation\(redirectTarget\)/);
    assert.doesNotMatch(verify, /router\.(?:push|replace)\(/);

    assert.match(selector, /useNavigationReady\(\)/);
    assert.match(selector, /useReliableNavigation\(\)/);
    assert.match(selector, /replaceNavigation\('\/company'\)/);
    assert.doesNotMatch(selector, /router\.(?:push|replace)\(/);
    assert.match(selector, /window\.location\.assign\(`\/api\/onboard\/resume/);
  });

  test('the pre-session trust read owns an explicit request-and-body deadline', () => {
    assert.match(signin, /fetchWithAuth\('\/api\/auth\/check-trust'/);
    assert.match(
      signin,
      /fetchWithAuth\('\/api\/auth\/check-trust',[\s\S]*?method: 'POST',[\s\S]*?Authorization: `Bearer \$\{accessToken\}`[\s\S]*?timeoutMs: AUTH_OPERATION_TIMEOUT_MS/,
    );
    const trustRead = signin.slice(
      signin.indexOf("fetchWithAuth('/api/auth/check-trust'"),
      signin.indexOf("console.warn('check-trust failed'"),
    );
    assert.match(trustRead, /await res\.json\(\)/);
  });

  test('a failed explicit password attempt cannot ride a newer auth event into the app', () => {
    assert.match(signin, /const explicitAttemptStartedRef = useRef\(false\)/);
    assert.match(
      signin,
      /shouldAutoRedirectExistingSession\(\{[\s\S]*?explicitAttemptStarted: explicitAttemptStartedRef\.current[\s\S]*?hasUser: Boolean\(user\)[\s\S]*?replaceNavigation\(redirectTarget\)/,
    );
    assert.match(
      signin,
      /submitInFlightRef\.current = true;[\s\S]*?explicitAttemptStartedRef\.current = true/,
    );
    assert.match(
      signin,
      /if \(trusted\) \{[\s\S]*?if \(!isAuthSessionCurrent\(passwordSession\)\)[\s\S]*?replaceNavigation\(authenticatedRedirectTarget\)/,
    );
    assert.doesNotMatch(signin, /explicitAttemptStartedRef\.current = false/);
  });

  test('an ambiguous password result requires a full fresh-sign-in boundary', () => {
    assert.match(authContext, /err instanceof AmbiguousSessionOperationError/);
    assert.match(authContext, /signInRecoveryRequiredRef\.current = true/);
    assert.match(
      authContext,
      /if \(signInRecoveryRequiredRef\.current\)[\s\S]*?requiresFreshSignin: true[\s\S]*?if \(signInInFlightRef\.current\)/,
    );
    assert.match(signin, /if \(result\.requiresFreshSignin\) \{[\s\S]*?setRequiresFreshSignin\(true\)/);
    assert.match(signin, /const freshSigninHref = rawRedirect[\s\S]*?'\/signin\?reason=auth-retry'/);
    assert.match(signin, /href=\{freshSigninHref\}/);
    assert.match(signin, /disabled=\{signing \|\| requiresFreshSignin \|\| !freshRecovery\.ready\}/);
    assert.match(signin, /window\.location\.replace\(freshSigninHref\)/);
    assert.match(signin, /freshRetry: isFreshRetry/);
    assert.match(signin, /resetLocalSession: resetForFreshSignIn/);
    assert.match(signin, /await freshRecovery\.resetBeforeSubmit\(\)[\s\S]*?explicitAttemptStartedRef\.current = true/);
    assert.match(authContext, /const resetForFreshSignIn = React\.useCallback[\s\S]*?clearSupabaseBrowserSessionCookies\(\)/);
    assert.match(
      signin,
      /requiresFreshSignin \? \([\s\S]*?<a href="\/signin\/forgot"[\s\S]*?: \([\s\S]*?<Link href="\/signin\/forgot"/,
    );
    assert.match(
      signin,
      /requiresFreshSignin \? \([\s\S]*?<a href="\/signup"[\s\S]*?: \([\s\S]*?<Link href="\/signup"/,
    );
  });

  test('OTP verification, device trust, and session refresh all reach a terminal state', () => {
    assert.match(
      verify,
      /fetchWithDeadline\([\s\S]*?'\/api\/auth\/2fa-status'[\s\S]*?timeoutMs: AUTH_OPERATION_TIMEOUT_MS/,
    );
    assert.match(
      verify,
      /withPromiseDeadline\([\s\S]*?supabase\.auth\.getSession\(\)[\s\S]*?timeoutMs: AUTH_OPERATION_TIMEOUT_MS/,
    );
    assert.match(
      verify,
      /const verificationOperation = supabase\.auth\.verifyOtp\([\s\S]*?settleSessionOperation\(verificationOperation,[\s\S]*?timeoutMs: AUTH_SESSION_OPERATION_TIMEOUT_MS[\s\S]*?discardLateSession: discardAuthSession/,
    );
    assert.match(
      verify,
      /fetchWithAuth\('\/api\/auth\/trust-device',[\s\S]*?Authorization: `Bearer \$\{ownedSession\.access_token\}`[\s\S]*?timeoutMs: AUTH_OPERATION_TIMEOUT_MS/,
    );
    assert.match(
      verify,
      /const refreshOperation = supabase\.auth\.refreshSession\(\{[\s\S]*?refresh_token: ownedSession\.refresh_token[\s\S]*?settleSessionOperation\([\s\S]*?refreshOperation[\s\S]*?timeoutMs: AUTH_SESSION_OPERATION_TIMEOUT_MS[\s\S]*?discardLateSession: discardAuthSession/,
    );
    assert.match(verify, /if \(!refreshData\.session\) throw new Error\('Secure session refresh returned no session'\)/);
    assert.match(verify, /refreshData\.session\.user\.id !== ownedSession\.user\.id[\s\S]*?!isAuthSessionCurrent\(refreshData\.session\)/);
    assert.match(verify, /catch \(err\)[\s\S]*?enterFreshSigninRecovery\(/);
    assert.match(verify, /submitInFlightRef\.current \|\| requiresFreshSignin/);
    assert.match(verify, /resendInFlightRef\.current/);
    assert.match(
      verify,
      /const enterFreshSigninRecovery = \(message: string\) => \{[\s\S]*?window\.location\.replace\(freshSigninHref\)/,
    );
    assert.ok(
      (verify.match(/enterFreshSigninRecovery\(/g) ?? []).length >= 4,
      'every consumed-code/session-ownership terminal path must replace the document',
    );
    assert.match(verify, /requiresFreshSignin \? \([\s\S]*?href=\{freshSigninHref\}/);
  });
});

describe('Home safety boundaries', () => {
  test('signed-out and property-less sessions are resolved before the shell renders', () => {
    const homePage = home.slice(home.indexOf('export default function HomePage()'));
    // Home routes from ONE pure decision now (resolveHomeEntry). The behaviour
    // of that decision is exercised directly in company-mode-scope.test.ts; what
    // this file pins is that the page still wires every terminal state to it and
    // never renders a shell before the decision is terminal.
    assert.match(homePage, /const entry = resolveHomeEntry\(\{/);
    assert.match(homePage, /const replaceNavigation = navigation\.replace/);
    assert.match(homePage, /if \(entry\.kind === 'signin'\) \{[\s\S]*?replaceNavigation\('\/signin'\)/);
    assert.match(homePage, /if \(entry\.kind === 'property_selector'\) replaceNavigation\('\/property-selector'\)/);
    assert.match(home, /const portfolio = usePortfolio\(\)/);
    assert.match(homePage, /if \(entry\.kind === 'wait'\) return <RouteLoadingState title="Opening Home…"/);
    assert.match(homePage, /entry\.kind === 'signin'[\s\S]*?<RouteLoadingState title="Returning to Sign In…"/);
    assert.match(homePage, /entry\.kind === 'property_selector'[\s\S]*?properties\.length === 0[\s\S]*?<RouteLoadingState title="Opening your workspace…"/);
    // The redirect into the standalone portfolio world is gone for good.
    assert.doesNotMatch(homePage, /portfolioDestination/);
    assert.doesNotMatch(homePage, /'\/portfolio\/choose'/);
    assert.match(rootLayout, /<ReliableNavigationProvider>[\s\S]*?\{children\}/);
    assert.match(
      reliableNavigation,
      /createElement\(NavigationFailurePortal,[\s\S]*?onOpenDirectly: openDirectly/,
    );
    assert.doesNotMatch(homePage, /return null/);
  });

  test('unfinished onboarding is guarded per property, not globally', () => {
    assert.match(home, /shouldResumeOnboarding\(user\.accountId, user\.role, activeProperty\.onboardingCompletedAt, activeProperty\.onboardingState, activeProperty\.onboardingPromptShownAt\)/);
    assert.match(home, /try \{[\s\S]*?sessionStorage\.getItem\(RESUME_GUARD_KEY\) === activeProperty\.id[\s\S]*?sessionStorage\.setItem\(RESUME_GUARD_KEY, activeProperty\.id\)[\s\S]*?\} catch \{ return; \}/);
    assert.match(home, /\/api\/onboard\/resume\?propertyId=/);
  });

  test('sign-out clears the onboarding loop breaker', () => {
    assert.match(authContext, /sessionStorage\.removeItem\(RESUME_GUARD_KEY\)/);
    assert.match(authContext, /event === 'SIGNED_OUT'[\s\S]*clearSignedOutBrowserState\(\)/);
  });

  test('completed onboarding exits to Home in both completion branches', () => {
    assert.match(onboard, /if \(data\.completed\)[\s\S]*push\('\/home'\)/);
    assert.match(onboard, /window\.location\.href = '\/home'/);
  });
});
