/**
 * Regression boundary for the legacy portfolio runner's organization topology.
 *
 * A successful zero-row relationship read means a genuinely empty company. A
 * failed read means we do not know the company, and must reach neither the day
 * claim nor the finding ledger. These tests use the real access/runner code and
 * replace only the Supabase transport.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';

type AdminClient = typeof import('@/lib/supabase-admin')['supabaseAdmin'];

interface QueryState {
  readonly table: string;
  selected: string | null;
  terminal: string | null;
}

interface MockQueryResult {
  data: unknown;
  error: { message: string } | null;
}

type QueryResponder = (state: Readonly<QueryState>) => MockQueryResult;

function topologyReceipt(
  organizationId: string,
  effectiveAt: Date,
  propertyIds: readonly string[],
): MockQueryResult {
  return {
    data: {
      ok: true,
      schemaVersion: 'organization-property-topology-v1',
      organizationId,
      effectiveAt: effectiveAt.toISOString(),
      propertyIds: [...propertyIds],
    },
    error: null,
  };
}

function fakeFrom(respond: QueryResponder): AdminClient['from'] {
  return ((table: string) => {
    const state: QueryState = { table, selected: null, terminal: null };
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
          if (property === 'maybeSingle' || property === 'single') {
            state.terminal = property;
            return Promise.resolve(respond({ ...state }));
          }
          return query;
        };
      },
    });
    return query;
  }) as unknown as AdminClient['from'];
}

describe('company topology fails closed for portfolio checks', { concurrency: false }, () => {
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

  test('strict topology distinguishes a proven empty company from an outage', async () => {
    const {
      propertiesOfOrganization,
      resolveOrganizationPropertyTopology,
    } = await import('@/lib/company/access');
    const organizationId = 'aaaaaaaa-0000-4000-8000-000000000001';
    const now = new Date('2026-07-28T15:00:00.000Z');

    admin.rpc = (async (fn: string) => (
      fn === 'staxis_resolve_organization_property_topology'
        ? topologyReceipt(organizationId, now, [])
        : { data: null, error: { message: 'unexpected rpc' } }
    )) as unknown as AdminClient['rpc'];
    const empty = await resolveOrganizationPropertyTopology(organizationId, now);
    assert.equal(empty.ok, true);
    if (empty.ok) {
      assert.deepEqual(empty.topology.propertyIds, []);
      assert.equal(empty.topology.effectiveAt, now.toISOString());
      assert.equal(Object.isFrozen(empty.topology), true);
      assert.equal(Object.isFrozen(empty.topology.propertyIds), true);
    }

    admin.rpc = (async () => ({
      data: null,
      error: { message: 'relationship store down' },
    })) as unknown as AdminClient['rpc'];
    const unavailable = await resolveOrganizationPropertyTopology(organizationId, now);
    assert.deepEqual(unavailable, { ok: false, reason: 'store_unavailable' });
    assert.deepEqual(
      await propertiesOfOrganization(organizationId),
      [],
      'legacy callers must retain their lenient empty-array fallback',
    );
  });

  test('a topology outage reaches no claim, hotel source, expiry, or hold path', async () => {
    const {
      companyLocalToday,
      gatherPortfolio,
      runPortfolioChecks,
    } = await import('@/lib/company/portfolio-runner');
    const organizationId = 'aaaaaaaa-0000-4000-8000-000000000001';
    const now = new Date('2026-07-28T15:00:00.000Z');
    let topologyReads = 0;
    let nonTopologyReads = 0;
    let claimCalls = 0;

    admin.from = fakeFrom(() => {
      nonTopologyReads += 1;
      return { data: [], error: null };
    });
    admin.rpc = (async (fn: string) => {
      if (fn === 'staxis_resolve_organization_property_topology') {
        topologyReads += 1;
        return { data: null, error: { message: 'relationship store down' } };
      }
      claimCalls += 1;
      return { data: null, error: null };
    }) as unknown as AdminClient['rpc'];

    await assert.rejects(
      () => companyLocalToday(organizationId, now),
      /company topology is unavailable/,
    );
    await assert.rejects(
      () => gatherPortfolio(organizationId, now),
      /company topology is unavailable/,
    );

    topologyReads = 0;
    const summary = await runPortfolioChecks({ organizationId, now });
    assert.equal(topologyReads, 1);
    assert.equal(nonTopologyReads, 0);
    assert.equal(claimCalls, 0);
    assert.equal(summary.ran, false);
    assert.equal(summary.completion, 'unavailable');
    assert.equal(summary.expired, 0);
    assert.deepEqual(summary.errors.map((error) => error.detectorId), ['topology']);
  });

  test('a property-timezone outage also stops before the claim and finding ledger', async () => {
    const { runPortfolioChecks } = await import('@/lib/company/portfolio-runner');
    const organizationId = 'aaaaaaaa-0000-4000-8000-000000000001';
    const propertyId = '11111111-0000-4000-8000-000000000001';
    const now = new Date('2026-07-28T15:00:00.000Z');
    let topologyReads = 0;
    let timezoneReads = 0;
    let otherReads = 0;
    let claimCalls = 0;

    admin.from = fakeFrom((state) => {
      if (state.table === 'properties' && state.selected === 'id, timezone') {
        timezoneReads += 1;
        return { data: null, error: { message: 'property metadata store down' } };
      }
      otherReads += 1;
      return { data: [], error: null };
    });
    admin.rpc = (async (fn: string) => {
      if (fn === 'staxis_resolve_organization_property_topology') {
        topologyReads += 1;
        return topologyReceipt(organizationId, now, [propertyId]);
      }
      claimCalls += 1;
      return { data: null, error: null };
    }) as unknown as AdminClient['rpc'];

    const summary = await runPortfolioChecks({ organizationId, now });
    assert.equal(topologyReads, 1);
    assert.equal(timezoneReads, 1);
    assert.equal(otherReads, 0);
    assert.equal(claimCalls, 0);
    assert.equal(summary.ran, false);
    assert.equal(summary.completion, 'unavailable');
    assert.equal(summary.expired, 0);
    assert.deepEqual(summary.errors.map((error) => error.detectorId), ['topology']);
    assert.match(summary.errors[0]?.error ?? '', /property timezones are unavailable/);
  });

  test('one successful topology snapshot drives both the run clock and gathering', async () => {
    const { runPortfolioChecks } = await import('@/lib/company/portfolio-runner');
    const organizationId = 'aaaaaaaa-0000-4000-8000-000000000001';
    const propertyId = '11111111-0000-4000-8000-000000000001';
    const now = new Date('2026-07-28T15:00:00.000Z');
    let topologyReads = 0;

    admin.from = fakeFrom((state) => {
      if (state.table === 'properties' && state.selected === 'id, timezone') {
        return { data: [{ id: propertyId, timezone: 'America/Chicago' }], error: null };
      }
      if (state.table === 'properties' && state.selected === 'id, name') {
        return { data: [{ id: propertyId, name: 'Snapshot Hotel' }], error: null };
      }
      if (state.table === 'properties' && state.selected === 'timezone, enabled_sections') {
        return {
          data: { timezone: 'America/Chicago', enabled_sections: null },
          error: null,
        };
      }
      // Empty operational ledgers are successful reads, as are empty expiry
      // updates. The assertion here is topology query count, not detector data.
      return { data: [], error: null };
    });
    admin.rpc = (async (fn: string) => {
      if (fn === 'staxis_resolve_organization_property_topology') {
        topologyReads += 1;
        return topologyReceipt(organizationId, now, [propertyId]);
      }
      return { data: null, error: { message: `unexpected rpc: ${fn}` } };
    }) as unknown as AdminClient['rpc'];

    const summary = await runPortfolioChecks({ organizationId, now, force: true });
    assert.equal(topologyReads, 1, 'the gather phase re-read company membership');
    assert.equal(summary.hotels, 1);
    assert.equal(summary.detectorsChecked, 2);
    assert.equal(summary.completion, 'completed');
    assert.equal(summary.localDate, '2026-07-28');
  });
});
