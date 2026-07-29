import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  isStaleDeploymentChunkError,
  reloadOnceWithSessionGuard,
  STALE_CHUNK_RECOVERY_PARAM,
  staleChunkRecoveryKey,
} from '@/lib/stale-chunk-recovery';

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

const propertyContext = source('src', 'contexts', 'PropertyContext.tsx');
const capabilityHook = source('src', 'lib', 'capabilities', 'useCan.ts');
const inventoryPage = source('src', 'app', 'inventory', 'page.tsx');
const inventoryShell = source('src', 'app', 'inventory', '_components', 'InventoryShell.tsx');
const financialsPage = source('src', 'app', 'financials', 'page.tsx');
const appLoading = source('src', 'app', 'loading.tsx');
const appError = source('src', 'app', 'error.tsx');
const globalError = source('src', 'app', 'global-error.tsx');
const rootLayout = source('src', 'app', 'layout.tsx');
const authenticatedBoundary = source(
  'src', 'components', 'layout', 'AuthenticatedRuntimeBoundary.tsx',
);
const resourceState = source(
  'src', 'components', 'layout', 'RouteResourceState.tsx',
);
const concourse = source('src', 'components', 'concourse', 'ConcourseBar.tsx');
const reliableNavigation = source(
  'src', 'lib', 'hooks', 'use-reliable-navigation.ts',
);
const concourseView = source(
  'src', 'components', 'concourse', 'ConcourseBarView.tsx',
);
const mobileConcourse = source(
  'src', 'components', 'concourse', 'MobileConcourseNav.tsx',
);
const homeHubView = source(
  'src', 'components', 'concourse', 'HomeHubView.tsx',
);
const appLayout = source('src', 'components', 'layout', 'AppLayout.tsx');
const maintenancePage = source('src', 'app', 'maintenance', 'page.tsx');
const maintenancePrimitives = source(
  'src', 'app', 'maintenance', '_components', '_mt-snow.tsx',
);
const housekeepingPage = source('src', 'app', 'housekeeping', 'page.tsx');
const housekeeperPage = source('src', 'app', 'housekeeper', '[id]', 'page.tsx');
const dashboardPage = source('src', 'app', 'dashboard', 'page.tsx');
const roomsDb = source('src', 'lib', 'db', 'rooms.ts');
const propertySelectorPage = source('src', 'app', 'property-selector', 'page.tsx');
const toldKnowledge = source(
  'src', 'components', 'concourse', 'ToldKnowledge.tsx',
);
const toldApi = source('src', 'components', 'concourse', 'told-api.ts');
const adminIndex = source('src', 'app', 'admin', 'page.tsx');

describe('authenticated route destinations', () => {
  test('the canonical admin return route resolves instead of landing on a 404', () => {
    assert.match(adminIndex, /redirect\('\/admin\/properties'\)/);
  });
});

describe('property and capability readiness', () => {
  test('capability lookup has explicit loading, ready, and fail-closed error states', () => {
    assert.match(
      propertyContext,
      /export type CapabilityOverridesStatus = 'idle' \| 'loading' \| 'ready' \| 'error'/,
    );

    const fetchOverrides = section(
      propertyContext,
      'async function fetchOverridesFor(',
      'export function PropertyProvider(',
    );
    assert.match(fetchOverrides, /if \(error\) throw error/);
    assert.match(fetchOverrides, /if \(!token\) throw new Error/);
    assert.match(fetchOverrides, /if \(!res\.ok\) throw new Error/);
    assert.match(fetchOverrides, /if \(!json\?\.data[\s\S]*?throw new Error/);
    assert.doesNotMatch(fetchOverrides, /return \{\}/);

    assert.match(
      propertyContext,
      /const exposedCapabilitySnapshot = capabilitySnapshot[\s\S]*?capabilitySnapshot\.viewerKey === expectedCapabilityViewerKey[\s\S]*?capabilitySnapshot\.propertyId === resolvedPropertyId/,
    );
    assert.match(
      propertyContext,
      /const capabilityOverrides = exposedCapabilitySnapshot\?\.status === 'ready'[\s\S]*?: EMPTY_CAPABILITY_OVERRIDES/,
    );
    assert.match(
      propertyContext,
      /const capabilityOverridesViewerKey = exposedCapabilitySnapshot\?\.status === 'ready'[\s\S]*?: null/,
    );
    assert.match(
      propertyContext,
      /const capabilityOverridesPropertyId = exposedCapabilitySnapshot\?\.status === 'ready'[\s\S]*?: null/,
    );

    const capabilityEffect = section(
      propertyContext,
      '// Load the active hotel\'s capability overrides',
      'const refreshCapabilities = useCallback(',
    );
    const normalLoad = capabilityEffect.slice(capabilityEffect.indexOf('let cancelled = false;'));
    const loading = normalLoad.indexOf("status: 'loading'");
    const request = normalLoad.indexOf('fetchOverridesFor(resolvedPropertyId)');
    const ready = normalLoad.indexOf("status: 'ready'", request);
    const failure = normalLoad.indexOf("status: 'error'", ready);
    assert.ok(loading >= 0 && request > loading && ready > request && failure > ready);
    assert.match(
      normalLoad,
      /catch \(err\)[\s\S]*?expectedCapabilityViewerKeyRef\.current === expectedCapabilityViewerKey[\s\S]*?overrides: EMPTY_CAPABILITY_OVERRIDES,[\s\S]*?status: 'error'/,
    );
  });

  test('capability retry stays scoped to the viewer and hotel captured before the request', () => {
    const refresh = section(
      propertyContext,
      'const refreshCapabilities = useCallback(',
      'const refreshProperty = async',
    );
    const viewerCapture = refresh.indexOf('const viewerKey = expectedCapabilityViewerKey;');
    const propertyCapture = refresh.indexOf('const propertyId = resolvedPropertyId;');
    const loading = refresh.indexOf("status: 'loading'");
    const request = refresh.indexOf('fetchOverridesFor(propertyId)');
    assert.ok(viewerCapture >= 0 && propertyCapture > viewerCapture && loading > propertyCapture && request > loading);
    assert.equal(
      (refresh.match(/if \(expectedCapabilityViewerKeyRef\.current !== viewerKey\) return;/g) ?? []).length,
      2,
      'both success and failure must discard a response for a stale viewer/property scope',
    );
    assert.match(refresh, /status: 'ready',[\s\S]*?error: null/);
    assert.match(refresh, /catch \(err\)[\s\S]*?status: 'error'/);
  });

  test('ready, delayed, and failed capability reads add zero full-page wait after hotel reach', () => {
    const main = section(
      appLayout,
      '<main className="cx-swap"',
      '<div className="staxis-feedback-slot">',
    );
    assert.match(main, /propertiesError[\s\S]*?<RouteErrorState/);
    assert.match(main, /sectionOff[\s\S]*?children/);
    assert.doesNotMatch(main, /capabilityOverridesStatus/);
    assert.doesNotMatch(appLayout, /Checking hotel access/);
    assert.equal(
      (main.match(/RouteLoadingState|setTimeout|setInterval|withPromiseDeadline|\bsleep\b/g) ?? []).length,
      0,
      'the authorized-page branch must contain no capability-driven wait mechanism',
    );

    const capabilityNotice = section(
      appLayout,
      "activeProperty && capabilityOverridesStatus === 'error'",
      '<main className="cx-swap"',
    );
    assert.match(capabilityNotice, /role="alert"/);
    assert.match(capabilityNotice, /Some actions are unavailable/);
    assert.match(capabilityNotice, /onClick=\{\(\) => void refreshCapabilities\(\)\}/);
    assert.match(capabilityNotice, /minHeight: 44/);
  });

  test('ordinary pathname navigation starts no additional capability request', () => {
    const capabilityEffect = section(
      propertyContext,
      '// Load the active hotel\'s capability overrides',
      'const refreshCapabilities = useCallback(',
    );
    assert.equal(
      (capabilityEffect.match(/fetchOverridesFor\(resolvedPropertyId\)/g) ?? []).length,
      1,
      'one viewer/hotel effect run starts exactly one background override request',
    );
    const capabilityDependencies = capabilityEffect.slice(capabilityEffect.lastIndexOf('}, ['));
    assert.match(
      capabilityDependencies,
      /resolvedPropertyId, expectedCapabilityViewerKey, activeOnboardingInProgress/,
    );
    assert.doesNotMatch(
      capabilityDependencies,
      /pathname/,
      'moving between ordinary authenticated pages must not refetch capability overrides',
    );

    const refresh = section(
      propertyContext,
      'const refreshCapabilities = useCallback(',
      'const refreshProperty = async',
    );
    assert.equal(
      (refresh.match(/fetchOverridesFor\(propertyId\)/g) ?? []).length,
      1,
      'an explicit retry starts exactly one new bounded request',
    );
  });

  test('delayed, failed, revoked, and retry states remain fail-closed for restricted actions', () => {
    assert.match(
      capabilityHook,
      /capabilityOverridesStatus === 'ready'[\s\S]*?capabilityOverridesPropertyId === activePropertyId[\s\S]*?capabilityOverridesViewerKey === viewerKey/,
    );
    assert.match(
      capabilityHook,
      /ready[\s\S]*?standing\.ready[\s\S]*?can\(role \? \{ role \} : null, capability, capabilityOverrides\)/,
    );

    const capabilityEffect = section(
      propertyContext,
      '// Load the active hotel\'s capability overrides',
      'const refreshCapabilities = useCallback(',
    );
    assert.match(
      capabilityEffect,
      /withPromiseDeadline\(fetchOverridesFor\(resolvedPropertyId\), \{[\s\S]*?timeoutMs: PROPERTY_CONTEXT_TIMEOUT_MS/,
    );
    assert.match(capabilityEffect, /catch \(err\)[\s\S]*?status: 'error'/);

    const refresh = section(
      propertyContext,
      'const refreshCapabilities = useCallback(',
      'const refreshProperty = async',
    );
    assert.match(refresh, /status: 'loading'[\s\S]*?withPromiseDeadline\(fetchOverridesFor\(propertyId\)/);
    assert.match(refresh, /status: 'ready'[\s\S]*?catch \(err\)[\s\S]*?status: 'error'/);

    assert.match(
      propertyContext,
      /const exposedProperties = propertiesViewerUid === userUid[\s\S]*?propertiesAuthorizationViewerKey === propertyAuthorizationViewerKey[\s\S]*?\? properties[\s\S]*?: \[\]/,
      'revoked or replaced authorization must mask retained hotel reach immediately',
    );
    assert.match(
      propertyContext,
      /const activeProperty = exposedProperties\.find\(p => p\.id === activePropertyId\) \?\? null/,
      'protected hotel content must derive only from the viewer-stamped reach snapshot',
    );
  });

  test('Inventory renders ordinary stock workflows without waiting on capability overrides', () => {
    const loading = inventoryPage.indexOf('if (loading) return <InventoryLoading />;');
    const noProperty = inventoryPage.indexOf('if (!activePropertyId) {', loading);
    const content = inventoryPage.indexOf('<InventoryShell key={activePropertyId} />', noProperty);
    assert.ok(
      loading >= 0
      && noProperty > loading
      && content > noProperty,
    );
    assert.match(
      inventoryPage.slice(noProperty, content),
      /<RouteErrorState[\s\S]*?No hotel is selected[\s\S]*?push\('\/property-selector'\)/,
    );
    assert.doesNotMatch(inventoryPage, /capabilityOverridesStatus|refreshCapabilities/);
    assert.doesNotMatch(inventoryPage, /loading \|\| !activePropertyId/);
    assert.match(
      inventoryShell,
      /const inventoryViewerContextReady = Boolean\([\s\S]*?activeProperty\?\.id === activePropertyId[\s\S]*?\);/,
    );
    assert.match(
      inventoryShell,
      /const inventoryContextReady = Boolean\([\s\S]*?inventoryViewerContextReady[\s\S]*?capabilityOverridesPropertyId === activePropertyId/,
    );
    assert.match(inventoryShell, /const canManage = inventoryContextReady && can\('manage_inventory_orders'\)/);
    assert.match(
      inventoryShell,
      /inventoryFinancialDataEnabled\(\{[\s\S]*?contextReady: inventoryContextReady/,
    );
    assert.match(
      inventoryShell,
      /if \(!uid \|\| !activePropertyId \|\| !inventoryViewerContextReady\) return;[\s\S]*?subscribeToInventory/,
    );
    assert.doesNotMatch(
      inventoryShell,
      /if \(!inventoryDataMatchesViewer \|\| !revealed \|\| !itemsLoaded \|\| !bundleLoaded\)/,
      'a later money-capability refresh must not hide an already revealed stock board',
    );
  });

  test('Financials renders its familiar shell before capability-dependent data', () => {
    const shellHeader = financialsPage.indexOf('<h1 style');
    const accessGate = financialsPage.indexOf(
      '{!authorizationContextReady || !accessContextReady ? (',
      shellHeader,
    );
    const summary = financialsPage.indexOf('{/* Summary tiles */}', accessGate);
    assert.ok(shellHeader >= 0 && accessGate > shellHeader && summary > accessGate);
    assert.match(
      financialsPage.slice(accessGate, summary),
      /Financial access could not be confirmed[\s\S]*Checking financial access for this hotel/,
    );
    assert.match(financialsPage, /enabled: !!activePropertyId && allowed/);
    assert.match(financialsPage, /const allowed = accessContextReady[\s\S]*authorizationContextReady/);
  });
});

describe('route loading and error recovery', () => {
  test('root route boundaries render accessible loading and retryable terminal states', () => {
    assert.match(appLoading, /<RouteLoadingState[\s\S]*?Opening this page/);
    assert.match(resourceState, /role="status"[\s\S]*?aria-busy="true"/);
    assert.match(resourceState, /role="alert"[\s\S]*?<button[^>]*onClick=\{onRetry\}/);

    for (const boundary of [appError, globalError]) {
      assert.match(boundary, /isStaleDeploymentChunkError\(error\)/);
      assert.match(boundary, /reloadOnceWithSessionGuard\(\{[\s\S]*?fallbackParam: STALE_CHUNK_RECOVERY_PARAM[\s\S]*?getSessionStorage: \(\) => window\.sessionStorage[\s\S]*?location: window\.location/);
      assert.match(boundary, /retryLabel=\{staleChunk \? 'Reload latest version' : 'Try again'\}/);
      assert.match(boundary, /onRetry=\{staleChunk \? \(\) => window\.location\.reload\(\) : reset\}/);
    }
    assert.match(globalError, /<html lang="en">[\s\S]*?<body/);
    assert.match(rootLayout, /<AuthenticatedRuntimeBoundary>[\s\S]*?\{children\}/);
    assert.match(
      authenticatedBoundary,
      /protectedRoute && sessionError[\s\S]*?<RouteErrorState[\s\S]*?onRetry=\{retrySession\}/,
    );
  });

  test('stale deployment chunks are distinguished from ordinary failures and keyed by route', () => {
    const named = new Error('obsolete asset');
    named.name = 'ChunkLoadError';
    assert.equal(isStaleDeploymentChunkError(named), true);
    assert.equal(isStaleDeploymentChunkError(new Error('Loading chunk 781 failed')), true);
    assert.equal(
      isStaleDeploymentChunkError(new TypeError('Failed to fetch dynamically imported module')),
      true,
    );
    assert.equal(isStaleDeploymentChunkError(new Error('Importing a module script failed')), true);
    assert.equal(
      isStaleDeploymentChunkError(new TypeError('Error loading dynamically imported module: https://example.test/chunk.js')),
      true,
    );
    assert.equal(
      isStaleDeploymentChunkError(new TypeError('Failed to load module script: Expected a JavaScript-or-Wasm module script')),
      true,
    );
    assert.equal(isStaleDeploymentChunkError(new Error('Request timed out')), false);

    const error = new Error('Loading chunk 781 failed');
    const first = staleChunkRecoveryKey('/inventory', error);
    assert.equal(first, staleChunkRecoveryKey('/inventory', error));
    assert.notEqual(first, staleChunkRecoveryKey('/staff', error));
    assert.notEqual(first, staleChunkRecoveryKey('/inventory', new Error('Loading chunk 782 failed')));
  });

  test('reload recovery remains one-shot when sessionStorage is blocked', () => {
    const key = 'staxis-chunk-recovery:/inventory:123';
    let replacedUrl = '';
    let reloads = 0;
    const location = {
      href: 'https://getstaxis.com/inventory?tab=stock',
      reload: () => { reloads += 1; },
      replace: (url: string) => { replacedUrl = url; },
    };
    const blockedStorage = () => { throw new DOMException('blocked', 'SecurityError'); };

    assert.equal(reloadOnceWithSessionGuard({
      key,
      fallbackParam: STALE_CHUNK_RECOVERY_PARAM,
      getSessionStorage: blockedStorage,
      location,
    }), true);
    assert.equal(reloads, 0);
    assert.equal(new URL(replacedUrl).searchParams.get(STALE_CHUNK_RECOVERY_PARAM), key);

    location.href = replacedUrl;
    replacedUrl = '';
    assert.equal(reloadOnceWithSessionGuard({
      key,
      fallbackParam: STALE_CHUNK_RECOVERY_PARAM,
      getSessionStorage: blockedStorage,
      location,
    }), false);
    assert.equal(replacedUrl, '');
    assert.equal(reloads, 0);
  });

});

describe('Concourse navigation reliability', () => {
  test('prefetch occurs only on pointer, focus, or touch intent', () => {
    assert.equal((reliableNavigation.match(/router\.prefetch\(/g) ?? []).length, 1);
    assert.doesNotMatch(concourse, /PREFETCHED_THIS_SESSION|hrefs\.forEach|SECTION_LIST\.map\(\(m\) => m\.navHref\)/);
    assert.match(reliableNavigation, /const prefetch = useCallback\(\(href: string\) => \{[\s\S]*?router\.prefetch\(href\)/);
    assert.match(concourse, /onIntent: \(\) => prefetch\(href\)/);
    assert.match(
      concourse,
      /onGearIntent=\{\(\) => prefetch\(portfolioScoped \? companyHref : '\/settings'\)\}/,
    );
    assert.match(concourseView, /onPointerEnter=\{it\.onIntent\}[\s\S]*?onFocus=\{it\.onIntent\}/);
    assert.match(concourseView, /onPointerEnter=\{onLogoIntent\}[\s\S]*?onFocus=\{onLogoIntent\}/);
    assert.match(mobileConcourse, /onPointerDown=\{item\.onIntent\}[\s\S]*?onFocus=\{item\.onIntent\}/);
    assert.match(homeHubView, /onPointerEnter=\{tile\.onIntent\}[\s\S]*?onPointerDown=\{tile\.onIntent\}[\s\S]*?onFocus=\{tile\.onIntent\}/);
  });

  test('a destination that commits its URL but never renders keeps a root-owned fallback', () => {
    assert.match(reliableNavigation, /export const NAVIGATION_COMMIT_TIMEOUT_MS = 8_000/);
    assert.match(
      reliableNavigation,
      /if \(!pending\) return;[\s\S]*?window\.setTimeout\([\s\S]*?setFailure\([\s\S]*?pending[\s\S]*?NAVIGATION_COMMIT_TIMEOUT_MS[\s\S]*?window\.clearTimeout\(timeout\)[\s\S]*?\[pending\]/,
    );
    assert.doesNotMatch(
      reliableNavigation,
      /useEffect\(\(\) => \{[\s\S]{0,180}?setPending\(null\)[\s\S]{0,120}?\}, \[pathname\]\)/,
      'pathname commit alone must not dismiss the watchdog',
    );
    assert.match(reliableNavigation, /router\[mode\]\(href\)/);
    assert.match(reliableNavigation, /pendingRef\.current\?\.href === href[\s\S]*?!failureRef\.current/);
    assert.match(reliableNavigation, /navigate\(failure\.href, failure\.mode, true\)/);
    assert.match(reliableNavigation, /window\.location\.assign\(failure\.href\)/);
    assert.match(
      reliableNavigation,
      /targetPathname\(current\.href\) !== readyPathname[\s\S]*?clearPending\(\)/,
    );
    assert.match(
      reliableNavigation,
      /export function useNavigationReady[\s\S]*?markReady\(pathname\)/,
    );
    assert.match(
      reliableNavigation,
      /document\.addEventListener\('click', onDocumentClick, true\)[\s\S]*?document\.removeEventListener\('click', onDocumentClick, true\)/,
      'secondary Next Links must arm the persistent watchdog too',
    );
    assert.match(
      reliableNavigation,
      /if \(url\.pathname === window\.location\.pathname\) return;/,
      'same-route query/hash links cannot wait for a pathname readiness event that will never fire',
    );
    assert.match(
      reliableNavigation,
      /const onPopState = \(\) => \{[\s\S]*?armNavigation\(destination, 'replace', 'history'\)[\s\S]*?addEventListener\('popstate'/,
      'back/forward destinations must receive the same persistent watchdog',
    );
    assert.match(
      reliableNavigation,
      /createElement\(NavigationFailurePortal,[\s\S]*?onRetry: retry[\s\S]*?onOpenDirectly: openDirectly/,
    );
    assert.doesNotMatch(reliableNavigation, /dismissFailure/);
    assert.doesNotMatch(resourceState, /onDismiss|toastDismiss|aria-label=\{es \? 'Cerrar' : 'Dismiss'\}/);
    assert.match(
      rootLayout,
      /<ReliableNavigationProvider>[\s\S]*?<PropertyProvider>[\s\S]*?<AuthenticatedRuntimeBoundary>/,
    );
    assert.match(appLayout, /useNavigationReady\(\)/);
    assert.match(propertySelectorPage, /useNavigationReady\(\)/);
    assert.doesNotMatch(appLoading, /useNavigationReady/);
    assert.match(resourceState, /This page is taking too long/);
    assert.match(resourceState, /Try again[\s\S]*?Open directly/);
  });
});

describe('authenticated shell and property-switch isolation', () => {
  test('property readiness is stamped to the viewer before redirect guards can run', () => {
    assert.match(propertyContext, /const \[propertiesErrorViewerUid, setPropertiesErrorViewerUid\]/);
    assert.match(
      propertyContext,
      /const exposedPropertiesLoading = !portfolioScopeQuiescent && \(loading \|\| Boolean\([\s\S]*?propertiesViewerUid !== userUid[\s\S]*?propertiesErrorViewerUid !== userUid/,
    );
    assert.match(
      propertyContext,
      /propertiesAuthorizationViewerKey !== propertyAuthorizationViewerKey[\s\S]*?propertiesErrorAuthorizationViewerKey !== propertyAuthorizationViewerKey/,
    );
    assert.match(
      propertyContext,
      /const retryProperties = useCallback\(\(\) => \{[\s\S]*?setLoading\(true\);[\s\S]*?setPropertiesErrorViewerUid\(null\);[\s\S]*?setPropertiesRetryKey/,
    );
    assert.match(propertyContext, /loading: exposedPropertiesLoading/);
    assert.match(propertyContext, /propertiesError: exposedPropertiesError/);
  });

  test('AppLayout omits global auto-translation and legacy worker cleanup', () => {
    assert.doesNotMatch(`${rootLayout}\n${appLayout}`, /GlobalAutoTranslate/);
    assert.doesNotMatch(appLayout, /navigator\.serviceWorker|getRegistrations\(|\.unregister\(/);
    assert.doesNotMatch(appLayout, /window\.caches|hotelops-v1|firebase-messaging-sw/);
    assert.doesNotMatch(
      appLayout,
      /staxis-legacy-worker-recovery|LEGACY_WORKER_RECOVERY_PARAM|reloadOnceWithSessionGuard|location\.reload/,
    );
    assert.equal(existsSync(join(process.cwd(), 'public', 'sw.js')), false);
    assert.match(
      housekeeperPage,
      /serviceWorker\.register\('\/sw-housekeeper\.js', \{ scope: '\/housekeeper\/' \}\)/,
    );
  });

  test('maintenance photos settle on signed-link and image transport failures', () => {
    const storageImage = maintenancePrimitives.slice(
      maintenancePrimitives.indexOf('export function StorageImage('),
    );
    assert.match(
      storageImage,
      /withPromiseDeadline\([\s\S]*?createSignedUrl\(path, 60 \* 5\)[\s\S]*?timeoutMs: STORAGE_IMAGE_URL_TIMEOUT_MS/,
    );
    assert.match(storageImage, /catch \{[\s\S]*?status: 'error'/);
    assert.match(storageImage, /<img[\s\S]*?onError=\{\(\) => \{[\s\S]*?status: 'error'/);
  });

  test('Knows document uploads have a terminal transport deadline', () => {
    assert.match(
      toldKnowledge,
      /put: \(signedUrl, contentType\) => putSigned\(signedUrl, file, contentType\)/,
    );
    assert.match(
      toldApi,
      /export async function putSigned[\s\S]*?fetchWithDeadline\([\s\S]*?timeoutMs: 60_000/,
    );
    assert.doesNotMatch(toldApi, /const res = await fetch\(signedUrl/);
  });

  test('Maintenance and Housekeeping remount property-owned state on hotel changes', () => {
    assert.match(maintenancePage, /key=\{`\$\{activePropertyId\}:\$\{tab\}`\}/);
    assert.match(housekeepingPage, /key=\{`\$\{activePropertyId\}:\$\{activeTab\}`\}/);
    assert.match(
      housekeepingPage,
      /<HousekeepingSetup[\s\S]*?key=\{activeProperty\.id\}[\s\S]*?propertyId=\{activeProperty\.id\}/,
    );
  });

  test('Dashboard snapshots synchronously mask every previous-hotel data source', () => {
    for (const [name, rowType] of [
      ['rooms', 'Room'],
      ['workOrders', 'WorkOrder'],
      ['complaints', 'Complaint'],
    ] as const) {
      const title = `${name[0].toUpperCase()}${name.slice(1)}`;
      assert.match(
        dashboardPage,
        new RegExp(`const \\[${name}Snapshot, set${title}Snapshot\\] = useState\\(\\(\\) => emptyScopedFeed<${rowType}>\\(\\)\\)`),
      );
      assert.match(
        dashboardPage,
        new RegExp(`scopedFeedView\\(${name}Snapshot, activePropertyId, today\\)`),
      );
      assert.match(
        dashboardPage,
        new RegExp(`set${title}Snapshot\\(\\(previous\\) => beginScopedFeed\\(previous, propertyId, date\\)\\)`),
      );
      assert.match(
        dashboardPage,
        new RegExp(`set${title}Snapshot\\(publishScopedFeed\\(propertyId, date, rows\\)\\)`),
      );
      assert.match(
        dashboardPage,
        new RegExp(`set${title}Snapshot\\(\\(previous\\) => failScopedFeed\\(previous, propertyId, date\\)\\)`),
      );
    }
    assert.match(
      dashboardPage,
      /const \[countsSnapshot, setCountsSnapshot\] = useState<\{ propertyId: string \| null; date: string \| null; value: TodayPropertyCounts \| null \}>/,
    );
    assert.match(
      dashboardPage,
      /const counts = countsSnapshot\.propertyId === activePropertyId && countsSnapshot\.date === today[\s\S]*?\? countsSnapshot\.value[\s\S]*?: null/,
    );
    assert.match(
      dashboardPage,
      /const countsSnapshotRef = useRef\(countsSnapshot\);[\s\S]*?countsSnapshotRef\.current = countsSnapshot/,
    );
    assert.match(dashboardPage, /setCountsSnapshot\(\{ propertyId, date, value: null \}\)/);
    assert.match(
      dashboardPage,
      /previous\.propertyId === propertyId && previous\.date === date \? previous\.value : null/,
    );
    assert.match(dashboardPage, /fetchTodayPropertyCounts\(propertyId, date, \{ throwOnError: true \}\)/);
    assert.match(dashboardPage, /const currentRequest = \+\+requestSequence[\s\S]*?currentRequest !== requestSequence/);
    assert.match(dashboardPage, /const countsUnavailable = !counts/);
    assert.match(
      dashboardPage,
      /\{\(countsUnavailable \|\| countsError\) && \([\s\S]*?role=\{countsError \? 'alert' : 'status'\}[\s\S]*?Showing last-known values\.[\s\S]*?Loading room summary…[\s\S]*?setCountsRetryKey\(\(key\) => key \+ 1\)/,
    );
    assert.match(
      dashboardPage,
      /const hasLastGoodAtStart = previousSnapshot\.propertyId === propertyId[\s\S]*?previousSnapshot\.date === date[\s\S]*?previousSnapshot\.value !== null[\s\S]*?if \(!hasLastGoodAtStart\)/,
    );
    assert.doesNotMatch(dashboardPage, /\|\| hasLastGood/);
    assert.match(
      dashboardPage,
      /const operationalFeedsCurrent = roomsFeed\.hasSnapshot[\s\S]*?workOrdersFeed\.hasSnapshot[\s\S]*?complaintsFeed\.hasSnapshot/,
    );
    assert.match(
      dashboardPage,
      /role=\{operationalFeedsFailed \? 'alert' : 'status'\}[\s\S]*?Loading live operational details…[\s\S]*?setOperationalRetryKey\(\(key\) => key \+ 1\)/,
    );
    assert.match(
      dashboardPage,
      /const housekeepingValue:[\s\S]*?!roomsFeed\.hasSnapshot[\s\S]*?const housekeepingSub = roomsFeed\.error/,
    );
    assert.match(
      dashboardPage,
      /const attentionBadge = operationalFeedsCurrent[\s\S]*?\? `\$\{attnTotal\}\+`[\s\S]*?: '—'/,
    );
    assert.match(
      dashboardPage,
      /\{operationalFeedsCurrent\s*\? \(ES \? 'Todo en orden\.' : 'All clear — nothing needs you right now\.'\)/,
    );
    assert.doesNotMatch(dashboardPage, /const \[rooms, setRooms\]|const \[workOrders, setWorkOrders\]|const \[complaints, setComplaints\]/);
  });

  test('Dashboard rollover rejects every stale-date room and counts publication', () => {
    assert.match(
      dashboardPage,
      /const dashboardScopeRef = useRef\(\{ propertyId: activePropertyId, date: today \}\);[\s\S]*?dashboardScopeRef\.current = \{ propertyId: activePropertyId, date: today \}/,
    );
    assert.match(
      dashboardPage,
      /subscribeToRooms\(user\.uid, propertyId, date, \(rows\) => \{[\s\S]*?currentScope\.propertyId !== propertyId \|\| currentScope\.date !== date\) return;[\s\S]*?setRoomsSnapshot\(publishScopedFeed\(propertyId, date, rows\)\)/,
    );
    assert.match(
      dashboardPage,
      /setRoomsSnapshot\(publishScopedFeed[\s\S]*?\}, \(error\) => \{[\s\S]*?currentScope\.date !== date\) return;[\s\S]*?failScopedFeed\(previous, propertyId, date\)/,
    );
    assert.match(
      dashboardPage,
      /let alive = true;[\s\S]*?const unsubscribe = subscribeToRooms[\s\S]*?return \(\) => \{[\s\S]*?alive = false;[\s\S]*?unsubscribe\(\)/,
    );
    assert.match(
      dashboardPage,
      /fetchTodayPropertyCounts\(propertyId, date, \{ throwOnError: true \}\)[\s\S]*?currentScope\.propertyId !== propertyId[\s\S]*?currentScope\.date !== date/,
    );
    assert.match(
      dashboardPage,
      /countsErrorSnapshot\.propertyId === activePropertyId && countsErrorSnapshot\.date === today/,
    );
    assert.match(
      dashboardPage,
      /setCountsErrorSnapshot\(\{ propertyId, date, message: null \}\)/,
    );
    assert.match(
      dashboardPage,
      /onClick=\{\(\) => setCountsRetryKey[\s\S]*?minHeight: 44/,
    );
  });

  test('Dashboard room access loss always reaches a terminal UI state', () => {
    const terminalAccessLoss = section(
      roomsDb,
      'if (err instanceof RoomsAccessLostError) {',
      'logErr(channelKey, err);',
    );
    assert.match(
      terminalAccessLoss,
      /if \(!cancelled\) onError\?\.\(err\);[\s\S]*?stopAll\(\)/,
    );
    assert.doesNotMatch(
      terminalAccessLoss,
      /ownsLatestRequest && !cancelled[\s\S]*?onError/,
    );
  });
});
