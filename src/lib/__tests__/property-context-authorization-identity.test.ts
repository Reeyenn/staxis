import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const propertyContext = readFileSync(
  join(process.cwd(), 'src', 'contexts', 'PropertyContext.tsx'),
  'utf8',
);
const propertySelector = readFileSync(
  join(process.cwd(), 'src', 'app', '(hotel)', 'property-selector', 'page.tsx'),
  'utf8',
);
const apiResourceHook = readFileSync(
  join(process.cwd(), 'src', 'lib', 'hooks', 'use-api-resource.ts'),
  'utf8',
);
const authorizationRefreshHook = readFileSync(
  join(process.cwd(), 'src', 'lib', 'hooks', 'use-authorization-refresh-key.ts'),
  'utf8',
);
const companyPage = readFileSync(
  join(process.cwd(), 'src', 'app', 'company', 'page.tsx'),
  'utf8',
);
const companyInvitationPage = readFileSync(
  join(process.cwd(), 'src', 'app', '(public)', 'company-invite', '[token]', 'page.tsx'),
  'utf8',
);

function section(start: string, end: string): string {
  const startIndex = propertyContext.indexOf(start);
  const endIndex = propertyContext.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing section start: ${start}`);
  assert.ok(endIndex > startIndex, `missing section end: ${end}`);
  return propertyContext.slice(startIndex, endIndex);
}

describe('PropertyContext authorization identity', () => {
  test('same-UID account replacement, role, or property grants mask prior snapshots', () => {
    assert.match(
      propertyContext,
      /const userPropertyAccessKey = \[\.\.\.\(user\?\.propertyAccess \?\? \[\]\)\]\.sort\(\)\.join\(','\)/,
    );
    assert.match(
      propertyContext,
      /const propertyAuthorizationIdentityKey = userUid && userAccountId[\s\S]*?`\$\{userUid\}:\$\{userAccountId\}:\$\{userRole \?\? 'unknown'\}:\$\{userPropertyAccessKey\}:\$\{actingAuthorizationKey\}`/,
    );
    assert.match(propertyContext, /useAuthorizationRefreshKey\([\s\S]*?propertyAuthorizationIdentityKey/);
    assert.match(
      propertyContext,
      /propertiesViewerUid === userUid[\s\S]*?propertiesAuthorizationViewerKey === propertyAuthorizationViewerKey[\s\S]*?\? properties[\s\S]*?: \[\]/,
    );
    assert.match(
      propertyContext,
      /propertiesErrorViewerUid === userUid[\s\S]*?propertiesErrorAuthorizationViewerKey === propertyAuthorizationViewerKey/,
    );

    const load = section('const loadUserUid = userUid;', 'const retryProperties = useCallback');
    assert.match(load, /const loadViewerKey = propertyAuthorizationViewerKey/);
    assert.match(load, /setPropertiesAuthorizationViewerKey\(loadViewerKey\)/);
    assert.match(load, /setPropertiesErrorAuthorizationViewerKey\(loadViewerKey\)/);
    assert.match(
      propertyContext,
      /\}, \[[\s\S]*?propertyAuthorizationViewerKey,[\s\S]*?propertiesRetryKey,[\s\S]*?authFlowActive,[\s\S]*?portfolioScopeQuiescent,[\s\S]*?actingHotelId,[\s\S]*?\]\)/,
    );
    assert.match(
      propertyContext,
      /propertyAuthorizationViewerKeyRef\.current !== refreshViewerKey/,
      'an old refresh must not mutate a newly authorized same-UID snapshot',
    );
  });

  test('protected hotel reads stay quiescent throughout the password and OTP routes', () => {
    assert.match(
      propertyContext,
      /const authFlowActive = pathname === '\/signin' \|\| pathname\.startsWith\('\/signin\/'\)/,
    );
    const load = section(
      'useEffect(() => {\n    if (!userUid || !propertyAuthorizationViewerKey || authFlowActive || portfolioScopeQuiescent)',
      'const retryProperties = useCallback',
    );
    assert.match(load, /setProperties\(\[\]\)/);
    assert.match(load, /setPropertiesError\(null\)/);
    assert.match(load, /setLoading\(false\)/);
    assert.match(
      load,
      /\[[\s\S]*?propertyAuthorizationViewerKey,[\s\S]*?propertiesRetryKey,[\s\S]*?authFlowActive,[\s\S]*?portfolioScopeQuiescent,[\s\S]*?actingHotelId,[\s\S]*?\]/,
    );
  });

  test('permission retries share one absolute ten-second load budget', () => {
    const load = section('const loadDeadlineAt = Date.now()', 'const retryProperties = useCallback');
    assert.equal((load.match(/const loadDeadlineAt =/g) ?? []).length, 1);
    assert.match(load, /Date\.now\(\) \+ PROPERTY_CONTEXT_TIMEOUT_MS/);
    assert.match(load, /const remainingMs = Math\.floor\(loadDeadlineAt - Date\.now\(\)\)/);
    assert.match(load, /remainingMs <= 0[\s\S]*?new RequestTimeoutError\('Hotel access', PROPERTY_CONTEXT_TIMEOUT_MS\)/);
    assert.match(
      load,
      /const read = loadActingHotelId[\s\S]*?getProperty\(loadUserUid, loadActingHotelId\)[\s\S]*?: getProperties\(loadUserUid\)[\s\S]*?withPromiseDeadline\(read, \{[\s\S]*?timeoutMs: remainingPropertyLoadBudgetMs\(\)/,
    );
    assert.match(
      load,
      /new Promise<void>\(\(resolve\) => setTimeout\(resolve, delay\)\)[\s\S]*?timeoutMs: remainingPropertyLoadBudgetMs\(\)/,
    );
    assert.match(load, /return loadProps\(retries - 1\)/);
    assert.doesNotMatch(
      load,
      /withPromiseDeadline\(getProperties\(loadUserUid\), \{[\s\S]{0,120}?timeoutMs: PROPERTY_CONTEXT_TIMEOUT_MS/,
    );
  });

  test('authorization stamping never re-filters server-resolved company hats', () => {
    const load = section('const loadProps = async', 'const retryProperties = useCallback');
    assert.match(load, /getProperties\(loadUserUid\)/);
    assert.match(load, /setProperties\(props\)/);
    assert.match(load, /legacy array UNION every live hat/);
    assert.doesNotMatch(load, /props\.filter|filter\([^)]*propertyAccess/);
  });

  test('selecting the already-active hotel preserves capability readiness', () => {
    const selection = section(
      'const setActivePropertyId = useCallback',
      '// Cross-tab sync',
    );
    const sameHotelGuard = selection.indexOf('if (id === activePropertyId)');
    const snapshotClear = selection.indexOf('setCapabilitySnapshot(null)');

    assert.ok(sameHotelGuard >= 0, 'same-hotel selection must have an explicit no-op path');
    assert.ok(snapshotClear > sameHotelGuard, 'same-hotel return must happen before capability reset');
    assert.match(
      selection.slice(sameHotelGuard, snapshotClear),
      /if \(id === activePropertyId\)[\s\S]*?return;/,
    );
    assert.match(selection, /\}, \[activePropertyId, actingHotelId\]\);/);
  });

  test('the property selector invalidates stale coverage on same-UID authorization changes', () => {
    assert.match(
      propertySelector,
      /authorizationIdentityKey = user[\s\S]*?user\.uid[\s\S]*?user\.accountId[\s\S]*?user\.role[\s\S]*?\[\.\.\.user\.propertyAccess\]\.sort\(\)\.join\(','\)/,
    );
    assert.match(propertySelector, /identityKey: authorizationViewerKey \?\? 'signed-out'/);
    assert.match(apiResourceHook, /identityKey\?: string \| number \| null/);
    assert.match(apiResourceHook, /\[enabled, sourceKey, identityKey, load, commitIdentityState\]/);
  });

  test('live company-hat coverage is revalidated at browser restore and recovery boundaries', () => {
    assert.match(authorizationRefreshHook, /AUTHORIZATION_CHANGED_EVENT = 'staxis:authorization-changed'/);
    assert.match(authorizationRefreshHook, /document\.addEventListener\('visibilitychange', onVisibilityChange\)/);
    assert.match(authorizationRefreshHook, /window\.addEventListener\('focus', onFocus\)/);
    assert.match(authorizationRefreshHook, /window\.addEventListener\('online', onOnline\)/);
    assert.match(authorizationRefreshHook, /event\.persisted/);
    assert.match(authorizationRefreshHook, /onAuthorizationChanged = \(\) => requestRefresh\(true\)/);
    assert.match(authorizationRefreshHook, /setRevision\(\(value\) => value \+ 1\)/);
    assert.match(
      propertyContext,
      /const activePropertyViewerKey = userUid && userAccountId && resolvedPropertyId[\s\S]*?const expectedStaffViewerKey = activePropertyViewerKey/,
    );
    assert.match(
      propertyContext,
      /const expectedCapabilityViewerKey = activePropertyViewerKey/,
    );
    assert.match(propertyContext, /activePropertyViewerKey,/);
  });

  test('same-tab access lifecycle writes explicitly invalidate authorization coverage', () => {
    assert.match(companyInvitationPage, /notifyAuthorizationChanged\(\);[\s\S]*?replace\('\/company'\)/);
    assert.match(
      companyPage,
      /const completeAccessMutation = React\.useCallback\(\(\) => \{[\s\S]*?notifyAuthorizationChanged\(\);[\s\S]*?setRetryKey/,
    );
    assert.equal((companyPage.match(/onCompleted=\{completeAccessMutation\}/g) ?? []).length, 3);
    assert.match(companyPage, /onStructureChanged=\{completeAccessMutation\}/);
    assert.match(companyPage, /onAccessChanged=\{completeAccessMutation\}/);
  });
});
