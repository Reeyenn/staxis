/**
 * The demo company sits out the SCHEDULED portfolio pass, and nothing else changes.
 *
 * Founder ruling, 2026-07-29: "The fake demo company shouldn't get those runs."
 * The rule has to hold in one direction and fail in the other, so these tests
 * cover both halves:
 *
 *   - scheduled discovery drops a company whose whole portfolio is test hotels,
 *     while a real company in the same fleet still runs; and
 *   - every way of NOT proving demo-ness answers "real", so an outage can never
 *     silently skip a paying customer's findings.
 *
 * The page-open fallback is covered by construction rather than by a test here:
 * it calls `runPortfolioChecks` directly (vp-queue-server.ts), and the exclusion
 * lives in the cron route's discovery, which that path never touches. The test
 * below that drives `runPortfolioChecks` on a demo organization is the guard
 * against someone "tidying" the rule down into the shared runner later.
 *
 * Uses the real access/runner/route code and replaces only the Supabase
 * transport, in the same shape as company-topology-fail-closed.test.ts.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';

import type { NextRequest } from 'next/server';

type AdminClient = typeof import('@/lib/supabase-admin')['supabaseAdmin'];

interface QueryState {
  readonly table: string;
  selected: string | null;
  /**
   * The ids an `.in('id', [...])` filter asked for. The real runner refuses to
   * proceed when a property read returns a different SET than the topology it is
   * comparing (portfolio-runner.ts treats that as a concurrent topology change),
   * so a fake that ignores the filter makes every run `unavailable`.
   */
  inValues: readonly string[] | null;
}

interface MockQueryResult {
  data: unknown;
  error: { message: string } | null;
}

type QueryResponder = (state: Readonly<QueryState>) => MockQueryResult;

const REAL_ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const DEMO_ORG = 'bbbbbbbb-0000-4000-8000-00000000000b';
const REAL_HOTEL = '11111111-0000-4000-8000-000000000001';
const DEMO_HOTEL_ONE = '22222222-0000-4000-8000-000000000002';
const DEMO_HOTEL_TWO = '33333333-0000-4000-8000-000000000003';

const PORTFOLIOS: Record<string, readonly string[]> = {
  [REAL_ORG]: [REAL_HOTEL],
  [DEMO_ORG]: [DEMO_HOTEL_ONE, DEMO_HOTEL_TWO],
};

const IS_TEST: Record<string, boolean> = {
  [REAL_HOTEL]: false,
  [DEMO_HOTEL_ONE]: true,
  [DEMO_HOTEL_TWO]: true,
};

function fakeFrom(respond: QueryResponder): AdminClient['from'] {
  return ((table: string) => {
    const state: QueryState = { table, selected: null, inValues: null };
    let query: Record<PropertyKey, unknown>;
    query = new Proxy({}, {
      get(_target, property) {
        if (property === 'then') {
          return (
            fulfilled: (value: MockQueryResult) => unknown,
            rejected: (reason: unknown) => unknown,
          ) => Promise.resolve(respond({ ...state })).then(fulfilled, rejected);
        }
        if (typeof property !== 'string') return undefined;
        return (...args: unknown[]) => {
          if (property === 'select') state.selected = typeof args[0] === 'string' ? args[0] : null;
          if (property === 'in' && Array.isArray(args[1])) {
            state.inValues = (args[1] as unknown[]).map(String);
          }
          if (property === 'maybeSingle' || property === 'single') {
            return Promise.resolve(respond({ ...state }));
          }
          return query;
        };
      },
    });
    return query;
  }) as unknown as AdminClient['from'];
}

/**
 * The property rows this query actually asked for.
 *
 * Honouring `.in('id', …)` is load-bearing rather than tidy: `portfolio-runner`
 * compares the returned id SET against the topology it is holding and treats any
 * difference as a concurrent topology change, so a fake that returns the whole
 * fixture makes every company's run `unavailable` before it reaches the claim.
 */
function propertyRowsFor(
  state: Readonly<QueryState>,
  row: (id: string) => Record<string, unknown>,
): MockQueryResult {
  const ids = state.inValues ?? Object.keys(IS_TEST);
  return { data: ids.map((id) => ({ id, ...row(id) })), error: null };
}

/**
 * A topology receipt for whatever organization and instant it is asked about.
 * The real validator requires the echoed `effectiveAt` to parse back to exactly
 * the requested instant, so this must echo the parameter rather than pick a date.
 */
function topologyRpc(portfolios: Record<string, readonly string[]>): AdminClient['rpc'] {
  return (async (fn: string, params?: Record<string, unknown>) => {
    if (fn !== 'staxis_resolve_organization_property_topology') {
      return { data: null, error: { message: 'unexpected rpc' } };
    }
    const organizationId = String(params?.p_organization_id ?? '');
    const effectiveAt = String(params?.p_effective_at ?? '');
    const propertyIds = [...(portfolios[organizationId] ?? [])].sort();
    return {
      data: {
        ok: true,
        schemaVersion: 'organization-property-topology-v1',
        organizationId,
        effectiveAt,
        propertyIds,
      },
      error: null,
    };
  }) as unknown as AdminClient['rpc'];
}

function cronRequest(query = ''): NextRequest {
  return new Request(`https://staxis.test/api/cron/run-management-patterns${query}`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ''}` },
  }) as unknown as NextRequest;
}

/**
 * How many organizations the invocation actually took on. The route reports this
 * on both the success and the degraded envelope, which matters because these
 * fixtures deliberately do not carry a whole findings run to completion.
 */
async function organizationsRequested(response: Response): Promise<number> {
  const body = await response.json() as {
    data?: { totals?: { organizationsRequested?: number } };
    details?: { totals?: { organizationsRequested?: number } };
  };
  const totals = body.data?.totals ?? body.details?.totals;
  assert.ok(totals, 'the route must report totals on either envelope');
  assert.equal(typeof totals.organizationsRequested, 'number');
  return totals.organizationsRequested!;
}

describe('the demo company sits out scheduled portfolio runs', { concurrency: false }, () => {
  let admin: AdminClient;
  let originalFrom: AdminClient['from'];
  let originalRpc: AdminClient['rpc'];

  before(async () => {
    ({ supabaseAdmin: admin } = await import('@/lib/supabase-admin'));
    originalFrom = admin.from.bind(admin) as AdminClient['from'];
    originalRpc = admin.rpc.bind(admin) as AdminClient['rpc'];
  });

  afterEach(() => {
    admin.from = originalFrom;
    admin.rpc = originalRpc;
  });

  after(() => {
    admin.from = originalFrom;
    admin.rpc = originalRpc;
  });

  // ─── The rule itself ──────────────────────────────────────────────────────

  test('a portfolio is demo only when it has hotels and all of them are test hotels', async () => {
    const { isDemoOnlyPortfolio } = await import('@/lib/company/demo-portfolio');

    assert.equal(isDemoOnlyPortfolio([{ isTest: true }]), true);
    assert.equal(isDemoOnlyPortfolio([{ isTest: true }, { isTest: true }]), true);
    assert.equal(
      isDemoOnlyPortfolio([{ isTest: true }, { isTest: false }]),
      false,
      'one real hotel makes the company a real customer',
    );
    assert.equal(
      isDemoOnlyPortfolio([]),
      false,
      'a company with no hotels yet is a new customer, not a demo',
    );
  });

  test('an all-test portfolio is proven demo and a mixed one is not', async () => {
    const { isDemoOnlyOrganization } = await import('@/lib/company/demo-portfolio');
    admin.rpc = topologyRpc(PORTFOLIOS);
    admin.from = fakeFrom((state) => {
      if (state.table === 'properties' && state.selected === 'id, is_test') {
        return propertyRowsFor(state, (id) => ({ is_test: IS_TEST[id] === true }));
      }
      return { data: [], error: null };
    });

    assert.equal(await isDemoOnlyOrganization(DEMO_ORG), true);
    assert.equal(await isDemoOnlyOrganization(REAL_ORG), false);
  });

  // ─── Unproven means real ──────────────────────────────────────────────────

  test('a topology outage answers real, never demo', async () => {
    const { isDemoOnlyOrganization } = await import('@/lib/company/demo-portfolio');
    admin.rpc = (async () => ({
      data: null,
      error: { message: 'relationship store down' },
    })) as unknown as AdminClient['rpc'];
    admin.from = fakeFrom(() => ({ data: [], error: null }));

    assert.equal(
      await isDemoOnlyOrganization(DEMO_ORG),
      false,
      'an unreadable company must never be skipped as demo',
    );
  });

  test('an unreadable or partial hotel-flag read answers real, never demo', async () => {
    const { isDemoOnlyOrganization } = await import('@/lib/company/demo-portfolio');
    admin.rpc = topologyRpc(PORTFOLIOS);

    admin.from = fakeFrom((state) => (
      state.table === 'properties'
        ? { data: null, error: { message: 'property metadata store down' } }
        : { data: [], error: null }
    ));
    assert.equal(await isDemoOnlyOrganization(DEMO_ORG), false);

    // The dangerous shape: a partial read that happens to return only the test
    // hotels would look unanimous if the rule did not check for completeness.
    admin.from = fakeFrom((state) => (
      state.table === 'properties' && state.selected === 'id, is_test'
        ? { data: [{ id: DEMO_HOTEL_ONE, is_test: true }], error: null }
        : { data: [], error: null }
    ));
    assert.equal(
      await isDemoOnlyOrganization(DEMO_ORG),
      false,
      'a portfolio is not unanimous if part of it was never read',
    );
  });

  test('an empty company is not demo, and costs no hotel read to decide', async () => {
    const { isDemoOnlyOrganization } = await import('@/lib/company/demo-portfolio');
    let propertyReads = 0;
    admin.rpc = topologyRpc({ [REAL_ORG]: [] });
    admin.from = fakeFrom((state) => {
      if (state.table === 'properties') propertyReads += 1;
      return { data: [], error: null };
    });

    assert.equal(await isDemoOnlyOrganization(REAL_ORG), false);
    assert.equal(propertyReads, 0);
  });

  // ─── The scheduled pass ───────────────────────────────────────────────────

  test('scheduled discovery runs the real company and skips the demo one', async () => {
    const { GET } = await import('@/app/api/cron/run-management-patterns/route');
    const claimed: string[] = [];

    admin.rpc = (async (fn: string, params?: Record<string, unknown>) => {
      if (fn === 'staxis_resolve_organization_property_topology') {
        return (topologyRpc(PORTFOLIOS) as unknown as (
          f: string, p?: Record<string, unknown>,
        ) => Promise<MockQueryResult>)(fn, params);
      }
      if (fn === 'claim_idempotency_key') {
        claimed.push(String(params?.p_key ?? ''));
        // Refuse the day so the fixture stops before the finding ledger. The
        // assertion is about WHICH companies were taken on, not what they wrote.
        return { data: null, error: { message: 'claim store closed for this test' } };
      }
      return { data: null, error: null };
    }) as unknown as AdminClient['rpc'];

    admin.from = fakeFrom((state) => {
      if (state.table === 'organizations') {
        return { data: [{ id: REAL_ORG }, { id: DEMO_ORG }], error: null };
      }
      if (state.table === 'properties' && state.selected === 'id, is_test') {
        return propertyRowsFor(state, (id) => ({ is_test: IS_TEST[id] === true }));
      }
      if (state.table === 'properties') {
        return propertyRowsFor(state, () => ({
          name: 'A hotel', timezone: 'America/Chicago',
        }));
      }
      return { data: [], error: null };
    });

    const requested = await organizationsRequested(await GET(cronRequest()));
    assert.equal(requested, 1, 'only the real company belongs to a scheduled pass');
    assert.ok(
      claimed.every((key) => !key.includes(DEMO_ORG)),
      `the demo company must not claim a portfolio day: ${claimed.join(', ')}`,
    );
    assert.ok(
      claimed.some((key) => key.includes(REAL_ORG)),
      'the real company must still be run by the same pass',
    );
  });

  test('an operator naming the demo company by id still runs it', async () => {
    const { GET } = await import('@/app/api/cron/run-management-patterns/route');
    let organizationDiscoveryReads = 0;
    const claimed: string[] = [];

    admin.rpc = (async (fn: string, params?: Record<string, unknown>) => {
      if (fn === 'staxis_resolve_organization_property_topology') {
        return (topologyRpc(PORTFOLIOS) as unknown as (
          f: string, p?: Record<string, unknown>,
        ) => Promise<MockQueryResult>)(fn, params);
      }
      if (fn === 'claim_idempotency_key') {
        claimed.push(String(params?.p_key ?? ''));
        return { data: null, error: { message: 'claim store closed for this test' } };
      }
      return { data: null, error: null };
    }) as unknown as AdminClient['rpc'];

    admin.from = fakeFrom((state) => {
      if (state.table === 'organizations') {
        organizationDiscoveryReads += 1;
        return { data: [], error: null };
      }
      if (state.table === 'properties') {
        return propertyRowsFor(state, () => ({
          name: 'A hotel', timezone: 'America/Chicago', is_test: true,
        }));
      }
      return { data: [], error: null };
    });

    const requested = await organizationsRequested(
      await GET(cronRequest(`?organizationId=${DEMO_ORG}`)),
    );
    assert.equal(requested, 1, 'an explicit organizationId is operator intent, not a schedule');
    assert.equal(organizationDiscoveryReads, 0, 'a named company skips discovery entirely');
    assert.ok(
      claimed.some((key) => key.includes(DEMO_ORG)),
      'the named demo company must actually be attempted',
    );
  });

  test('the shared runner itself never filters, so the page-open fallback keeps working', async () => {
    const { runPortfolioChecks } = await import('@/lib/company/portfolio-runner');
    const claimed: string[] = [];

    admin.rpc = (async (fn: string, params?: Record<string, unknown>) => {
      if (fn === 'staxis_resolve_organization_property_topology') {
        return (topologyRpc(PORTFOLIOS) as unknown as (
          f: string, p?: Record<string, unknown>,
        ) => Promise<MockQueryResult>)(fn, params);
      }
      if (fn === 'claim_idempotency_key') {
        claimed.push(String(params?.p_key ?? ''));
        return { data: null, error: { message: 'claim store closed for this test' } };
      }
      return { data: null, error: null };
    }) as unknown as AdminClient['rpc'];

    admin.from = fakeFrom((state) => {
      if (state.table === 'properties') {
        return propertyRowsFor(state, () => ({
          name: 'A hotel', timezone: 'America/Chicago', is_test: true,
        }));
      }
      return { data: [], error: null };
    });

    // The demo company reaches the day claim through the shared runner. If a
    // future refactor moves the exclusion in here, this fails and the live
    // walkthrough that depends on the fallback is protected.
    const summary = await runPortfolioChecks({ organizationId: DEMO_ORG });
    assert.equal(summary.organizationId, DEMO_ORG);
    assert.ok(
      claimed.some((key) => key.includes(DEMO_ORG)),
      'the fallback runner must still take on the demo company',
    );
  });
});
