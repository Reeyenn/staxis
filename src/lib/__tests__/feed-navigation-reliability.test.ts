import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

import {
  PORTFOLIO_QUEUE_TIMEOUT_ERROR,
  hotelFallbackState,
  portfolioScopeForViewer,
  portfolioRequestState,
  readWithPortfolioDeadline,
  shouldOptimisticallySettlePortfolioVerdict,
  shouldRenderQueueIdentityLoading,
  shouldRenderPortfolioProbe,
} from '@/components/concourse/portfolio-queue-request';
import { loadFeedMorningBrief, type FeedBriefLoader } from '@/lib/findings/feed-brief';

const PROPERTY_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('Feed portfolio navigation reaches a visible terminal state', () => {
  test('distinguishes loading, retryable error, hotel fallback, and portfolio content', () => {
    assert.equal(
      portfolioRequestState({ data: null, loading: true, error: null }).kind,
      'loading',
    );
    assert.equal(
      portfolioRequestState({ data: null, loading: false, error: 'network down' }).kind,
      'error',
    );
    assert.equal(
      portfolioRequestState({ data: { scope: null }, loading: false, error: null }).kind,
      'hotel',
    );
    assert.equal(
      portfolioRequestState({
        data: { scope: { organizationId: 'org-1' } },
        loading: false,
        error: null,
      }).kind,
      'portfolio',
    );
  });

  test('a defensive impossible hook state is an error, never a blank screen', () => {
    const state = portfolioRequestState({ data: null, loading: false, error: null });
    assert.equal(state.kind, 'error');
  });

  test('last-good scope wins over a failed refresh', () => {
    assert.equal(
      portfolioRequestState({
        data: { scope: { organizationId: 'org-1' } },
        loading: false,
        error: 'refresh failed',
      }).kind,
      'portfolio',
    );
    assert.equal(
      portfolioRequestState({
        data: { scope: null },
        loading: false,
        error: 'refresh failed',
      }).kind,
      'hotel',
    );
  });

  test('a successful non-company probe ends in a hotel queue or an explicit terminal empty state', () => {
    assert.equal(hotelFallbackState(undefined, true), 'waiting');
    assert.equal(hotelFallbackState({ organizationId: 'org-1' }, true), 'portfolio');
    assert.equal(hotelFallbackState(null, true), 'hotel');
    assert.equal(hotelFallbackState(null, false), 'empty');
  });

  test('the portfolio handoff unmounts its loading notice for hotel-scoped accounts', () => {
    assert.equal(shouldRenderPortfolioProbe(undefined), true);
    assert.equal(shouldRenderPortfolioProbe({ organizationId: 'org-1' }), true);
    assert.equal(shouldRenderPortfolioProbe(null), false);

    const queueView = readFileSync(
      resolve(process.cwd(), 'src/components/concourse/QueueView.tsx'),
      'utf8',
    );
    assert.match(queueView, /showPortfolioProbe\s*&&\s*\(/);
  });

  test('a prior viewer\'s portfolio handoff is synchronously masked', () => {
    const portfolio = { organizationId: 'org-a' };
    assert.equal(
      portfolioScopeForViewer({ viewerKey: 'viewer-a', scope: portfolio }, 'viewer-a'),
      portfolio,
    );
    assert.equal(
      portfolioScopeForViewer({ viewerKey: 'viewer-a', scope: null }, 'viewer-a'),
      null,
    );
    assert.equal(
      portfolioScopeForViewer({ viewerKey: 'viewer-a', scope: portfolio }, 'viewer-b'),
      undefined,
    );
    assert.equal(
      portfolioScopeForViewer({ viewerKey: 'viewer-a', scope: null }, 'viewer-b'),
      undefined,
      'a hotel fallback owned by viewer A must not suppress viewer B\'s portfolio probe',
    );
  });

  test('a signed-in Queue stays visibly loading until its exact viewer identity resolves', () => {
    assert.equal(shouldRenderQueueIdentityLoading(false, null), false);
    assert.equal(shouldRenderQueueIdentityLoading(true, null), true);
    assert.equal(shouldRenderQueueIdentityLoading(true, 'viewer-a'), false);

    const queueView = readFileSync(
      resolve(process.cwd(), 'src/components/concourse/QueueView.tsx'),
      'utf8',
    );
    assert.match(
      queueView,
      /if \(shouldRenderQueueIdentityLoading\(!!user, portfolioAuthorizationKey\)\)[\s\S]*?data-feed-state="loading"[\s\S]*?role="status"[\s\S]*?aria-busy="true"/,
    );
  });

  test('every account-scoped Queue read carries the canonical viewer identity', () => {
    const queueView = readFileSync(
      resolve(process.cwd(), 'src/components/concourse/QueueView.tsx'),
      'utf8',
    );
    const portfolioView = readFileSync(
      resolve(process.cwd(), 'src/components/concourse/PortfolioQueueView.tsx'),
      'utf8',
    );

    assert.match(
      queueView,
      /buildCompanyAccessViewerKey\(\{[\s\S]*?uid: user\.uid[\s\S]*?accountId: user\.accountId[\s\S]*?role: user\.role[\s\S]*?propertyAccess: user\.propertyAccess[\s\S]*?resolvedPropertyKey[\s\S]*?adminTargetPropertyId:/,
    );
    assert.match(
      queueView,
      /useApiResource<CoveragePayload>\([\s\S]*?identityKey: portfolioAuthorizationKey/,
    );
    assert.match(
      queueView,
      /useApiResource<BriefPayload>\([\s\S]*?identityKey: viewerAuthorizationKey/,
    );
    assert.match(
      queueView,
      /<PortfolioQueueView[\s\S]*?key=\{portfolioAuthorizationKey\}[\s\S]*?authorizationKey=\{portfolioAuthorizationKey\}/,
    );
    assert.match(
      portfolioView,
      /useApiResource<PortfolioPayload>\([\s\S]*?identityKey: authorizationKey/,
    );
  });

  test('a request that never settles is aborted and becomes retryable', async () => {
    let aborted = false;
    const result = await readWithPortfolioDeadline<{ scope: null }>(
      (signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          // Deliberately do not resolve: the timeout result, not transport
          // cooperation, is what guarantees the UI reaches an error state.
          void resolve;
        });
      }),
      10,
    );

    assert.equal(result.error, PORTFOLIO_QUEUE_TIMEOUT_ERROR);
    assert.equal(aborted, true);
  });

  test('Retry can succeed after a timed-out first attempt', async () => {
    let attempt = 0;
    const read = (signal: AbortSignal) => {
      attempt += 1;
      if (attempt === 1) {
        return new Promise<{ data: { scope: null } }>(() => {
          // The first transport is intentionally hung. The helper's signal is
          // accepted to mirror the real fetch even though this fake ignores it.
          void signal;
        });
      }
      return Promise.resolve({ data: { scope: null } });
    };

    const first = await readWithPortfolioDeadline(read, 10);
    const second = await readWithPortfolioDeadline(read, 100);

    assert.equal(first.error, PORTFOLIO_QUEUE_TIMEOUT_ERROR);
    assert.deepEqual(second, { data: { scope: null } });
  });

  test('Seen stays visible for a climbed hotel card after the authoritative reload', () => {
    assert.equal(shouldOptimisticallySettlePortfolioVerdict(true, 'known_problem'), false);
    assert.equal(shouldOptimisticallySettlePortfolioVerdict(true, 'muted'), true);
    assert.equal(shouldOptimisticallySettlePortfolioVerdict(true, 'resolved'), true);
    assert.equal(shouldOptimisticallySettlePortfolioVerdict(false, 'known_problem'), true);
  });
});

describe('ordinary Feed brief GET does not call a paid AI provider', () => {
  test('the GET delegates to the deterministic Feed loader', () => {
    const route = readFileSync(
      resolve(process.cwd(), 'src/app/api/findings/brief/route.ts'),
      'utf8',
    );

    assert.match(route, /await loadFeedMorningBrief\(propertyId\)/);
    assert.doesNotMatch(route, /getMorningBrief\s*\(/);
  });

  test('the route-owned loader always disables the optional wording pass', async () => {
    let paidProviderCalls = 0;
    let phrasing: boolean | undefined;

    const providerBackedLoader: FeedBriefLoader = async (options) => {
      phrasing = options.phrasing;
      if (options.phrasing !== false) paidProviderCalls += 1;
      return { brief: null, cached: false, generated: false };
    };

    await loadFeedMorningBrief(PROPERTY_ID, providerBackedLoader);

    assert.equal(phrasing, false);
    assert.equal(paidProviderCalls, 0);
  });
});
