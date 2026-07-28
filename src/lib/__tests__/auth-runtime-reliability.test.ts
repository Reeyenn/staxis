import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

function section(contents: string, start: string, end: string): string {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing section start: ${start}`);
  assert.ok(endIndex > startIndex, `missing section end: ${end}`);
  return contents.slice(startIndex, endIndex);
}

const auth = source('src', 'contexts', 'AuthContext.tsx');
const supabaseClient = source('src', 'lib', 'supabase.ts');
const boundary = source(
  'src', 'components', 'layout', 'AuthenticatedRuntimeBoundary.tsx',
);
const rootLayout = source('src', 'app', 'layout.tsx');

describe('authenticated runtime hydration', () => {
  test('hung hydration reaches a transient terminal state and stale work cannot end loading', () => {
    assert.match(auth, /const hydrationGeneration = \+\+authEventGenerationRef\.current/);

    const hydration = section(
      auth,
      'void (async () => {',
      '// Subscribe to subsequent auth state changes',
    );
    assert.match(
      hydration,
      /catch \(err\)[\s\S]*?if \(active && !resolved && authEventGenerationRef\.current === hydrationGeneration\)/,
    );
    assert.match(
      hydration,
      /finally[\s\S]*?if \(active && !resolved && authEventGenerationRef\.current === hydrationGeneration\)[\s\S]*?resolved = true;[\s\S]*?setLoading\(false\)/,
    );

    const timeout = section(
      auth,
      'const timeout = setTimeout(() => {',
      'return () => {',
    );
    assert.match(timeout, /if \(!resolved && active\)/);
    assert.match(timeout, /session hydration did not resolve within 10s/);
    assert.match(timeout, /setSessionErrorKind\('transient'\)/);
    assert.match(timeout, /setLoading\(false\)/);
    assert.match(timeout, /10_000/);
    assert.doesNotMatch(
      timeout,
      /setUser\(null\)/,
      'a network timeout is not evidence that the authenticated user ended',
    );
  });

  test('legacy migration owns INITIAL_SESSION(null) until its retryable work settles', () => {
    assert.match(auth, /let legacyMigrationSettled = false/);
    assert.match(
      auth,
      /try \{[\s\S]*?await migrateLegacySessionIfPresent\(\);[\s\S]*?\} finally \{[\s\S]*?legacyMigrationSettled = true/,
    );

    const listener = section(
      auth,
      'supabase.auth.onAuthStateChange((event, session) => {',
      '// Belt-and-suspenders around auth + account hydration',
    );
    const migrationGuard = listener.indexOf(
      "if (event === 'INITIAL_SESSION' && !session?.user && !legacyMigrationSettled) return;",
    );
    const generation = listener.indexOf('const eventGeneration = ++authEventGenerationRef.current;');
    assert.ok(
      migrationGuard >= 0 && generation > migrationGuard,
      'an unauthenticated initial event must not invalidate an in-flight legacy migration',
    );
  });

  test('an account is considered absent only after a confirmed second empty read', () => {
    const accountLoader = section(
      auth,
      'async function loadAppUserUncached(authUid: string)',
      'export function AuthProvider',
    );
    assert.match(accountLoader, /if \(result\.error \|\| !result\.data\)/);
    assert.match(
      accountLoader,
      /if \(result\.error \|\| !result\.data\)[\s\S]*?await new Promise[\s\S]*?result = await fetchRow\(\)/,
    );
    assert.match(accountLoader, /const \{ data, error \} = result;[\s\S]*?if \(error\)[\s\S]*?throw error;[\s\S]*?if \(!data\) return null/);
  });
});

describe('terminal, transient, and retry policy', () => {
  test('revoked sessions and network failures produce different actionable outcomes', () => {
    assert.match(
      auth,
      /refresh_token_not_found\|refresh_token_already_used\|session_not_found\|invalid_grant\|flow_state_not_found/,
    );
    assert.match(
      auth,
      /if \(!sessionReadCompleted && isTerminalSessionHydrationError\(err\)\)[\s\S]*?clearSignedOutBrowserState\(\)[\s\S]*?setSessionErrorKind\('ended'\)[\s\S]*?else[\s\S]*?setSessionErrorKind\('transient'\)/,
    );

    const hydration = section(
      auth,
      'void (async () => {',
      '// Subscribe to subsequent auth state changes',
    );
    const terminal = section(
      hydration,
      'if (!sessionReadCompleted && isTerminalSessionHydrationError(err)) {',
      '} else {',
    );
    assert.match(
      terminal,
      /clearSignedOutBrowserState\(\);[\s\S]*?clearSupabaseBrowserSessionCookies\(\);[\s\S]*?authSessionUidRef\.current = null;[\s\S]*?userRef\.current = null;[\s\S]*?setUser\(null\);[\s\S]*?setSessionErrorKind\('ended'\)/,
      'an authoritative terminal session error must clear both identity snapshots and the persisted cookie',
    );

    const signedOut = section(
      auth,
      "if (event === 'SIGNED_OUT') {",
      'if (!session?.user) {',
    );
    assert.match(signedOut, /const endedDuringHydration = !resolved && !userRef\.current/);
    assert.match(
      signedOut,
      /const terminalReason = terminalSignOutReasonRef\.current;[\s\S]*?terminalSignOutReasonRef\.current = null;[\s\S]*?setSessionError\(terminalReason \?\? \(endedDuringHydration[\s\S]*?setSessionErrorKind\(terminalReason \|\| endedDuringHydration \? 'ended' : null\)/,
      'GoTrue SIGNED_OUT must preserve an account-revocation reason set by the initiating branch',
    );
    assert.match(signedOut, /clearSignedOutBrowserState\(\)/);
    assert.match(signedOut, /userRef\.current = null;[\s\S]*?setUser\(null\)/);
    assert.match(signedOut, /resolved = true;[\s\S]*?setLoading\(false\)/);

    const retry = section(auth, 'const retrySession = React.useCallback(() => {', 'const signIn = async');
    assert.match(
      retry,
      /sessionErrorKind === 'ended'[\s\S]*?clearSignedOutBrowserState\(\)[\s\S]*?clearSupabaseBrowserSessionCookies\(\)[\s\S]*?supabase\.auth\.signOut\(\{ scope: 'local' \}\)[\s\S]*?window\.location\.assign\('\/signin\?reason=session-ended'\)/,
    );
    const loading = retry.indexOf('setLoading(true)');
    const clearError = retry.indexOf('setSessionError(null)', loading);
    const nextAttempt = retry.indexOf('setSessionRetryKey((key) => key + 1)', clearError);
    assert.ok(
      loading >= 0 && clearError > loading && nextAttempt > clearError,
      'retry must synchronously enter a blocking loading state before clearing the error',
    );
  });
});

describe('auth-event ordering and account isolation', () => {
  test('only the latest auth identity may commit an account lookup', () => {
    const listener = section(
      auth,
      'supabase.auth.onAuthStateChange((event, session) => {',
      '// Belt-and-suspenders around auth + account hydration',
    );
    assert.match(listener, /const eventGeneration = \+\+authEventGenerationRef\.current/);
    assert.match(listener, /const uid = session\.user\.id;[\s\S]*?authSessionUidRef\.current = uid/);
    assert.match(
      listener,
      /if \(userRef\.current && userRef\.current\.uid !== uid\) \{[\s\S]*?clearSignedOutBrowserState\(\);[\s\S]*?userRef\.current = null;[\s\S]*?setUser\(null\)/,
    );
    assert.match(listener, /if \(!userRef\.current\) setLoading\(true\)/);
    assert.ok(
      (listener.match(/authEventGenerationRef\.current !== eventGeneration/g) ?? []).length >= 3,
      'queued, completed, and failed account lookups must all reject stale generations',
    );
    assert.match(
      auth,
      /return \(\) => \{[\s\S]*?active = false;[\s\S]*?authEventGenerationRef\.current \+= 1;[\s\S]*?listener\.subscription\.unsubscribe\(\)/,
    );
    assert.match(
      listener,
      /prev\.staffId === appUser\.staffId[\s\S]*?prev\.isDemo === appUser\.isDemo[\s\S]*?JSON\.stringify\(prev\.propertyAccess/,
      'isDemo changes must invalidate the stable user snapshot just like role and property access',
    );
  });

  test('a confirmed empty account lookup fails closed even for an established user', () => {
    const listener = section(
      auth,
      'supabase.auth.onAuthStateChange((event, session) => {',
      '// Belt-and-suspenders around auth + account hydration',
    );
    const confirmedEmpty = section(
      listener,
      '} else {\n            // `loadAppUser` already confirmed the successful empty lookup.',
      '        } catch (err) {',
    );
    assert.doesNotMatch(confirmedEmpty, /if \(!userRef\.current\)/);
    assert.match(
      confirmedEmpty,
      /terminalSignOutReasonRef\.current = unavailableMessage;[\s\S]*?const \{ error: signOutError \} = await supabase\.auth\.signOut\(\);[\s\S]*?if \(signOutFailed\) clearSupabaseBrowserSessionCookies\(\)/,
    );
    assert.match(
      confirmedEmpty,
      /authEventGenerationRef\.current !== eventGeneration[\s\S]*?authSessionUidRef\.current = null;[\s\S]*?userRef\.current = null;[\s\S]*?setUser\(null\);[\s\S]*?setSessionErrorKind\('ended'\);[\s\S]*?setLoading\(false\)/,
    );
  });

  test('eager sign-in cannot reinstall an identity that lost a sign-out or account-switch race', () => {
    const signIn = section(auth, 'const signIn = async', 'const signOut = async');
    assert.match(signIn, /const attemptGeneration = \+\+signInAttemptGenerationRef\.current/);
    assert.match(
      signIn,
      /const accountLoadGeneration = authEventGenerationRef\.current;[\s\S]*?const appUser = await withPromiseDeadline\([\s\S]*?loadAppUser\(data\.user\.id\)[\s\S]*?signInAttemptGenerationRef\.current !== attemptGeneration[\s\S]*?authSessionUidRef\.current !== data\.user\.id[\s\S]*?authSessionRefreshTokenRef\.current !== data\.session\.refresh_token[\s\S]*?return/,
    );
    const staleGuard = signIn.indexOf('signInAttemptGenerationRef.current !== attemptGeneration');
    const commit = signIn.indexOf('setUser(appUser)', staleGuard);
    assert.ok(staleGuard >= 0 && commit > staleGuard, 'identity generation must be checked before eager sign-in commits');

    const ownership = section(auth, 'const isAuthSessionCurrent =', 'const discardAuthSession =');
    assert.match(ownership, /authSessionUidRef\.current === expectedSession\.user\.id/);
    assert.match(ownership, /authSessionRefreshTokenRef\.current === expectedSession\.refresh_token/);
    const discard = section(auth, 'const discardAuthSession =', 'const signIn = async');
    assert.match(discard, /if \(!isAuthSessionCurrent\(expectedSession\)\) return false/);
    assert.match(discard, /clearSupabaseBrowserSessionCookies\(\)/);
    assert.doesNotMatch(discard, /clearSupabaseSessionBounded|revoke-trust|supabase\.auth\.signOut\(/);
  });

  test('all authoritative session endings remove account-scoped browser selection', () => {
    const cleanup = section(
      auth,
      'function clearSignedOutBrowserState(): void {',
      'function isTerminalSessionHydrationError',
    );
    assert.match(cleanup, /sessionStorage\.removeItem\('hotelops-session-selected'\)/);
    assert.match(cleanup, /sessionStorage\.removeItem\(RESUME_GUARD_KEY\)/);
    assert.match(cleanup, /localStorage\.removeItem\('hotelops-account'\)/);
    assert.match(cleanup, /localStorage\.removeItem\('staxis-auth'\)/);
    assert.match(cleanup, /localStorage\.removeItem\('hotelops-active-property'\)/);
    assert.match(
      cleanup,
      /sessionStorage[\s\S]*?\} catch \{[\s\S]*?try \{[\s\S]*?localStorage/,
      'blocked sessionStorage must not prevent local property cleanup',
    );

    const initialNoSession = section(
      auth,
      '} else {\n          clearSignedOutBrowserState();',
      '}\n      } catch (err)',
    );
    assert.match(initialNoSession, /userRef\.current = null;[\s\S]*?setUser\(null\)/);

    const explicitSignOut = section(auth, 'const signOut = async () => {', 'return (');
    assert.match(
      explicitSignOut,
      /^const signOut = async \(\) => \{\n\s*signInAttemptGenerationRef\.current \+= 1;\n\s*authEventGenerationRef\.current \+= 1;[\s\S]*?authSessionUidRef\.current = null;[\s\S]*?authSessionRefreshTokenRef\.current = null;[\s\S]*?userRef\.current = null;[\s\S]*?clearSignedOutBrowserState\(\)/,
      'sign-out must invalidate deferred identity work before its first await',
    );
    assert.match(
      explicitSignOut,
      /await clearSupabaseSessionBounded\(\);[\s\S]*?setUser\(null\)/,
      'a failed remote revoke must still durably remove the local browser session',
    );
    const boundedCleanup = section(
      auth,
      'async function clearSupabaseSessionBounded(): Promise<void> {',
      'function isTerminalSessionHydrationError',
    );
    assert.match(boundedCleanup, /withPromiseDeadline\([\s\S]*?supabase\.auth\.signOut\(\)/);
    assert.match(boundedCleanup, /finally \{\s*clearSupabaseBrowserSessionCookies\(\)/);
    assert.match(boundedCleanup, /supabase\.auth\.signOut\(\{ scope: 'local' \}\)/);

    assert.match(
      supabaseClient,
      /filter\(\(name\) => name === authCookiePrefix \|\| name\.startsWith\(`\$\{authCookiePrefix\}\.\`\)\)/,
    );
    assert.match(
      supabaseClient,
      /document\.cookie = `\$\{name\}=; Path=\/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`/,
      'both the base Supabase cookie and chunk cookies must be expired at the origin root',
    );
  });
});

describe('protected-route runtime boundary', () => {
  test('errors and retry hydration mask children until auth reaches a terminal state', () => {
    assert.match(rootLayout, /<AuthenticatedRuntimeBoundary>[\s\S]*?\{children\}/);
    assert.match(boundary, /const \{ user, loading, sessionError, sessionErrorKind, retrySession \} = useAuth\(\)/);

    const errorState = boundary.indexOf('if (protectedRoute && sessionError)');
    const loadingState = boundary.indexOf('if (protectedRoute && loading)', errorState);
    const missingUserState = boundary.indexOf('if (protectedRoute && !user)', loadingState);
    const children = boundary.indexOf('return children', missingUserState);
    assert.ok(
      errorState >= 0
      && loadingState > errorState
      && missingUserState > loadingState
      && children > missingUserState,
    );
    assert.match(boundary, /sessionErrorKind === 'ended' \? 'Sign in again' : 'Try again'/);
    assert.match(boundary, /<RouteLoadingState title="Confirming your session…"/);
    assert.match(
      boundary,
      /if \(protectedRoute && !user\)[\s\S]*?title="Sign in to continue"[\s\S]*?reason: 'session-ended'/,
      'protected routes must terminate at an actionable signed-out state instead of rendering cached children',
    );
  });
});
